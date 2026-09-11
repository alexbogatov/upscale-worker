/* main.js — MP4Box demux → VideoDecoder → worker upscale → VideoEncoder → WebM.
 *
 * No <video>, no seeking, no rVFC. Every sample from the MP4 track is decoded,
 * upscaled, and encoded exactly once. Selecting a file starts the export
 * immediately — there is no Export button.
 *
 * Puppeteer integration:
 *   window.__upscale_state = { status, done, error, frames, total }
 *   console.log('__UPSCALE_DONE__ ' + JSON.stringify({ ok, ... }))
 */
(function () {
  // Puppeteer-facing status. Updated as the pipeline runs.
  window.__upscale_state = { status: 'idle', done: false, error: null, frames: 0, total: 0 };
  function publish(patch) { Object.assign(window.__upscale_state, patch); }

  const file_input  = document.getElementById('file');
  const status_el   = document.getElementById('status');
  const progress_el = document.getElementById('progress');
  const eta_el      = document.getElementById('eta');
  const preview     = document.getElementById('preview');
  const preview_ctx = preview.getContext('2d');

  const PREVIEW_EVERY_N_FRAMES = 1;

  let worker   = null;
  let width    = 0;
  let height   = 0;
  let busy     = false;

  function set_status(t)   { status_el.textContent = t; }
  function set_progress(t) { progress_el.textContent = t; }
  function set_eta(t)      { eta_el.textContent = t; }

  function fmt_time(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '—';
    seconds = Math.round(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  async function has_webgpu() {
    if (!('gpu' in navigator)) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch { return false; }
  }

  function teardown_worker() {
    if (worker) { worker.terminate(); worker = null; }
  }

  async function start_worker(w, h) {
    teardown_worker();

    const scratch = document.createElement('canvas');
    scratch.width  = w * 2;
    scratch.height = h * 2;
    const offscreen = scratch.transferControlToOffscreen();

    worker = new Worker('./upscale-worker.js');
    worker.onmessage = (event) => {
      const { cmd, data } = event.data;
      if (cmd === 'error') {
        console.error('[main] worker error:', data);
        set_status('error: ' + data);
        busy = false;
      }
    };

    worker.postMessage(
      { cmd: 'init', canvas: offscreen, weights_url: './weights/cnn-28.bin' },
      [offscreen]
    );

    await new Promise((resolve, reject) => {
      const on_msg = (e) => {
        if (e.data.cmd === 'ready') { worker.removeEventListener('message', on_msg); resolve(); }
        if (e.data.cmd === 'error') { worker.removeEventListener('message', on_msg); reject(new Error(e.data.data)); }
      };
      worker.addEventListener('message', on_msg);
    });
  }

  function upscale_one(bitmap) {
    return new Promise((resolve, reject) => {
      const on_msg = (e) => {
        if (e.data.cmd === 'frame_done') {
          worker.removeEventListener('message', on_msg);
          resolve(e.data.bitmap);
        } else if (e.data.cmd === 'error') {
          worker.removeEventListener('message', on_msg);
          reject(new Error(e.data.data));
        }
      };
      worker.addEventListener('message', on_msg);
      worker.postMessage(
        { cmd: 'upscale_frame', bitmap, width, height },
        [bitmap]
      );
    });
  }

  function probe_mp4(file) {
    return new Promise(async (resolve, reject) => {
      try {
        const buf = await file.arrayBuffer();
        const mp4 = MP4Box.createFile();
        mp4.onError = (e) => reject(new Error('MP4Box: ' + e));
        mp4.onReady = (info) => {
          const v = info.videoTracks[0];
          if (!v) return reject(new Error('No video track in MP4'));
          resolve({
            codec:        v.codec,
            coded_width:  v.track_width  || v.video.width,
            coded_height: v.track_height || v.video.height,
            nb_samples:   v.nb_samples,
          });
        };
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
        mp4.flush();
      } catch (e) { reject(e); }
    });
  }

  // ----------------------------------------------------------------------
  // File selection → everything else happens automatically.
  // ----------------------------------------------------------------------
  file_input.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file || busy) return;

    busy = true;
    publish({ status: 'reading_metadata', done: false, error: null, frames: 0, total: 0 });
    set_status('reading metadata…');
    set_progress('');
    set_eta('');

    try {
      if (!(await has_webgpu())) {
        throw new Error('WebGPU not available — this engine requires WebGPU for CNN-28.');
      }

      const { codec, coded_width, coded_height, nb_samples } = await probe_mp4(file);
      width  = coded_width;
      height = coded_height;

      preview.width  = width  * 2;
      preview.height = height * 2;

      await start_worker(width, height);
      console.log('[main] ready:', width + '×' + height, codec, nb_samples, 'frames');

      await run_export(file);
    } catch (err) {
      console.error('[main] failed:', err);
      set_status('failed: ' + (err.message || err));
      publish({ status: 'failed', done: true, error: err.message || String(err) });
      console.log('__UPSCALE_DONE__ ' + JSON.stringify({ ok: false, error: err.message || String(err) }));
    } finally {
      busy = false;
      // Reset the input so re-selecting the same file fires 'change' again.
      file_input.value = '';
    }
  });

  // ----------------------------------------------------------------------
  // Export (runs unattended)
  // ----------------------------------------------------------------------
  async function run_export(file_obj) {
    set_status('exporting…');
    const export_start_ms = performance.now();

    const file_buffer = await file_obj.arrayBuffer();

    // ---- Output encoder + muxer.
    const { Muxer, ArrayBufferTarget } = window.WebMMuxer;
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'V_VP9', width: width * 2, height: height * 2, frameRate: 30 },
    });

    let encoder_error = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encoder_error = e; console.error('[main] encoder error:', e); },
    });

    const encoder_config = await pick_encoder_config(width * 2, height * 2);
    if (!encoder_config) throw new Error('No supported VP9/VP8 encoder configuration found.');
    console.log('[main] encoder config:', encoder_config);
    encoder.configure(encoder_config);

    // ---- Demux + decode.
    const mp4 = MP4Box.createFile();

    let total_frames    = 0;
    let samples_fed     = 0;
    let frames_decoded  = 0;
    let frames_encoded  = 0;
    let decoder         = null;
    let decoder_error   = null;
    let encoder_started = false;

    let chain = Promise.resolve();

    const update_eta = () => {
      const elapsed_s = (performance.now() - export_start_ms) / 1000;
      const fps_now   = frames_encoded / Math.max(0.001, elapsed_s);
      const remaining = (total_frames - frames_encoded) / Math.max(0.01, fps_now);
      set_eta(
        `  ·  ${fmt_time(elapsed_s)} elapsed  ·  ` +
        `${fps_now.toFixed(1)} fps  ·  ${fmt_time(remaining)} left`
      );
    };

    const on_decoded_frame = (frame) => {
      frames_decoded++;
      chain = chain.then(async () => {
        if (encoder_error) { frame.close(); return; }

        const bitmap = await createImageBitmap(frame);
        frame.close();

        const upscaled = await upscale_one(bitmap);

        if (frames_encoded % PREVIEW_EVERY_N_FRAMES === 0) {
          preview_ctx.drawImage(upscaled, 0, 0);
        }

        const ts = Math.round(1e6 * frames_encoded / 30);
        const enc_frame = new VideoFrame(upscaled, {
          timestamp: ts,
          duration: Math.round(1e6 / 30),
        });
        encoder.encode(enc_frame, { keyFrame: (frames_encoded % 60 === 0) });
        enc_frame.close();
        upscaled.close();

        frames_encoded++;
        if (frames_encoded % 5 === 0 || frames_encoded === total_frames) {
          const pct = Math.round((frames_encoded / Math.max(1, total_frames)) * 100);
          set_progress(`${pct}%  (${frames_encoded}/${total_frames})`);
          update_eta();
          publish({ status: 'exporting', frames: frames_encoded, total: total_frames });
        }
      });
    };

    let all_samples_fed_resolve;
    const all_samples_fed = new Promise((res) => { all_samples_fed_resolve = res; });

    mp4.onError = (e) => {
      console.error('[main] MP4Box error:', e);
      decoder_error = new Error('MP4Box: ' + e);
    };

    mp4.onReady = (info) => {
      const v = info.videoTracks[0];
      if (!v) { decoder_error = new Error('No video track'); return; }
      total_frames = v.nb_samples || 0;
      publish({ total: total_frames });
      console.log('[main] track:', v.codec, v.track_width + '×' + v.track_height,
                  total_frames, 'samples');

      const description = get_avcc_description(mp4, v.id);
      decoder = new VideoDecoder({
        output: on_decoded_frame,
        error:  (e) => { decoder_error = e; console.error('[main] decoder error:', e); },
      });
      decoder.configure({
        codec: v.codec,
        description,
        codedWidth:  v.track_width,
        codedHeight: v.track_height,
      });

      mp4.setExtractionOptions(v.id, null, { nbSamples: 50 });
      mp4.start();
    };

    mp4.onSamples = (id, user, samples) => {
      if (decoder_error) return;
      for (const s of samples) {
        const chunk = new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round((1e6 * s.cts) / s.timescale),
          duration:  Math.round((1e6 * s.duration) / s.timescale),
          data: s.data,
        });
        decoder.decode(chunk);
        samples_fed++;
      }
      if (samples_fed >= total_frames && !encoder_started) {
        encoder_started = true;
        all_samples_fed_resolve();
      }
    };

    file_buffer.fileStart = 0;
    mp4.appendBuffer(file_buffer);
    mp4.flush();

    await all_samples_fed;
    if (decoder_error) throw decoder_error;

    await decoder.flush();
    if (decoder_error) throw decoder_error;

    await chain;
    if (encoder_error) throw encoder_error;

    await encoder.flush();
    encoder.close();
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/webm' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (file_obj.name.replace(/\.[^.]+$/, '') || 'output') + '.upscaled.webm';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    const total_s = (performance.now() - export_start_ms) / 1000;
    const avg_fps = frames_encoded / Math.max(0.001, total_s);
    set_status(`done · ${frames_encoded} frames in ${fmt_time(total_s)} (${avg_fps.toFixed(1)} fps avg)`);
    publish({ status: 'done', done: true, frames: frames_encoded, total: total_frames });
    console.log('__UPSCALE_DONE__ ' + JSON.stringify({
      ok: true,
      frames: frames_encoded,
      total: total_frames,
      seconds: Number(total_s.toFixed(2)),
      avg_fps: Number(avg_fps.toFixed(2)),
      filename: (file_obj.name.replace(/\.[^.]+$/, '') || 'output') + '.upscaled.webm',
    }));
  }

  async function pick_encoder_config(w, h) {
    const candidates = [
      { codec: 'vp09.00.10.08', width: w, height: h, bitrate: 12_000_000, framerate: 30 },
      { codec: 'vp09.00.51.08', width: w, height: h, bitrate: 12_000_000, framerate: 30 },
      { codec: 'vp09.00.41.08', width: w, height: h, bitrate: 12_000_000, framerate: 30 },
      { codec: 'vp8',           width: w, height: h, bitrate: 12_000_000, framerate: 30 },
    ];
    for (const cfg of candidates) {
      try {
        const { supported } = await VideoEncoder.isConfigSupported(cfg);
        if (supported) return cfg;
      } catch {}
    }
    return null;
  }

  function get_avcc_description(mp4, track_id) {
    const trak = mp4.moov.traks.find(t => t.tkhd.track_id === track_id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || null;
    if (!box) return undefined;
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8);
  }
})();