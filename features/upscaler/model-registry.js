/**
 * Shared model definitions for the image and video upscaler features.
 * Single source of truth — all model <select> elements render from this list.
 */

export const UPSCALER_MODELS = [
  { url: 'models/RMBN_M4C8_x4.onnx', scale: 4, range: 255, label: '4x Lightweight M8C16 (RMBN)' },
  { url: 'models/RMBN_M4C8_FACES_x4.onnx', scale: 4, range: 255, label: '4x RMBN Faces (Face-tuned)' },
  { url: 'models/4x-ClearRealityV1.onnx', scale: 4, backend: 'wasm', label: '4x ClearReality V1 (SPAN)' },
  { url: 'models/4x-UltraSharpV2_Lite.onnx', scale: 4, label: '4x UltraSharp V2 Lite (RealPLKSR)' },
  { url: 'models/4x-UltraMix_Balanced.onnx', scale: 4, label: '4x UltraMix Balanced (ESRGAN)' },
];

/**
 * Render <option> elements for a model <select>.
 * @param {typeof UPSCALER_MODELS} [models]
 * @param {{ selected?: string }} [opts] — `selected` is matched against model URL
 */
export function modelOptionsHTML(models = UPSCALER_MODELS, { selected } = {}) {
  return models.map(m => {
    const attrs = [
      `value="${m.url}"`,
      `data-scale="${m.scale}"`,
    ];
    if (m.range) attrs.push(`data-range="${m.range}"`);
    if (m.backend) attrs.push(`data-backend="${m.backend}"`);
    if (m.url === selected) attrs.push('selected');
    return `<option ${attrs.join(' ')}>${m.label}</option>`;
  }).join('\n              ');
}
