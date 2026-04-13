/**
 * Shared model definitions for the image and video upscaler features.
 * Single source of truth — all model <select> elements render from this list.
 */

export const UPSCALER_MODELS = [
  { url: 'models/4x-UpdraftTiny.onnx', scale: 4, range: 255, label: 'Updraft Tiny (SPAN-like)' },
  { url: 'models/4x-UpdraftLightweight.onnx', scale: 4, range: 255, label: 'Updraft Lightweight (SPAN-like)' },
  { url: 'models/4x-UpdraftMidweight.onnx', scale: 4, range: 255, label: 'Updraft Midweight (SPAN-like)' },
  { url: 'models/4x-ClearRealityV1.onnx', scale: 4, backend: 'wasm', label: 'ClearReality (SPAN)' },
  { url: 'models/4x-UltraSharpV2_Lite.onnx', scale: 4, label: 'UltraSharp V2 Lite (RealPLKSR)' },
  { url: 'models/4x-UltraSharpV2.onnx', scale: 4, backend: 'wasm', label: 'UltraSharp V2 (DAT)' },
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
