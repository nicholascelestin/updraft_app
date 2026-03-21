/**
 * UpscalerEngine — pure inference logic, zero DOM dependency.
 * Downloads an ONNX super-resolution model, creates a session,
 * and runs tiled inference on an image.
 */

const DEFAULT_SCALE = 4;
const DEFAULT_OVERLAP = 16;

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
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

  constructor({ modelUrl, scale = DEFAULT_SCALE, overlap = DEFAULT_OVERLAP, inputRange = 1 }) {
    this.#modelUrl = modelUrl;
    this.#scale = scale;
    this.#overlap = overlap;
    this.#inputRange = inputRange; // 1 = model expects 0-1, 255 = model expects 0-255
  }

  get scale() { return this.#scale; }
  get isLoaded() { return this.#session !== null; }

  async loadModel(backend = 'wasm', onProgress) {
    if (this.#session) return;

    const ort = globalThis.ort;
    if (!ort) throw new Error('ONNX Runtime not loaded — include ort.all.min.js before using UpscalerEngine');

    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
    ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

    if (!this.#modelBuffer) {
      onProgress?.(0, 'Downloading model\u2026');
      const resp = await fetch(this.#modelUrl);
      if (!resp.ok) throw new Error(`Model download failed: HTTP ${resp.status}`);

      const total = parseInt(resp.headers.get('content-length') || '0', 10);
      const reader = resp.body.getReader();
      const chunks = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total) {
          const frac = loaded / total;
          onProgress?.(frac, `Downloading model\u2026 ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
        }
      }

      const buf = new Uint8Array(loaded);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      this.#modelBuffer = buf.buffer;
    }

    onProgress?.(1, 'Loading model into runtime\u2026');

    try {
      this.#session = await ort.InferenceSession.create(this.#modelBuffer, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
      });
    } catch (e) {
      if (backend !== 'wasm') {
        onProgress?.(1, `${backend} failed, falling back to WASM\u2026`);
        this.#session = await ort.InferenceSession.create(this.#modelBuffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
      } else {
        throw e;
      }
    }

    this.#modelBuffer = null;
    onProgress?.(1, 'Model loaded.');
  }

  async upscale(img, tileSize, onTile, signal) {
    if (!this.#session) throw new Error('Model not loaded — call loadModel() first');

    const scale = this.#scale;
    const overlap = this.#overlap;
    const srcW = img.width;
    const srcH = img.height;
    const outW = srcW * scale;
    const outH = srcH * scale;

    const tmpC = document.createElement('canvas');
    tmpC.width = srcW;
    tmpC.height = srcH;
    const tmpCtx = tmpC.getContext('2d');
    tmpCtx.drawImage(img, 0, 0);
    const srcData = tmpCtx.getImageData(0, 0, srcW, srcH);
    tmpC.width = 0;
    tmpC.height = 0;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d');

    const step = tileSize - overlap;
    const tiles = [];
    for (let ty = 0; ty < srcH; ty += step) {
      for (let tx = 0; tx < srcW; tx += step) {
        tiles.push({
          x: tx, y: ty,
          w: Math.min(tileSize, srcW - tx),
          h: Math.min(tileSize, srcH - ty),
        });
      }
    }

    const inputName = this.#session.inputNames[0];
    const outputName = this.#session.outputNames[0];

    for (let i = 0; i < tiles.length; i++) {
      if (signal?.aborted) throw new DOMException('Upscale cancelled', 'AbortError');

      const { x: tx, y: ty, w: tw, h: th } = tiles[i];

      const inputScale = this.#inputRange === 255 ? 1 : 255;
      const input = extractTileCHW(srcData, tx, ty, tw, th, inputScale);
      const tensor = new ort.Tensor('float32', input, [1, 3, th, tw]);

      const t0 = performance.now();
      const results = await this.#session.run({ [inputName]: tensor });
      const tileMs = performance.now() - t0;

      const outData = results[outputName].data;
      const outTW = tw * scale;
      const outTH = th * scale;

      const outputScale = this.#inputRange === 255 ? 1 : 255;
      writeTileToCanvas(
        outCtx, outData, outTW, outTH,
        tx * scale, ty * scale, outTW, outTH,
        outW, outH, overlap * scale, outputScale,
      );

      tensor.dispose();
      results[outputName].dispose();

      onTile?.({
        index: i, total: tiles.length, tileMs, tilePixels: tw * th, canvas: outCanvas,
        outX: tx * scale, outY: ty * scale, outW: outTW, outH: outTH,
      });

      await new Promise(r => setTimeout(r, 0));
    }

    if (_scratchCanvas) { _scratchCanvas.width = 0; _scratchCanvas.height = 0; }

    return outCanvas;
  }
}
