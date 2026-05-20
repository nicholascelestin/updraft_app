/**
 * Shared model definitions for the image and video upscaler features.
 * Single source of truth — all model <select> elements render from this list.
 */

export const UPSCALER_MODELS = [
  { url: 'models/4x-UpdraftSmall.onnx', scale: 4, label: 'Updraft Small (Custom)', sizeMB: 1.4, multipleOf: 32 },
  { url: 'models/4x-ClearRealityV1.onnx', scale: 4, label: 'ClearReality (SPAN)', sizeMB: 1.9 },
  { url: 'models/DAT_light_x4_dyn_OTF_4.onnx', scale: 4, label: 'DAT Light Restore (DAT-Light OTF)', sizeMB: 5 },
  { url: 'models/4x-UltraSharpV2_Lite.onnx', scale: 4, label: 'UltraSharp V2 Lite (RealPLKSR)', sizeMB: 30 },
  { url: 'models/4x-UltraSharpV2.onnx', scale: 4, label: 'UltraSharp V2 (DAT)', sizeMB: 52 },
  { url: 'models/super.onnx', scale: 4, label: 'Apple Super 188k', sizeMB: 5.5, multipleOf: 32 },
  { url: 'models/super_2.onnx', scale: 4, label: 'Apple Super 2 202k', sizeMB: 5.5, multipleOf: 32 },
  { url: 'models/super_3.onnx', scale: 4, label: 'Apple Super 3 244k', sizeMB: 5.5, multipleOf: 32 },

  {
    url: 'models/tinysr_fused.onnx',
    scale: 4,
    label: 'TinySR (DiT refiner)',
    sizeMB: 687,
    multipleOf: 128,        // 128 LR × 4 = 512 HR (the fixed model input)
    maxTileSize: 128,       // same — every tile pads/crops to exactly 128 LR
    precision: 'fp16',
    upscaleBefore: true,
    tileBlend: 'gaussian',  // diffusion-style: hard-overlap shows seams
  }

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
    if (Number.isFinite(m.multipleOf) && m.multipleOf > 1) {
      attrs.push(`data-multipleof="${m.multipleOf}"`);
    }
    // Default precision is fp32; only emit data-precision when the model is
    // fp16 so unannotated registry entries stay legible.
    if (m.precision === 'fp16') attrs.push(`data-precision="fp16"`);
    // upscaleBefore=true marks HR-space refiners (e.g. fused diffusion SR
    // graphs). The engine bicubic-upsamples LR->HR before tiling so the
    // model sees HR pixel patches; multipleOf / maxTileSize stay in LR units.
    if (m.upscaleBefore) attrs.push(`data-upscalebefore="true"`);
    // tileBlend='gaussian' switches the tile stitcher to float32 Gaussian-
    // weighted accumulation (forces CPU readback path). Use for diffusion-
    // style models where the default half-overlap hard crop shows seams.
    if (m.tileBlend === 'gaussian') attrs.push(`data-tileblend="gaussian"`);
    if (m.url === selected) attrs.push('selected');
    const sizeStr = m.sizeMB != null ? ` (~${m.sizeMB}MB)` : '';
    return `<option ${attrs.join(' ')}>${m.label}${sizeStr}</option>`;
  }).join('\n              ');
}
