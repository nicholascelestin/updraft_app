/**
 * UpscalerEngine — tiled ONNX super-resolution inference.
 * Downloads a model, creates a session, runs tiled inference on images.
 * Uses Canvas 2D for pixel I/O in the WASM/WebGL path; GPU paths avoid readback.
 */

import { fetchWithProgress } from 'lib/fetch-progress';
import { GpuTileRenderer } from './gpu-tile-renderer.js';
import { GpuFrameExtractor } from './gpu-frame-extractor.js';
import { buildTileGrid, pasteTileCropped } from './tiling.js';

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
 * 3×3 bilateral denoise on ImageData in-place.
 *
 * Weights each neighbor by color similarity to the center pixel,
 * so edges are preserved while flat noisy regions get smoothed.
 * Small kernel keeps it proportionate for low-res sources.
 *
 * @param {ImageData} imageData - modified in-place
 * @param {number} strength - 0..1 blend toward filtered result
 */
function denoiseImageData(imageData, strength) {
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data.length);
  const sigmaR = 15 + strength * 15;
  const colorFalloff = -0.5 / (sigmaR * sigmaR);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ci = (y * width + x) * 4;
      const cr = data[ci], cg = data[ci + 1], cb = data[ci + 2];
      let sumR = 0, sumG = 0, sumB = 0, wSum = 0;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const ni = (ny * width + nx) * 4;
          const dr = data[ni] - cr, dg = data[ni + 1] - cg, db = data[ni + 2] - cb;
          const colorDist2 = dr * dr + dg * dg + db * db;
          const w = Math.exp(colorDist2 * colorFalloff);
          sumR += data[ni]     * w;
          sumG += data[ni + 1] * w;
          sumB += data[ni + 2] * w;
          wSum += w;
        }
      }

      out[ci]     = cr + ((sumR / wSum) - cr) * strength;
      out[ci + 1] = cg + ((sumG / wSum) - cg) * strength;
      out[ci + 2] = cb + ((sumB / wSum) - cb) * strength;
      out[ci + 3] = data[ci + 3];
    }
  }

  data.set(out);
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

export class UpscalerEngine {
  #session = null;
  #modelBuffer = null;
  #modelUrl;
  #scale;
  #overlap;
  #modelValueRange;
  #denoise;
  #profile;
  #activeBackend = null;
  #device = null;
  #gpuRenderer = null;
  #gpuExtractor = null;

  constructor({ modelUrl, scale = DEFAULT_SCALE, overlap = DEFAULT_OVERLAP, modelValueRange = 1, denoise = 0, profile = false }) {
    this.#modelUrl = modelUrl;
    this.#scale = scale;
    this.#overlap = overlap;
    this.#modelValueRange = modelValueRange;
    this.#denoise = denoise;
    this.#profile = profile;
  }

  get scale() { return this.#scale; }
  get denoise() { return this.#denoise; }
  get activeBackend() { return this.#activeBackend; }
  get isLoaded() { return this.#session !== null; }

  async loadModel(backend = 'wasm', onProgress) {
    if (this.#session && this.#activeBackend === backend) return;
    this.#releaseSession();

    const ort = globalThis.ort;
    if (!ort) throw new Error('ONNX Runtime not loaded — include ort.all.min.js before using UpscalerEngine');

    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
    ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

    if (backend === 'webgpu' && ort.env.webgpu) {
      ort.env.webgpu.profilingMode = 'default';
    }

    if (!this.#modelBuffer) {
      this.#modelBuffer = await fetchWithProgress(this.#modelUrl, onProgress);
    }

    onProgress?.(1, 'Loading model into runtime\u2026');

    const sessionOpts = {
      executionProviders: [backend],
      graphOptimizationLevel: 'all',
      ...(this.#profile && { enableProfiling: true }),
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
        onProgress?.(1, `${backend} failed, falling back to WASM\u2026`);
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
    onProgress?.(1, 'Model loaded.');
  }

  async upscale(img, tileSize, { onTile, signal } = {}) {
    if (!this.#session) throw new Error('Model not loaded — call loadModel() first');

    const perf = { setup: 0, denoise: 0, extract: 0, inference: 0, readback: 0, gpuRender: 0, writeTile: 0, dispose: 0, total: 0 };
    const tTotal = performance.now();

    const scale = this.#scale;
    const overlap = this.#overlap;
    const srcW = img.videoWidth ?? img.width;
    const srcH = img.videoHeight ?? img.height;
    const outW = srcW * scale;
    const outH = srcH * scale;
    const useGpu = this.#gpuRenderer !== null;
    const useGpuInput = this.#gpuExtractor !== null && this.#denoise === 0;

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

    if (this.#profile) try { this.#session.startProfiling(); } catch {}

    for (let i = 0; i < tiles.length; i++) {
      if (signal?.aborted) throw new DOMException('Upscale cancelled', 'AbortError');
      if (useGpu && (this.#gpuRenderer?.lost || this.#gpuExtractor?.lost)) {
        throw new Error('GPU device was lost (browser or OS interrupted). Please retry or switch to the WASM backend.');
      }

      const { x: tx, y: ty, w: tw, h: th } = tiles[i];

      const tExtract = performance.now();
      const tensor = this.#createTileTensor(srcData, tx, ty, tw, th, useGpuInput);
      perf.extract += performance.now() - tExtract;

      const tInfer = performance.now();
      const results = await this.#session.run({ [inputName]: tensor });
      const tileMs = performance.now() - tInfer;
      perf.inference += tileMs;

      const outTW = tw * scale;
      const outTH = th * scale;

      if (useGpu) {
        const tGpu = performance.now();
        this.#gpuRenderer.renderTile(
          results[outputName].gpuBuffer, outTW, outTH,
          tx * scale, ty * scale, overlap * scale, 1 / this.#modelValueRange,
        );
        this.#gpuRenderer.presentToCanvas();
        perf.gpuRender += performance.now() - tGpu;
      } else {
        const tReadback = performance.now();
        const outData = results[outputName].data;
        perf.readback += performance.now() - tReadback;

        const tWrite = performance.now();
        const imgData = chwToImageData(outData, outTW, outTH, 255 / this.#modelValueRange);
        pasteTileCropped(outCtx, imgData, tx * scale, ty * scale, outW, outH, overlap * scale);
        perf.writeTile += performance.now() - tWrite;
      }

      const tDispose = performance.now();
      tensor.dispose();
      results[outputName].dispose();
      perf.dispose += performance.now() - tDispose;

      onTile?.({
        index: i, total: tiles.length, tileMs, tilePixels: tw * th, canvas: outCanvas,
        outX: tx * scale, outY: ty * scale, outW: outTW, outH: outTH,
      });

      await yieldToEventLoop();
    }

    if (useGpu) this.#gpuRenderer.presentToCanvas();

    if (this.#profile) {
      perf.total = performance.now() - tTotal;
      this.#logPerf(perf, tiles, tileSize, srcW, srcH, outW, outH, useGpu, useGpuInput);
      this.#endProfiling();
    }

    return outCanvas;
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
      if (this.#denoise > 0) {
        const tDenoise = performance.now();
        denoiseImageData(srcData, this.#denoise);
        perf.denoise = performance.now() - tDenoise;
      }
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

  #logPerf(perf, tiles, tileSize, srcW, srcH, outW, outH, useGpu, useGpuInput) {
    const renderLabel = useGpu ? 'GPU render (shader)' : 'Write tiles (canvas)';
    const renderMs = useGpu ? perf.gpuRender : perf.writeTile;
    const pipelineLabel = useGpuInput ? ' [GPU\u2192GPU]' : useGpu ? ' [GPU]' : ' [CPU]';
    console.log(
      `[Upscaler Perf] ${srcW}\u00d7${srcH} \u2192 ${outW}\u00d7${outH} | ${tiles.length} tiles @ ${tileSize > 0 ? tileSize + 'px' : 'full image'}${pipelineLabel}\n` +
      `  ${(useGpuInput ? 'GPU frame upload:' : 'Setup (canvas/getImageData):').padEnd(30)}${perf.setup.toFixed(1)}ms\n` +
      `  Denoise:                     ${perf.denoise.toFixed(1)}ms\n` +
      `  Tile extract (CHW\u2192tensor):   ${perf.extract.toFixed(1)}ms\n` +
      `  Inference (session.run):     ${perf.inference.toFixed(1)}ms\n` +
      `  Data readback (.data):       ${perf.readback.toFixed(1)}ms\n` +
      `  ${renderLabel.padEnd(29)}${renderMs.toFixed(1)}ms\n` +
      `  Dispose (tensor/result):     ${perf.dispose.toFixed(1)}ms\n` +
      `  Total:                       ${perf.total.toFixed(1)}ms`,
    );
  }

  #endProfiling() {
    const captured = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const intercept = (...args) => captured.push(args.join(' '));
    console.log = intercept;
    console.warn = intercept;
    try { this.#session.endProfiling(); } catch {}
    console.log = origLog;
    console.warn = origWarn;

    if (!captured.length) return;
    let events;
    try {
      const raw = captured.join('\n');
      events = JSON.parse(raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1));
    } catch { return; }

    const nodes = events.filter(e => e.cat === 'Node');
    const runs = events.filter(e => e.name === 'model_run');
    if (!nodes.length) return;

    const gpu = {}, cpu = {};
    let toHost = 0, toHostN = 0, fromHost = 0, fromHostN = 0;

    for (const n of nodes) {
      const op = n.args?.op_name ?? n.name;
      const us = n.dur ?? 0;
      if (op === 'MemcpyToHost') { toHost += us; toHostN++; continue; }
      if (op === 'MemcpyFromHost') { fromHost += us; fromHostN++; continue; }
      const bucket = n.args?.provider === 'CPUExecutionProvider' ? cpu : gpu;
      bucket[op] ??= { us: 0, n: 0 };
      bucket[op].us += us;
      bucket[op].n++;
    }

    const ms = us => (us / 1000).toFixed(1) + 'ms';
    const sumUs = obj => Object.values(obj).reduce((s, e) => s + e.us, 0);
    const fmtBucket = b => Object.entries(b)
      .sort(([, a], [, b]) => b.us - a.us)
      .map(([op, { us, n }]) => `${op}\u00d7${n} ${ms(us)}`)
      .join(', ');

    const runUs = runs.reduce((s, r) => s + (r.dur ?? 0), 0);
    const gpuT = sumUs(gpu), cpuT = sumUs(cpu);

    const lines = [`[ORT Profile] ${runs.length} run(s), model_run: ${ms(runUs)}`];
    if (gpuT)     lines.push(`  GPU ops:  ${ms(gpuT).padStart(9)}  ${fmtBucket(gpu)}`);
    if (cpuT)     lines.push(`  CPU ops:  ${ms(cpuT).padStart(9)}  ${fmtBucket(cpu)}`);
    if (toHost)   lines.push(`  GPU\u2192CPU:  ${ms(toHost).padStart(9)}  \u00d7${toHostN}`);
    if (fromHost) lines.push(`  CPU\u2192GPU:  ${ms(fromHost).padStart(9)}  \u00d7${fromHostN}`);

    console.log(lines.join('\n'));
  }
}
