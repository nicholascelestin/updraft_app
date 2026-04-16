/**
 * Shared model definitions for the image and video upscaler features.
 * Single source of truth — all model <select> elements render from this list.
 */

export const UPSCALER_MODELS = [
  { url: 'models/1x-Kim2091-DeJpeg-v0.onnx', scale: 1, range: 1, label: 'Kim2091 DeJpeg', sizeMB: 9.2 },
  { url: 'models/2xParagonSR_Nano_gan_op18_fp32.onnx', scale: 2, range: 1, label: 'ParagonSR Nano GAN', sizeMB: 0.7 },
  { url: 'models/4x-UpdraftTiny.onnx', scale: 4, range: 255, label: 'Updraft Tiny (RMBN)', sizeMB: 0.6 },
  { url: 'models/4x-UpdraftLightweight.onnx', scale: 4, range: 255, label: 'Updraft Lightweight (SPAN-like)', sizeMB: 0.8 },
  { url: 'models/4x-UpdraftMidweight.onnx', scale: 4, range: 255, label: 'Updraft Midweight (SPAN-like)', sizeMB: 1.2 },
  // { url: 'models/4x-UpdraftMidweight_V2.onnx', scale: 4, range: 255, label: 'Updraft Midweight V2 (SPAN-like)', sizeMB: 1.4 },
  // { url: 'models/4x-UpdraftMidweight_V3.onnx', scale: 4, range: 255, label: 'Updraft Midweight V3 (SPAN-like)', sizeMB: 1.4 },
  // { url: 'models/4x-UpdraftMidweight_V4.onnx', scale: 4, range: 255, label: 'Updraft Midweight V4 (SPAN-like)', sizeMB: 1.4 },
  // { url: 'models/4x-UpdraftMidweight_V4_SOFT.onnx', scale: 4, range: 255, label: 'Updraft Midweight V4 Soft (SPAN-like)', sizeMB: 1.4 },
  // { url: 'models/4x-UpdraftMidweight_V5.onnx', scale: 4, range: 255, label: 'Updraft Midweight V5 (SPAN-like)', sizeMB: 1.4 },
  // { url: 'models/4x-UpdraftMidweight_V6.onnx', scale: 4, range: 255, label: 'Updraft Midweight V6 (SPAN-like)', sizeMB: 1.4 },
  // { url: 'models/4x-UpdraftMidweight_V7.onnx', scale: 4, range: 255, label: 'Updraft Midweight V7 (SPAN-like)', sizeMB: 1.4 },

  { url: 'models/4x-ClearRealityV1.onnx', scale: 4, label: 'ClearReality (SPAN)', sizeMB: 1.8 },
  { url: 'models/4xPurePhoto-Span.onnx', scale: 4, label: 'PurePhoto (SPAN)', sizeMB: 1.7 },
  { url: 'models/4xPurePhoto-RealPLSKR.onnx', scale: 4, label: 'PurePhoto (RealPLKSR)', sizeMB: 30 },
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
