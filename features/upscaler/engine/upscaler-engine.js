/**
 * UpscalerEngine — tiled ONNX super-resolution inference.
 * Downloads a model, creates a session, runs tiled inference on images.
 * Uses Canvas 2D for pixel I/O in the WASM/WebGL path; GPU paths avoid readback.
 */

import { fetchWithProgress } from 'lib/fetch-progress';
import { GpuTileRenderer, GpuOutputTooLargeError } from './gpu-tile-renderer.js';
import { GpuFrameExtractor } from './gpu-frame-extractor.js';
import {
  buildTileGrid,
  pasteTileCropped,
  overlapCrop,
  makeGaussianWeights2D,
  accumulateGaussianTile,
  finalizeGaussianRegion,
} from './tiling.js';
import { readMetaEntry, isFp16InputType } from 'lib/onnx-meta';
import { dispatchBackendEvent } from 'lib/backend-events';
import { loadSession } from 'lib/backend';

const DEFAULT_SCALE = 4;
const DEFAULT_OVERLAP = 16;

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
}

// Normalize the various aliases the caller might pass for backend intent.
// New code should pass 'gpu' or 'cpu' directly; the legacy ORT-Web strings
// 'webgpu' and 'wasm' are still accepted so a half-migrated UI keeps working.
function normalizeIntent(value) {
  if (value === 'webgpu' || value === 'gpu') return 'gpu';
  if (value === 'wasm'   || value === 'cpu') return 'cpu';
  return 'cpu';
}

function yieldToEventLoop() {
  return new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = resolve;
    ch.port2.postMessage(undefined);
  });
}

function clampCoord(v, max) {
  if (v < 0) return 0;
  if (v > max) return max;
  return v;
}

/**
 * Extract a tile from ImageData as Float32 in CHW layout
 * (channels-first: [R plane, G plane, B plane]), with edge replication padding.
 *
 * @param {number} valueScale - multiply each pixel byte by this (e.g. 1/255 for [0,1] output)
 */
function extractTileNCHW(imageData, tx, ty, tw, th, padW, padH, valueScale) {
  const { data, width } = imageData;
  const out = new Float32Array(3 * padH * padW);
  const planeSize = padH * padW;
  const maxX = tx + tw - 1;
  const maxY = ty + th - 1;
  for (let row = 0; row < padH; row++) {
    for (let col = 0; col < padW; col++) {
      const srcX = clampCoord(tx + col, maxX);
      const srcY = clampCoord(ty + row, maxY);
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = row * padW + col;
      out[dstIdx]                 = data[srcIdx]     * valueScale;
      out[planeSize + dstIdx]     = data[srcIdx + 1] * valueScale;
      out[2 * planeSize + dstIdx] = data[srcIdx + 2] * valueScale;
    }
  }
  return out;
}

/**
 * Extract a tile from ImageData as Float32 in HWC layout
 * (channels-last: [R,G,B, R,G,B, ...]), with edge replication padding.
 */
function extractTileNHWC(imageData, tx, ty, tw, th, padW, padH, valueScale) {
  const { data, width } = imageData;
  const out = new Float32Array(padH * padW * 3);
  const maxX = tx + tw - 1;
  const maxY = ty + th - 1;
  for (let row = 0; row < padH; row++) {
    for (let col = 0; col < padW; col++) {
      const srcX = clampCoord(tx + col, maxX);
      const srcY = clampCoord(ty + row, maxY);
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (row * padW + col) * 3;
      out[dstIdx] = data[srcIdx] * valueScale;
      out[dstIdx + 1] = data[srcIdx + 1] * valueScale;
      out[dstIdx + 2] = data[srcIdx + 2] * valueScale;
    }
  }
  return out;
}

/**
 * Convert CHW float32 data (channels-first: [R plane, G plane, B plane])
 * back into an RGBA ImageData. Inverse of extractTileCHW.
 *
 * @param {number} valueScale - multiply each CHW value by this to get [0,255] bytes
 */
function chwToImageData(chwData, width, height, valueScale) {
  const imgData = new ImageData(width, height);
  const px = imgData.data;
  const planeSize = width * height;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const srcIdx = row * width + col;
      const dstIdx = srcIdx * 4;
      px[dstIdx]     = clampByte(chwData[srcIdx] * valueScale);
      px[dstIdx + 1] = clampByte(chwData[planeSize + srcIdx] * valueScale);
      px[dstIdx + 2] = clampByte(chwData[2 * planeSize + srcIdx] * valueScale);
      px[dstIdx + 3] = 255;
    }
  }
  return imgData;
}

/**
 * Convert HWC float32 data (channels-last: [R,G,B, R,G,B, …] per pixel)
 * into an RGBA ImageData. Used when the WebGPU EP returns NHWC-ordered output.
 */
function hwcToImageData(hwcData, width, height, valueScale) {
  const imgData = new ImageData(width, height);
  const px = imgData.data;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const srcIdx = (row * width + col) * 3;
      const dstIdx = (row * width + col) * 4;
      px[dstIdx]     = clampByte(hwcData[srcIdx]     * valueScale);
      px[dstIdx + 1] = clampByte(hwcData[srcIdx + 1] * valueScale);
      px[dstIdx + 2] = clampByte(hwcData[srcIdx + 2] * valueScale);
      px[dstIdx + 3] = 255;
    }
  }
  return imgData;
}

// ---------------------------------------------------------------------------
// fp16 packing — ORT-Web fp16 tensors take/return a Uint16Array of IEEE-754
// binary16 bit patterns. We use the platform's Float16Array when available
// (Chromium 122+, Safari 18.2+) and fall back to a manual packer otherwise.
// fp16 only kicks in when the model is declared fp16; everything else stays
// fp32 with no extra work.
// ---------------------------------------------------------------------------

const HAS_NATIVE_FLOAT16 = typeof globalThis.Float16Array === 'function';

function packFloat32ToFloat16Bits(f32) {
  if (HAS_NATIVE_FLOAT16) {
    const f16 = new globalThis.Float16Array(f32);
    return new Uint16Array(f16.buffer, f16.byteOffset, f16.length);
  }
  const out = new Uint16Array(f32.length);
  // f32arr is a Float32Array; reinterpret as Uint32 to read bit fields.
  const u32 = new Uint32Array(f32.buffer, f32.byteOffset, f32.length);
  for (let i = 0; i < f32.length; i++) {
    const x = u32[i];
    const sign = (x >>> 16) & 0x8000;
    const expRaw = (x >>> 23) & 0xff;
    const mantissa = x & 0x7fffff;
    let exp = expRaw - 127 + 15;
    if (expRaw === 0xff) {
      out[i] = sign | 0x7c00 | (mantissa ? 0x200 : 0);
    } else if (exp >= 31) {
      out[i] = sign | 0x7c00;
    } else if (exp <= 0) {
      if (exp < -10) {
        out[i] = sign;
      } else {
        const m = mantissa | 0x800000;
        out[i] = sign | (m >>> (14 - exp));
      }
    } else {
      out[i] = sign | (exp << 10) | (mantissa >>> 13);
    }
  }
  return out;
}

function unpackFloat16BitsToFloat32(u16) {
  if (HAS_NATIVE_FLOAT16) {
    const f16 = new globalThis.Float16Array(u16.buffer, u16.byteOffset, u16.length);
    return new Float32Array(f16);
  }
  const out = new Float32Array(u16.length);
  const u32 = new Uint32Array(out.buffer);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i];
    const sign = (h & 0x8000) << 16;
    const exp = (h >> 10) & 0x1f;
    const mantissa = h & 0x3ff;
    if (exp === 0) {
      if (mantissa === 0) {
        u32[i] = sign;
      } else {
        let e = -14;
        let m = mantissa;
        while (!(m & 0x400)) { m <<= 1; e--; }
        m &= 0x3ff;
        u32[i] = sign | ((e + 127) << 23) | (m << 13);
      }
    } else if (exp === 0x1f) {
      u32[i] = sign | 0x7f800000 | (mantissa << 13);
    } else {
      u32[i] = sign | ((exp - 15 + 127) << 23) | (mantissa << 13);
    }
  }
  return out;
}

// TODO(ort-web): remove this whole block when ORT-Web fixes
// program-manager.ts normalizeDispatchGroupSize, which today does a lossy
// rewrite of dispatch shape (X, 1, 1) → (sqrt(X), sqrt(X), 1) and breaks
// the (X=col, Y=row) contract Conv2DMatMul and MatMul shaders expect.
//
// What goes wrong: ORT reshuffles whenever X > maxComputeWorkgroupsPerDimension
// (65535). Conv2DMatMul/MatMul then treat the synthesised Y as a row-tile
// index, the row-bounds guard rejects ~99% of writes, and the output
// buffer is left mostly uninitialised — visible as scrambled output for
// any model whose post-PixelShuffle activation has H*W > ~2.1M pixels.
//
// Workaround: monkey-patch device.createShaderModule to recover the
// effective column from both workgroup ids when dim_a_outer is small
// enough that the original dispatch Y was 1.

const WGPU_DISPATCH_FIX_INSTALLED = Symbol.for('updraft.wgslDispatchOverflowFix');

const CONV2D_MM_FIND =
  'let globalRowStart = i32(workgroupId.y) * 32;\n' +
  '    let globalColStart = i32(workgroupId.x) * 32;';
const CONV2D_MM_REPLACE =
  'let p_isSmallA = uniforms.dim_a_outer <= 32;\n' +
  '    let p_totalCols = (u32(uniforms.dim_b_outer) + 31u) / 32u;\n' +
  '    let p_dispatchX = u32(ceil(sqrt(f32(p_totalCols))));\n' +
  '    let p_effectiveCol = workgroupId.x + workgroupId.y * p_dispatchX;\n' +
  '    let globalRowStart = select(i32(workgroupId.y) * 32, 0, p_isSmallA);\n' +
  '    let globalColStart = select(i32(workgroupId.x) * 32, i32(p_effectiveCol) * 32, p_isSmallA);';

const MATMUL_FIND =
  'let globalRow =i32(globalId.y) * rowPerThread;\n' +
  '  let globalCol = i32(globalId.x);';
const MATMUL_REPLACE =
  'let p_isSmallA = uniforms.dim_a_outer <= 8;\n' +
  '  let p_totalVecCols = (u32(uniforms.dim_b_outer) + 31u) / 32u;\n' +
  '  let p_dispatchX = u32(ceil(sqrt(f32(p_totalVecCols))));\n' +
  '  let p_effectiveWgX = workgroupId.x + workgroupId.y * p_dispatchX;\n' +
  '  let globalRow = select(i32(globalId.y) * rowPerThread, i32(localId.y) * rowPerThread, p_isSmallA);\n' +
  '  let globalCol = select(i32(globalId.x), i32(p_effectiveWgX) * 8 + i32(localId.x), p_isSmallA);';

function patchWGSLForDispatchOverflow(code, label) {
  if (label === 'Conv2DMatMul' && code.includes(CONV2D_MM_FIND)) {
    return code.split(CONV2D_MM_FIND).join(CONV2D_MM_REPLACE);
  }
  if (label === 'MatMul' && code.includes(MATMUL_FIND)) {
    return code.split(MATMUL_FIND).join(MATMUL_REPLACE);
  }
  return code;
}

function installWebGPUDispatchFix(device) {
  if (!device || device[WGPU_DISPATCH_FIX_INSTALLED]) return false;
  const origCreate = device.createShaderModule.bind(device);
  device.createShaderModule = (descriptor) => {
    const patched = patchWGSLForDispatchOverflow(descriptor.code, descriptor.label || '');
    if (patched === descriptor.code) return origCreate(descriptor);
    return origCreate({ ...descriptor, code: patched });
  };
  device[WGPU_DISPATCH_FIX_INSTALLED] = true;
  return true;
}

export class UpscalerEngine {
  #session = null;
  #modelBuffer = null;
  #modelUrl;
  #scale;
  #overlap;
  #modelValueRange;
  #modelLayout;
  #modelInputMultiple;
  #modelPrecision;
  #upscaleBefore;
  #tileBlend;
  #profiling = false;
  // What the user actually got: a label like 'web-webgpu', 'web-wasm',
  // 'native-coreml/MLProgram', 'native-cpu'. Set by loadSession on every
  // successful load AND kept current by #backendListener for the rest of
  // the session — without that, runtime EP fallbacks (e.g. native worker
  // drops from CoreML to CPU mid-tile) would leave it stale and the
  // loadModel early-return path would mis-announce on the next run.
  #realizedBackend = null;
  #backendListener = null;
  // What the caller asked for ('gpu' | 'cpu'). The loadModel short-circuit
  // keys off this so the engine doesn't pointlessly reload when the user
  // re-runs with the same intent.
  #intent = null;
  #device = null;
  #gpuRenderer = null;
  #gpuExtractor = null;

  constructor({
    modelUrl,
    scale = DEFAULT_SCALE,
    overlap = DEFAULT_OVERLAP,
    modelValueRange = 1,
    modelLayout = 'nchw',
    modelInputMultiple = 1,
    modelPrecision = 'fp32',
    // upscaleBefore=true: the model operates in HR pixel space (e.g. a
    // refiner that takes a pre-upsampled LR image and returns an HR image
    // at the SAME resolution). Tile coordinates and modelInputMultiple
    // stay in LR-pixel units (consistent with regular SR models advertised
    // with scale > 1); the engine bicubic-upsamples LR->HR before tile
    // extraction and multiplies extraction coords by `scale` so the
    // backend sees HR tensors. All GPU fast paths remain viable — they're
    // coordinate-agnostic.
    upscaleBefore = false,
    // tileBlend='gaussian' replaces the default half-overlap hard crop
    // with float32 Gaussian-weighted accumulation. Use for diffusion-
    // style models with visible tile seams. Costs ~16 bytes/HR-pixel
    // working memory and forces the CPU readback path (the GPU output
    // renderer writes directly to the bgra8unorm canvas surface, which
    // can't host the float32 accumulator).
    tileBlend = 'overlapCrop',
    profile = false,
  }) {
    this.#modelUrl = modelUrl;
    this.#scale = scale;
    this.#overlap = overlap;
    this.#modelValueRange = modelValueRange;
    this.#modelLayout = modelLayout === 'nhwc' ? 'nhwc' : 'nchw';
    this.#modelInputMultiple = Number.isFinite(modelInputMultiple) ? Math.max(1, Math.floor(modelInputMultiple)) : 1;
    this.#modelPrecision = modelPrecision === 'fp16' ? 'fp16' : 'fp32';
    this.#upscaleBefore = !!upscaleBefore;
    this.#tileBlend = tileBlend === 'gaussian' ? 'gaussian' : 'overlapCrop';
    this.#profiling = profile;
  }

  get scale() { return this.#scale; }
  // The realized backend label (e.g. 'web-webgpu', 'native-coreml/MLProgram').
  // For UI display via friendlyBackend; not used for identity checks.
  get realizedBackend() { return this.#realizedBackend; }
  // The user's load intent ('gpu' | 'cpu'). EnginePool and loadModel both
  // key off this for "do we already have the right session?" decisions.
  get intent() { return this.#intent; }
  get isLoaded() { return this.#session !== null; }
  get profiling() { return this.#profiling; }
  set profiling(v) { this.#profiling = !!v; }
  get modelPrecision() { return this.#modelPrecision; }

  async loadModel(intent = 'cpu', onProgress) {
    if (onProgress != null && typeof onProgress !== 'function') {
      console.warn('[UpscalerEngine] Ignoring non-function onProgress callback.', {
        type: typeof onProgress,
        value: onProgress,
        intent,
      });
    }
    intent = normalizeIntent(intent);
    const report = typeof onProgress === 'function' ? onProgress : null;
    if (this.#session && this.#intent === intent) {
      // Reusing the existing session; re-announce so per-run backend
      // trackers (status bar's "Done via X" line) record a success this run.
      if (this.#realizedBackend) {
        dispatchBackendEvent({ kind: 'success', backend: this.#realizedBackend });
      }
      return;
    }
    this.#releaseSession();

    if (!this.#modelBuffer) {
      this.#modelBuffer = await fetchWithProgress(this.#modelUrl, report);
    }

    report?.(1, 'Loading model into runtime\u2026');

    // The GPU fast paths (zero-copy input extract via GpuFrameExtractor and
    // zero-readback output render via GpuTileRenderer) both assume fp32
    // storage buffers in their WGSL shaders. fp16 models go through the
    // standard CPU readback path: ONNX still runs on the GPU, but the tile
    // tensors round-trip through the CPU as Uint16 bit patterns. We make the
    // initial decision from the configured precision, then re-validate after
    // the session is created (the model's declared input dtype is the source
    // of truth — see comment below).
    let canUseGpuFastPath =
      this.#modelPrecision !== 'fp16' &&
      this.#modelLayout === 'nchw' &&
      this.#modelInputMultiple === 1;
    const sessionLoadOpts = { profile: this.#profiling };
    if (intent === 'gpu' && canUseGpuFastPath) {
      sessionLoadOpts.preferredOutputLocation = 'gpu-buffer';
    }
    // ORT's graph optimizer fuses Conv + PReLU pairs into com.microsoft.FusedConv,
    // but the WebGPU EP only registers a FusedConv kernel for fp32 — not fp16.
    // The fusion pass runs anyway and produces an unrunnable node on fp16
    // graphs; the whole session-load then fails and the engine falls back to
    // WASM. Setting graphOptimizationLevel='disabled' stops the fusion entirely
    // and lets Conv + PReLU run as separate fp16-supported kernels.
    if (this.#modelPrecision === 'fp16') {
      sessionLoadOpts.graphOptimizationLevel = 'disabled';
    }

    // loadSession picks between native (desktop bridge) and web (ort-web)
    // based on whether __nativeOrt is exposed; it dispatches its own
    // attempt/fallback/success backend-events so we don't need to here.
    const { session, realizedBackend } = await loadSession(this.#modelBuffer, intent, sessionLoadOpts);
    this.#session = session;
    this.#intent = intent;
    this.#realizedBackend = realizedBackend;
    this.#trackRealizedBackend();

    // Self-correct modelPrecision from the model's declared input dtype.
    // Stale custom-model records (e.g. uploaded before fp16 support existed,
    // or before the inspector started reading the right metadata field)
    // can carry the wrong precision; the model graph itself doesn't lie.
    // Without this, the engine would build fp32 tensors for an fp16 model
    // and ORT would throw "Unexpected input data type" at the first run.
    const sessionInputName = this.#session.inputNames?.[0];
    const sessionInMeta = readMetaEntry(this.#session.inputMetadata, sessionInputName, 0);
    const declaredInputType = sessionInMeta?.type;
    const detectedPrecision = isFp16InputType(declaredInputType)
      ? 'fp16'
      : 'fp32';
    if (detectedPrecision !== this.#modelPrecision) {
      console.warn(
        `[UpscalerEngine] Configured precision (${this.#modelPrecision}) disagrees with the model's declared input dtype (${declaredInputType}); using ${detectedPrecision}. ` +
        `If this is a saved custom model, edit it and set Precision = ${detectedPrecision} to make this explicit.`,
      );
      this.#modelPrecision = detectedPrecision;
      canUseGpuFastPath =
        this.#modelPrecision !== 'fp16' &&
        this.#modelLayout === 'nchw' &&
        this.#modelInputMultiple === 1;
    }

    if (this.#realizedBackend === 'web-webgpu') {
      const ort = globalThis.ort;
      try {
        this.#device = await ort.env.webgpu.device;
        // installWebGPUDispatchFix is idempotent across model loads. If we
        // install it here for the first time, the just-created session's
        // shader modules were compiled by ORT-Web BEFORE the wrapper
        // existed — release and recreate so all shaders go through it now.
        if (installWebGPUDispatchFix(this.#device)) {
          await this.#session.release();
          const reloaded = await loadSession(this.#modelBuffer, intent, sessionLoadOpts);
          this.#session = reloaded.session;
          this.#realizedBackend = reloaded.realizedBackend;
        }
        if (canUseGpuFastPath) {
          this.#gpuRenderer = new GpuTileRenderer(this.#device);
        }
        if (canUseGpuFastPath && typeof ort.Tensor.fromGpuBuffer === 'function') {
          this.#gpuExtractor = new GpuFrameExtractor(this.#device);
        }
      } catch (err) {
        console.warn('[UpscalerEngine] GPU pipeline init failed, using CPU fallback:', err);
        this.#device = null;
        this.#gpuRenderer = null;
        this.#gpuExtractor = null;
      }
    }

    this.#modelBuffer = null;
    report?.(1, 'Model loaded.');
  }

  async upscale(img, tileSize, { onTile, signal } = {}) {
    if (!this.#session) throw new Error('Model not loaded — call loadModel() first');

    const perf = {
      setup: 0,
      extract: 0,
      inference: 0,
      inferenceEstimated: 0,
      readback: 0,
      gpuRender: 0,
      writeTile: 0,
      dispose: 0,
      total: 0,
    };
    const tTotal = performance.now();

    const scale = this.#scale;
    const overlap = this.#overlap;
    const srcW = img.videoWidth ?? img.width;
    const srcH = img.videoHeight ?? img.height;
    const outW = srcW * scale;
    const outH = srcH * scale;
    const gaussianBlend = this.#tileBlend === 'gaussian';
    // The GPU output renderer writes via fragment shader directly to the
    // canvas's bgra8unorm surface, so it can't host the float32
    // accumulator Gaussian blending needs. Force the CPU readback path.
    let useGpu = this.#gpuRenderer !== null && !gaussianBlend;
    const useGpuInput = this.#gpuExtractor !== null;

    // In upscaleBefore mode the model takes HR-sized tiles, so we
    // multiply all input-side tile coords/dims by `scale`. The output
    // side already uses HR coords (tx*scale, outTW=tw*scale, …) for
    // every model, so the GPU output renderer needs no changes.
    const pixelScale = this.#upscaleBefore ? scale : 1;

    // Gaussian accumulator buffers + a per-tile-size weight cache. The
    // accumRGB stores values in [0, 255] before clamping (matching what
    // the existing chwToImageData decoder produces), so finalize can do
    // a single divide+clamp+pack pass.
    const accumRGB = gaussianBlend ? new Float32Array(3 * outW * outH) : null;
    const accumW = gaussianBlend ? new Float32Array(outW * outH) : null;
    const gaussWeightCache = gaussianBlend ? new Map() : null;

    // The WebGPU canvas surface and the renderer's persistent output texture
    // are both bounded by maxTextureDimension2D (commonly 8192, sometimes
    // 16384). Exceeding this cap doesn't throw — WebGPU pushes a validation
    // error and the canvas stays black — so we proactively fall back to the
    // CPU readback path whenever the destination is too big. ONNX inference
    // continues to run on WebGPU; only the output rendering path changes.
    if (useGpu) {
      const maxDim = this.#device?.limits?.maxTextureDimension2D ?? 8192;
      if (outW > maxDim || outH > maxDim) {
        console.info(
          `[UpscalerEngine] Output ${outW}\u00d7${outH} exceeds GPU max texture dimension ${maxDim}; using CPU readback path for this image.`,
        );
        useGpu = false;
      }
    }

    // For upscaleBefore models, pre-rasterize an HR bicubic upsample on
    // a 2D canvas and use that as the source for tile extraction. The
    // GPU extractor and CPU getImageData paths both accept any canvas;
    // they just see a larger texture/ImageData with HR coordinates.
    let extractImg = img;
    let extractW = srcW;
    let extractH = srcH;
    if (this.#upscaleBefore) {
      const hrCanvas = document.createElement('canvas');
      hrCanvas.width = outW;
      hrCanvas.height = outH;
      const hrCtx = hrCanvas.getContext('2d');
      hrCtx.imageSmoothingEnabled = true;
      hrCtx.imageSmoothingQuality = 'high';
      hrCtx.drawImage(img, 0, 0, outW, outH);
      extractImg = hrCanvas;
      extractW = outW;
      extractH = outH;
    }

    const srcData = this.#prepareSource(extractImg, extractW, extractH, useGpuInput, perf);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;

    let outCtx = null;
    if (useGpu) {
      try {
        this.#gpuRenderer.configure(outCanvas, outW, outH);
      } catch (err) {
        if (err instanceof GpuOutputTooLargeError) {
          console.info(
            `[UpscalerEngine] ${err.message} Using CPU readback path for this image.`,
          );
        } else {
          console.warn(
            '[UpscalerEngine] GPU canvas configure failed, falling back to CPU readback:',
            err,
          );
        }
        useGpu = false;
      }
    }
    if (!useGpu) {
      outCtx = outCanvas.getContext('2d');
    }

    const tiles = buildTileGrid(srcW, srcH, tileSize, overlap);

    const inputName = this.#session.inputNames[0];
    const outputName = this.#session.outputNames[0];

    if (this.#profiling) try { this.#session.startProfiling(); } catch {}

    let firstInferAt = 0;
    let callbackMs = 0;
    let yieldMs = 0;
    for (let i = 0; i < tiles.length; i++) {
      if (signal?.aborted) throw new DOMException('Upscale cancelled', 'AbortError');
      const rendererLost = useGpu && this.#gpuRenderer?.lost;
      const extractorLost = useGpuInput && this.#gpuExtractor?.lost;
      if (rendererLost || extractorLost) {
        throw new Error('GPU device was lost (browser or OS interrupted). Please retry or switch to the WASM backend.');
      }

      const { x: tx, y: ty, w: tw, h: th } = tiles[i];

      const paddedTW = this.#alignToMultiple(tw);
      const paddedTH = this.#alignToMultiple(th);
      const tExtract = performance.now();
      // In upscaleBefore mode the source canvas is HR-sized, so extraction
      // coords/dims scale up. Equality checks against the LR-side padded
      // values are unaffected (both sides scale by the same factor).
      const tensor = this.#createTileTensor(
        srcData,
        tx * pixelScale,
        ty * pixelScale,
        tw * pixelScale,
        th * pixelScale,
        paddedTW * pixelScale,
        paddedTH * pixelScale,
        useGpuInput && paddedTW === tw && paddedTH === th,
      );
      const extractMs = performance.now() - tExtract;
      perf.extract += extractMs;

      const tInfer = performance.now();
      if (!firstInferAt) firstInferAt = tInfer;
      const results = await this.#session.run({ [inputName]: tensor });
      const inferenceMs = performance.now() - tInfer;
      perf.inference += inferenceMs;

      const outTW = tw * scale;
      const outTH = th * scale;
      const outPaddedTW = paddedTW * scale;
      const outPaddedTH = paddedTH * scale;
      let renderMs = 0, readbackMs = 0;

      if (useGpu && outPaddedTW === outTW && outPaddedTH === outTH) {
        const tGpu = performance.now();
        this.#gpuRenderer.renderTile(
          results[outputName].gpuBuffer, outTW, outTH,
          tx * scale, ty * scale, overlap * scale, 1 / this.#modelValueRange,
        );
        this.#gpuRenderer.presentToCanvas();
        renderMs = performance.now() - tGpu;
        perf.gpuRender += renderMs;
      } else {
        const tReadback = performance.now();
        const outTensor = results[outputName];
        // When the session was opened with preferredOutputLocation:'gpu-buffer'
        // (gpu fast path enabled at load time) but we're falling back per-image
        // because the destination canvas would exceed maxTextureDimension2D,
        // the tensor lives on the GPU and `.data` is empty. getData(true)
        // downloads the data and releases the GPU buffer in one step.
        const rawOutData = outTensor.location === 'gpu-buffer'
          ? await outTensor.getData(true)
          : outTensor.data;
        // fp16 output tensors expose a Uint16Array of bit patterns; unpack
        // to Float32 once so the existing CHW/HWC decoders can stay fp32.
        const outData = outTensor.type === 'float16'
          ? unpackFloat16BitsToFloat32(rawOutData)
          : rawOutData;
        readbackMs = performance.now() - tReadback;
        perf.readback += readbackMs;

        const tWrite = performance.now();
        const dims = outTensor.dims;
        const isNHWC = dims.length === 4 && dims[3] === 3 && dims[1] !== 3;
        if (gaussianBlend) {
          // Look up / build the weight kernel for this tile's HR-side
          // content dimensions (outTH, outTW). Edge tiles can be smaller
          // than interior tiles; cache by key.
          const key = `${outTH}x${outTW}`;
          let weights = gaussWeightCache.get(key);
          if (!weights) {
            weights = makeGaussianWeights2D(outTH, outTW);
            gaussWeightCache.set(key, weights);
          }
          const valueScale = 255 / this.#modelValueRange;
          accumulateGaussianTile(
            accumRGB, accumW, outW, outH,
            outData, outPaddedTW, outPaddedTH,
            outTW, outTH, tx * scale, ty * scale,
            weights, valueScale, isNHWC ? 'hwc' : 'chw',
          );
          // Finalize just the rectangle this tile touched so the user
          // sees progressive preview. Overlapping tiles will rewrite
          // their shared region as they accumulate; the last tile to
          // touch a pixel writes the same value a final full-canvas
          // finalize would.
          finalizeGaussianRegion(
            outCtx, tx * scale, ty * scale, outTW, outTH,
            outW, outH, accumRGB, accumW,
          );
        } else {
          const decode = isNHWC ? hwcToImageData : chwToImageData;
          const paddedImgData = decode(outData, outPaddedTW, outPaddedTH, 255 / this.#modelValueRange);
          const imgData = outPaddedTW === outTW && outPaddedTH === outTH
            ? paddedImgData
            : this.#cropImageData(paddedImgData, outTW, outTH);
          pasteTileCropped(outCtx, imgData, tx * scale, ty * scale, outW, outH, overlap * scale);
        }
        renderMs = performance.now() - tWrite;
        perf.writeTile += renderMs;
      }

      const tDispose = performance.now();
      tensor.dispose();
      results[outputName].dispose();
      const disposeMs = performance.now() - tDispose;
      perf.dispose += disposeMs;

      const crop = overlapCrop(tx * scale, ty * scale, outTW, outTH, outW, outH, overlap * scale);
      const tCallback = performance.now();
      onTile?.({
        index: i, total: tiles.length, tileMs: inferenceMs, tilePixels: tw * th,
        canvas: outCanvas, outX: tx * scale, outY: ty * scale, outW: outTW, outH: outTH,
        crop,
        perf: { extractMs, inferenceMs, readbackMs, renderMs, disposeMs },
      });
      callbackMs += performance.now() - tCallback;

      const tYield = performance.now();
      await yieldToEventLoop();
      yieldMs += performance.now() - tYield;
    }

    if (useGpu) {
      this.#gpuRenderer.presentToCanvas();
      await this.#waitForGpuWork();
    }

    const tDone = performance.now();
    perf.total = tDone - tTotal;
    if (useGpu && firstInferAt) {
      const gpuSpanMs = tDone - firstInferAt;
      const otherTrackedMs =
        perf.extract +
        perf.gpuRender +
        perf.readback +
        perf.writeTile +
        perf.dispose +
        callbackMs +
        yieldMs;
      perf.inferenceEstimated = Math.max(0, gpuSpanMs - otherTrackedMs);
    }

    let ortProfile = null;
    if (this.#profiling) {
      ortProfile = this.#collectOrtProfile();
    }

    // 'gpu-gpu' = GPU input extract + GPU output render (zero readback).
    // 'gpu'     = ONNX runs on GPU but at least one of input/output uses CPU
    //             (e.g., per-image fallback when output exceeds maxTexDim).
    // 'cpu'     = WASM/CPU end-to-end.
    const pipeline = useGpu && useGpuInput
      ? 'gpu-gpu'
      : (useGpu || useGpuInput) ? 'gpu' : 'cpu';
    return {
      canvas: outCanvas,
      perf: { ...perf, tiles: tiles.length, tileSize, srcW, srcH, outW, outH, pipeline },
      ortProfile,
    };
  }

  destroy() {
    this.#releaseSession();
    this.#modelBuffer = null;
  }

  #releaseSession() {
    this.#untrackRealizedBackend();
    this.#gpuRenderer?.destroy();
    this.#gpuRenderer = null;
    this.#gpuExtractor?.destroy();
    this.#gpuExtractor = null;
    this.#device = null;
    try { this.#session?.release(); } catch {}
    this.#session = null;
    this.#realizedBackend = null;
    this.#intent = null;
  }

  // While a session is alive, follow runtime backend changes via the
  // backend-event channel — the native worker can fall back from CoreML to
  // CPU between tiles, and that's the only signal we get. Without this the
  // next loadModel-early-return announces a stale realizedBackend.
  #trackRealizedBackend() {
    if (this.#backendListener) return;
    this.#backendListener = (e) => {
      const d = e?.detail;
      if (d && d.kind === 'success' && typeof d.backend === 'string') {
        this.#realizedBackend = d.backend;
      }
    };
    document.addEventListener('aitools:backend-event', this.#backendListener);
  }

  #untrackRealizedBackend() {
    if (!this.#backendListener) return;
    document.removeEventListener('aitools:backend-event', this.#backendListener);
    this.#backendListener = null;
  }

  #prepareSource(img, srcW, srcH, useGpuInput, perf) {
    const tSetup = performance.now();
    let srcData = null;
    if (useGpuInput) {
      this.#gpuExtractor.uploadFrame(img, srcW, srcH);
    } else {
      const tmpC = document.createElement('canvas');
      tmpC.width = srcW;
      tmpC.height = srcH;
      const tmpCtx = tmpC.getContext('2d');
      tmpCtx.drawImage(img, 0, 0);
      srcData = tmpCtx.getImageData(0, 0, srcW, srcH);
      tmpC.width = 0;
      tmpC.height = 0;
    }
    perf.setup = performance.now() - tSetup;
    return srcData;
  }

  #alignToMultiple(value) {
    const m = this.#modelInputMultiple;
    if (!Number.isFinite(m) || m <= 1) return value;
    return Math.ceil(value / m) * m;
  }

  #cropImageData(imgData, width, height) {
    if (imgData.width === width && imgData.height === height) return imgData;
    const out = new ImageData(width, height);
    const src = imgData.data;
    const dst = out.data;
    const srcStride = imgData.width * 4;
    const dstStride = width * 4;
    for (let row = 0; row < height; row++) {
      const srcStart = row * srcStride;
      const dstStart = row * dstStride;
      dst.set(src.subarray(srcStart, srcStart + dstStride), dstStart);
    }
    return out;
  }

  #createTileTensor(srcData, tx, ty, tw, th, paddedTW, paddedTH, useGpuInput) {
    const ort = globalThis.ort;
    if (useGpuInput) {
      // GPU input fast path is gated to fp32 in loadModel(), so we only
      // reach here when the model is fp32.
      const gpuBuf = this.#gpuExtractor.extractTile(tx, ty, tw, th, this.#modelValueRange);
      return ort.Tensor.fromGpuBuffer(gpuBuf, {
        dataType: 'float32',
        dims: [1, 3, th, tw],
        dispose: () => {},
      });
    }
    const isNHWC = this.#modelLayout === 'nhwc';
    const extract = isNHWC ? extractTileNHWC : extractTileNCHW;
    const dims = isNHWC ? [1, paddedTH, paddedTW, 3] : [1, 3, paddedTH, paddedTW];
    const f32 = extract(
      srcData,
      tx,
      ty,
      tw,
      th,
      paddedTW,
      paddedTH,
      this.#modelValueRange / 255,
    );
    if (this.#modelPrecision === 'fp16') {
      const u16 = packFloat32ToFloat16Bits(f32);
      return new ort.Tensor('float16', u16, dims);
    }
    return new ort.Tensor('float32', f32, dims);
  }

  async #waitForGpuWork() {
    try {
      if (this.#device?.queue?.onSubmittedWorkDone) {
        await this.#device.queue.onSubmittedWorkDone();
      }
    } catch {
      // Ignore sync failures and let the caller continue.
    }
  }

  /**
   * Capture ORT's profiling output (logged to console by endProfiling)
   * and return it as structured data instead of formatted strings.
   */
  #collectOrtProfile() {
    const captured = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const intercept = (...args) => captured.push(args.join(' '));
    console.log = intercept;
    console.warn = intercept;
    try { this.#session.endProfiling(); } catch {}
    console.log = origLog;
    console.warn = origWarn;

    if (!captured.length) return null;
    let events;
    try {
      const raw = captured.join('\n');
      events = JSON.parse(raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1));
    } catch { return null; }

    const nodes = events.filter(e => e.cat === 'Node');
    const runs = events.filter(e => e.name === 'model_run');
    if (!nodes.length) return null;

    const gpuOps = {}, cpuOps = {};
    let toHostUs = 0, toHostN = 0, fromHostUs = 0, fromHostN = 0;

    for (const n of nodes) {
      const op = n.args?.op_name ?? n.name;
      const us = n.dur ?? 0;
      if (op === 'MemcpyToHost') { toHostUs += us; toHostN++; continue; }
      if (op === 'MemcpyFromHost') { fromHostUs += us; fromHostN++; continue; }
      const bucket = n.args?.provider === 'CPUExecutionProvider' ? cpuOps : gpuOps;
      bucket[op] ??= { us: 0, n: 0 };
      bucket[op].us += us;
      bucket[op].n++;
    }

    return {
      runs: runs.length,
      modelRunUs: runs.reduce((s, r) => s + (r.dur ?? 0), 0),
      gpuOps,
      cpuOps,
      memcpy: {
        toHost: { us: toHostUs, n: toHostN },
        fromHost: { us: fromHostUs, n: fromHostN },
      },
    };
  }
}
