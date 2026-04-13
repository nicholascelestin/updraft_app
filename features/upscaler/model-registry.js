/**
 * Shared model definitions for the image and video upscaler features.
 * Single source of truth — all model <select> elements render from this list.
 */

export const UPSCALER_MODELS = [
  { url: 'models/4x-UpdraftTiny.onnx', scale: 4, range: 255, label: 'Updraft Tiny (RMBN)', sizeMB: 0.6 },
  { url: 'models/4x-UpdraftLightweight.onnx', scale: 4, range: 255, label: 'Updraft Lightweight (SPAN-like)', sizeMB: 0.8 },
  { url: 'models/4x-UpdraftMidweight.onnx', scale: 4, range: 255, label: 'Updraft Midweight (SPAN-like)', sizeMB: 1.2 },
  { url: 'models/4x-ClearRealityV1.onnx', scale: 4, label: 'ClearReality (SPAN)', sizeMB: 1.8 },
  { url: 'models/4x-UltraSharpV2_Lite.onnx', scale: 4, label: 'UltraSharp V2 Lite (RealPLKSR)', sizeMB: 28 },
  { url: 'models/4x-UltraSharpV2.onnx', scale: 4, label: 'UltraSharp V2 (DAT)', sizeMB: 49 },
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
    if (m.sizeMB != null) attrs.push(`data-sizemb="${m.sizeMB}"`);
    if (m.url === selected) attrs.push('selected');
    const sizeStr = m.sizeMB != null ? ` (~${m.sizeMB}MB)` : '';
    return `<option ${attrs.join(' ')}>${m.label}${sizeStr}</option>`;
  }).join('\n              ');
}
