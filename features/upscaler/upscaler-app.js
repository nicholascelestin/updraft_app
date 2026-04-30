/**
 * <upscaler-app> — orchestrates the image upscaler feature.
 * Delegates inference to Pipeline; owns abort control and presentation.
 */

import { morph } from 'lib/morph';
import { Pipeline } from './upscale-pipeline.js';
import { modelOptionsHTML } from './model-registry.js';
import {
  deleteCustomModelByUrl,
  getCustomModelByUrl,
  getUploadCustomOptionHTML,
  listCustomModels,
} from './custom-model-store.js';
import 'components/image-drop-zone';
import 'components/status-bar';
import 'components/image-cropper';
import 'components/compare-slider';
import './upscale-preview.js';
import './perf-monitor.js';
import './custom-model-upload-dialog.js';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const UPLOAD_CUSTOM_VALUE = '__upload_custom__';

// Single source of truth for localStorage <-> form control wiring.
// `kind` is 'value' for inputs/selects, 'checked' for checkboxes.
const PERSISTED_CONTROLS = [
  { selector: '.runpod-endpoint',         key: 'upscaler_runpod_endpoint',         kind: 'value',   event: 'input' },
  { selector: '.runpod-apikey',           key: 'upscaler_runpod_apikey',           kind: 'value',   event: 'input' },
  { selector: '.tilesize-select',         key: 'upscaler_tilesize',                kind: 'value',   event: 'change' },
  { selector: '.backend-select',          key: 'upscaler_backend',                 kind: 'value',   event: 'change' },
  { selector: '.output-select',           key: 'upscaler_output',                  kind: 'value',   event: 'change' },
  { selector: '.pass-all-enabled',        key: 'upscaler_pass_all_enabled',        kind: 'checked', event: 'change' },
  { selector: '.pass-all-blend',          key: 'upscaler_pass_all_blend',          kind: 'value',   event: 'input' },
  { selector: '.pass-all-model',          key: 'upscaler_pass_all_model',          kind: 'value',   event: 'change' },
  { selector: '.pass-compare-enabled',    key: 'upscaler_pass_compare_enabled',    kind: 'checked', event: 'change' },
  { selector: '.pass-compare-model',      key: 'upscaler_pass_compare_model',      kind: 'value',   event: 'change' },
  { selector: '.detector-face-enabled',   key: 'upscaler_detector_face_enabled',   kind: 'checked', event: 'change' },
  { selector: '.detector-face-padding',   key: 'upscaler_detector_face_padding_px', kind: 'value',   event: 'input' },
  { selector: '.detector-face-score',     key: 'upscaler_detector_face_score',     kind: 'value',   event: 'input' },
  { selector: '.detector-face-blend',     key: 'upscaler_detector_face_blend',     kind: 'value',   event: 'input' },
  { selector: '.detector-face-model',     key: 'upscaler_detector_face_model',     kind: 'value',   event: 'change' },
];

function readControl(el, kind) {
  return kind === 'checked' ? (el.checked ? '1' : '0') : el.value;
}
function writeControl(el, kind, saved) {
  if (kind === 'checked') el.checked = saved === '1';
  else el.value = saved;
}

/**
 * Format a pipeline/inference error for end users.
 * Detects the ONNX reshape-window-size failure and adds a remediation hint
 * derived from the model's declared layout/multiple-of/maxTileSize and any
 * dimensions the runtime reported in the raw error. Pure: caller passes the
 * relevant model facts so this function stays DOM-free and unit-testable.
 */
function formatUpscaleErrorMessage(error, { layout = 'nchw', multipleOf = 1, maxTileSize = null } = {}) {
  const raw = error?.message || String(error || 'Unknown error');
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
    return `Model reshape failed: this model only accepts inputs up to ${maxTileSize}\u00d7${maxTileSize}. Reduce Tile size to \u2264 ${maxTileSize} and set Multiple-of = ${maxTileSize} so edge tiles get padded back into range. Raw error: ${raw}`;
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

class UpscalerApp extends HTMLElement {
  #loadedImage = null;
  #running = false;
  #generation = 0;
  #viewState = { expanded: false, upscaledOnly: false };
  #customModels = [];
  #previousModelValue = '';
  #outputBaseLabels = null;

  #pipeline = new Pipeline();
  #abortController = null;

  connectedCallback() {
    this.#render();
    this.#customModels = listCustomModels();
    this.#refreshModelSelectOptions(localStorage.getItem('upscaler_model') || undefined);
    this.#setupPersistence();
    this.#setupViewStateSync();
    this.#setupUpscaleActions();
    this.#restoreSettings();
  }

  #q(sel) { return this.querySelector(sel); }
  #isBuiltInResampler(modelOpt) { return !!modelOpt?.value?.startsWith('builtin:'); }
  #syncViewSizeButtonLabel() {
    const btn = this.#q('.viewsize-btn');
    if (!btn) return;
    const expanded = this.#viewState.expanded;
    const icon = expanded ? 'fa-arrows-up-down' : 'fa-arrows-left-right-to-line';
    const label = expanded ? 'Fit Height' : 'Fit Width';
    btn.innerHTML = `<i class="fas ${icon}"></i> <span class="btn-label">${label}</span>`;
    btn.title = label;
  }

  #getCustomModelOptionsHTML(selected) {
    if (!this.#customModels.length) return '';
    return this.#customModels.map((model) => {
      const attrs = [
        `value="${model.url}"`,
        `data-scale="${model.scale}"`,
        `data-range="${model.range || 1}"`,
        `data-layout="${model.layout || 'nchw'}"`,
        `data-multipleof="${model.multipleOf || 1}"`,
        `data-sizemb="${model.sizeMB}"`,
      ];
      if (Number.isFinite(model.maxTileSize)) {
        attrs.push(`data-maxtilesize="${model.maxTileSize}"`);
      }
      if (model.url === selected) attrs.push('selected');
      const sizeStr = model.sizeMB != null ? ` (~${model.sizeMB}MB)` : '';
      return `<option ${attrs.join(' ')}>${escapeHtml(model.label)}${sizeStr}</option>`;
    }).join('\n              ');
  }

  #refreshModelSelectOptions(selected) {
    const modelEl = this.#q('.model-select');
    if (!modelEl) return;
    modelEl.innerHTML = [
      modelOptionsHTML(undefined, { selected, includeResamplers: true }),
      this.#getCustomModelOptionsHTML(selected),
      getUploadCustomOptionHTML(),
    ].filter(Boolean).join('\n              ');
    if (selected) modelEl.value = selected;
    if (!modelEl.selectedOptions.length) modelEl.selectedIndex = 0;

    // Pass selectors share the same custom-model list as the primary select.
    // We only refresh their option lists — never their selection — so adding
    // or editing a custom model from the main select doesn't disturb whatever
    // the user has chosen for the all-pass / face-pass.
    this.#refreshPassModelSelect('.pass-all-model');
    this.#refreshPassModelSelect('.pass-compare-model');
    this.#refreshPassModelSelect('.detector-face-model');
  }

  #refreshPassModelSelect(selector) {
    const el = this.#q(selector);
    if (!el) return;
    const previousValue = el.value;
    el.innerHTML = [
      modelOptionsHTML(undefined, { selected: previousValue }),
      this.#getCustomModelOptionsHTML(previousValue),
    ].filter(Boolean).join('\n              ');
    // Re-apply the previous selection if it still exists (covers the upload
    // case where we want to keep the user's pass choice). If the previously
    // selected custom model has just been deleted, fall back to the first
    // option so the select is never left in an invalid state.
    if (previousValue) {
      el.value = previousValue;
      if (!el.selectedOptions.length) el.selectedIndex = 0;
    } else if (!el.selectedOptions.length) {
      el.selectedIndex = 0;
    }
  }

  // --- Pipeline helpers ---

  #scaleCanvasToOutput(srCanvas, image, outputScale) {
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

  #createComparisonCanvases(resultCanvas, image, outputScale) {
    const afterCanvas = this.#scaleCanvasToOutput(resultCanvas, image, outputScale);
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
  #createComparisonPairCanvases(baseSR, comparisonSR, image, outputScale) {
    return {
      beforeCanvas: this.#scaleCanvasToOutput(baseSR, image, outputScale),
      afterCanvas: this.#scaleCanvasToOutput(comparisonSR, image, outputScale),
    };
  }

  // --- Event setup ---

  #setupPersistence() {
    for (const { selector, key, kind, event } of PERSISTED_CONTROLS) {
      const el = this.#q(selector);
      el.addEventListener(event, () => localStorage.setItem(key, readControl(el, kind)));
    }
  }

  #setupViewStateSync() {
    this.#q('.viewsize-btn').addEventListener('click', () => {
      this.#viewState.expanded = !this.#viewState.expanded;
      this.#applyViewState();
      this.#persistViewState();
      if (!this.#viewState.expanded) this.#snapCenterVisibleCanvas();
    });
    this.#q('compare-slider').addEventListener('view-state-change', (e) => {
      if (typeof e.detail.upscaledOnly === 'boolean') {
        this.#viewState.upscaledOnly = e.detail.upscaledOnly;
      }
      this.#persistViewState();
    });
  }

  #getVisibleCanvasElement() {
    for (const sel of ['compare-slider', 'upscale-preview', 'image-cropper', 'image-drop-zone']) {
      const el = this.#q(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  #snapCenterVisibleCanvas() {
    const el = this.#getVisibleCanvasElement();
    if (!el) return;
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const fullyVisible = rect.top >= 0 && rect.bottom <= vh;
      if (fullyVisible) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  #persistViewState() {
    localStorage.setItem('upscaler_view_expanded', this.#viewState.expanded ? '1' : '0');
    localStorage.setItem('upscaler_view_upscaled_only', this.#viewState.upscaledOnly ? '1' : '0');
  }

  #applyViewState() {
    const expanded = this.#viewState.expanded;
    this.#q('image-cropper').classList.toggle('expanded', expanded);
    this.#q('upscale-preview').classList.toggle('expanded', expanded);
    this.#q('compare-slider').classList.toggle('expanded', expanded);
    this.#syncViewSizeButtonLabel();
  }

  #setupUpscaleActions() {
    const statusBar     = this.#q('status-bar');
    const dropZone      = this.#q('image-drop-zone');
    const cropper       = this.#q('image-cropper');
    const preview       = this.#q('upscale-preview');
    const compareSlider = this.#q('compare-slider');
    const perfMonitor   = this.#q('perf-monitor');
    const upscaleBtn    = this.#q('.upscale-btn');
    const stopBtn       = this.#q('.stop-btn');
    const startOverBtn  = this.#q('.startover-btn');
    const clearCropBtn  = this.#q('.clear-crop-btn');
    const zoomToggleBtn = this.#q('.zoom-toggle-btn');
    const openInTabBtn  = this.#q('.open-in-tab-btn');
    const downloadBtn   = this.#q('.download-btn');
    const toolbarLeft   = this.#q('.canvas-toolbar-left');
    const toolbarRight  = this.#q('.canvas-toolbar-right');
    const zoomHint      = this.#q('.canvas-zoom-hint');
    const modelEl       = this.#q('.model-select');
    const editCustomBtn = this.#q('.edit-custom-model-btn');
    const deleteCustomBtn = this.#q('.delete-custom-model-btn');

    const CROP_HINT = ' \u2014 drag to crop (optional).';

    const syncZoomToggleLabel = () => {
      const upscaledOnly = !!this.#viewState.upscaledOnly;
      const icon = upscaledOnly ? 'fa-arrows-left-right' : 'fa-magnifying-glass-plus';
      const label = upscaledOnly ? 'Use Slider' : 'Use Zoom';
      zoomToggleBtn.innerHTML = `<i class="fas ${icon}"></i> <span class="btn-label">${label}</span>`;
      const compareShowing = zoomToggleBtn.style.display !== 'none';
      zoomHint.hidden = !(upscaledOnly && compareShowing);
    };
    syncZoomToggleLabel();

    const showCompareControls = () => {
      zoomToggleBtn.style.display = 'inline-block';
      toolbarRight.hidden = false;
      syncZoomToggleLabel();
    };
    const hideCompareControls = () => {
      zoomToggleBtn.style.display = 'none';
      toolbarRight.hidden = true;
      zoomHint.hidden = true;
    };

    statusBar.message = 'Load an image to begin.';

    this.#q('.perf-toggle-btn').addEventListener('click', () => {
      perfMonitor.visible ? perfMonitor.hide() : perfMonitor.show();
    });

    this.#q('.clear-cache-btn').addEventListener('click', () => {
      if (this.#running) return;
      this.#pipeline.destroy();
      statusBar.message = 'Model cache cleared.';
    });

    const resetToStart = () => {
      this.#loadedImage = null;
      this.#running = false;
      this.#generation++;
      this.#abortController = null;
      upscaleBtn.disabled = true;
      stopBtn.style.display = 'none';
      startOverBtn.style.display = 'none';
      clearCropBtn.style.display = 'none';
      hideCompareControls();
      toolbarLeft.hidden = true;
      cropper.hide();
      preview.hide();
      compareSlider.hide();
      dropZone.show();
      statusBar.message = 'Load an image to begin.';
      statusBar.hideProgress();
    };

    const showReady = () => {
      upscaleBtn.disabled = false;
      startOverBtn.style.display = 'inline-block';
      clearCropBtn.style.display = 'none';
      hideCompareControls();
      toolbarLeft.hidden = false;
      compareSlider.hide();
      preview.hide();
      dropZone.hide();
      cropper.show(this.#loadedImage);
      statusBar.message = `${this.#loadedImage.width}\u00d7${this.#loadedImage.height}${CROP_HINT}`;
      statusBar.hideProgress();
    };

    dropZone.addEventListener('image-loaded', (e) => {
      if (this.#running) {
        this.#abortController?.abort();
        this.#running = false;
        this.#generation++;
        this.#abortController = null;
        stopBtn.style.display = 'none';
        this.#q('.clear-cache-btn').disabled = false;
      }
      this.#loadedImage = e.detail.image;
      showReady();
    });

    cropper.addEventListener('crop-changed', (e) => {
      const crop = e.detail.crop;
      if (crop) {
        clearCropBtn.style.display = 'inline-block';
        statusBar.message = `${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 crop ${crop.w}\u00d7${crop.h}.`;
      } else {
        clearCropBtn.style.display = 'none';
        statusBar.message = `${this.#loadedImage.width}\u00d7${this.#loadedImage.height}${CROP_HINT}`;
      }
    });

    clearCropBtn.addEventListener('click', () => {
      cropper.clearCrop();
    });

    modelEl.addEventListener('change', async () => {
      if (modelEl.value === UPLOAD_CUSTOM_VALUE) {
        const previousOption = Array.from(modelEl.options).find((opt) => opt.value === this.#previousModelValue);
        const defaultScale = parseInt(previousOption?.dataset.scale, 10) || 4;
        const customModel = await this.#q('custom-model-upload-dialog').open({ defaultScale });
        if (!customModel) {
          modelEl.value = this.#previousModelValue;
        } else {
          this.#customModels = listCustomModels();
          this.#refreshModelSelectOptions(customModel.url);
          this.#previousModelValue = customModel.url;
          statusBar.message = `Added "${customModel.label}" (${customModel.scale}x, ~${customModel.sizeMB}MB).`;
        }
      } else {
        this.#previousModelValue = modelEl.value;
      }
      localStorage.setItem('upscaler_model', modelEl.value);
      this.#updateModelBoundControls();
      this.#updateCustomDeleteVisibility();
    });

    editCustomBtn.addEventListener('click', async () => {
      if (this.#running) return;
      const selected = getCustomModelByUrl(modelEl.value);
      if (!selected) return;
      const updated = await this.#q('custom-model-upload-dialog').open({ editModel: selected });
      if (!updated) return;
      this.#customModels = listCustomModels();
      this.#refreshModelSelectOptions(updated.url);
      this.#previousModelValue = updated.url;
      localStorage.setItem('upscaler_model', updated.url);
      this.#updateModelBoundControls();
      this.#updateCustomDeleteVisibility();
      statusBar.message = `Updated "${updated.label}".`;
    });

    deleteCustomBtn.addEventListener('click', async () => {
      if (this.#running) return;
      const selected = getCustomModelByUrl(modelEl.value);
      if (!selected) return;
      const ok = globalThis.confirm(`Delete custom model "${selected.label}"?\n\nThis will remove it from the local model cache.`);
      if (!ok) return;
      await deleteCustomModelByUrl(selected.url);
      this.#customModels = listCustomModels();
      this.#refreshModelSelectOptions();
      if (modelEl.value === UPLOAD_CUSTOM_VALUE && modelEl.options.length > 1) {
        modelEl.selectedIndex = 0;
      }
      this.#previousModelValue = modelEl.value;
      localStorage.setItem('upscaler_model', modelEl.value);
      this.#updateModelBoundControls();
      this.#updateCustomDeleteVisibility();
      statusBar.message = `Deleted "${selected.label}".`;
    });

    this.#q('.tilesize-select').addEventListener('change', () => {
      this.#updateHangWarning();
    });

    // The pass selectors can also carry a max-tile cap (custom DAT models
    // etc.), so toggling a pass on/off or switching its model has to refresh
    // the tile-size dropdown's enabled set the same way the main model
    // change does.
    for (const sel of [
      '.pass-all-enabled',
      '.pass-all-model',
      '.pass-compare-enabled',
      '.pass-compare-model',
      '.detector-face-enabled',
      '.detector-face-model',
    ]) {
      this.#q(sel)?.addEventListener('change', () => this.#updateModelBoundControls());
    }

    this.#q('.pass-compare-enabled')?.addEventListener('change', () => {
      this.#syncComparisonExclusion();
    });

    const wireMirror = (selector, mirrorSelector) => {
      this.#q(selector).addEventListener('input', (e) => {
        this.#q(mirrorSelector).textContent = e.target.value;
      });
    };
    wireMirror('.pass-all-blend',      '.pass-all-blend-val');
    wireMirror('.detector-face-score', '.detector-face-score-val');
    wireMirror('.detector-face-blend', '.detector-face-blend-val');

    // --- Upscale pipeline ---

    upscaleBtn.addEventListener('click', async () => {
      if (this.#running || !this.#loadedImage) return;
      this.#running = true;
      const gen = ++this.#generation;
      this.#abortController = new AbortController();

      upscaleBtn.disabled = true;
      this.#q('.clear-cache-btn').disabled = true;
      stopBtn.style.display = 'inline-block';
      startOverBtn.style.display = 'none';
      clearCropBtn.style.display = 'none';
      hideCompareControls();
      compareSlider.hide();

      try {
        statusBar.showProgress(0);
        const inputImage = cropper.extractImage();
        cropper.style.display = 'none';

        const signal = this.#abortController.signal;
        const parsedOutputScale = parseInt(this.#q('.output-select').value, 10);
        const requestedOutputScale = Number.isFinite(parsedOutputScale) ? parsedOutputScale : 4;

        let beforeCanvas, afterCanvas, scale, comparison;

        if (this.#q('.mode-select').value === 'runpod') {
          ({ beforeCanvas, afterCanvas, scale, comparison } = await this.#runRunPodUpscale(
            inputImage, signal, statusBar, preview,
          ));
        } else {
          ({ beforeCanvas, afterCanvas, scale, comparison } = await this.#runLocalUpscale(
            inputImage, signal, requestedOutputScale, statusBar, preview, perfMonitor,
          ));
        }

        statusBar.hideProgress();
        const outW = inputImage.width * scale;
        const outH = inputImage.height * scale;
        statusBar.message = `Done: ${inputImage.width}\u00d7${inputImage.height} \u2192 ${outW}\u00d7${outH}.`;

        compareSlider.classList.toggle('expanded', this.#viewState.expanded);
        await compareSlider.show(beforeCanvas, afterCanvas, {
          downloadName: comparison ? `comparison_${scale}x.png` : `upscaled_${scale}x.png`,
        });
        compareSlider.setUpscaledOnly(this.#viewState.upscaledOnly);
        preview.hide();
        showCompareControls();

      } catch (e) {
        if (e.name === 'AbortError') {
          statusBar.message = 'Cancelled.';
        } else {
          console.error(e);
          const opt = this.#q('.model-select')?.selectedOptions?.[0];
          const parsedMaxTile = parseInt(opt?.dataset?.maxtilesize, 10);
          statusBar.message = 'Error: ' + formatUpscaleErrorMessage(e, {
            layout: opt?.dataset?.layout,
            multipleOf: parseInt(opt?.dataset?.multipleof, 10),
            maxTileSize: Number.isFinite(parsedMaxTile) ? parsedMaxTile : null,
          });
        }
        statusBar.hideProgress();
        perfMonitor.stop();
      }

      if (this.#generation === gen) {
        this.#running = false;
        this.#abortController = null;
        stopBtn.style.display = 'none';
        startOverBtn.style.display = 'inline-block';
        upscaleBtn.disabled = false;
        this.#q('.clear-cache-btn').disabled = false;
      }
    });

    stopBtn.addEventListener('click', () => {
      this.#abortController?.abort();
    });

    startOverBtn.addEventListener('click', () => {
      if (this.#running) this.#abortController?.abort();
      resetToStart();
    });

    zoomToggleBtn.addEventListener('click', () => {
      compareSlider.toggleUpscaledView();
    });
    openInTabBtn.addEventListener('click', () => {
      compareSlider.openInTab();
    });
    downloadBtn.addEventListener('click', () => {
      compareSlider.download();
    });

    compareSlider.addEventListener('view-state-change', () => {
      syncZoomToggleLabel();
    });
  }

  #updateModelBoundControls() {
    const modelEl = this.#q('.model-select');
    const outputEl = this.#q('.output-select');
    const tileEl = this.#q('.tilesize-select');
    const upscaleBtn = this.#q('.upscale-btn');

    if (!this.#outputBaseLabels) {
      this.#outputBaseLabels = new Map(Array.from(outputEl.options).map(opt => [
        opt.value,
        opt.textContent.replace(/\s+\(no downscale\)$/i, ''),
      ]));
    }

    const modelOpt = modelEl.selectedOptions[0];
    const scale = parseInt(modelOpt?.dataset.scale, 10) || 4;
    const verb = scale === 1 ? 'Enhance' : 'Upscale';
    const maxOutputScale = Math.max(1, Math.min(scale, 4));
    const isBuiltInResampler = this.#isBuiltInResampler(modelOpt);
    const previousOutputScale = parseInt(outputEl.value, 10);

    upscaleBtn.innerHTML = `<i class="fas fa-wand-magic-sparkles"></i> <span class="btn-label">${verb} ${scale}x</span>`;

    for (const opt of outputEl.options) {
      const optionScale = parseInt(opt.value, 10) || 1;
      const baseLabel = this.#outputBaseLabels.get(opt.value) || `${optionScale}x`;
      opt.textContent = !isBuiltInResampler && optionScale === maxOutputScale
        ? `${baseLabel} (no downscale)`
        : baseLabel;
      opt.disabled = optionScale > maxOutputScale;
    }

    const preferredScale = Number.isFinite(previousOutputScale) ? previousOutputScale : maxOutputScale;
    const nextOutputScale = Math.max(1, Math.min(maxOutputScale, preferredScale));
    outputEl.value = String(nextOutputScale);
    localStorage.setItem('upscaler_output', outputEl.value);
    this.#q('.backend-select').disabled = isBuiltInResampler;
    tileEl.disabled = isBuiltInResampler;

    // Compute the strictest tile-size cap from the main model plus any
    // enabled pass models — so picking a 64-cap custom model as the
    // all-pass also disables tiles >64 in the dropdown, even if the main
    // model has no cap.
    const capCandidates = [modelOpt];
    if (this.#q('.pass-all-enabled')?.checked) {
      capCandidates.push(this.#q('.pass-all-model')?.selectedOptions[0]);
    }
    if (this.#q('.pass-compare-enabled')?.checked) {
      capCandidates.push(this.#q('.pass-compare-model')?.selectedOptions[0]);
    }
    if (this.#q('.detector-face-enabled')?.checked) {
      capCandidates.push(this.#q('.detector-face-model')?.selectedOptions[0]);
    }
    const caps = capCandidates
      .map((o) => parseInt(o?.dataset?.maxtilesize, 10))
      .filter((v) => Number.isFinite(v) && v >= 1);
    const hasMaxTile = caps.length > 0;
    const maxTileSize = hasMaxTile ? Math.min(...caps) : Infinity;
    let largestEnabledTileVal = null;
    for (const opt of tileEl.options) {
      const optVal = parseInt(opt.value, 10);
      const isFullImage = optVal === 0;
      const exceeds = hasMaxTile && (isFullImage || optVal > maxTileSize);
      opt.disabled = exceeds;
      if (!opt.disabled && Number.isFinite(optVal) && optVal > 0) {
        if (largestEnabledTileVal === null || optVal > largestEnabledTileVal) {
          largestEnabledTileVal = optVal;
        }
      }
    }
    if (hasMaxTile && tileEl.selectedOptions[0]?.disabled && largestEnabledTileVal != null) {
      tileEl.value = String(largestEnabledTileVal);
      localStorage.setItem('upscaler_tilesize', tileEl.value);
    }

    this.#updateHangWarning();
  }

  #updateCustomDeleteVisibility() {
    const modelEl = this.#q('.model-select');
    const editCustomBtn = this.#q('.edit-custom-model-btn');
    const deleteCustomBtn = this.#q('.delete-custom-model-btn');
    const selected = getCustomModelByUrl(modelEl.value);
    deleteCustomBtn.hidden = !selected;
    deleteCustomBtn.disabled = !selected || this.#running;
    deleteCustomBtn.title = selected
      ? `Delete custom model "${selected.label}"`
      : 'Delete selected custom model';
    editCustomBtn.hidden = !selected;
    editCustomBtn.disabled = !selected || this.#running;
    editCustomBtn.title = selected
      ? `Edit custom model "${selected.label}"`
      : 'Edit selected custom model';
  }

  #updateInputMirrors() {
    this.#q('.pass-all-blend-val').textContent = this.#q('.pass-all-blend').value;
    this.#q('.detector-face-score-val').textContent = this.#q('.detector-face-score').value;
    this.#q('.detector-face-blend-val').textContent = this.#q('.detector-face-blend').value;
  }

  // When Comparison is on, the All/Faces passes are mutually exclusive — they
  // would muddy what the slider is showing. We disable their controls and dim
  // the rows, but we leave the underlying values untouched so toggling
  // Comparison off restores the user's prior pass setup verbatim.
  #syncComparisonExclusion() {
    const compareOn = !!this.#q('.pass-compare-enabled')?.checked;
    const otherRows = this.querySelectorAll('.detector-row:not(.pass-compare-row)');
    for (const row of otherRows) {
      row.classList.toggle('passes-disabled', compareOn);
      for (const ctrl of row.querySelectorAll('input, select')) {
        ctrl.disabled = compareOn;
      }
    }
  }

  #updateHangWarning() {
    const modelOpt = this.#q('.model-select').selectedOptions[0];
    if (this.#isBuiltInResampler(modelOpt)) {
      this.#q('.hang-warn').classList.remove('visible');
      return;
    }
    const sizeMB = parseFloat(modelOpt?.dataset.sizemb) || 0;
    const tileSize = parseInt(this.#q('.tilesize-select').value, 10);
    const show = sizeMB > 10 && tileSize > 128;
    this.#q('.hang-warn').classList.toggle('visible', show);
  }

  // --- Config extraction ---

  #extractConfig() {
    const opt = this.#q('.model-select').selectedOptions[0];
    const modelUrl = opt.value;
    const scale = parseInt(opt.dataset.scale, 10) || 4;
    const modelValueRange = parseInt(opt.dataset.range, 10) || 1;
    const modelLayout = opt.dataset.layout || 'nchw';
    const modelInputMultiple = parseInt(opt.dataset.multipleof, 10) || 1;
    const backend = opt.dataset.backend || this.#q('.backend-select').value;
    let tileSize = parseInt(this.#q('.tilesize-select').value, 10);
    const profile = this.#q('perf-monitor').visible;

    const config = { modelUrl, scale, modelValueRange, modelLayout, modelInputMultiple, backend, tileSize, profile };

    // Track every option that contributes to the run, so the tile-size cap
    // below covers the strictest model among the main + enabled passes —
    // not just the primary one.
    const optionsForClamp = [opt];

    // Comparison runs the base + a second SR pass and shows them side-by-
    // side; All/Faces would mutate the base canvas the slider is supposed to
    // expose, so we suppress them entirely whenever Comparison is on. The UI
    // already disables those rows — this is the matching defensive guard at
    // the config layer.
    const compareOn = this.#q('.pass-compare-enabled').checked;

    if (compareOn) {
      const copt = this.#q('.pass-compare-model').selectedOptions[0];
      if (copt) optionsForClamp.push(copt);
      config.comparison = {
        modelUrl: copt?.value || modelUrl,
        scale: parseInt(copt?.dataset.scale, 10) || scale,
        modelValueRange: parseInt(copt?.dataset.range, 10) || 1,
        modelLayout: copt?.dataset.layout || 'nchw',
        modelInputMultiple: parseInt(copt?.dataset.multipleof, 10) || 1,
        backend: copt?.dataset.backend || backend,
      };
    } else {
      if (this.#q('.pass-all-enabled').checked) {
        const aopt = this.#q('.pass-all-model').selectedOptions[0];
        if (aopt) optionsForClamp.push(aopt);
        config.all = {
          modelUrl: aopt?.value || modelUrl,
          scale: parseInt(aopt?.dataset.scale, 10) || scale,
          modelValueRange: parseInt(aopt?.dataset.range, 10) || 1,
          modelLayout: aopt?.dataset.layout || 'nchw',
          modelInputMultiple: parseInt(aopt?.dataset.multipleof, 10) || 1,
          backend: aopt?.dataset.backend || backend,
          blendOpacity: parseFloat(this.#q('.pass-all-blend').value),
        };
      }

      if (this.#q('.detector-face-enabled').checked) {
        const fopt = this.#q('.detector-face-model').selectedOptions[0];
        if (fopt) optionsForClamp.push(fopt);
        config.face = {
          modelUrl: fopt?.value || modelUrl,
          scale: parseInt(fopt?.dataset.scale, 10) || scale,
          modelValueRange: parseInt(fopt?.dataset.range, 10) || 1,
          modelLayout: fopt?.dataset.layout || 'nchw',
          modelInputMultiple: parseInt(fopt?.dataset.multipleof, 10) || 1,
          backend: fopt?.dataset.backend || backend,
          paddingPx: parseInt(this.#q('.detector-face-padding').value, 10) || 0,
          featherPx: 16,
          blendOpacity: parseFloat(this.#q('.detector-face-blend').value),
          scoreThreshold: parseFloat(this.#q('.detector-face-score').value),
        };
      }
    }

    // Models with a hard input-size cap (e.g. DAT exports with baked-in
    // window counts) only accept tiles up to a fixed dim. We clamp the
    // pipeline's shared tile size to the strictest selected model so the
    // engine never feeds anything past any model's limit. Combined with
    // each model's modelInputMultiple == maxTileSize, every padded tile
    // lands at exactly the cap.
    const caps = optionsForClamp
      .map((o) => parseInt(o?.dataset?.maxtilesize, 10))
      .filter((v) => Number.isFinite(v) && v >= 1);
    if (caps.length) {
      const minCap = Math.min(...caps);
      if (tileSize <= 0 || tileSize > minCap) tileSize = minCap;
      config.tileSize = tileSize;
    }

    return config;
  }

  async #runBuiltInResampleUpscale(inputImage, signal, requestedOutputScale, statusBar, preview, modelUrl) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const isLanczos = modelUrl === 'builtin:lanczos-4x';
    const methodLabel = isLanczos ? 'Lanczos' : 'Bicubic';
    const scale = 4;
    const outW = inputImage.width * scale;
    const outH = inputImage.height * scale;

    preview.showDimmedPreview(inputImage, outW, outH);
    statusBar.showProgress(0.25);
    statusBar.message = `${methodLabel} resampling\u2026`;

    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = outW;
    resultCanvas.height = outH;
    const ctx = resultCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = isLanczos ? 'high' : 'medium';
    ctx.drawImage(inputImage, 0, 0, outW, outH);

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    statusBar.showProgress(1);
    const outputScale = Math.max(1, Math.min(requestedOutputScale, scale));
    const canvases = this.#createComparisonCanvases(resultCanvas, inputImage, outputScale);
    return { ...canvases, scale: outputScale };
  }

  // --- Pipeline branches ---

  async #runLocalUpscale(inputImage, signal, requestedOutputScale, statusBar, preview, perfMonitor) {
    const modelOpt = this.#q('.model-select').selectedOptions[0];
    if (this.#isBuiltInResampler(modelOpt)) {
      return this.#runBuiltInResampleUpscale(
        inputImage,
        signal,
        requestedOutputScale,
        statusBar,
        preview,
        modelOpt.value,
      );
    }

    const config = this.#extractConfig();
    if (perfMonitor.visible) perfMonitor.start(config.backend);
    const stepLabel = {
      tiledUpscale: 'Upscaling',
      comparison: 'Comparison',
      blendAll: 'All-pass',
      detectFaces: 'Detecting',
      enhanceFaces: 'Faces',
    };

    const outW = inputImage.width * config.scale;
    const outH = inputImage.height * config.scale;
    preview.showDimmedPreview(inputImage, outW, outH);
    statusBar.message = `Upscaling ${inputImage.width}\u00d7${inputImage.height} \u2192 ${outW}\u00d7${outH}\u2026`;

    const result = await this.#pipeline.run(inputImage, config, {
      onProgress(frac, msg) {
        statusBar.showProgress(frac);
        statusBar.message = msg;
      },
      onStage(stage) {
        const label = stepLabel[stage.step] || stage.step;
        const prefix = label ? `${label}: ` : '';
        if (typeof stage.progress === 'number') statusBar.showProgress(stage.progress);
        if (stage.message) statusBar.message = prefix + stage.message;
        else if (stage.phase === 'start') statusBar.message = `${label}…`;
        if (perfMonitor.visible) perfMonitor.updateStage(stage);
      },
      onTile(info) {
        if (info.step === 'tiledUpscale') {
          preview.drawTile(info);
        } else if (info.step === 'comparison') {
          preview.drawTile(info);
        } else if (info.step === 'blendAll') {
          preview.drawTile(info, { opacity: config.all?.blendOpacity ?? 1 });
        } else if (info.step === 'enhanceFaces' && info.composited) {
          preview.drawTile(info);
        }
        statusBar.showProgress((info.index + 1) / info.total);
        const label = stepLabel[info.step] || info.step || 'Pass';
        if (info.step === 'enhanceFaces') {
          if (info.composited) {
            statusBar.message = `${label}: face ${(info.faceIndex ?? 0) + 1}/${info.faceTotal ?? '?'} done`;
          } else {
            const faceN = Number.isFinite(info.faceIndex) ? info.faceIndex + 1 : null;
            const faceTotal = Number.isFinite(info.faceTotal) ? info.faceTotal : null;
            const facePrefix = faceN && faceTotal ? `face ${faceN}/${faceTotal}, ` : '';
            const faceTileTotal = Number.isFinite(info.faceTileTotal) ? info.faceTileTotal : info.total;
            statusBar.message = `${label}: ${facePrefix}tile ${info.index + 1}/${faceTileTotal}`;
          }
        } else {
          statusBar.message = `${label}: tile ${info.index + 1}/${info.total}`;
        }
        if (perfMonitor.visible) perfMonitor.update({
          step: info.step,
          index: info.index, total: info.total,
          tileMs: info.tileMs, tilePixels: info.tilePixels, perf: info.perf,
        });
      },
      signal,
    });

    if (result.perf || result.pipelinePerf) {
      perfMonitor.showResults(result.perf, result.ortProfile, result.pipelinePerf);
    }

    const outputScale = Math.max(1, Math.min(requestedOutputScale, result.scale));
    if (config.comparison && result.comparisonImage) {
      const canvases = this.#createComparisonPairCanvases(
        result.image, result.comparisonImage, inputImage, outputScale,
      );
      return { ...canvases, scale: outputScale, comparison: true };
    }
    const canvases = this.#createComparisonCanvases(result.image, inputImage, outputScale);
    return { ...canvases, scale: outputScale, comparison: false };
  }

  async #runRunPodUpscale(inputImage, signal, statusBar, preview) {
    const endpointEl = this.#q('.runpod-endpoint');
    const apikeyEl = this.#q('.runpod-apikey');
    if (!endpointEl.value || !apikeyEl.value) {
      throw new Error('Enter your RunPod Endpoint ID and API Key.');
    }

    const { RunPodEngine } = await import('./runpod-engine.js');
    const engine = new RunPodEngine({
      endpointId: endpointEl.value.trim(),
      apiKey: apikeyEl.value.trim(),
      scale: 4,
    });

    const parsedOutputScale = parseInt(this.#q('.output-select').value, 10);
    const requestedScale = Number.isFinite(parsedOutputScale) ? parsedOutputScale : 4;
    const finalScale = Math.max(1, Math.min(requestedScale, 4));

    const outW = inputImage.width * 4;
    const outH = inputImage.height * 4;
    preview.showDimmedPreview(inputImage, outW, outH);
    statusBar.message = `Upscaling ${inputImage.width}\u00d7${inputImage.height} via RunPod\u2026`;
    statusBar.showIndeterminate();

    const { canvas: resultCanvas, scale: actualScale } = await engine.upscale(
      inputImage,
      (msg) => { statusBar.message = msg; },
      signal,
    );

    const scale = Math.min(finalScale, actualScale);
    const canvases = this.#createComparisonCanvases(resultCanvas, inputImage, scale);
    return { ...canvases, scale, comparison: false };
  }

  // --- Settings ---

  #restoreSettings() {
    for (const { selector, key, kind } of PERSISTED_CONTROLS) {
      const saved = localStorage.getItem(key);
      if (saved === null) continue;
      writeControl(this.#q(selector), kind, saved);
    }
    this.#viewState.expanded = localStorage.getItem('upscaler_view_expanded') === '1';
    this.#viewState.upscaledOnly = localStorage.getItem('upscaler_view_upscaled_only') === '1';

    const modelEl = this.#q('.model-select');
    if (!modelEl.selectedOptions.length) modelEl.selectedIndex = 0;
    this.#previousModelValue = modelEl.value;

    this.#applyViewState();
    this.#q('compare-slider').setUpscaledOnly(this.#viewState.upscaledOnly);
    this.#syncComparisonExclusion();
    this.#updateModelBoundControls();
    this.#updateInputMirrors();
    this.#updateCustomDeleteVisibility();
  }

  // --- Template ---

  #render() {
    morph(this, `
      <style>
        upscaler-app .controls {
          display: flex; flex-wrap: wrap; gap: 0.4rem 0.75rem;
          align-items: center; margin-bottom: 1rem;
        }
        upscaler-app .controls label {
          display: inline-flex; align-items: center; gap: 0.35rem;
          font-size: 0.85rem; margin-bottom: 0; white-space: nowrap;
        }
        upscaler-app .controls select,
        upscaler-app .controls input {
          margin-bottom: 0; padding: 0.3rem 0.5rem;
          font-size: 0.85rem; width: auto;
        }
        upscaler-app select:not([multiple], [size]) {
          max-width: 100%;
          padding-left: 0.7rem;
          padding-right: 2.25rem;
          padding-inline-start: 0.7rem;
          padding-inline-end: 2.25rem;
          background-position: center right 0.7rem;
          overflow: hidden;
          white-space: nowrap;
        }
        upscaler-app select.model-select,
        upscaler-app select.pass-all-model,
        upscaler-app select.pass-compare-model,
        upscaler-app select.detector-face-model {
          width: min(100%, 25em);
          max-width: 25em;
          text-overflow: ellipsis;
        }
        upscaler-app select.output-select {
          width: min(100%, calc(2ch + 0.7rem + 2.25rem));
          max-width: calc(2ch + 0.7rem + 2.25rem);
        }
        upscaler-app select.tilesize-select {
          width: min(100%, calc(3ch + 0.7rem + 2.25rem));
          max-width: calc(3ch + 0.7rem + 2.25rem);
        }
        upscaler-app select.backend-select {
          width: min(100%, calc(4ch + 0.7rem + 2.25rem));
          max-width: calc(4ch + 0.7rem + 2.25rem);
        }
        upscaler-app .delete-custom-model-btn,
        upscaler-app .edit-custom-model-btn {
          padding: 0.3rem 0.55rem;
          min-width: 2rem;
        }
        upscaler-app .controls button {
          margin-bottom: 0; padding: 0.4rem 0.8rem;
          font-size: 0.85rem; width: auto;
        }
        upscaler-app .local-controls,
        upscaler-app .runpod-controls {
          display: inline-flex; flex-wrap: wrap; gap: 0.4rem 0.75rem;
          align-items: center;
        }
        upscaler-app .passes-panel {
          margin-bottom: 1rem;
          padding: 0.6rem 0.7rem;
          border: 1px solid var(--pico-muted-border-color);
          border-radius: var(--pico-border-radius);
        }
        upscaler-app .passes-panel > summary {
          cursor: pointer;
          font-size: 0.9rem;
          user-select: none;
          margin-bottom: 0;
          padding: 0.15rem 0;
        }
        upscaler-app .detector-row {
          display: grid;
          grid-template-columns:
            minmax(11rem, 1fr)
            minmax(17rem, 2.2fr)
            minmax(13rem, 1.2fr)
            minmax(14rem, 1.35fr);
          gap: 0.35rem 0.55rem;
          align-items: center;
          width: 100%;
          max-width: none;
          margin-top: 0.45rem;
        }
        upscaler-app .detector-row:first-of-type {
          margin-top: 0;
        }
        upscaler-app .detector-row.passes-disabled {
          opacity: 0.5;
        }
        upscaler-app .detector-row label {
          margin-bottom: 0;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          column-gap: 0.35rem;
          font-size: 0.85rem;
          min-height: 2rem;
          width: 100%;
        }
        upscaler-app .detector-row .check-control {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          width: auto;
        }
        upscaler-app .detector-row .range-control {
          grid-template-columns: auto auto;
        }
        upscaler-app .detector-row .range-field {
          display: inline-grid;
          grid-auto-flow: column;
          align-items: center;
          column-gap: 0.3rem;
        }
        upscaler-app .detector-row .range-input {
          width: 7rem;
          vertical-align: middle;
        }
        upscaler-app .detector-row .range-value {
          min-width: 4ch;
          font-variant-numeric: tabular-nums;
        }
        upscaler-app .detector-row input,
        upscaler-app .detector-row select {
          margin-bottom: 0;
        }
        upscaler-app .detector-row input[type="checkbox"] {
          margin-top: 0;
        }
        upscaler-app .detector-row .model-control select {
          width: 100%;
          min-width: 0;
        }
        upscaler-app .detector-row .model-control {
          grid-template-columns: minmax(0, 1fr);
        }
        @media (max-width: 980px) {
          upscaler-app .detector-row {
            grid-template-columns: 1fr;
          }
        }
        upscaler-app .hang-warn {
          display: none;
          position: relative;
          color: var(--pico-del-color, #c62828);
          font-size: 1rem;
          cursor: help;
          align-self: center;
        }
        upscaler-app .hang-warn.visible {
          display: inline-flex;
        }
        upscaler-app .hang-warn .hang-warn-tip {
          display: none;
          position: absolute;
          bottom: calc(100% + 0.45rem);
          left: 50%;
          transform: translateX(-50%);
          background: var(--pico-card-background-color, #1e1e2e);
          color: var(--pico-color, #cdd6f4);
          border: 1px solid var(--pico-muted-border-color);
          border-radius: var(--pico-border-radius);
          padding: 0.5rem 0.65rem;
          font-size: 0.78rem;
          line-height: 1.4;
          white-space: normal;
          width: max-content;
          max-width: 26rem;
          z-index: 10;
          pointer-events: none;
          box-shadow: 0 2px 8px rgba(0,0,0,.25);
        }
        upscaler-app .hang-warn:hover .hang-warn-tip {
          display: block;
        }
        upscaler-app .canvas-stack {
          position: relative;
          background: rgba(0, 0, 0, 0.4);
          border-radius: var(--pico-border-radius);
          padding: 0.5rem;
        }
        upscaler-app .canvas-toolbar-rail {
          position: sticky;
          top: 0.75rem;
          height: 0;
          z-index: 10;
          pointer-events: none;
        }
        upscaler-app .canvas-toolbar {
          position: absolute;
          top: 0;
          display: inline-flex;
          gap: 0.25rem;
          align-items: center;
          padding: 0.25rem 0.3rem;
          background: color-mix(in oklab, var(--pico-card-background-color, #1e1e2e) 32%, transparent);
          border: 1px solid color-mix(in oklab, var(--pico-muted-border-color) 45%, transparent);
          border-radius: var(--pico-border-radius);
          box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(10px) saturate(1.1);
          -webkit-backdrop-filter: blur(10px) saturate(1.1);
          pointer-events: auto;
          max-width: calc(100% - 1.5rem);
        }
        upscaler-app .canvas-toolbar-left {
          left: 0.75rem;
        }
        upscaler-app .canvas-toolbar-right {
          right: 0.75rem;
        }
        upscaler-app .canvas-toolbar[hidden] {
          display: none;
        }
        upscaler-app .canvas-toolbar-stack-left {
          position: absolute;
          top: 0;
          left: 0.75rem;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 0.25rem;
          max-width: calc(100% - 1.5rem);
          pointer-events: none;
        }
        upscaler-app .canvas-toolbar-stack-left > * {
          pointer-events: auto;
        }
        upscaler-app .canvas-toolbar-stack-left > .canvas-toolbar {
          position: static;
          left: auto;
          top: auto;
          max-width: 100%;
        }
        upscaler-app .canvas-zoom-hint {
          font-size: 0.7rem;
          line-height: 1.25;
          padding: 0.15rem 0.5rem;
          color: #fff;
          background: color-mix(in oklab, var(--pico-card-background-color, #1e1e2e) 32%, transparent);
          border: 1px solid color-mix(in oklab, var(--pico-muted-border-color) 45%, transparent);
          border-radius: var(--pico-border-radius);
          backdrop-filter: blur(10px) saturate(1.1);
          -webkit-backdrop-filter: blur(10px) saturate(1.1);
          max-width: 100%;
        }
        upscaler-app .canvas-zoom-hint[hidden] {
          display: none;
        }
        upscaler-app .canvas-toolbar button {
          margin-bottom: 0;
          padding: 0.25rem 0.5rem;
          font-size: 0.72rem;
          line-height: 1.2;
          width: auto;
          white-space: nowrap;
        }
        upscaler-app .canvas-toolbar button.secondary,
        upscaler-app .canvas-toolbar button.outline {
          opacity: 0.78;
          transition: opacity 0.15s ease;
          background: transparent;
          border-color: currentColor;
          color: #fff;
          mix-blend-mode: difference;
        }
        upscaler-app .canvas-toolbar button.secondary:hover,
        upscaler-app .canvas-toolbar button.outline:hover,
        upscaler-app .canvas-toolbar button.secondary:focus-visible,
        upscaler-app .canvas-toolbar button.outline:focus-visible {
          opacity: 1;
          background: transparent;
          border-color: currentColor;
          color: #fff;
        }
        upscaler-app .canvas-toolbar button .fas {
          font-size: 0.78em;
          margin-right: 0.15rem;
        }
        upscaler-app .canvas-toolbar button .btn-label {
          display: inline;
        }
        @media (max-width: 768px) {
          upscaler-app .canvas-toolbar button .btn-label {
            display: none;
          }
          upscaler-app .canvas-toolbar button .fas {
            margin-right: 0;
          }
        }
        upscaler-app .canvas-toolbar status-bar {
          display: inline-flex;
          flex-direction: column;
          align-items: stretch;
          justify-content: center;
          gap: 0.15rem;
          margin-left: 0.3rem;
          min-width: 0;
          max-width: 20rem;
        }
        upscaler-app .canvas-toolbar status-bar .status-text {
          font-size: 0.68rem;
          line-height: 1.25;
          min-height: 0;
          margin-bottom: 0;
          color: #fff;
          mix-blend-mode: difference;
        }
        upscaler-app .canvas-toolbar status-bar .progress-track {
          width: 100%;
          max-width: 180px;
          height: 3px;
          margin-bottom: 0;
          mix-blend-mode: difference;
        }
      </style>

      <select class="mode-select" hidden>
        <option value="local" selected>Local (ONNX)</option>
        <option value="runpod">RunPod Serverless</option>
      </select>

      <div class="controls">
        <span class="local-controls">
          <label>Model:
            <select class="model-select">
              ${modelOptionsHTML(undefined, { includeResamplers: true })}
              ${getUploadCustomOptionHTML()}
            </select>
          </label>
          <button class="secondary outline edit-custom-model-btn" type="button" hidden title="Edit selected custom model" aria-label="Edit selected custom model">
            <i class="fas fa-pen"></i>
          </button>
          <button class="secondary outline delete-custom-model-btn" type="button" hidden title="Delete selected custom model" aria-label="Delete selected custom model">
            <i class="fas fa-trash"></i>
          </button>
          <label>Backend:
            <select class="backend-select">
              <option value="webgpu">GPU (WebGPU)</option>
              <option value="wasm">CPU (WASM)</option>
            </select>
          </label>
          <label>Tile size:
            <select class="tilesize-select">
              <option value="64">64</option>
              <option value="80">80</option>
              <option value="128">128</option>
              <option value="192" selected>192</option>
              <option value="256">256</option>
              <option value="384">384</option>
              <option value="512">512</option>
              <option value="0">Full image (no tiling)</option>
            </select>
          </label>
          <label>Final Output:
            <select class="output-select">
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="3">3x</option>
              <option value="4" selected>4x (no downscale)</option>
            </select>
          </label>
        </span>

        <span class="runpod-controls" style="display:none">
          <label>Endpoint:
            <input class="runpod-endpoint" type="text" placeholder="ID or full URL" style="width:28ch">
          </label>
          <label>API Key:
            <input class="runpod-apikey" type="password" placeholder="rp_..." style="width:18ch">
          </label>
        </span>

        <button class="perf-toggle-btn secondary outline" title="Toggle performance monitor">
          <i class="fas fa-gauge-high"></i>
        </button>
        <span class="hang-warn" aria-label="Performance warning">
          <i class="fas fa-triangle-exclamation"></i>
          <span class="hang-warn-tip">
            Large models (&gt;10 MB) with tile sizes above 128 can block the
            browser's main thread for extended periods, causing the UI to freeze.
            You may not be able to click Stop until the current tile finishes.
            Consider reducing the tile size or using a smaller model.
          </span>
        </span>
        <button class="clear-cache-btn secondary outline" hidden title="Clear cached ONNX models (frees memory)">
          <i class="fas fa-broom"></i> Clear Cache
        </button>
      </div>

      <details class="passes-panel">
        <summary><i class="fas fa-user-check"></i> Additional Passes</summary>
        <div class="detector-row pass-compare-row">
          <label class="check-control">
            <input class="pass-compare-enabled" type="checkbox">
            Comparison
          </label>
          <label class="model-control">
            <select class="pass-compare-model" aria-label="Comparison pass model">
              ${modelOptionsHTML()}
            </select>
          </label>
        </div>
        <div class="detector-row pass-all-row">
          <label class="check-control">
            <input class="pass-all-enabled" type="checkbox">
            All (full image blend)
          </label>
          <label class="model-control">
            <select class="pass-all-model" aria-label="All pass model">
              ${modelOptionsHTML()}
            </select>
          </label>
          <label class="range-control" title="Blend opacity of the secondary full-image pass over the base upscale">
            Blend:
            <span class="range-field">
              <input class="pass-all-blend range-input" type="range" min="0" max="1" step="0.05" value="0.40">
              <span class="pass-all-blend-val range-value">0.40</span>
            </span>
          </label>
        </div>
        <div class="detector-row pass-faces-row">
          <label class="check-control">
            <input class="detector-face-enabled" type="checkbox">
            Faces (YuNet)
          </label>
          <label class="model-control">
            <select class="detector-face-model" aria-label="Face pass model">
              ${modelOptionsHTML(undefined, { selected: 'models/RMBN_M4C8_FACES_x4.onnx' })}
            </select>
          </label>
          <label class="range-control" title="Blend opacity of the face patch over the base upscale (1 = full replace, lower = transparent blend)">
            Blend:
            <span class="range-field">
              <input class="detector-face-blend range-input" type="range" min="0" max="1" step="0.05" value="0.65">
              <span class="detector-face-blend-val range-value">0.65</span>
            </span>
          </label>
          <label hidden>Padding:
            <input class="detector-face-padding" type="number" min="0" max="512" step="1" value="20" style="width:7ch">
            px
          </label>
          <label class="range-control" title="Minimum face detection confidence">
            Confidence Threshold:
            <span class="range-field">
              <input class="detector-face-score range-input" type="range" min="0.3" max="0.95" step="0.01" value="0.70">
              <span class="detector-face-score-val range-value">0.70</span>
            </span>
          </label>
        </div>
      </details>

      <custom-model-upload-dialog></custom-model-upload-dialog>

      <div class="canvas-stack">
        <div class="canvas-toolbar-rail" aria-hidden="true">
          <div class="canvas-toolbar-stack-left">
            <div class="canvas-toolbar canvas-toolbar-left" hidden>
              <button class="upscale-btn" disabled title="Upscale image">
                <i class="fas fa-wand-magic-sparkles"></i> <span class="btn-label">Upscale 4x</span>
              </button>
              <button class="stop-btn secondary" style="display:none" title="Stop upscale">
                <i class="fas fa-stop"></i> <span class="btn-label">Stop</span>
              </button>
              <button class="viewsize-btn secondary outline" type="button" title="Fit Width">
                <i class="fas fa-arrows-left-right-to-line"></i> <span class="btn-label">Fit Width</span>
              </button>
              <button class="zoom-toggle-btn secondary outline" type="button" style="display:none" title="Toggle between slider compare and upscaled-only inspection">
                <i class="fas fa-magnifying-glass-plus"></i> <span class="btn-label">Use Zoom</span>
              </button>
              <button class="clear-crop-btn secondary outline" style="display:none" type="button" title="Clear the selected crop region">
                <i class="fas fa-eraser"></i> <span class="btn-label">Clear Selection</span>
              </button>
              <button class="startover-btn secondary outline" style="display:none" title="Start over with a new image">
                <i class="fas fa-redo"></i> <span class="btn-label">Start Over</span>
              </button>
              <status-bar></status-bar>
            </div>
            <div class="canvas-zoom-hint" hidden>
              Click: Zoom \u00b7 Right-click: Compare \u00b7 Shift+Wheel: Bubble size \u00b7 Ctrl+Wheel: Zoom factor
            </div>
          </div>
          <div class="canvas-toolbar canvas-toolbar-right" hidden>
            <button class="open-in-tab-btn secondary outline" type="button" title="Open the upscaled image in a new tab">
              <i class="fas fa-up-right-from-square"></i> <span class="btn-label">Open in Tab</span>
            </button>
            <button class="download-btn secondary outline" type="button" title="Download the upscaled image">
              <i class="fas fa-download"></i> <span class="btn-label">Download</span>
            </button>
          </div>
        </div>
        <image-drop-zone></image-drop-zone>
        <image-cropper></image-cropper>
        <upscale-preview></upscale-preview>
        <compare-slider></compare-slider>
      </div>
      <perf-monitor></perf-monitor>
    `);
  }
}

customElements.define('upscaler-app', UpscalerApp);
