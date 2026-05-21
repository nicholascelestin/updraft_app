import { morph } from 'lib/morph';
import { trackBackendEvents, friendlyBackend, realizedIsGpu } from 'lib/backend-events';
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
    precision === 'fp16' && backend !== 'gpu' &&
    (/kernel.*not.*found/i.test(raw) || /not.*supported/i.test(raw) || /no kernel/i.test(raw));
  if (isFp16DtypeError && backend === 'gpu') {
    return `Model precision metadata was stale: this model declares fp16 inputs but the engine had it tagged as fp32. The engine has now corrected itself — try running again. (If the error persists, open the model from the Edit pencil and set Precision = fp16, or re-upload it.) Raw error: ${raw}`;
  }
  if (isFp16DtypeError || isFp16KernelMissing) {
    return `This model uses fp16 (16-bit) precision, which the CPU backend does not fully support. Switch Backend to "GPU" and run again. Raw error: ${raw}`;
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

    // Empty initial state — no "Ready" copy; icon alone communicates "waiting".
    toolbar.statusBar.set({ title: '', state: 'idle', details: '', progress: -1, tileCount: null });

    // Status updates from controls (custom-model upload/edit/delete) carry
    // their own { title, state, details } payload; forward verbatim.
    this.addEventListener('status-message', (e) => {
      toolbar.statusBar.set(e.detail);
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
      toolbar.statusBar.set({
        title: 'Image loaded',
        state: 'idle',
        details: `${img.width}×${img.height}. Drag to crop (optional), then click Upscale.`,
        progress: -1,
        tileCount: null,
      });
    });

    canvasArea.addEventListener('crop-changed', (e) => {
      const crop = e.detail.crop;
      const img = canvasArea.image;
      toolbar.hasCrop = !!crop;
      toolbar.statusBar.set(crop ? {
        title: 'Crop selected',
        state: 'idle',
        details: `${img.width}×${img.height}, cropped to ${crop.w}×${crop.h}.`,
      } : {
        title: 'Image loaded',
        state: 'idle',
        details: `${img.width}×${img.height}. Drag to crop (optional), then click Upscale.`,
      });
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
      toolbar.statusBar.set({
        title: 'Cache cleared',
        state: 'idle',
        details: 'Model cache cleared. Next run will re-download.',
      });
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
    toolbar.statusBar.set(existingCrop ? {
      title: 'Crop selected',
      state: 'idle',
      details: `${img.width}×${img.height}, cropped to ${existingCrop.w}×${existingCrop.h}.`,
      progress: -1,
      tileCount: null,
    } : {
      title: 'Image loaded',
      state: 'idle',
      details: `${img.width}×${img.height}. Drag to crop (optional), then click Upscale.`,
      progress: -1,
      tileCount: null,
    });
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
    toolbar.statusBar.set({ title: '', state: 'idle', details: '', progress: -1, tileCount: null });
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

    // runState is monotonic: 'running' → 'warning' (stays once warned).
    // The tracker updates it as backend events arrive; the orchestrator
    // reads it on completion to pick the final icon color.
    let runState = 'running';
    const tracker = trackBackendEvents((ev) => {
      if (ev.kind === 'attempt') {
        status.set({ title: `Loading on ${friendlyBackend(ev.backend)}`, state: runState });
      } else if (ev.kind === 'success') {
        status.set({ title: `Running on ${friendlyBackend(ev.backend)}`, state: runState });
      } else if (ev.kind === 'fallback') {
        runState = 'warning';
        status.set({ title: `Fallback from ${friendlyBackend(ev.backend)}`, state: runState });
      } else if (ev.kind === 'skipped') {
        runState = 'warning';
        status.set({ title: `Skipping ${friendlyBackend(ev.backend)}`, state: runState });
      }
    });

    try {
      status.set({
        title: 'Loading model',
        state: 'running',
        details: '',
        progress: 0,
        tileCount: null,
      });
      const inputImage = canvasArea.croppedImage;
      const requestedOutputScale = controls.outputScale;

      const { beforeCanvas, afterCanvas, scale, comparison } =
        await this.#runPipeline(controls, canvasArea, perfMon, status, signal, inputImage, requestedOutputScale, () => runState);

      const outW = inputImage.width * scale;
      const outH = inputImage.height * scale;
      const summary = tracker.summary();
      // The tracker only flags hadFallback when a fallback event fires *this
      // run*. After a prior runtime fallback (CoreML→CPU), the worker's
      // session is already on CPU, so the next run produces no fallback
      // event of its own — yet the user asked for GPU and is silently on
      // CPU. Treat that intent/reality mismatch as warning-worthy too.
      const userWantsGpu = controls.backend === 'gpu';
      const ranOnCpuDespiteIntent = userWantsGpu && summary.activeBackend && !realizedIsGpu(summary.activeBackend);
      const finalState = (summary.hadFallback || summary.hadSkip || ranOnCpuDespiteIntent) ? 'warning' : 'success';
      const via = summary.activeBackend ? ` via ${friendlyBackend(summary.activeBackend)}` : '';
      const detailsLines = [`${inputImage.width}×${inputImage.height} → ${outW}×${outH}${via}`];
      if (ranOnCpuDespiteIntent && !summary.hadFallback) {
        detailsLines.push(`Requested GPU but running on ${friendlyBackend(summary.activeBackend)} (prior fallback this session — reload to retry GPU).`);
      }
      if (summary.lines.length) detailsLines.push(...summary.lines);
      status.set({
        title: 'Done',
        state: finalState,
        details: detailsLines.join('\n'),
        progress: -1,
        tileCount: null,
      });

      await canvasArea.showResult(beforeCanvas, afterCanvas, {
        downloadName: comparison ? `comparison_${scale}x.png` : `upscaled_${scale}x.png`,
      });
      toolbar.state = 'done';
    } catch (e) {
      if (e.name === 'AbortError') {
        status.set({
          title: 'Cancelled',
          state: 'idle',
          details: 'You stopped this run.',
          progress: -1,
          tileCount: null,
        });
      } else {
        console.error(e);
        const opt = controls.selectedModelOption;
        const parsedMaxTile = parseInt(opt?.dataset?.maxtilesize, 10);
        const errMsg = formatUpscaleErrorMessage(e, {
          layout: opt?.dataset?.layout,
          multipleOf: parseInt(opt?.dataset?.multipleof, 10),
          maxTileSize: Number.isFinite(parsedMaxTile) ? parsedMaxTile : null,
          precision: opt?.dataset?.precision === 'fp16' ? 'fp16' : 'fp32',
          backend: controls.backend,
        });
        status.set({
          title: 'Error',
          state: 'error',
          details: errMsg,
          progress: -1,
          tileCount: null,
        });
      }
      perfMon.stop();
      // Fall back to ready so the user can adjust and retry.
      if (this.#generation === gen) toolbar.state = canvasArea.image ? 'ready' : 'empty';
    } finally {
      tracker.stop();
    }

    if (this.#generation === gen) {
      this.#running = false;
      this.#abortController = null;
      controls.isRunning = false;
    }
  }

  async #runPipeline(controls, canvasArea, perfMon, status, signal, inputImage, requestedOutputScale, getRunState) {
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

    const result = await this.#pipeline.run(inputImage, config, {
      onProgress(frac, msg) {
        status.set({ progress: frac, details: msg });
      },
      onStage(stage) {
        const label = STEP_LABEL[stage.step] || stage.step;
        const updates = { state: getRunState() };
        if (typeof stage.progress === 'number') updates.progress = stage.progress;
        if (stage.message) {
          updates.title = label;
          updates.details = stage.message;
        } else if (stage.phase === 'start') {
          updates.title = label;
        }
        status.set(updates);
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
        const label = STEP_LABEL[info.step] || info.step || 'Pass';
        const progress = (info.index + 1) / info.total;
        if (info.step === 'enhanceFaces') {
          if (info.composited) {
            status.set({
              title: label,
              state: getRunState(),
              details: `face ${(info.faceIndex ?? 0) + 1}/${info.faceTotal ?? '?'} done`,
              progress,
              tileCount: { done: info.index + 1, total: info.total },
            });
          } else {
            const faceN = Number.isFinite(info.faceIndex) ? info.faceIndex + 1 : null;
            const faceTotal = Number.isFinite(info.faceTotal) ? info.faceTotal : null;
            const facePrefix = faceN && faceTotal ? `face ${faceN}/${faceTotal}, ` : '';
            const faceTileTotal = Number.isFinite(info.faceTileTotal) ? info.faceTileTotal : info.total;
            status.set({
              title: label,
              state: getRunState(),
              details: `${facePrefix}tile ${info.index + 1}/${faceTileTotal}`,
              progress,
              tileCount: { done: info.index + 1, total: faceTileTotal },
            });
          }
        } else {
          status.set({
            title: label,
            state: getRunState(),
            details: `tile ${info.index + 1}/${info.total} — ${inputImage.width}×${inputImage.height} → ${outW}×${outH}`,
            progress,
            tileCount: { done: info.index + 1, total: info.total },
          });
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
    status.set({
      title: 'Resampling',
      state: 'running',
      details: `${methodLabel} resampling, ${inputImage.width}×${inputImage.height} → ${outW}×${outH}`,
      progress: 0.25,
    });

    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = outW;
    resultCanvas.height = outH;
    const ctx = resultCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = isLanczos ? 'high' : 'medium';
    ctx.drawImage(inputImage, 0, 0, outW, outH);

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    status.set({ progress: 1 });
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
