/* worker.js — owns the OffscreenCanvas, the WebSR instance, and the weights. */

let WebSR_class          = null;
let parse_binary_weights = null;

let network     = null;
let gpu_device  = null;
let out_canvas  = null;
let weights_url = null;

// --- chunk-capture shim: MUST run before importScripts('vendor/websr.js') ---
self.webpackChunkfree_video_upscaler = self.webpackChunkfree_video_upscaler || [];
const _orig_push = self.webpackChunkfree_video_upscaler.push.bind(
  self.webpackChunkfree_video_upscaler
);
self.webpackChunkfree_video_upscaler.push = function (chunk) {
  if (Array.isArray(chunk) && Array.isArray(chunk[0]) && chunk[0].includes(104)) {
    self.__websrModules = chunk[1];
  }
  return _orig_push(chunk);
};
// ---------------------------------------------------------------------------

function make_require() {
  const modules = self.__websrModules;
  if (!modules) throw new Error('[worker] __websrModules not populated');

  const mod_cache = {};
  function requireWebSR(id) {
    if (mod_cache[id]) return mod_cache[id].exports;
    const mod = mod_cache[id] = { exports: {} };

    requireWebSR.d = (exports, definition) => {
      for (const key in definition)
        if (Object.prototype.hasOwnProperty.call(definition, key) &&
            !Object.prototype.hasOwnProperty.call(exports, key))
          Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
    };
    requireWebSR.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
    requireWebSR.r = (exports) => {
      if (typeof Symbol !== 'undefined' && Symbol.toStringTag)
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
      Object.defineProperty(exports, '__esModule', { value: true });
    };
    requireWebSR.n = (module) => {
      const getter = module && module.__esModule ? () => module.default : () => module;
      requireWebSR.d(getter, { a: getter });
      return getter;
    };
    requireWebSR.t = (value, mode) => {
      if (mode & 1) value = requireWebSR(value);
      if (mode & 8) return value;
      if (typeof value === 'object' && value) {
        if ((mode & 4) && value.__esModule) return value;
        if ((mode & 16) && typeof value.then === 'function') return value;
      }
      const ns = Object.create(null);
      requireWebSR.r(ns);
      const getters = {};
      if (mode & 2 && typeof value === 'object')
        for (const key in value) getters[key] = () => value[key];
      getters.default = () => value;
      requireWebSR.d(ns, getters);
      return ns;
    };

    if (typeof modules[id] !== 'function') {
      throw new Error('[worker] module ' + id + ' not in chunk');
    }
    modules[id](mod, mod.exports, requireWebSR);
    return mod.exports;
  }
  return requireWebSR;
}

async function load_engine() {
  importScripts('./vendor/weights-parser.js');
  importScripts('./vendor/websr.js');

  const requireWebSR = make_require();

  WebSR_class          = requireWebSR(513);   // WebGPU WebSR class
  parse_binary_weights = self.parse_weights;  // A4K/X4V parser

  if (typeof WebSR_class !== 'function' || typeof WebSR_class.initWebGPU !== 'function') {
    throw new Error('[worker] module 513 did not expose the WebGPU WebSR class');
  }
  console.log('[worker] engine loaded.', {
    WebSR:   WebSR_class.name,
    statics: Object.getOwnPropertyNames(WebSR_class),
  });
}

async function ensure_network(frame_width, frame_height) {
  if (network) return;

  if (!gpu_device) {
    gpu_device = await WebSR_class.initWebGPU();
    if (!gpu_device) {
      throw new Error('WebGPU is required for anime4k/cnn-2x-28 — no adapter or device.');
    }
  }

  const weight_buffer = await (await fetch(weights_url)).arrayBuffer();
  const weights = parse_binary_weights(weight_buffer);
  console.log('[worker] weights parsed:', Object.keys(weights.layers).length, 'layers');

  network = new WebSR_class({
    network_name: 'anime4k/cnn-2x-28',
    weights: weights,
    gpu: gpu_device,
    canvas: out_canvas,
    outputResolution: { width: frame_width * 2, height: frame_height * 2 },
    tier: { tier: 3 },
  });

  console.log('[worker] webgpu network ready');
}

self.onmessage = async (event) => {
  const { cmd } = event.data;

  try {
    if (cmd === 'init') {
      out_canvas  = event.data.canvas;
      weights_url = event.data.weights_url;

      await load_engine();
      self.postMessage({ cmd: 'ready' });
      return;
    }

    if (cmd === 'upscale_frame') {
      const { bitmap, width, height } = event.data;

      await ensure_network(width, height);
      await network.render(bitmap);
      bitmap.close();

      const out_bitmap = out_canvas.transferToImageBitmap();
      self.postMessage({ cmd: 'frame_done', bitmap: out_bitmap }, [out_bitmap]);
      return;
    }
  } catch (err) {
    console.error('[worker] error:', err);
    self.postMessage({ cmd: 'error', data: err.message || String(err) });
  }
};