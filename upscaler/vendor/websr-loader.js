/* websr-loader.js */
(function () {
  const modules = window.__websrModules;
  if (!modules) {
    console.error('[websr-loader] __websrModules not found — chunk-capture shim missing or websr.js failed to load.');
    return;
  }
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
    if (typeof modules[id] !== 'function') throw new Error('[websr-loader] module ' + id + ' not in chunk');
    modules[id](mod, mod.exports, requireWebSR);
    return mod.exports;
  }
  
  for (const id of Object.keys(modules)) {
    try { requireWebSR(id); } catch (e) { /* some modules need runtime context */ }
  }

  // Module 513 IS the WebGPU WebSR class. No .default — the module's
  // exports object is the constructor itself. Verified against 104.main.js:
  // 513's wrapper ends with `e.exports = t()` where t() === i(540).default.
  // Object.keys() on it shows only ['parseBinaryWeights'] because class
  // statics are non-enumerable — that probe was the red herring.
  window.WebSR              = requireWebSR(513);
  window.WebGLWebSR         = requireWebSR(478).Z;
  window.parseBinaryWeights = window.WebSR.parseBinaryWeights; // X4V-only; parity

  console.log('[websr-loader]', {
    WebSR:              typeof window.WebSR,              // expect "function"
    initWebGPU:         typeof window.WebSR.initWebGPU,   // expect "function"
    WebGLWebSR:         typeof window.WebGLWebSR,         // expect "function"
    parseBinaryWeights: typeof window.parseBinaryWeights, // expect "function"
  });

})();