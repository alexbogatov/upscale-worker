import os from 'os';
import http from 'http';
import { readFileSync, createReadStream, createWriteStream } from 'fs';
import { mkdir, writeFile, readdir, stat, unlink, rename } from 'fs/promises';
import { join, extname } from 'path';
import puppeteer from 'puppeteer-core';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ============================================
// CONSTANTS & IDENTITY
// ============================================
const MACHINE_ID = os.hostname();
const WORKER_SESSION_ID = process.env.WORKER_SESSION_ID;
const WORKER_API_SECRET = process.env.WORKER_API_SECRET;

if (!WORKER_API_SECRET) {
  console.error('[worker] FATAL: WORKER_API_SECRET environment variable is missing.');
  process.exit(1);
}

const API_BASE_URL = process.env.API_BASE_URL || 'https://api.runltx.com';
const JOB_TYPE = process.env.JOB_TYPE || 'upscale';
const MODEL = process.env.MODEL || 'upscale-video';

const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 8099;
const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 5) * 1000;
const MAX_EMPTY_POLLS = parseInt(process.env.MAX_EMPTY_POLLS, 10) || 3;
const MAX_JOB_SECONDS = parseInt(process.env.MAX_JOB_SECONDS, 10) || 1800;
const CHROME_BIN = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const PUPPETEER_HEADLESS = process.env.PUPPETEER_HEADLESS === 'true';

const WORK_DIR = process.env.WORK_DIR || '/tmp/upscaler';
const OUTPUT_DIR = process.env.OUTPUT_DIR || join(WORK_DIR, 'out');
const STATS_FILE = '/tmp/worker_stats.json';
const UPSCALER_DIR = join(process.cwd(), 'upscaler');

// Cloudflare R2 Credentials
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_CDN_URL = process.env.R2_CDN_URL;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.warn('[worker] [Config Warning] Missing one or more R2 credentials.');
}

const s3_client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || '',
    secretAccessKey: R2_SECRET_ACCESS_KEY || '',
  },
});

let total_jobs_processed = 0;
let total_generation_time_sec = 0;
let consecutive_failures = 0;
let browser = null;

// ============================================
// HELPERS
// ============================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const get_api_headers = () => ({
  'worker-auth': WORKER_API_SECRET,
  'x-machine-id': MACHINE_ID,
  'content-type': 'application/json'
});

const sync_stats_file = async () => {
  try {
    const stats = {
      jobs_processed: total_jobs_processed,
      total_generation_time_sec: Math.round(total_generation_time_sec * 100) / 100,
    };
    await writeFile(STATS_FILE, JSON.stringify(stats));
  } catch (_) {}
};

// ============================================
// STATIC HTTP SERVER (Upscaler assets & /video/)
// ============================================
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.bin': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.css': 'text/css'
};

const serve_file = async (file_path, req, res) => {
  try {
    const file_stat = await stat(file_path);
    const total_size = file_stat.size;
    const ext = extname(file_path).toLowerCase();
    const content_type = MIME_TYPES[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total_size - 1;

      if (start >= total_size || end >= total_size) {
        res.writeHead(416, { 'Content-Range': `bytes */${total_size}` });
        return res.end();
      }

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total_size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': content_type,
      });

      createReadStream(file_path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total_size,
        'Content-Type': content_type,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(file_path).pipe(res);
    }
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
};

const start_static_server = () => {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
      let pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith('/video/')) {
        const video_name = pathname.slice('/video/'.length);
        const file_path = join(WORK_DIR, video_name);
        return await serve_file(file_path, req, res);
      }

      if (pathname === '/' || pathname === '') {
        pathname = '/index.html';
      }

      const file_path = join(UPSCALER_DIR, pathname);
      await serve_file(file_path, req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  return new Promise((resolve) => {
    server.listen(HTTP_PORT, '127.0.0.1', () => {
      console.log(`[server] Static HTTP server listening on 127.0.0.1:${HTTP_PORT}`);
      resolve(server);
    });
  });
};

// ============================================
// BROWSER LIFECYCLE (PUPPETEER + WEBGPU)
// ============================================
const launch_browser = async () => {
  console.log(`[browser] Launching Chrome (${CHROME_BIN})...`);

  const instance = await puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: PUPPETEER_HEADLESS ? 'new' : false,
    ignoreDefaultArgs: ['--use-angle=swiftshader-webgl'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-angle=vulkan',
      '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE',
      '--enable-unsafe-webgpu',
      '--disable-web-security',
    ]
  });

  instance.on('disconnected', () => {
    console.error('[browser] Chrome disconnected or crashed.');
    browser = null;
  });

  return instance;
};

const verify_webgpu = async (browser_instance) => {
  const page = await browser_instance.newPage();
  try {
    await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'networkidle2' });
    const gpu_status = await page.evaluate(async () => {
      if (!navigator.gpu) return { available: false, error: 'navigator.gpu is undefined' };
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return { available: false, error: 'No adapter found' };
        const info = await adapter.requestAdapterInfo();
        return { available: true, info };
      } catch (e) {
        return { available: false, error: e.message };
      }
    });

    if (gpu_status.available) {
      console.log(`[browser] WebGPU verified: available (adapter: ${gpu_status.info.device || gpu_status.info.vendor})`);
    } else {
      console.warn(`[browser] WebGPU check warning: ${gpu_status.error}`);
    }
  } finally {
    await page.close();
  }
};

// ============================================
// API OPERATIONS
// ============================================
const poll_for_job = async () => {
  try {
    const url = `${API_BASE_URL}/v1/worker/get`;
    const response = await fetch(url, {
      method: 'POST',
      headers: get_api_headers(),
      body: JSON.stringify({
        session_id: WORKER_SESSION_ID,
        job_type: JOB_TYPE,
        models: MODEL
      })
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const err_text = await response.text();
      throw new Error(`HTTP ${response.status}: ${err_text}`);
    }

    return await response.json();
  } catch (err) {
    console.error('[api] Poll error:', err.message);
    return null;
  }
};

const complete_job = async (job_id, output_url, generation_time_sec) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const url = `${API_BASE_URL}/v1/worker/complete`;
      const response = await fetch(url, {
        method: 'POST',
        headers: get_api_headers(),
        body: JSON.stringify({
          session_id: WORKER_SESSION_ID,
          job_id,
          output_url,
          generation_time_sec
        })
      });

      if (!response.ok) {
        const err_text = await response.text();
        throw new Error(`HTTP ${response.status}: ${err_text}`);
      }

      return await response.json();
    } catch (err) {
      console.error(`[api] Complete attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await sleep(2000);
    }
  }
};

const fail_job = async (job_id, error_message) => {
  try {
    const url = `${API_BASE_URL}/v1/worker/fail`;
    await fetch(url, {
      method: 'POST',
      headers: get_api_headers(),
      body: JSON.stringify({
        session_id: WORKER_SESSION_ID,
        job_id,
        error_message: typeof error_message === 'string' ? error_message : (error_message?.message || 'Worker failure')
      })
    });
  } catch (err) {
    console.error('[api] Fail report error:', err.message);
  }
};

// ============================================
// FILE TRANSFERS & STORAGE
// ============================================
const download_video = async (url, target_path) => {
  console.log(`[download] Fetching ${url} -> ${target_path}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Video download failed: ${res.statusText}`);
  const file_stream = createWriteStream(target_path);
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    file_stream.write(Buffer.from(value));
  }
  await new Promise((resolve) => file_stream.end(resolve));
};

const upload_to_r2 = async (file_path, job_id) => {
  console.log(`[upload] Uploading ${file_path} to R2 bucket: ${R2_BUCKET_NAME}...`);
  const key = `upscales/${job_id}.webm`;
  const file_stream = createReadStream(file_path);

  await s3_client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: file_stream,
    ContentType: 'video/webm',
  }));

  return `${R2_CDN_URL}/${key}`;
};

const wait_for_downloaded_file = async (file_path, timeout_ms = 60000) => {
  const start = Date.now();
  let last_size = -1;

  while (Date.now() - start < timeout_ms) {
    try {
      const s = await stat(file_path);
      if (s.size > 0) {
        if (s.size === last_size) {
          return true; // Size is stable across samples
        }
        last_size = s.size;
      }
    } catch (_) {}
    await sleep(500);
  }
  return false;
};

// ============================================
// UPSCALE EXECUTION FLOW
// ============================================
const run_upscale = async (filename) => {
  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();
  await cdp.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: OUTPUT_DIR,
  });

  return new Promise(async (resolve, reject) => {
    let settled = false;

    const watchdog = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Timeout after ${MAX_JOB_SECONDS}s`));
      }
    }, MAX_JOB_SECONDS * 1000);

    page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('__UPSCALE_DONE__')) {
        try {
          const payload = JSON.parse(text.replace('__UPSCALE_DONE__', '').trim());
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          if (payload.ok) {
            resolve(payload);
          } else {
            reject(new Error(payload.error || 'Upscale failed inside page'));
          }
        } catch (e) {
          if (!settled) {
            settled = true;
            clearTimeout(watchdog);
            reject(e);
          }
        }
      }
    });

    page.on('pageerror', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        reject(err);
      }
    });

    try {
      const upscale_url = `http://127.0.0.1:${HTTP_PORT}/?file=${encodeURIComponent('/video/' + filename)}`;
      console.log(`[upscale] Navigating to ${upscale_url}`);
      await page.goto(upscale_url, { waitUntil: 'networkidle2' });
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        reject(err);
      }
    }
  }).finally(async () => {
    try { await page.close(); } catch (_) {}
  });
};

// ============================================
// MAIN LOOP
// ============================================
const main = async () => {
  console.log(`[worker] Started on host: ${MACHINE_ID}`);

  await mkdir(WORK_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await sync_stats_file();

  await start_static_server();
  browser = await launch_browser();
  await verify_webgpu(browser);

  let empty_poll_count = 0;

  while (true) {
    if (!browser) {
      console.log('[browser] Recovering missing Chrome instance...');
      browser = await launch_browser();
    }

    const job_res = await poll_for_job();

    if (!job_res || !job_res.success || !job_res.data) {
      empty_poll_count++;
      console.log(`[worker] No jobs available (${empty_poll_count}/${MAX_EMPTY_POLLS})`);

      if (empty_poll_count >= MAX_EMPTY_POLLS) {
        console.log('[worker] Inactivity limit reached. Terminating container...');
        await browser.close();
        process.exit(0);
      }

      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    empty_poll_count = 0;
    const job_data = job_res.data;
    const job_id = job_data.job_id;
    const video_url = job_data.input?.video_url || job_data.video_url;

    if (!video_url) {
      console.error(`[worker] Job ${job_id} missing video_url`);
      await fail_job(job_id, 'Missing video_url');
      continue;
    }

    console.log(`[worker] Claimed Job [${job_id}] -> ${video_url}`);
    const input_filename = `${job_id}.mp4`;
    const input_path = join(WORK_DIR, input_filename);
    let output_path = null;

    try {
      await download_video(video_url, input_path);

      const start_time = Date.now();
      const upscale_result = await run_upscale(input_filename);
      const generation_time = (Date.now() - start_time) / 1000;

      const produced_filename = upscale_result.filename;
      output_path = join(OUTPUT_DIR, produced_filename);

      const arrived = await wait_for_downloaded_file(output_path);
      if (!arrived) {
        throw new Error('Produced WebM file never finalized in OUTPUT_DIR');
      }

      const r2_url = await upload_to_r2(output_path, job_id);
      await complete_job(job_id, r2_url, generation_time);

      total_jobs_processed++;
      total_generation_time_sec += generation_time;
      consecutive_failures = 0;
      await sync_stats_file();

      console.log(`[worker] Job [${job_id}] completed in ${generation_time.toFixed(2)}s -> ${r2_url}`);
    } catch (err) {
      console.error(`[worker] Job [${job_id}] failed:`, err.message);
      consecutive_failures++;
      await fail_job(job_id, err.message);

      if (consecutive_failures >= 5) {
        console.error('[worker] FATAL: 5 consecutive failures. Exiting.');
        process.exit(1);
      }
    } finally {
      try { await unlink(input_path); } catch (_) {}
      if (output_path) {
        try { await unlink(output_path); } catch (_) {}
      }
    }
  }
};

const handle_exit = async () => {
  console.log('[worker] Shutdown signal received.');
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
  process.exit(0);
};

process.on('SIGINT', handle_exit);
process.on('SIGTERM', handle_exit);

main().catch((err) => {
  console.error('[worker] Unhandled fatal exception:', err);
  process.exit(1);
});