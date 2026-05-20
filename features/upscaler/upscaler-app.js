import { morph } from 'lib/morph';
import { Pipeline } from './upscale-pipeline.js';
import './ui/upscaler-controls.js';
import './ui/upscaler-canvas-area.js';
import './ui/upscaler-toolbar.js';
import './ui/perf-monitor.js';

/**
 * Format a pipeline/inference error for end users.
 * Detects the ONNX reshape-window-size failure and adds a remediation hint
 * derived from the model's declared layout/multiple-of/maxTileSize and any
 * dimensions the runtime reported in the raw error. Pure: caller passes the
 * relevant model facts so this function stays DOM-free and unit-testable.
 */
function formatUpscaleErrorMessage(error, { layout = 'nchw', multipleOf = 1, maxTileSize = null, precision = 'fp32', backend = null } = {}) {
  const raw = error?.message || String(error || 'Unknown error');

  const isFp16DtypeError =
    /Unexpected input data type/i.test(raw) && /tensor\(float16\)/i.test(raw);
  const isFp16KernelMissing =
    precision === 'fp16' && backend !== 'webgpu' &&
    (/kernel.*not.*found/i.test(raw) || /not.*supported/i.test(raw) || /no kernel/i.test(raw));
  if (isFp16DtypeError && backend === 'webgpu') {
    return `Model precision metadata was stale: this model declares fp16 inputs but the engine had it tagged as fp32. The engine has now corrected itself — try running again. (If the error persists, open the model from the Edit pencil and set Precision = fp16, or re-upload it.) Raw error: ${raw}`;
  }
  if (isFp16DtypeError || isFp16KernelMissing) {
    return `This model uses fp16 (16-bit) precision, which the CPU/WASM backend does not fully support. Switch Backend to "GPU (WebGPU)" and run again. Raw error: ${raw}`;
  }

  const isReshapeWindowError =
    /reshape_helper\.h/i.test(raw) ||
    /input_shape_size == size/i.test(raw) ||
    /cannot be reshaped to the requested shape/i.test(raw);
  if (!isReshapeWindowError) return raw;

  const upperLayout = String(layout).toUpperCase();
  const altLayout = upperLayout === 'NHWC' ? 'NCHW' : 'NHWC';
  const parseShape = (text) => String(text || '')
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter(Number.isFinite);
  const shapeMatch = raw.match(/Input shape:\{([^}]*)\}.*requested shape:\{([^}]*)\}/i);
  const inputDims = shapeMatch ? parseShape(shapeMatch[1]) : [];
  const requestedDims = shapeMatch ? parseShape(shapeMatch[2]) : [];

  // When the model is known to have a hard input-size cap (detected by the
  // inspector or set manually), the right remediation is to reduce tile size,
  // not to bump Multiple-of — bumping it would push padded edge tiles past
  // the cap.
  if (Number.isFinite(maxTileSize) && maxTileSize >= 1) {
    return `Model reshape failed: this model only accepts inputs up to ${maxTileSize}×${maxTileSize}. Reduce Tile size to ≤ ${maxTileSize} and set Multiple-of = ${maxTileSize} so edge tiles get padded back into range. Raw error: ${raw}`;
  }

  let inferredMultiple = 0;
  const pow2Requested = requestedDims.filter((d) => d > 1 && d <= 256 && (d & (d - 1)) === 0);
  if (pow2Requested.length) {
    inferredMultiple = Math.max(...pow2Requested);
  }
  if (inputDims.length > 0 && requestedDims.length > 1) {
    const likelyGroup = requestedDims[1];
    if (Number.isFinite(likelyGroup) && likelyGroup > 1 && inputDims[0] % likelyGroup !== 0) {
      inferredMultiple = Math.max(inferredMultiple, likelyGroup);
    }
  }

  const suggestedMultiple = Math.max(multipleOf > 1 ? multipleOf : 8, inferredMultiple || 0);
  const specificHint = inferredMultiple > 8
    ? ` Based on the reported reshape, try Multiple-of ${inferredMultiple} first.`
    : '';
  return `Model reshape failed (likely window-size constraint). Try setting Multiple-of to ${suggestedMultiple} (common values: 8/16/32/64) and/or switch Layout to ${altLayout}.${specificHint} If reducing the tile size below ~64 makes it work, the model may have a hard upper bound — set "Max tile" on the custom model. Raw error: ${raw}`;
}

const STEP_LABEL = {
  tiledUpscale: 'Upscaling',
  comparison: 'Comparison',
  blendAll: 'All-pass',
  detectFaces: 'Detecting',
  enhanceFaces: 'Faces',
};

function scaleCanvasToOutput(srCanvas, image, outputScale) {
  const targetScale = Math.max(1, outputScale || Math.round(srCanvas.width / image.width) || 1);
  const w = image.width * targetScale;
  const h = image.height * targetScale;
  if (srCanvas.width === w && srCanvas.height === h) return srCanvas;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srCanvas, 0, 0, w, h);
  return out;
}

function makeComparisonCanvases(resultCanvas, image, outputScale) {
  const afterCanvas = scaleCanvasToOutput(resultCanvas, image, outputScale);
  const w = afterCanvas.width;
  const h = afterCanvas.height;
  const beforeCanvas = document.createElement('canvas');
  beforeCanvas.width = w;
  beforeCanvas.height = h;
  const bCtx = beforeCanvas.getContext('2d');
  bCtx.imageSmoothingEnabled = false;
  bCtx.drawImage(image, 0, 0, w, h);
  return { beforeCanvas, afterCanvas };
}

// For Comparison mode: both layers are SR canvases of the same size, so the
// before slot is the base SR (no pixelated LR upscale) and the after slot
// is the comparison SR. We still honor the user's Final Output downscale.
function makeComparisonPairCanvases(baseSR, comparisonSR, image, outputScale) {
  return {
    beforeCanvas: scaleCanvasToOutput(baseSR, image, outputScale),
    afterCanvas: scaleCanvasToOutput(comparisonSR, image, outputScale),
  };
}

class UpscalerApp extends HTMLElement {
  #pipeline = new Pipeline();
  #abortController = null;
  #running = false;
  #generation = 0;

  connectedCallback() {
    this.#render();
    this.#wire();
    this.#restoreViewState();
  }

  #q(sel) { return this.querySelector(sel); }

  // ── Wiring ─────────────────────────────────────────────────────────────

  #wire() {
    const controls   = this.#q('upscaler-controls');
    const canvasArea = this.#q('upscaler-canvas-area');
    const toolbar    = this.#q('upscaler-toolbar');
    const perfMon    = this.#q('perf-monitor');
    const cropHint   = ' — drag to crop (optional).';

    toolbar.statusBar.message = 'Load an image to begin.';

    // Status messages from controls (custom-model upload/edit/delete).
    this.addEventListener('status-message', (e) => {
      toolbar.statusBar.message = e.detail.message;
    });

    // Model change → update upscale button label.
    this.addEventListener('model-change', (e) => {
      toolbar.setUpscaleLabel(`${e.detail.verb} ${e.detail.scale}x`);
    });

    // Image loaded → switch to ready phase, pick a default view mode that
    // keeps the whole image on screen.
    canvasArea.addEventListener('image-loaded', (e) => {
      if (this.#running) {
        this.#abortController?.abort();
        this.#running = false;
        this.#generation++;
        this.#abortController = null;
      }
      const img = e.detail.image;
      this.#setMode(canvasArea.defaultModeForImage(img));
      canvasArea.showCropping(img);
      toolbar.state = 'ready';
      toolbar.hasCrop = false;
      toolbar.statusBar.message = `${img.width}×${img.height}${cropHint}`;
      toolbar.statusBar.hideProgress();
    });

    canvasArea.addEventListener('crop-changed', (e) => {
      const crop = e.detail.crop;
      const img = canvasArea.image;
      toolbar.hasCrop = !!crop;
      toolbar.statusBar.message = crop
        ? `${img.width}×${img.height} — crop ${crop.w}×${crop.h}.`
        : `${img.width}×${img.height}${cropHint}`;
    });

    // View mode (toolbar → canvas).
    toolbar.addEventListener('view-mode-change', (e) => {
      this.#setMode(e.detail.mode);
      canvasArea.snapCenterVisible();
    });

    // Button events from toolbar.
    toolbar.addEventListener('upscale-click',     () => this.#runUpscale());
    toolbar.addEventListener('stop-click',        () => this.#abortController?.abort());
    toolbar.addEventListener('start-over-click',  () => {
      if (this.#running) this.#abortController?.abort();
      this.#reset();
    });
    toolbar.addEventListener('back-to-crop-click', () => {
      if (this.#running || !canvasArea.image) return;
      this.#showReady();
    });
    toolbar.addEventListener('clear-crop-click',  () => canvasArea.clearCrop());
    toolbar.addEventListener('open-in-tab-click', () => canvasArea.openInTab());
    toolbar.addEventListener('download-click',    () => canvasArea.download());

    // perf-toggle + clear-cache buttons live inside <upscaler-controls>
    // but their actions are orchestrator-level (perf monitor, pipeline cache).
    this.addEventListener('perf-toggle', () => {
      perfMon.visible ? perfMon.hide() : perfMon.show();
    });
    this.addEventListener('clear-cache', () => {
      if (this.#running) return;
      this.#pipeline.destroy();
      toolbar.statusBar.message = 'Model cache cleared.';
    });
  }

  // ── Phase helpers ──────────────────────────────────────────────────────

  #showReady() {
    const canvasArea = this.#q('upscaler-canvas-area');
    const toolbar = this.#q('upscaler-toolbar');
    const img = canvasArea.image;
    canvasArea.showCropping(img);
    const existingCrop = canvasArea.currentCrop;
    toolbar.state = 'ready';
    toolbar.hasCrop = !!existingCrop;
    toolbar.statusBar.message = existingCrop
      ? `${img.width}×${img.height} — crop ${existingCrop.w}×${existingCrop.h}.`
      : `${img.width}×${img.height} — drag to crop (optional).`;
    toolbar.statusBar.hideProgress();
  }

  #reset() {
    this.#running = false;
    this.#generation++;
    this.#abortController = null;
    const canvasArea = this.#q('upscaler-canvas-area');
    const toolbar = this.#q('upscaler-toolbar');
    canvasArea.showInitial();
    toolbar.state = 'empty';
    toolbar.hasCrop = false;
    toolbar.statusBar.message = 'Load an image to begin.';
    toolbar.statusBar.hideProgress();
  }

  // ── View-mode persistence (orchestrator-level so it survives across phases) ──

  #setMode(mode) {
    const canvasArea = this.#q('upscaler-canvas-area');
    const toolbar = this.#q('upscaler-toolbar');
    if (canvasArea.viewMode === mode) return;
    canvasArea.viewMode = mode;
    toolbar.viewMode = mode;
    localStorage.setItem('upscaler_view_mode', mode);
  }

  #restoreViewState() {
    const saved = localStorage.getItem('upscaler_view_mode');
    const mode = ['fit-width', 'fit-height', 'one-to-one'].includes(saved) ? saved : 'fit-width';
    this.#q('upscaler-canvas-area').viewMode = mode;
    this.#q('upscaler-toolbar').viewMode = mode;
  }

  // ── Upscale run flow ───────────────────────────────────────────────────

  async #runUpscale() {
    if (this.#running) return;
    const controls   = this.#q('upscaler-controls');
    const canvasArea = this.#q('upscaler-canvas-area');
    const toolbar    = this.#q('upscaler-toolbar');
    const perfMon    = this.#q('perf-monitor');
    const status     = toolbar.statusBar;

    if (!canvasArea.image) return;
    this.#running = true;
    const gen = ++this.#generation;
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    controls.isRunning = true;
    toolbar.state = 'running';

    try {
      status.showProgress(0);
      const inputImage = canvasArea.croppedImage;
      const requestedOutputScale = controls.outputScale;

      const { beforeCanvas, afterCanvas, scale, comparison } =
        await this.#runPipeline(controls, canvasArea, perfMon, status, signal, inputImage, requestedOutputScale);

      status.hideProgress();
      const outW = inputImage.width * scale;
      const outH = inputImage.height * scale;
      status.message = `Done: ${inputImage.width}×${inputImage.height} → ${outW}×${outH}.`;

      await canvasArea.showResult(beforeCanvas, afterCanvas, {
        downloadName: comparison ? `comparison_${scale}x.png` : `upscaled_${scale}x.png`,
      });
      toolbar.state = 'done';
    } catch (e) {
      if (e.name === 'AbortError') {
        status.message = 'Cancelled.';
      } else {
        console.error(e);
        const opt = controls.selectedModelOption;
        const parsedMaxTile = parseInt(opt?.dataset?.maxtilesize, 10);
        status.message = 'Error: ' + formatUpscaleErrorMessage(e, {
          layout: opt?.dataset?.layout,
          multipleOf: parseInt(opt?.dataset?.multipleof, 10),
          maxTileSize: Number.isFinite(parsedMaxTile) ? parsedMaxTile : null,
          precision: opt?.dataset?.precision === 'fp16' ? 'fp16' : 'fp32',
          backend: controls.backend,
        });
      }
      status.hideProgress();
      perfMon.stop();
      // Fall back to ready so the user can adjust and retry.
      if (this.#generation === gen) toolbar.state = canvasArea.image ? 'ready' : 'empty';
    }

    if (this.#generation === gen) {
      this.#running = false;
      this.#abortController = null;
      controls.isRunning = false;
    }
  }

  async #runPipeline(controls, canvasArea, perfMon, status, signal, inputImage, requestedOutputScale) {
    const modelOpt = controls.selectedModelOption;
    const isBuiltInResampler = !!modelOpt?.value?.startsWith('builtin:');

    if (isBuiltInResampler) {
      return this.#runBuiltInResample(inputImage, modelOpt.value, requestedOutputScale, canvasArea, status, signal);
    }

    const config = { ...controls.config, profile: perfMon.visible };
    if (perfMon.visible) perfMon.start(config.backend);

    const outW = inputImage.width * config.scale;
    const outH = inputImage.height * config.scale;
    canvasArea.showPreview(inputImage, outW, outH);
    status.message = `Upscaling ${inputImage.width}×${inputImage.height} → ${outW}×${outH}…`;

    const result = await this.#pipeline.run(inputImage, config, {
      onProgress(frac, msg) {
        status.showProgress(frac);
        status.message = msg;
      },
      onStage(stage) {
        const label = STEP_LABEL[stage.step] || stage.step;
        const prefix = label ? `${label}: ` : '';
        if (typeof stage.progress === 'number') status.showProgress(stage.progress);
        if (stage.message) status.message = prefix + stage.message;
        else if (stage.phase === 'start') status.message = `${label}…`;
        if (perfMon.visible) perfMon.updateStage(stage);
      },
      onTile: (info) => {
        if (info.step === 'tiledUpscale' || info.step === 'comparison') {
          canvasArea.drawPreviewTile(info);
        } else if (info.step === 'blendAll') {
          canvasArea.drawPreviewTile(info, { opacity: config.all?.blendOpacity ?? 1 });
        } else if (info.step === 'enhanceFaces' && info.composited) {
          canvasArea.drawPreviewTile(info);
        }
        status.showProgress((info.index + 1) / info.total);
        const label = STEP_LABEL[info.step] || info.step || 'Pass';
        if (info.step === 'enhanceFaces') {
          if (info.composited) {
            status.message = `${label}: face ${(info.faceIndex ?? 0) + 1}/${info.faceTotal ?? '?'} done`;
          } else {
            const faceN = Number.isFinite(info.faceIndex) ? info.faceIndex + 1 : null;
            const faceTotal = Number.isFinite(info.faceTotal) ? info.faceTotal : null;
            const facePrefix = faceN && faceTotal ? `face ${faceN}/${faceTotal}, ` : '';
            const faceTileTotal = Number.isFinite(info.faceTileTotal) ? info.faceTileTotal : info.total;
            status.message = `${label}: ${facePrefix}tile ${info.index + 1}/${faceTileTotal}`;
          }
        } else {
          status.message = `${label}: tile ${info.index + 1}/${info.total}`;
        }
        if (perfMon.visible) perfMon.update({
          step: info.step,
          index: info.index, total: info.total,
          tileMs: info.tileMs, tilePixels: info.tilePixels, perf: info.perf,
        });
      },
      signal,
    });

    if (result.perf || result.pipelinePerf) {
      perfMon.showResults(result.perf, result.ortProfile, result.pipelinePerf);
    }

    const outputScale = Math.max(1, Math.min(requestedOutputScale, result.scale));
    if (config.comparison && result.comparisonImage) {
      const canvases = makeComparisonPairCanvases(result.image, result.comparisonImage, inputImage, outputScale);
      return { ...canvases, scale: outputScale, comparison: true };
    }
    const canvases = makeComparisonCanvases(result.image, inputImage, outputScale);
    return { ...canvases, scale: outputScale, comparison: false };
  }

  async #runBuiltInResample(inputImage, modelUrl, requestedOutputScale, canvasArea, status, signal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const isLanczos = modelUrl === 'builtin:lanczos-4x';
    const methodLabel = isLanczos ? 'Lanczos' : 'Bicubic';
    const scale = 4;
    const outW = inputImage.width * scale;
    const outH = inputImage.height * scale;

    canvasArea.showPreview(inputImage, outW, outH);
    status.showProgress(0.25);
    status.message = `${methodLabel} resampling…`;

    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = outW;
    resultCanvas.height = outH;
    const ctx = resultCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = isLanczos ? 'high' : 'medium';
    ctx.drawImage(inputImage, 0, 0, outW, outH);

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    status.showProgress(1);
    const outputScale = Math.max(1, Math.min(requestedOutputScale, scale));
    const canvases = makeComparisonCanvases(resultCanvas, inputImage, outputScale);
    return { ...canvases, scale: outputScale, comparison: false };
  }

  // ── Template ───────────────────────────────────────────────────────────

  #render() {
    morph(this, `
      <style>
        upscaler-app .canvas-stack {
          position: relative;
          background: rgba(0, 0, 0, 0.4);
          border-radius: var(--pico-border-radius);
          padding: 0.5rem;
        }
      </style>
      <upscaler-controls></upscaler-controls>
      <div class="canvas-stack">
        <upscaler-toolbar></upscaler-toolbar>
        <upscaler-canvas-area></upscaler-canvas-area>
      </div>
      <perf-monitor></perf-monitor>
    `);
  }
}

customElements.define('upscaler-app', UpscalerApp);
