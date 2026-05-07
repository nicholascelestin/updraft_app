/**
 * UpscalerEngine — tiled ONNX super-resolution inference.
 * Downloads a model, creates a session, runs tiled inference on images.
 * Uses Canvas 2D for pixel I/O in the WASM/WebGL path; GPU paths avoid readback.
 */

import { fetchWithProgress } from 'lib/fetch-progress';
import { GpuTileRenderer, GpuOutputTooLargeError } from './gpu-tile-renderer.js';
import { GpuFrameExtractor } from './gpu-frame-extractor.js';
import { buildTileGrid, pasteTileCropped, overlapCrop } from './tiling.js';

const DEFAULT_SCALE = 4;
const DEFAULT_OVERLAP = 16;

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
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

/**
 * ORT-Web 1.18+ exposes `session.inputMetadata` / `outputMetadata` as a
 * readonly array of ValueMetadata, ordered to match `inputNames` /
 * `outputNames`. Older versions exposed it as a Record keyed by tensor
 * name. Accept both shapes so behavior is stable across ORT upgrades.
 */
function readSessionMetaEntry(metaCollection, name, index = 0) {
  if (!metaCollection) return null;
  if (Array.isArray(metaCollection)) {
    if (name) {
      const byName = metaCollection.find((m) => m?.name === name);
      if (byName) return byName;
    }
    return metaCollection[index] || null;
  }
  return (name && metaCollection[name]) || null;
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
  #profiling = false;
  #activeBackend = null;
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
    profile = false,
  }) {
    this.#modelUrl = modelUrl;
    this.#scale = scale;
    this.#overlap = overlap;
    this.#modelValueRange = modelValueRange;
    this.#modelLayout = modelLayout === 'nhwc' ? 'nhwc' : 'nchw';
    this.#modelInputMultiple = Number.isFinite(modelInputMultiple) ? Math.max(1, Math.floor(modelInputMultiple)) : 1;
    this.#modelPrecision = modelPrecision === 'fp16' ? 'fp16' : 'fp32';
    this.#profiling = profile;
  }

  get scale() { return this.#scale; }
  get activeBackend() { return this.#activeBackend; }
  get isLoaded() { return this.#session !== null; }
  get profiling() { return this.#profiling; }
  set profiling(v) { this.#profiling = !!v; }
  get modelPrecision() { return this.#modelPrecision; }

  async loadModel(backend = 'wasm', onProgress) {
    if (onProgress != null && typeof onProgress !== 'function') {
      console.warn('[UpscalerEngine] Ignoring non-function onProgress callback.', {
        type: typeof onProgress,
        value: onProgress,
        backend,
      });
    }
    const report = typeof onProgress === 'function' ? onProgress : null;
    if (this.#session && this.#activeBackend === backend) return;
    this.#releaseSession();

    const ort = globalThis.ort;
    if (!ort) throw new Error('ONNX Runtime not loaded — include ort.all.min.js before using UpscalerEngine');

    ort.env.wasm.wasmPaths =
      globalThis.__ORT_WASM_PATHS__ ||
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
    ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

    if (backend === 'webgpu' && ort.env.webgpu) {
      ort.env.webgpu.profilingMode = 'default';
    }

    if (!this.#modelBuffer) {
      this.#modelBuffer = await fetchWithProgress(this.#modelUrl, report);
    }

    report?.(1, 'Loading model into runtime\u2026');

    const sessionOpts = {
      executionProviders: [
        backend === 'webgpu'
          ? { name: 'webgpu', preferredLayout: 'NCHW' }
          : backend,
      ],
      graphOptimizationLevel: 'all',
      ...(this.#profiling && { enableProfiling: true }),
    };

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
    if (backend === 'webgpu' && canUseGpuFastPath) {
      sessionOpts.preferredOutputLocation = 'gpu-buffer';
    }

    let actualBackend = backend;
    try {
      this.#session = await ort.InferenceSession.create(this.#modelBuffer, sessionOpts);
    } catch (e) {
      if (backend !== 'wasm') {
        console.warn(`[UpscalerEngine] ${backend} backend failed, falling back to WASM. Reason:`, e);
        report?.(1, `${backend} failed, falling back to WASM\u2026`);
        sessionOpts.executionProviders = ['wasm'];
        delete sessionOpts.preferredOutputLocation;
        delete sessionOpts.enableProfiling;
        actualBackend = 'wasm';
        this.#session = await ort.InferenceSession.create(this.#modelBuffer, sessionOpts);
      } else {
        throw e;
      }
    }

    this.#activeBackend = actualBackend;

    // Self-correct modelPrecision from the model's declared input dtype.
    // Stale custom-model records (e.g. uploaded before fp16 support existed,
    // or before the inspector started reading the right metadata field)
    // can carry the wrong precision; the model graph itself doesn't lie.
    // Without this, the engine would build fp32 tensors for an fp16 model
    // and ORT would throw "Unexpected input data type" at the first run.
    // Note: ORT-Web's inputMetadata is an array (1.18+) keyed positionally
    // to inputNames — readSessionMetaEntry handles that shape plus the
    // older Record-keyed-by-name form.
    const sessionInputName = this.#session.inputNames?.[0];
    const sessionInMeta = readSessionMetaEntry(this.#session.inputMetadata, sessionInputName, 0);
    const declaredInputType = sessionInMeta?.type;
    const detectedPrecision = String(declaredInputType || '').toLowerCase().includes('float16')
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

    if (actualBackend === 'webgpu') {
      try {
        this.#device = await ort.env.webgpu.device;
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
    let useGpu = this.#gpuRenderer !== null;
    const useGpuInput = this.#gpuExtractor !== null;

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

    const srcData = this.#prepareSource(img, srcW, srcH, useGpuInput, perf);

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
      const tensor = this.#createTileTensor(
        srcData,
        tx,
        ty,
        tw,
        th,
        paddedTW,
        paddedTH,
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
        const decode = isNHWC ? hwcToImageData : chwToImageData;
        const paddedImgData = decode(outData, outPaddedTW, outPaddedTH, 255 / this.#modelValueRange);
        const imgData = outPaddedTW === outTW && outPaddedTH === outTH
          ? paddedImgData
          : this.#cropImageData(paddedImgData, outTW, outTH);
        pasteTileCropped(outCtx, imgData, tx * scale, ty * scale, outW, outH, overlap * scale);
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
    this.#gpuRenderer?.destroy();
    this.#gpuRenderer = null;
    this.#gpuExtractor?.destroy();
    this.#gpuExtractor = null;
    this.#device = null;
    try { this.#session?.release(); } catch {}
    this.#session = null;
    this.#activeBackend = null;
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
