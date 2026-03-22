/**
 * UpscalerEngine — pure inference logic, zero DOM dependency.
 * Downloads an ONNX super-resolution model, creates a session,
 * and runs tiled inference on an image.
 */

import { fetchWithProgress } from '../../lib/fetch-progress.js';
import { GpuTileRenderer } from './gpu-tile-renderer.js';

const DEFAULT_SCALE = 4;
const DEFAULT_OVERLAP = 16;

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
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
  // σ_range controls color similarity gate.
  // Lower = only very similar pixels contribute (subtle).
  // 30 at full strength is moderate; scales down with strength.
  const sigmaR = 15 + strength * 15;
  const inv2sr2 = -0.5 / (sigmaR * sigmaR);

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
          const w = Math.exp(colorDist2 * inv2sr2);
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
 * Extract a tile from ImageData as a Float32 CHW array.
 * @param {number} inputScale - divide pixel values by this (255 for 0-1 range, 1 for 0-255 range)
 */
function extractTileCHW(imageData, tx, ty, tw, th, inputScale = 255) {
  const { data, width } = imageData;
  const out = new Float32Array(3 * th * tw);
  const planeSize = th * tw;
  for (let row = 0; row < th; row++) {
    for (let col = 0; col < tw; col++) {
      const srcIdx = ((ty + row) * width + (tx + col)) * 4;
      const dstIdx = row * tw + col;
      out[dstIdx]                 = data[srcIdx]     / inputScale;
      out[planeSize + dstIdx]     = data[srcIdx + 1] / inputScale;
      out[2 * planeSize + dstIdx] = data[srcIdx + 2] / inputScale;
    }
  }
  return out;
}

/**
 * Write a CHW output tile onto the destination canvas, cropping overlap.
 */
let _scratchCanvas = null;
let _scratchCtx = null;

function writeTileToCanvas(ctx, chwData, fullW, fullH, dx, dy, realW, realH, canvasW, canvasH, overlap, outputScale = 255) {
  const imgData = ctx.createImageData(realW, realH);
  const px = imgData.data;
  const planeSize = fullW * fullH;
  for (let row = 0; row < realH; row++) {
    for (let col = 0; col < realW; col++) {
      const srcIdx = row * fullW + col;
      const dstIdx = (row * realW + col) * 4;
      px[dstIdx]     = clamp255(chwData[srcIdx] * outputScale);
      px[dstIdx + 1] = clamp255(chwData[planeSize + srcIdx] * outputScale);
      px[dstIdx + 2] = clamp255(chwData[2 * planeSize + srcIdx] * outputScale);
      px[dstIdx + 3] = 255;
    }
  }

  const cropL = dx > 0 ? overlap / 2 : 0;
  const cropT = dy > 0 ? overlap / 2 : 0;
  const cropR = (dx + realW) < canvasW ? overlap / 2 : 0;
  const cropB = (dy + realH) < canvasH ? overlap / 2 : 0;

  if (!_scratchCanvas) {
    _scratchCanvas = document.createElement('canvas');
    _scratchCtx = _scratchCanvas.getContext('2d');
  }
  _scratchCanvas.width = realW;
  _scratchCanvas.height = realH;
  _scratchCtx.putImageData(imgData, 0, 0);

  ctx.drawImage(
    _scratchCanvas,
    cropL, cropT, realW - cropL - cropR, realH - cropT - cropB,
    dx + cropL, dy + cropT, realW - cropL - cropR, realH - cropT - cropB,
  );
}

export class UpscalerEngine {
  #session = null;
  #modelBuffer = null;
  #modelUrl;
  #scale;
  #overlap;
  #inputRange;
  #denoise;
  #activeBackend = null;
  #device = null;
  #gpuRenderer = null;

  constructor({ modelUrl, scale = DEFAULT_SCALE, overlap = DEFAULT_OVERLAP, inputRange = 1, denoise = 0 }) {
    this.#modelUrl = modelUrl;
    this.#scale = scale;
    this.#overlap = overlap;
    this.#inputRange = inputRange; // 1 = model expects 0-1, 255 = model expects 0-255
    this.#denoise = denoise;       // 0..1 artifact smoothing strength
  }

  get scale() { return this.#scale; }
  get denoise() { return this.#denoise; }
  get activeBackend() { return this.#activeBackend; }
  get isLoaded() { return this.#session !== null; }

  async loadModel(backend = 'wasm', onProgress) {
    if (this.#session && this.#activeBackend === backend) return;

    if (this.#session) {
      this.#gpuRenderer?.destroy();
      this.#gpuRenderer = null;
      this.#device = null;
      try { this.#session.release(); } catch {}
      this.#session = null;
      this.#activeBackend = null;
    }

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
      enableProfiling: true,
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
      } catch (err) {
        console.warn('[UpscalerEngine] GPU tile renderer init failed, using CPU readback:', err);
        this.#device = null;
        this.#gpuRenderer = null;
      }
    }

    this.#modelBuffer = null;
    onProgress?.(1, 'Model loaded.');
  }

  async upscale(img, tileSize, onTile, signal) {
    if (!this.#session) throw new Error('Model not loaded — call loadModel() first');

    const perf = { setup: 0, denoise: 0, extract: 0, inference: 0, readback: 0, gpuRender: 0, writeTile: 0, dispose: 0, yieldCb: 0, total: 0 };
    const tTotal = performance.now();

    const scale = this.#scale;
    const overlap = this.#overlap;
    const srcW = img.width;
    const srcH = img.height;
    const outW = srcW * scale;
    const outH = srcH * scale;
    const useGpu = this.#gpuRenderer !== null;

    const tSetup = performance.now();
    const tmpC = document.createElement('canvas');
    tmpC.width = srcW;
    tmpC.height = srcH;
    const tmpCtx = tmpC.getContext('2d');
    tmpCtx.drawImage(img, 0, 0);

    const srcData = tmpCtx.getImageData(0, 0, srcW, srcH);
    perf.setup = performance.now() - tSetup;

    if (this.#denoise > 0) {
      const tDenoise = performance.now();
      denoiseImageData(srcData, this.#denoise);
      perf.denoise = performance.now() - tDenoise;
    }
    tmpC.width = 0;
    tmpC.height = 0;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;

    let outCtx = null;
    if (useGpu) {
      this.#gpuRenderer.configure(outCanvas, outW, outH);
    } else {
      outCtx = outCanvas.getContext('2d');
    }

    // tileSize 0 means "full image, no tiling" — skip overlap since there are no seams
    const noTiling = tileSize <= 0;
    const effectiveTileSize = noTiling ? Math.max(srcW, srcH) : tileSize;
    const step = noTiling ? effectiveTileSize : effectiveTileSize - overlap;
    const tiles = [];
    for (let ty = 0; ty < srcH; ty += step) {
      for (let tx = 0; tx < srcW; tx += step) {
        tiles.push({
          x: tx, y: ty,
          w: Math.min(effectiveTileSize, srcW - tx),
          h: Math.min(effectiveTileSize, srcH - ty),
        });
      }
    }

    const inputName = this.#session.inputNames[0];
    const outputName = this.#session.outputNames[0];

    try { this.#session.startProfiling(); } catch {}

    for (let i = 0; i < tiles.length; i++) {
      if (signal?.aborted) throw new DOMException('Upscale cancelled', 'AbortError');

      const { x: tx, y: ty, w: tw, h: th } = tiles[i];

      // inputRange controls the model's expected pixel value range:
      //   inputRange=1   → model expects [0,1]: divide by 255 to normalize
      //   inputRange=255 → model expects [0,255]: divide by 1 (pass through)
      const tExtract = performance.now();
      const inputScale = this.#inputRange === 255 ? 1 : 255;
      const input = extractTileCHW(srcData, tx, ty, tw, th, inputScale);
      const tensor = new ort.Tensor('float32', input, [1, 3, th, tw]);
      perf.extract += performance.now() - tExtract;

      const tInfer = performance.now();
      const results = await this.#session.run({ [inputName]: tensor });
      const tileMs = performance.now() - tInfer;
      perf.inference += tileMs;

      const outTW = tw * scale;
      const outTH = th * scale;

      if (useGpu) {
        const tGpu = performance.now();
        const gpuOutputScale = this.#inputRange === 255 ? (1 / 255) : 1.0;
        this.#gpuRenderer.renderTile(
          results[outputName].gpuBuffer, outTW, outTH,
          tx * scale, ty * scale, overlap * scale, gpuOutputScale,
        );
        this.#gpuRenderer.presentToCanvas();
        perf.gpuRender += performance.now() - tGpu;
      } else {
        const tReadback = performance.now();
        const outData = results[outputName].data;
        perf.readback += performance.now() - tReadback;

        const tWrite = performance.now();
        const outputScale = this.#inputRange === 255 ? 1 : 255;
        writeTileToCanvas(
          outCtx, outData, outTW, outTH,
          tx * scale, ty * scale, outTW, outTH,
          outW, outH, overlap * scale, outputScale,
        );
        perf.writeTile += performance.now() - tWrite;
      }

      const tDispose = performance.now();
      tensor.dispose();
      results[outputName].dispose();
      perf.dispose += performance.now() - tDispose;

      const tYield = performance.now();
      onTile?.({
        index: i, total: tiles.length, tileMs, tilePixels: tw * th, canvas: outCanvas,
        outX: tx * scale, outY: ty * scale, outW: outTW, outH: outTH,
      });

      await new Promise(resolve => {
        const ch = new MessageChannel();
        ch.port1.onmessage = resolve;
        ch.port2.postMessage(undefined);
      });
      perf.yieldCb += performance.now() - tYield;
    }

    if (!useGpu && _scratchCanvas) { _scratchCanvas.width = 0; _scratchCanvas.height = 0; }

    // Ensure final frame is on canvas for toBlob after the last yield
    if (useGpu) this.#gpuRenderer.presentToCanvas();

    this.#endProfilingWithSummary();

    perf.total = performance.now() - tTotal;
    const renderLabel = useGpu ? 'GPU render (shader)' : 'Write tiles (canvas)';
    const renderMs = useGpu ? perf.gpuRender : perf.writeTile;
    console.log(
      `[Upscaler Perf] ${srcW}\u00d7${srcH} \u2192 ${outW}\u00d7${outH} | ${tiles.length} tiles @ ${tileSize > 0 ? tileSize + 'px' : 'full image'}${useGpu ? ' [GPU]' : ' [CPU]'}\n` +
      `  Setup (canvas/getImageData): ${perf.setup.toFixed(1)}ms\n` +
      `  Denoise:                     ${perf.denoise.toFixed(1)}ms\n` +
      `  Tile extract (CHW\u2192tensor):   ${perf.extract.toFixed(1)}ms\n` +
      `  Inference (session.run):     ${perf.inference.toFixed(1)}ms\n` +
      `  Data readback (.data):       ${perf.readback.toFixed(1)}ms\n` +
      `  ${renderLabel.padEnd(29)}${renderMs.toFixed(1)}ms\n` +
      `  Dispose (tensor/result):     ${perf.dispose.toFixed(1)}ms\n` +
      `  Yield (callback/msgCh):      ${perf.yieldCb.toFixed(1)}ms\n` +
      `  Total:                       ${perf.total.toFixed(1)}ms`,
    );

    return outCanvas;
  }

  #endProfilingWithSummary() {
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
      .map(([op, { us, n }]) => `${op}×${n} ${ms(us)}`)
      .join(', ');

    const runUs = runs.reduce((s, r) => s + (r.dur ?? 0), 0);
    const gpuT = sumUs(gpu), cpuT = sumUs(cpu);

    const lines = [`[ORT Profile] ${runs.length} run(s), model_run: ${ms(runUs)}`];
    if (gpuT)     lines.push(`  GPU ops:  ${ms(gpuT).padStart(9)}  ${fmtBucket(gpu)}`);
    if (cpuT)     lines.push(`  CPU ops:  ${ms(cpuT).padStart(9)}  ${fmtBucket(cpu)}`);
    if (toHost)   lines.push(`  GPU→CPU:  ${ms(toHost).padStart(9)}  ×${toHostN}`);
    if (fromHost) lines.push(`  CPU→GPU:  ${ms(fromHost).padStart(9)}  ×${fromHostN}`);

    console.log(lines.join('\n'));
  }
}
