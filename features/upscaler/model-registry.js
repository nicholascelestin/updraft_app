// Built-in ONNX model catalog. Consumed only by SRModelStore at init.
// Custom models live in localStorage and flow through the same store.
// Resamplers (Lanczos, bicubic) are a different concept entirely and live
// in upscaler-controls.js where they're rendered into the model select.

export const UPSCALER_MODELS = [
  { url: 'models/4xPurePhoto-Span.onnx', scale: 4, label: 'PurePhoto-Span (Custom)', sizeMB: 1.7},
  { url: 'models/4x-UpdraftSmall_V2_fp16.onnx', scale: 4, label: 'Updraft Small (Custom)', sizeMB: 1.2, multipleOf: 32, precision: 'fp16' },
  { url: 'models/4x-ClearRealityV1_fp16.onnx', scale: 4, label: 'ClearReality (SPAN)', sizeMB: 1.0, precision: 'fp16' },
  { url: 'models/4x-UpdraftBig_fp16.onnx', scale: 4, label: 'Updraft Big (Custom)', sizeMB: 3.3, multipleOf: 32, precision: 'fp16' },
  { url: 'models/DAT_light_x4_dyn_OTF_4_fp16.onnx', scale: 4, label: 'DAT Light Restore (DAT-Light OTF)', sizeMB: 4.4, precision: 'fp16' },
  { url: 'models/4x-UltraSharpV2_Lite_fp16.onnx', scale: 4, label: 'UltraSharp V2 Lite (RealPLKSR)', sizeMB: 15, precision: 'fp16' },
  { url: 'models/4x-UltraSharpV2.onnx', scale: 4, label: 'UltraSharp V2 (DAT)', sizeMB: 52 },
  { url: 'models/no_red_8_fp16.onnx', scale: 4, label: 'No Reduction 8 FP16 500k (Custom)', sizeMB: 1.2 },
  { url: 'models/no_red_11_fp16.onnx', scale: 4, label: 'No Reduction 11 FP16 623k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_1_fp16.onnx', scale: 4, label: 'Yasss 1 FP16 500k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_2_fp16.onnx', scale: 4, label: 'Yasss 2 FP16 529k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_3_fp16.onnx', scale: 4, label: 'Yasss 3 FP16 550k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_4_fp16.onnx', scale: 4, label: 'Yasss 4 FP16 591k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_5_fp16.onnx', scale: 4, label: 'Yasss 5 FP16 575k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_6_fp16.onnx', scale: 4, label: 'Yasss 6 FP16 616k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_7_fp16.onnx', scale: 4, label: 'Yasss 7 FP16 650k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_8_fp16.onnx', scale: 4, label: 'Yasss 8 FP16 669k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_9_fp16.onnx', scale: 4, label: 'Yasss 9 FP16 710k (Custom)', sizeMB: 1.2 },
  // { url: 'models/yes_red_10_fp16.onnx', scale: 4, label: 'Yasss 10 FP16 750k (Custom)', sizeMB: 1.2 },
  { url: 'models/yes_red_11_fp16.onnx', scale: 4, label: 'Yasss 11 FP16 786k (Custom)', sizeMB: 1.2 },
  { url: 'models/yes_red_12_fp16.onnx', scale: 4, label: 'Yasss 12 FP16 811k (Custom)', sizeMB: 1.2 },
  { url: 'models/yes_red_13_fp16.onnx', scale: 4, label: 'Yasss 13 FP16 850k (Custom)', sizeMB: 1.2 },
  { url: 'models/yes_red_14_fp16.onnx', scale: 4, label: 'Yasss 14 FP16 900k (Custom)', sizeMB: 1.2 },
  { url: 'models/yes_red_15_fp16.onnx', scale: 4, label: 'Yasss 15 FP16 932k (Custom)', sizeMB: 1.2 },
  { url: 'models/yes_red_16_fp16.onnx', scale: 4, label: 'Yasss 16 FP16 843k (Custom)', sizeMB: 1.2 },
  { url: 'models/yes_red_17_fp16.onnx', scale: 4, label: 'Yasss 17 FP16 862k (Custom)', sizeMB: 1.2 },
  { url: 'models/yes_red_18_fp16.onnx', scale: 4, label: 'Yasss 18 FP16 893k (Custom)', sizeMB: 1.2 },
  { url: 'models/yes_red_19_fp16.onnx', scale: 4, label: 'Yasss 19 FP16 947k (Custom)', sizeMB: 1.2 },


  { url: 'models/adist_1.onnx', scale: 4, label: 'Adist 1 823k (Custom)', sizeMB: 1.2 },
  { url: 'models/adist_2.onnx', scale: 4, label: 'Adist 2 857k (Custom)', sizeMB: 1.2 },
  { url: 'models/adist_3.onnx', scale: 4, label: 'Adist 3 900k (Custom)', sizeMB: 1.2 },
  { url: 'models/adist_3.onnx', scale: 4, label: 'Adist 4 940k (Custom)', sizeMB: 1.2 },




  





  
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
