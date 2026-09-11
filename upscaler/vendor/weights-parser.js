/* weights-parser.js — dual-format weights parser extracted from 22.main.js.
 * Accepts A4K and X4V containers.
 */
(function () {
  'use strict';

  function parse_a4k(buffer) {
    const view = new DataView(buffer);
    let offset = 4;
    const version = view.getUint32(offset, true);
    if (version !== 1) throw new Error('Unsupported A4K weight version: ' + version);
    offset += 4;
    const layer_count = view.getUint32(offset, true);
    offset += 4;
    const layers = {};
    const decoder = new TextDecoder();
    for (let i = 0; i < layer_count; i++) {
      const name_len = view.getUint32(offset, true); offset += 4;
      const name = decoder.decode(new Uint8Array(buffer, offset, name_len)); offset += name_len;
      const weights_len = view.getUint32(offset, true); offset += 4;
      const bias_len    = view.getUint32(offset, true); offset += 4;
      const weights = new Float32Array(buffer.slice(offset, offset + 4 * weights_len)); offset += 4 * weights_len;
      const bias    = new Float32Array(buffer.slice(offset, offset + 4 * bias_len));     offset += 4 * bias_len;
      layers[name] = { weights, bias };
    }
    return { name: "", layers };
  }

  function parse_x4v(buffer) {
    const view = new DataView(buffer);
    let offset = 4;
    const version = view.getUint32(offset, true); offset += 4;
    if (version !== 1) throw new Error('Unsupported X4V weight version: ' + version);
    const layer_count = view.getUint32(offset, true); offset += 4;
    offset += 4;
    const decoder = new TextDecoder();
    const layers = [];
    for (let i = 0; i < layer_count; i++) {
      const name_len = view.getUint32(offset, true); offset += 4;
      const name = decoder.decode(new Uint8Array(buffer, offset, name_len)); offset += name_len;
      const type         = view.getUint32(offset, true); offset += 4;
      const in_channels  = view.getUint32(offset, true); offset += 4;
      const out_channels = view.getUint32(offset, true); offset += 4;
      const num_matrices = view.getUint32(offset, true); offset += 4;
      const num_bias     = view.getUint32(offset, true); offset += 4;
      const num_alpha    = view.getUint32(offset, true); offset += 4;
      const matrices = new Float32Array(buffer.slice(offset, offset + 4 * num_matrices)); offset += 4 * num_matrices;
      const bias     = new Float32Array(buffer.slice(offset, offset + 4 * num_bias));     offset += 4 * num_bias;
      const alpha    = num_alpha > 0 ? new Float32Array(buffer.slice(offset, offset + 4 * num_alpha)) : undefined;
      offset += 4 * num_alpha;
      layers.push({
        name,
        type: type === 1 ? 'conv_prelu' : 'conv',
        in_channels,
        out_channels,
        in_vec4s: Math.ceil(in_channels / 4),
        out_vec4s: Math.ceil(out_channels / 4),
        matrices,
        bias,
        alpha,
      });
    }
    return { version, layers };
  }

  function parse_weights(buffer) {
    if (buffer.byteLength < 4) throw new Error('Invalid binary weight file (too short)');
    const view = new DataView(buffer);
    const b0 = view.getUint8(0), b1 = view.getUint8(1), b2 = view.getUint8(2), b3 = view.getUint8(3);
    if (b0 === 65 && b1 === 52 && b2 === 75 && b3 === 0) return parse_a4k(buffer);
    if (b0 === 88 && b1 === 52 && b2 === 86 && b3 === 0) return parse_x4v(buffer);
    throw new Error('Invalid binary weight file (bad magic): ' +
      [b0, b1, b2, b3].map(function(b){ return b.toString(16).padStart(2, '0'); }).join(' '));
  }

  self.parse_weights = parse_weights;
})();