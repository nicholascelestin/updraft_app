/**
 * Shared model definitions for the image and video upscaler features.
 * Single source of truth — all model <select> elements render from this list.
 */

export const UPSCALER_MODELS = [
  { url: 'models/1x-Kim2091-DeJpeg-v0.onnx', scale: 1, range: 1, label: 'Kim2091 DeJpeg', sizeMB: 9.2 },
  { url: 'models/1x-ITF-SkinDiffDetail-Lite-v1.onnx', scale: 1, range: 1, label: 'SkinDiffDetail Lite', sizeMB: 20 },

  { url: 'models/4x-UpdraftTiny.onnx', scale: 4, range: 255, label: 'Updraft Tiny (RMBN)', sizeMB: 0.6 },
  { url: 'models/4x-UpdraftLightweight.onnx', scale: 4, range: 255, label: 'Updraft Lightweight (SPAN-like)', sizeMB: 0.8 },
  { url: 'models/4x-UpdraftMidweight.onnx', scale: 4, range: 255, label: 'Updraft Midweight (SPAN-like)', sizeMB: 1.2 },
  // { url: 'models/4x-UpdraftLightweight_CHARB_L_S_203.onnx', scale: 4, range: 1, label: 'Updraft Midweight V3 CHARB LS 320 203k (SPAN-like)', sizeMB: 1.4 },
  // { url: 'models/UP_INV_19.onnx', scale: 4, range: 1, label: 'Up Inv 700k (SPAN-like)', sizeMB: 1.4, maxTileSize: 256 },
  // { url: 'models/apple.onnx', scale: 4, range: 1, label: 'Apple (SPAN-like)', sizeMB: 1.4, maxTileSize: 256 },
  // { url: 'models/cayenne.onnx', scale: 4, range: 1, label: 'Cayenne (SPAN-like)', sizeMB: 1.4, maxTileSize: 256 },
  // { url: 'models/banana.onnx', scale: 4, range: 1, label: 'Banana (SPAN-like)', sizeMB: 1.4, maxTileSize: 256 },






  { url: 'models/4x-ClearRealityV1.onnx', scale: 4, label: 'ClearReality (SPAN)', sizeMB: 1.8 },
  { url: 'models/4xPurePhoto-Span.onnx', scale: 4, label: 'PurePhoto (SPAN)', sizeMB: 1.7 },
  { url: 'models/DAT_light_x4_dyn.onnx', scale: 4, label: 'DAT Light Official (DAT-Light)', sizeMB: 5 },
  // { url: 'models/DAT_light_x4_dyn_OTF.onnx', scale: 4, label: 'DAT Light OTF 25k (DAT-Light)', sizeMB: 5 },
  // { url: 'models/DAT_light_x4_dyn_OTF_2.onnx', scale: 4, label: 'DAT Light OTF 50k (DAT-Light)', sizeMB: 5 },
  { url: 'models/DAT_light_x4_dyn_OTF_3.onnx', scale: 4, label: 'DAT Light Restore (DAT-Light OTF)', sizeMB: 5 },




  { url: 'models/4xPurePhoto-RealPLSKR.onnx', scale: 4, label: 'PurePhoto (RealPLKSR)', sizeMB: 30 },
  { url: 'models/4x-UltraSharpV2_Lite.onnx', scale: 4, label: 'UltraSharp V2 Lite (RealPLKSR)', sizeMB: 28 },
  { url: 'models/4x-UltraSharpV2.onnx', scale: 4, label: 'UltraSharp V2 (DAT)', sizeMB: 49 },
];

export const UPSCALER_RESAMPLER_MODELS = [
  { url: 'builtin:lanczos-4x', scale: 4, label: 'Lanczos' },
  { url: 'builtin:bicubic-4x', scale: 4, label: 'Bicubic' },
];

/**
 * Render <option> elements for a model <select>.
 * @param {typeof UPSCALER_MODELS} [models]
 * @param {{ selected?: string, includeResamplers?: boolean }} [opts]
 *   - `selected` is matched against model URL
 *   - `includeResamplers` appends built-in non-ONNX upscale methods
 */
export function modelOptionsHTML(models = UPSCALER_MODELS, { selected, includeResamplers = false } = {}) {
  const modelList = includeResamplers
    ? [...models, ...UPSCALER_RESAMPLER_MODELS]
    : models;

  return modelList.map(m => {
    const attrs = [
      `value="${m.url}"`,
      `data-scale="${m.scale}"`,
    ];
    if (m.range) attrs.push(`data-range="${m.range}"`);
    if (m.backend) attrs.push(`data-backend="${m.backend}"`);
    if (m.sizeMB != null) attrs.push(`data-sizemb="${m.sizeMB}"`);
    if (Number.isFinite(m.maxTileSize)) attrs.push(`data-maxtilesize="${m.maxTileSize}"`);
    // Default precision is fp32; only emit data-precision when the model is
    // fp16 so unannotated registry entries stay legible.
    if (m.precision === 'fp16') attrs.push(`data-precision="fp16"`);
    if (m.url === selected) attrs.push('selected');
    const sizeStr = m.sizeMB != null ? ` (~${m.sizeMB}MB)` : '';
    return `<option ${attrs.join(' ')}>${m.label}${sizeStr}</option>`;
  }).join('\n              ');
}
