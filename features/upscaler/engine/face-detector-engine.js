import { fetchWithProgress } from 'lib/fetch-progress';
import { loadSession } from 'lib/backend';
import { dispatchBackendEvent } from 'lib/backend-events';

const DETECTORS = {
  'face-yunet': {
    label: 'Face (YuNet)',
    url: 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx',
    inputWidth: 640,
    inputHeight: 640,
    scoreThreshold: 0.7,
    iouThreshold: 0.3,
    topK: 20,
  },
};

export { DETECTORS };

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}


function tensorToRows(tensor) {
  const dims = tensor.dims || [];
  const data = tensor.data;
  if (!data || !dims.length) return null;

  // [N, C]
  if (dims.length === 2) {
    return {
      rows: dims[0],
      cols: dims[1],
      at: (row, col) => data[row * dims[1] + col],
    };
  }

  // [1, N, C]
  if (dims.length === 3 && dims[0] === 1) {
    return {
      rows: dims[1],
      cols: dims[2],
      at: (row, col) => data[row * dims[2] + col],
    };
  }

  return null;
}

function nms(boxes, iouThreshold, topK) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept = [];

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const iw = Math.max(0, x2 - x1);
    const ih = Math.max(0, y2 - y1);
    const inter = iw * ih;
    const union = a.w * a.h + b.w * b.h - inter;
    return union <= 0 ? 0 : inter / union;
  }

  for (const cand of sorted) {
    if (kept.length >= topK) break;
    let suppressed = false;
    for (const k of kept) {
      if (iou(cand, k) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(cand);
  }

  return kept;
}

function parseDecodedDetections(outputTensor, scoreThreshold, srcW, srcH, inW, inH) {
  const rows = tensorToRows(outputTensor);
  if (!rows || rows.cols < 15) return [];
  const sx = srcW / inW;
  const sy = srcH / inH;
  const faces = [];

  for (let i = 0; i < rows.rows; i++) {
    const score = rows.at(i, 14);
    if (score < scoreThreshold) continue;

    const x = rows.at(i, 0) * sx;
    const y = rows.at(i, 1) * sy;
    const w = rows.at(i, 2) * sx;
    const h = rows.at(i, 3) * sy;
    if (w <= 1 || h <= 1) continue;

    faces.push({ x, y, w, h, score });
  }

  return faces;
}

function readFeatureVector(tensor, anchorIndex, featureCount) {
  const dims = tensor.dims || [];
  const data = tensor.data;
  if (!data) return null;

  // [1, A, F]
  if (dims.length === 3 && dims[0] === 1 && dims[2] >= featureCount) {
    const off = anchorIndex * dims[2];
    const out = new Array(featureCount);
    for (let i = 0; i < featureCount; i++) out[i] = data[off + i];
    return out;
  }

  // [1, F, H, W]
  if (dims.length === 4 && dims[0] === 1 && dims[1] >= featureCount) {
    const anchors = dims[2] * dims[3];
    if (anchorIndex >= anchors) return null;
    const out = new Array(featureCount);
    for (let i = 0; i < featureCount; i++) out[i] = data[i * anchors + anchorIndex];
    return out;
  }

  // [1, H, W, F]
  if (dims.length === 4 && dims[0] === 1 && dims[3] >= featureCount) {
    const off = anchorIndex * dims[3];
    const out = new Array(featureCount);
    for (let i = 0; i < featureCount; i++) out[i] = data[off + i];
    return out;
  }

  const off = anchorIndex * featureCount;
  if (off + featureCount - 1 >= data.length) return null;
  const out = new Array(featureCount);
  for (let i = 0; i < featureCount; i++) out[i] = data[off + i];
  return out;
}

function decodeRawYunet(results, scoreThreshold, srcW, srcH, padW, padH) {
  const sx = srcW / padW;
  const sy = srcH / padH;
  const outByName = new Map(Object.entries(results));
  const faces = [];
  const strides = [8, 16, 32];

  for (const stride of strides) {
    const cls = outByName.get(`cls_${stride}`);
    const obj = outByName.get(`obj_${stride}`);
    const bbox = outByName.get(`bbox_${stride}`);
    if (!cls || !obj || !bbox) continue;

    const fmW = Math.floor(padW / stride);
    const fmH = Math.floor(padH / stride);
    const anchorCount = fmW * fmH;

    for (let i = 0; i < anchorCount; i++) {
      const clsVec = readFeatureVector(cls, i, 1);
      const objVec = readFeatureVector(obj, i, 1);
      if (!clsVec || !objVec) continue;
      const clsScore = clamp(clsVec[0], 0, 1);
      const objScore = clamp(objVec[0], 0, 1);
      const score = Math.sqrt(clsScore * objScore);
      if (score < scoreThreshold) continue;

      const bb = readFeatureVector(bbox, i, 4);
      if (!bb) continue;
      const [dx, dy, dw, dh] = bb;

      const c = i % fmW;
      const r = Math.floor(i / fmW);
      const cx = (c + dx) * stride;
      const cy = (r + dy) * stride;
      const w = Math.exp(dw) * stride;
      const h = Math.exp(dh) * stride;
      const x1 = cx - w / 2;
      const y1 = cy - h / 2;
      if (w <= 1 || h <= 1) continue;

      faces.push({
        x: clamp(x1 * sx, 0, srcW - 1),
        y: clamp(y1 * sy, 0, srcH - 1),
        w: Math.min(w * sx, srcW),
        h: Math.min(h * sy, srcH),
        score,
      });
    }
  }

  return faces;
}

export class FaceDetectorEngine {
  #session = null;
  #modelBuffer = null;
  #currentDetectorKey = null;
  #intent = null;
  // Set by loadSession; kept current by #backendListener so a runtime EP
  // fallback doesn't leave a stale label that the loadModel early-return
  // re-announces later.
  #realizedBackend = null;
  #backendListener = null;
  get isLoaded() { return this.#session !== null; }
  get realizedBackend() { return this.#realizedBackend; }
  get intent() { return this.#intent; }
  get currentDetector() { return this.#currentDetectorKey; }

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

  async loadModel(detectorKey = 'face-yunet', intent = 'cpu', onProgress) {
    if (onProgress != null && typeof onProgress !== 'function') {
      console.warn('[FaceDetectorEngine] Ignoring non-function onProgress callback.', {
        type: typeof onProgress,
        value: onProgress,
        detectorKey,
        intent,
      });
    }
    intent = normalizeIntent(intent);
    const report = typeof onProgress === 'function' ? onProgress : null;
    if (this.#session && this.#currentDetectorKey === detectorKey && this.#intent === intent) {
      if (this.#realizedBackend) {
        dispatchBackendEvent({ kind: 'success', backend: this.#realizedBackend });
      }
      return;
    }

    const cfg = DETECTORS[detectorKey];
    if (!cfg) throw new Error(`Unknown detector: ${detectorKey}`);

    if (this.#session) {
      try { this.#session.release(); } catch {}
      this.#session = null;
    }
    if (this.#currentDetectorKey !== detectorKey) {
      this.#modelBuffer = null;
    }

    if (!this.#modelBuffer) {
      this.#modelBuffer = await fetchWithProgress(cfg.url, report);
    }

    report?.(1, 'Loading detector into runtime...');
    console.info(`[FaceDetectorEngine] Loading detector "${detectorKey}" with intent "${intent}"`);
    const { session, realizedBackend } = await loadSession(this.#modelBuffer, intent);
    this.#session = session;
    this.#intent = intent;
    this.#realizedBackend = realizedBackend;
    this.#currentDetectorKey = detectorKey;
    this.#trackRealizedBackend();
    console.info(`[FaceDetectorEngine] Detector ready on ${realizedBackend}`);
    report?.(1, 'Detector loaded.');
  }

  async detectFaces(image, {
    detectorKey = 'face-yunet',
    scoreThreshold,
    iouThreshold,
    topK,
    signal,
  } = {}) {
    if (!this.#session || this.#currentDetectorKey !== detectorKey) {
      throw new Error('Detector not loaded — call loadModel() first');
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const cfg = DETECTORS[detectorKey];
    const minScore = Number.isFinite(scoreThreshold) ? scoreThreshold : cfg.scoreThreshold;
    const maxIou = Number.isFinite(iouThreshold) ? iouThreshold : cfg.iouThreshold;
    const maxKeep = Number.isFinite(topK) ? topK : cfg.topK;
    const srcW = image.width;
    const srcH = image.height;
    const inW = cfg.inputWidth;
    const inH = cfg.inputHeight;

    const prepCanvas = document.createElement('canvas');
    prepCanvas.width = inW;
    prepCanvas.height = inH;
    const prepCtx = prepCanvas.getContext('2d');
    prepCtx.drawImage(image, 0, 0, inW, inH);
    const imageData = prepCtx.getImageData(0, 0, inW, inH);
    const px = imageData.data;

    const planeSize = inW * inH;
    const input = new Float32Array(3 * planeSize);
    for (let i = 0; i < planeSize; i++) {
      const si = i * 4;
      // Match OpenCV DNN blobFromImage defaults used by FaceDetectorYN:
      // BGR order, no scale, zero mean.
      input[i] = px[si + 2];
      input[planeSize + i] = px[si + 1];
      input[2 * planeSize + i] = px[si];
    }

    prepCanvas.width = 0;
    prepCanvas.height = 0;

    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const ort = globalThis.ort;
    const tensor = new ort.Tensor('float32', input, [1, 3, inH, inW]);
    const inputName = this.#session.inputNames[0];
    const results = await this.#session.run({ [inputName]: tensor });
    tensor.dispose();

    let candidates = [];
    const outputNames = this.#session.outputNames || [];
    if (outputNames.length === 1) {
      const raw = results[outputNames[0]];
      candidates = parseDecodedDetections(raw, minScore, srcW, srcH, inW, inH);
    }

    if (!candidates.length) {
      candidates = decodeRawYunet(results, minScore, srcW, srcH, inW, inH);
    }

    for (const name of outputNames) {
      try { results[name]?.dispose?.(); } catch {}
    }

    const filtered = nms(
      candidates,
      maxIou,
      maxKeep,
    );

    return filtered.map(face => ({
      ...face,
      x: clamp(face.x, 0, srcW - 1),
      y: clamp(face.y, 0, srcH - 1),
      w: clamp(face.w, 1, srcW),
      h: clamp(face.h, 1, srcH),
    }));
  }

  release() {
    this.#untrackRealizedBackend();
    if (this.#session) {
      try { this.#session.release(); } catch {}
      this.#session = null;
    }
    this.#modelBuffer = null;
    this.#currentDetectorKey = null;
    this.#intent = null;
    this.#realizedBackend = null;
  }
}

function normalizeIntent(value) {
  if (value === 'webgpu' || value === 'gpu') return 'gpu';
  if (value === 'wasm'   || value === 'cpu') return 'cpu';
  return 'cpu';
}
