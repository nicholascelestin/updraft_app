// Built-in ONNX model catalog. Consumed only by SRModelStore at init.
// Custom models live in localStorage and flow through the same store.
// Resamplers (Lanczos, bicubic) are a different concept entirely and live
// in upscaler-controls.js where they're rendered into the model select.

export const UPSCALER_MODELS = [
  // 4x_IllustrationJaNai_V3detail_FDAT_M_40k_fp16_1x3xHxW_dyn-HW_strong_bf16_op23_dynamo.onnx
  
  { url: 'models/2x_DIS_Balanced_Hermes_Live_Action_WebVideo_fp16_op20_172k.onnx', scale: 2, label: 'LiveAction (Span)', sizeMB: 0.5, precision: 'fp16' },
  { url: 'models/4xPurePhoto-Span_fp16_op17.onnx', scale: 4, label: 'PurePhoto (Span)', sizeMB: 0.8, precision: 'fp16' },
  { url: 'models/4x-ClearRealityV1_fp16.onnx', scale: 4, label: 'ClearReality (SPAN)', sizeMB: 1.0, precision: 'fp16' },
  { url: 'models/DAT_light_x4_dyn_OTF_4_fp16.onnx', scale: 4, label: 'DAT Light Restore (DAT-Light OTF)', sizeMB: 4.4, precision: 'fp16' },
  { url: 'models/4x_IllustrationJaNai_V3detail_FDAT_M_40k_fp16_1x3xHxW_dyn-HW_op23.onnx', scale: 4, label: 'IllustrationJaNai (FDAT-M)', sizeMB: 8.7, multipleOf: 8, precision: 'fp16' },
  { url: 'models/4x-UltraSharpV2_Lite_fp16.onnx', scale: 4, label: 'UltraSharp V2 Lite (RealPLKSR)', sizeMB: 15, precision: 'fp16' },
  { url: 'models/4x-UltraSharpV2.onnx', scale: 4, label: 'UltraSharp V2 (DAT)', sizeMB: 52 },
  { url: 'models/4x-UpdraftSmall_V3_BASE_fp16.onnx', scale: 4, label: 'Updraft Small Base (Custom)', sizeMB: 1.3, multipleOf: 32, precision: 'fp16' },
  { url: 'models/4x-UpdraftSmall_V3_GAN_fp16.onnx', scale: 4, label: 'Updraft Small GAN (Custom)', sizeMB: 1.3, multipleOf: 32, precision: 'fp16' },

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
