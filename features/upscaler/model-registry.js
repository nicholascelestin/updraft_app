// Built-in ONNX model catalog. Consumed only by SRModelStore at init.
// Custom models live in localStorage and flow through the same store.
// Resamplers (Lanczos, bicubic) are a different concept entirely and live
// in upscaler-controls.js where they're rendered into the model select.

export const UPSCALER_MODELS = [
  { url: 'models/4xPurePhoto-Span_fp16_op17.onnx', scale: 4, label: 'PurePhoto (Span)', sizeMB: 0.8, precision: 'fp16' },
  { url: 'models/4x-ClearRealityV1_fp16.onnx', scale: 4, label: 'ClearReality (SPAN)', sizeMB: 1.0, precision: 'fp16' },
  { url: 'models/4x-UpdraftSmall_V3_fp16.onnx', scale: 4, label: 'Updraft Small V3 (Custom)', sizeMB: 1.3, multipleOf: 32, precision: 'fp16' },
  { url: 'models/DAT_light_x4_dyn_OTF_4_fp16.onnx', scale: 4, label: 'DAT Light Restore (DAT-L)', sizeMB: 4.4, precision: 'fp16' },
  { url: 'models/4x_IllustrationJaNai_V3detail_FDAT_M_40k_fp16_1x3xHxW_dyn-HW_op23.onnx', scale: 4, label: 'IllustrationJaNai (FDAT-M)', sizeMB: 8.7, multipleOf: 8, precision: 'fp16' },
  { url: 'models/4x-UltraSharpV2_Lite_fp16.onnx', scale: 4, label: 'UltraSharp V2 Lite (RealPLKSR)', sizeMB: 15, precision: 'fp16' },
  { url: 'models/4x-UltraSharpV2.onnx', scale: 4, label: 'UltraSharp V2 (DAT)', sizeMB: 52 },
  


  {
    url: 'models/tinysr_fused.onnx',
    scale: 4,
    label: 'TinySR (DiT refiner)',
    sizeMB: 687,
    multipleOf: 128,        
    maxTileSize: 128,       
    precision: 'fp16',
    upscaleBefore: true,
    tileBlend: 'gaussian',  // diffusion-style: hard-overlap shows seams
  },
];
