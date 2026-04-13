/**
 * BgRemovalEngine — pure inference logic, zero DOM dependency.
 * Downloads an ONNX segmentation model, creates a session,
 * and runs background removal on an image.
 */

import { fetchWithProgress } from 'lib/fetch-progress';

const MODELS = {
  'isnet': {
    url: 'https://huggingface.co/onnx-community/ISNet-ONNX/resolve/main/onnx/model_quantized.onnx',
    inputSize: 1024,
    label: 'IS-Net (General Use, ~42 MB)',
    // preprocessor_config: do_rescale=false, mean=[128,128,128], std=[256,256,256]
    preprocess(pixel) { return (pixel - 128) / 256; },
  },
  'rmbg-1.4': {
    url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx',
    inputSize: 1024,
    label: 'BRIA RMBG-1.4 (High Quality, ~44 MB)',
    // preprocessor_config: do_rescale=true (1/255), mean=[0.5,0.5,0.5], std=[1,1,1]
    preprocess(pixel) { return pixel / 255 - 0.5; },
  },
};

export { MODELS };

export class BgRemovalEngine {
  #session = null;
  #modelBuffer = null;
  #currentModelKey = null;

  get isLoaded() { return this.#session !== null; }
  get currentModel() { return this.#currentModelKey; }

  async loadModel(modelKey, backend = 'wasm', onProgress) {
    if (onProgress != null && typeof onProgress !== 'function') {
      console.warn('[BgRemovalEngine] Ignoring non-function onProgress callback.', {
        type: typeof onProgress,
        value: onProgress,
        modelKey,
        backend,
      });
    }
    const report = typeof onProgress === 'function' ? onProgress : null;
    if (this.#session && this.#currentModelKey === modelKey) return;

    const cfg = MODELS[modelKey];
    if (!cfg) throw new Error(`Unknown model: ${modelKey}`);

    const ort = globalThis.ort;
    if (!ort) throw new Error('ONNX Runtime not loaded');

    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
    ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

    // Release old session if switching models
    if (this.#session) {
      this.#session.release();
      this.#session = null;
    }
    if (this.#currentModelKey !== modelKey) {
      this.#modelBuffer = null;
    }

    if (!this.#modelBuffer) {
      this.#modelBuffer = await fetchWithProgress(cfg.url, report);
    }

    report?.(1, 'Loading model into runtime\u2026');

    try {
      this.#session = await ort.InferenceSession.create(this.#modelBuffer, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
      });
    } catch (e) {
      if (backend !== 'wasm') {
        report?.(1, `${backend} failed, falling back to WASM\u2026`);
        this.#session = await ort.InferenceSession.create(this.#modelBuffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
      } else {
        throw e;
      }
    }

    this.#currentModelKey = modelKey;
    report?.(1, 'Model loaded.');
  }

  async removeBackground(image, signal) {
    if (!this.#session) throw new Error('Model not loaded — call loadModel() first');
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const cfg = MODELS[this.#currentModelKey];
    const inputSize = cfg.inputSize;
    const origW = image.width;
    const origH = image.height;

    // --- Resize input to model dimensions ---
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = inputSize;
    tmpCanvas.height = inputSize;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.drawImage(image, 0, 0, inputSize, inputSize);
    const imageData = tmpCtx.getImageData(0, 0, inputSize, inputSize);

    // --- Convert to CHW Float32 with model-specific normalization ---
    const planeSize = inputSize * inputSize;
    const float32 = new Float32Array(3 * planeSize);
    const px = imageData.data;
    const preprocess = cfg.preprocess;

    for (let i = 0; i < planeSize; i++) {
      const si = i * 4;
      float32[i]                 = preprocess(px[si]);
      float32[planeSize + i]     = preprocess(px[si + 1]);
      float32[2 * planeSize + i] = preprocess(px[si + 2]);
    }

    // Free temp canvas memory
    tmpCanvas.width = 0;
    tmpCanvas.height = 0;

    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    // --- Run inference ---
    const tensor = new ort.Tensor('float32', float32, [1, 3, inputSize, inputSize]);
    const inputName = this.#session.inputNames[0];
    const outputName = this.#session.outputNames[0];

    const results = await this.#session.run({ [inputName]: tensor });
    const rawMask = results[outputName].data;

    tensor.dispose();

    // --- Sigmoid + clamp to 0-1 ---
    const maskSize = inputSize * inputSize;
    const mask = new Float32Array(maskSize);
    for (let i = 0; i < maskSize; i++) {
      const v = rawMask[i];
      // Apply sigmoid if value is outside 0-1 (raw logits)
      mask[i] = (v < 0 || v > 1) ? 1 / (1 + Math.exp(-v)) : v;
    }

    results[outputName].dispose();

    // --- Write mask to canvas, resize to original dimensions ---
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = inputSize;
    maskCanvas.height = inputSize;
    const maskCtx = maskCanvas.getContext('2d');
    const maskImgData = maskCtx.createImageData(inputSize, inputSize);
    for (let i = 0; i < maskSize; i++) {
      const v = Math.round(mask[i] * 255);
      maskImgData.data[i * 4]     = v;
      maskImgData.data[i * 4 + 1] = v;
      maskImgData.data[i * 4 + 2] = v;
      maskImgData.data[i * 4 + 3] = 255;
    }
    maskCtx.putImageData(maskImgData, 0, 0);

    // Resize mask to original image dimensions (bilinear via drawImage)
    const fullMaskCanvas = document.createElement('canvas');
    fullMaskCanvas.width = origW;
    fullMaskCanvas.height = origH;
    const fullMaskCtx = fullMaskCanvas.getContext('2d');
    fullMaskCtx.drawImage(maskCanvas, 0, 0, origW, origH);
    const fullMaskData = fullMaskCtx.getImageData(0, 0, origW, origH);

    // Free small mask canvas
    maskCanvas.width = 0;
    maskCanvas.height = 0;

    // --- Apply mask as alpha channel to original image ---
    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = origW;
    resultCanvas.height = origH;
    const resultCtx = resultCanvas.getContext('2d');
    resultCtx.drawImage(image, 0, 0);
    const resultData = resultCtx.getImageData(0, 0, origW, origH);

    for (let i = 0; i < origW * origH; i++) {
      resultData.data[i * 4 + 3] = fullMaskData.data[i * 4]; // R channel = mask
    }
    resultCtx.putImageData(resultData, 0, 0);

    // Free full mask canvas
    fullMaskCanvas.width = 0;
    fullMaskCanvas.height = 0;

    return resultCanvas;
  }

  release() {
    if (this.#session) {
      this.#session.release();
      this.#session = null;
    }
    this.#modelBuffer = null;
    this.#currentModelKey = null;
  }
}
