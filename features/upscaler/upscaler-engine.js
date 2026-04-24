/**
 * UpscalerEngine — tiled ONNX super-resolution inference.
 * Downloads a model, creates a session, runs tiled inference on images.
 * Uses Canvas 2D for pixel I/O in the WASM/WebGL path; GPU paths avoid readback.
 */

import { fetchWithProgress } from 'lib/fetch-progress';
import { GpuTileRenderer } from './gpu-tile-renderer.js';
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

/**
 * Extract a tile from ImageData as Float32 in CHW layout
 * (channels-first: [R plane, G plane, B plane]).
 *
 * @param {number} valueScale - multiply each pixel byte by this (e.g. 1/255 for [0,1] output)
 */
function extractTileCHW(imageData, tx, ty, tw, th, valueScale) {
  const { data, width } = imageData;
  const out = new Float32Array(3 * th * tw);
  const planeSize = th * tw;
  for (let row = 0; row < th; row++) {
    for (let col = 0; col < tw; col++) {
      const srcIdx = ((ty + row) * width + (tx + col)) * 4;
      const dstIdx = row * tw + col;
      out[dstIdx]                 = data[srcIdx]     * valueScale;
      out[planeSize + dstIdx]     = data[srcIdx + 1] * valueScale;
      out[2 * planeSize + dstIdx] = data[srcIdx + 2] * valueScale;
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

export class UpscalerEngine {
  #session = null;
  #modelBuffer = null;
  #modelUrl;
  #scale;
  #overlap;
  #modelValueRange;
  #profiling = false;
  #activeBackend = null;
  #device = null;
  #gpuRenderer = null;
  #gpuExtractor = null;

  constructor({ modelUrl, scale = DEFAULT_SCALE, overlap = DEFAULT_OVERLAP, modelValueRange = 1, profile = false }) {
    this.#modelUrl = modelUrl;
    this.#scale = scale;
    this.#overlap = overlap;
    this.#modelValueRange = modelValueRange;
    this.#profiling = profile;
  }

  get scale() { return this.#scale; }
  get activeBackend() { return this.#activeBackend; }
  get isLoaded() { return this.#session !== null; }
  get profiling() { return this.#profiling; }
  set profiling(v) { this.#profiling = !!v; }

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

    if (backend === 'webgpu') {
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

    if (actualBackend === 'webgpu') {
      try {
        this.#device = await ort.env.webgpu.device;
        this.#gpuRenderer = new GpuTileRenderer(this.#device);
        if (typeof ort.Tensor.fromGpuBuffer === 'function') {
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
    const useGpu = this.#gpuRenderer !== null;
    const useGpuInput = this.#gpuExtractor !== null;

    const srcData = this.#prepareSource(img, srcW, srcH, useGpuInput, perf);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;

    let outCtx = null;
    if (useGpu) {
      this.#gpuRenderer.configure(outCanvas, outW, outH);
    } else {
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
      if (useGpu && (this.#gpuRenderer?.lost || this.#gpuExtractor?.lost)) {
        throw new Error('GPU device was lost (browser or OS interrupted). Please retry or switch to the WASM backend.');
      }

      const { x: tx, y: ty, w: tw, h: th } = tiles[i];

      const tExtract = performance.now();
      const tensor = this.#createTileTensor(srcData, tx, ty, tw, th, useGpuInput);
      const extractMs = performance.now() - tExtract;
      perf.extract += extractMs;

      const tInfer = performance.now();
      if (!firstInferAt) firstInferAt = tInfer;
      const results = await this.#session.run({ [inputName]: tensor });
      const inferenceMs = performance.now() - tInfer;
      perf.inference += inferenceMs;

      const outTW = tw * scale;
      const outTH = th * scale;
      let renderMs = 0, readbackMs = 0;

      if (useGpu) {
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
        const outData = outTensor.data;
        readbackMs = performance.now() - tReadback;
        perf.readback += readbackMs;

        const tWrite = performance.now();
        const dims = outTensor.dims;
        const isNHWC = dims.length === 4 && dims[3] === 3 && dims[1] !== 3;
        const decode = isNHWC ? hwcToImageData : chwToImageData;
        const imgData = decode(outData, outTW, outTH, 255 / this.#modelValueRange);
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

    const pipeline = useGpuInput ? 'gpu-gpu' : useGpu ? 'gpu' : 'cpu';
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

  #createTileTensor(srcData, tx, ty, tw, th, useGpuInput) {
    const ort = globalThis.ort;
    if (useGpuInput) {
      const gpuBuf = this.#gpuExtractor.extractTile(tx, ty, tw, th, this.#modelValueRange);
      return ort.Tensor.fromGpuBuffer(gpuBuf, {
        dataType: 'float32',
        dims: [1, 3, th, tw],
        dispose: () => {},
      });
    }
    const input = extractTileCHW(srcData, tx, ty, tw, th, this.#modelValueRange / 255);
    return new ort.Tensor('float32', input, [1, 3, th, tw]);
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
