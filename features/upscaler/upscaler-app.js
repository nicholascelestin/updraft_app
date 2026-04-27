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
  saveCustomModel,
} from './custom-model-store.js';
import { inspectCustomModelFile } from './custom-model-inspector.js';
import 'components/image-drop-zone';
import 'components/status-bar';
import 'components/image-cropper';
import 'components/compare-slider';
import './upscale-preview.js';
import './perf-monitor.js';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const UPLOAD_CUSTOM_VALUE = '__upload_custom__';

class UpscalerApp extends HTMLElement {
  #loadedImage = null;
  #running = false;
  #generation = 0;
  #viewState = { expanded: false, upscaledOnly: false };
  #customModels = [];

  #pipeline = new Pipeline();
  #abortController = null;

  connectedCallback() {
    this.#render();
    this.#customModels = listCustomModels();
    this.#refreshModelSelectOptions(localStorage.getItem('upscaler_model') || undefined);
    this.#setupPersistence();
    this.#setupModeSwitch();
    this.#setupViewStateSync();
    this.#setupUpscaleActions();
    this.#restoreSettings();
  }

  #q(sel) { return this.querySelector(sel); }
  #isBuiltInResampler(modelOpt) { return !!modelOpt?.value?.startsWith('builtin:'); }
  #syncViewSizeButtonLabel() {
    const btn = this.#q('.viewsize-btn');
    if (!btn) return;
    btn.textContent = this.#viewState.expanded ? 'Fit to View' : 'Full Size';
  }

  #formatUpscaleErrorMessage(error) {
    const raw = error?.message || String(error || 'Unknown error');
    const isReshapeWindowError =
      /reshape_helper\.h/i.test(raw) ||
      /input_shape_size == size/i.test(raw) ||
      /cannot be reshaped to the requested shape/i.test(raw);
    if (!isReshapeWindowError) return raw;

    const modelOpt = this.#q('.model-select')?.selectedOptions?.[0];
    const layout = (modelOpt?.dataset?.layout || 'nchw').toUpperCase();
    const multiple = parseInt(modelOpt?.dataset?.multipleof, 10) || 1;
    const altLayout = layout === 'NHWC' ? 'NCHW' : 'NHWC';
    const parseShape = (text) => String(text || '')
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter(Number.isFinite);
    const shapeMatch = raw.match(/Input shape:\{([^}]*)\}.*requested shape:\{([^}]*)\}/i);
    const inputDims = shapeMatch ? parseShape(shapeMatch[1]) : [];
    const requestedDims = shapeMatch ? parseShape(shapeMatch[2]) : [];

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

    const suggestedMultiple = Math.max(multiple > 1 ? multiple : 8, inferredMultiple || 0);
    const specificHint = inferredMultiple > 8
      ? ` Based on the reported reshape, try Multiple-of ${inferredMultiple} first.`
      : '';
    return `Model reshape failed (likely window-size constraint). Try setting Multiple-of to ${suggestedMultiple} (common values: 8/16/32/64) and/or switch Layout to ${altLayout}.${specificHint} Raw error: ${raw}`;
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
  }

  async #showCustomModelUploadModal(defaultScale = 4) {
    const dialog = this.#q('.custom-model-dialog');
    const form = this.#q('.custom-model-form');
    const fileInput = this.#q('.custom-model-file');
    const labelInput = this.#q('.custom-model-label');
    const scaleInput = this.#q('.custom-model-scale');
    const rangeInput = this.#q('.custom-model-range');
    const layoutInput = this.#q('.custom-model-layout');
    const multipleInput = this.#q('.custom-model-multiple');
    const sizeLabel = this.#q('.custom-model-size');
    const detectLabel = this.#q('.custom-model-detected');
    const errorLabel = this.#q('.custom-model-error');
    const saveBtn = this.#q('.custom-model-save-btn');
    const cancelBtn = this.#q('.custom-model-cancel-btn');

    if (!dialog || !form || !fileInput || !labelInput || !scaleInput || !rangeInput || !layoutInput || !multipleInput || !sizeLabel || !detectLabel || !errorLabel || !saveBtn || !cancelBtn) {
      throw new Error('Custom model upload UI is unavailable.');
    }

    fileInput.value = '';
    labelInput.value = '';
    scaleInput.value = String(defaultScale);
    rangeInput.value = '1';
    layoutInput.value = 'nchw';
    multipleInput.value = '1';
    errorLabel.textContent = '';
    sizeLabel.textContent = 'Model size: -';
    detectLabel.textContent = 'Auto-detect: waiting for model file…';
    saveBtn.disabled = false;

    return new Promise((resolve) => {
      let settled = false;
      let inspectSeq = 0;
      const cleanup = () => {
        form.removeEventListener('submit', onSubmit);
        fileInput.removeEventListener('change', onFileChange);
        cancelBtn.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onCancel);
        dialog.removeEventListener('close', onClose);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onFileChange = () => {
        const seq = ++inspectSeq;
        const file = fileInput.files?.[0];
        if (!file) {
          sizeLabel.textContent = 'Model size: -';
          detectLabel.textContent = 'Auto-detect: waiting for model file…';
          return;
        }
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        sizeLabel.textContent = `Model size: ~${sizeMB} MB`;
        errorLabel.textContent = '';
        if (!labelInput.value.trim()) {
          labelInput.value = file.name.replace(/\.onnx$/i, '');
        }
        detectLabel.textContent = 'Auto-detect: inspecting ONNX metadata…';
        saveBtn.disabled = true;
        inspectCustomModelFile(file, {
          onProgress: (message) => {
            if (seq !== inspectSeq || settled) return;
            detectLabel.textContent = `Auto-detect: ${message}`;
          },
        }).then((result) => {
          if (seq !== inspectSeq || settled) return;
          if (Number.isFinite(result?.scale)) {
            scaleInput.value = String(result.scale);
          }
          rangeInput.value = String(result?.range === 255 ? 255 : 1);
          layoutInput.value = result?.layout === 'nhwc' ? 'nhwc' : 'nchw';
          if (Number.isFinite(result?.multipleOf)) {
            multipleInput.value = String(Math.max(1, result.multipleOf));
          }
          const parts = [];
          if (result?.layout) parts.push(`layout ${result.layout.toUpperCase()}`);
          if (Number.isFinite(result?.multipleOf)) {
            const suffix = result?.multipleOfSource === 'probe' ? ' (probed)' : '';
            parts.push(`multiple ${result.multipleOf}${suffix}`);
          }
          if (result?.inputType) parts.push(`input ${result.inputType}`);
          if (Number.isFinite(result?.scale)) {
            const suffix = result?.scaleSource === 'probe' ? ' (probed)' : result?.scaleSource === 'metadata' ? ' (metadata)' : ' (default)';
            parts.push(`scale ${result.scale}x${suffix}`);
          }
          detectLabel.textContent = parts.length
            ? `Auto-detected: ${parts.join(', ')}.`
            : 'Auto-detect finished with defaults.';
          if (Array.isArray(result?.notes) && result.notes.length) {
            errorLabel.textContent = result.notes[0];
          }
          saveBtn.disabled = false;
        }).catch((err) => {
          if (seq !== inspectSeq || settled) return;
          detectLabel.textContent = 'Auto-detect failed; using defaults.';
          errorLabel.textContent = err?.message || 'Could not inspect model metadata.';
          saveBtn.disabled = false;
        });
      };
      const onCancel = (e) => {
        e?.preventDefault?.();
        if (dialog.open) dialog.close();
        finish(null);
      };
      const onClose = () => finish(null);
      const onSubmit = async (e) => {
        e.preventDefault();
        errorLabel.textContent = '';
        const file = fileInput.files?.[0];
        if (!file) {
          errorLabel.textContent = 'Choose an ONNX model file first.';
          return;
        }
        if (!/\.onnx$/i.test(file.name)) {
          errorLabel.textContent = 'Only .onnx files are supported.';
          return;
        }
        saveBtn.disabled = true;
        try {
          const model = await saveCustomModel({
            file,
            label: labelInput.value,
            scale: scaleInput.value,
            range: rangeInput.value,
            layout: layoutInput.value,
            multipleOf: multipleInput.value,
          });
          if (dialog.open) dialog.close();
          finish(model);
        } catch (err) {
          errorLabel.textContent = err?.message || 'Failed to save model.';
          saveBtn.disabled = false;
        }
      };

      form.addEventListener('submit', onSubmit);
      fileInput.addEventListener('change', onFileChange);
      cancelBtn.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onCancel);
      dialog.addEventListener('close', onClose);
      dialog.showModal();
    });
  }

  // --- Pipeline helpers ---

  #createComparisonCanvases(resultCanvas, image, outputScale) {
    const targetScale = Math.max(1, outputScale || Math.round(resultCanvas.width / image.width) || 1);
    const w = image.width * targetScale;
    const h = image.height * targetScale;
    const needsDownscale = resultCanvas.width !== w || resultCanvas.height !== h;

    let afterCanvas = resultCanvas;
    if (needsDownscale) {
      afterCanvas = document.createElement('canvas');
      afterCanvas.width = w;
      afterCanvas.height = h;
      const afterCtx = afterCanvas.getContext('2d');
      afterCtx.imageSmoothingEnabled = true;
      afterCtx.imageSmoothingQuality = 'high';
      afterCtx.drawImage(resultCanvas, 0, 0, w, h);
    }

    const beforeCanvas = document.createElement('canvas');
    beforeCanvas.width = w;
    beforeCanvas.height = h;
    const bCtx = beforeCanvas.getContext('2d');
    bCtx.imageSmoothingEnabled = false;
    bCtx.drawImage(image, 0, 0, w, h);

    return { beforeCanvas, afterCanvas };
  }

  // --- Event setup ---

  #setupPersistence() {
    const persist = (selector, key, event = 'change') => {
      const el = this.#q(selector);
      el.addEventListener(event, () => localStorage.setItem(key, el.value));
    };
    const persistChecked = (selector, key) => {
      const el = this.#q(selector);
      el.addEventListener('change', () => localStorage.setItem(key, el.checked ? '1' : '0'));
    };

    persist('.runpod-endpoint', 'upscaler_runpod_endpoint', 'input');
    persist('.runpod-apikey', 'upscaler_runpod_apikey', 'input');
    persist('.tilesize-select', 'upscaler_tilesize');
    persist('.backend-select', 'upscaler_backend');
    persist('.output-select', 'upscaler_output');
    persistChecked('.pass-all-enabled', 'upscaler_pass_all_enabled');
    persist('.pass-all-blend', 'upscaler_pass_all_blend', 'input');
    persist('.pass-all-model', 'upscaler_pass_all_model');
    persistChecked('.detector-face-enabled', 'upscaler_detector_face_enabled');
    persist('.detector-face-padding', 'upscaler_detector_face_padding_px', 'input');
    persist('.detector-face-score', 'upscaler_detector_face_score', 'input');
    persist('.detector-face-blend', 'upscaler_detector_face_blend', 'input');
    persist('.detector-face-model', 'upscaler_detector_face_model');
  }

  #setupModeSwitch() {
    // Mode is locked to 'local' — RunPod UI hidden but code path preserved
  }

  #setupViewStateSync() {
    const cropper = this.#q('image-cropper');
    const preview = this.#q('upscale-preview');
    const compareSlider = this.#q('compare-slider');
    const viewSizeBtn = this.#q('.viewsize-btn');
    const persistViewState = () => {
      localStorage.setItem('upscaler_view_expanded', this.#viewState.expanded ? '1' : '0');
      localStorage.setItem('upscaler_view_upscaled_only', this.#viewState.upscaledOnly ? '1' : '0');
    };
    const applyExpandedAcrossViews = () => {
      cropper.setExpanded(this.#viewState.expanded);
      preview.setExpanded(this.#viewState.expanded);
      compareSlider.setExpanded(this.#viewState.expanded);
    };
    viewSizeBtn.addEventListener('click', () => {
      this.#viewState.expanded = !this.#viewState.expanded;
      applyExpandedAcrossViews();
      this.#syncViewSizeButtonLabel();
      persistViewState();
    });
    compareSlider.addEventListener('view-state-change', (e) => {
      if (typeof e.detail.upscaledOnly === 'boolean') {
        this.#viewState.upscaledOnly = e.detail.upscaledOnly;
      }
      persistViewState();
    });
    applyExpandedAcrossViews();
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
    const modelEl       = this.#q('.model-select');
    const deleteCustomBtn = this.#q('.delete-custom-model-btn');
    const backendEl     = this.#q('.backend-select');
    const tileSizeEl    = this.#q('.tilesize-select');
    const outputEl      = this.#q('.output-select');
    const outputLabelsByValue = new Map(Array.from(outputEl.options).map(opt => ([
      opt.value,
      opt.textContent.replace(/\s+\(no downscale\)$/i, ''),
    ])));

    statusBar.message = 'Load an image to begin.';

    this.#q('.perf-toggle-btn').addEventListener('click', () => {
      perfMonitor.visible ? perfMonitor.hide() : perfMonitor.show();
    });

    this.#q('.clear-cache-btn').addEventListener('click', () => {
      if (this.#running) return;
      this.#pipeline.destroy();
      statusBar.message = 'Model cache cleared — models will reload on next upscale.';
    });

    const resetToStart = () => {
      this.#loadedImage = null;
      this.#running = false;
      this.#generation++;
      this.#abortController = null;
      upscaleBtn.disabled = true;
      stopBtn.style.display = 'none';
      startOverBtn.style.display = 'none';
      cropper.hide();
      preview.cleanup();
      preview.hide();
      compareSlider.hide();
      dropZone.show();
      statusBar.message = 'Load an image to begin.';
      statusBar.hideProgress();
    };

    const showReady = () => {
      upscaleBtn.disabled = false;
      startOverBtn.style.display = 'inline-block';
      compareSlider.hide();
      preview.hide();
      preview.cleanup();
      dropZone.hide();
      cropper.show(this.#loadedImage);
      statusBar.message = `Loaded ${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 ready to upscale.`;
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
        statusBar.message = `Loaded ${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 crop ${crop.w}\u00d7${crop.h} selected \u2014 ready to upscale.`;
      } else {
        statusBar.message = `Loaded ${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 ready to upscale.`;
      }
    });

    const updateModelBoundControls = () => {
      const scale = parseInt(modelEl.selectedOptions[0]?.dataset.scale, 10) || 4;
      const verb = scale === 1 ? 'Enhance' : 'Upscale';
      const maxOutputScale = Math.max(1, Math.min(scale, 4));
      const isBuiltInResampler = this.#isBuiltInResampler(modelEl.selectedOptions[0]);
      const previousOutputScale = parseInt(outputEl.value, 10);

      upscaleBtn.innerHTML = `<i class="fas fa-wand-magic-sparkles"></i> ${verb} ${scale}x`;

      for (const opt of outputEl.options) {
        const optionScale = parseInt(opt.value, 10) || 1;
        const baseLabel = outputLabelsByValue.get(opt.value) || `${optionScale}x`;
        opt.textContent = !isBuiltInResampler && optionScale === maxOutputScale
          ? `${baseLabel} (no downscale)`
          : baseLabel;
        opt.disabled = optionScale > maxOutputScale;
      }

      const preferredScale = Number.isFinite(previousOutputScale) ? previousOutputScale : maxOutputScale;
      const nextOutputScale = Math.max(1, Math.min(maxOutputScale, preferredScale));
      outputEl.value = String(nextOutputScale);
      localStorage.setItem('upscaler_output', outputEl.value);
      backendEl.disabled = isBuiltInResampler;
      tileSizeEl.disabled = isBuiltInResampler;
      this.#updateHangWarning();
    };

    const updateCustomDeleteVisibility = () => {
      const selected = getCustomModelByUrl(modelEl.value);
      deleteCustomBtn.hidden = !selected;
      deleteCustomBtn.disabled = !selected || this.#running;
      if (selected) {
        deleteCustomBtn.title = `Delete custom model "${selected.label}"`;
      } else {
        deleteCustomBtn.title = 'Delete selected custom model';
      }
    };

    let previousModelValue = modelEl.value;
    modelEl.addEventListener('change', async () => {
      if (modelEl.value === UPLOAD_CUSTOM_VALUE) {
        const previousOption = Array.from(modelEl.options).find((opt) => opt.value === previousModelValue);
        const defaultScale = parseInt(previousOption?.dataset.scale, 10) || 4;
        const customModel = await this.#showCustomModelUploadModal(defaultScale);
        if (!customModel) {
          modelEl.value = previousModelValue;
        } else {
          this.#customModels = listCustomModels();
          this.#refreshModelSelectOptions(customModel.url);
          previousModelValue = customModel.url;
          statusBar.message = `Custom model "${customModel.label}" added (${customModel.scale}x, ~${customModel.sizeMB}MB).`;
        }
      } else {
        previousModelValue = modelEl.value;
      }
      localStorage.setItem('upscaler_model', modelEl.value);
      updateModelBoundControls();
      updateCustomDeleteVisibility();
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
      previousModelValue = modelEl.value;
      localStorage.setItem('upscaler_model', modelEl.value);
      updateModelBoundControls();
      updateCustomDeleteVisibility();
      statusBar.message = `Deleted custom model "${selected.label}".`;
    });

    this.#q('.tilesize-select').addEventListener('change', () => {
      this.#updateHangWarning();
    });

    this.#q('.pass-all-blend').addEventListener('input', (e) => {
      this.#q('.pass-all-blend-val').textContent = e.target.value;
    });
    this.#q('.detector-face-score').addEventListener('input', (e) => {
      this.#q('.detector-face-score-val').textContent = e.target.value;
    });
    this.#q('.detector-face-blend').addEventListener('input', (e) => {
      this.#q('.detector-face-blend-val').textContent = e.target.value;
    });

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
      compareSlider.hide();
      preview.cleanup();

      try {
        statusBar.showProgress(0);
        const inputImage = cropper.extractImage();
        cropper.style.display = 'none';

        const signal = this.#abortController.signal;
        const parsedOutputScale = parseInt(this.#q('.output-select').value, 10);
        const requestedOutputScale = Number.isFinite(parsedOutputScale) ? parsedOutputScale : 4;

        let beforeCanvas, afterCanvas, scale;

        if (this.#q('.mode-select').value === 'runpod') {
          ({ beforeCanvas, afterCanvas, scale } = await this.#runRunPodUpscale(
            inputImage, signal, statusBar, preview,
          ));
        } else {
          ({ beforeCanvas, afterCanvas, scale } = await this.#runLocalUpscale(
            inputImage, signal, requestedOutputScale, statusBar, preview, perfMonitor,
          ));
        }

        statusBar.hideProgress();
        const outW = inputImage.width * scale;
        const outH = inputImage.height * scale;
        statusBar.message = `Done \u2014 ${inputImage.width}\u00d7${inputImage.height} \u2192 ${outW}\u00d7${outH}.`;

        compareSlider.style.maxWidth = outW + 'px';
        compareSlider.setAttribute('after-label', `${scale}x Upscaled`);
        await compareSlider.show(beforeCanvas, afterCanvas, {
          downloadName: `upscaled_${scale}x.png`,
        });
        compareSlider.setViewState(this.#viewState);
        preview.hide();

      } catch (e) {
        if (e.name === 'AbortError') {
          statusBar.message = 'Upscale cancelled.';
        } else {
          console.error(e);
          statusBar.message = 'Error: ' + this.#formatUpscaleErrorMessage(e);
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

    updateCustomDeleteVisibility();
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
    const tileSize = parseInt(this.#q('.tilesize-select').value, 10);
    const profile = this.#q('perf-monitor').visible;

    const config = { modelUrl, scale, modelValueRange, modelLayout, modelInputMultiple, backend, tileSize, profile };

    if (this.#q('.pass-all-enabled').checked) {
      const aopt = this.#q('.pass-all-model').selectedOptions[0];
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

    return config;
  }

  async #runBuiltInResampleUpscale(inputImage, signal, requestedOutputScale, statusBar, preview, modelUrl) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const isLanczos = modelUrl === 'builtin:lanczos-4x';
    const methodLabel = isLanczos ? 'Lanczos' : 'Bicubic';
    const scale = 4;
    const outW = inputImage.width * scale;
    const outH = inputImage.height * scale;

    preview.showDimmedPreview(
      inputImage,
      outW,
      outH,
      `Upscaling ${inputImage.width}\u00d7${inputImage.height} via ${methodLabel}\u2026`,
    );
    statusBar.showProgress(0.25);
    statusBar.message = `Applying ${methodLabel} resample\u2026`;

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
      tiledUpscale: 'Base pass',
      blendAll: 'All-pass blend',
      detectFaces: 'Face detection',
      enhanceFaces: 'Face enhance',
    };

    const outW = inputImage.width * config.scale;
    const outH = inputImage.height * config.scale;
    preview.showDimmedPreview(
      inputImage, outW, outH,
      `Upscaling ${inputImage.width}\u00d7${inputImage.height} \u2192 ${outW}\u00d7${outH}\u2026`,
    );

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
        } else if (info.step === 'blendAll') {
          preview.drawTile(info, { opacity: config.all?.blendOpacity ?? 1 });
        } else if (info.step === 'enhanceFaces' && info.composited) {
          preview.drawTile(info);
        }
        statusBar.showProgress((info.index + 1) / info.total);
        const label = stepLabel[info.step] || info.step || 'Pass';
        if (info.step === 'enhanceFaces') {
          if (info.composited) {
            statusBar.message = `${label}: composited face ${(info.faceIndex ?? 0) + 1}/${info.faceTotal ?? '?'}`;
          } else {
            const faceN = Number.isFinite(info.faceIndex) ? info.faceIndex + 1 : null;
            const faceTotal = Number.isFinite(info.faceTotal) ? info.faceTotal : null;
            const facePrefix = faceN && faceTotal ? `face ${faceN}/${faceTotal}, ` : '';
            const faceTileTotal = Number.isFinite(info.faceTileTotal) ? info.faceTileTotal : info.total;
            statusBar.message = `${label}: ${facePrefix}tile ${info.index + 1} / ${faceTileTotal}`;
          }
        } else {
          statusBar.message = `${label}: tile ${info.index + 1} / ${info.total}`;
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
    const canvases = this.#createComparisonCanvases(result.image, inputImage, outputScale);
    return { ...canvases, scale: outputScale };
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
    preview.showDimmedPreview(inputImage, outW, outH, `Upscaling ${inputImage.width}\u00d7${inputImage.height} via RunPod\u2026`);

    statusBar.showIndeterminate();

    const { canvas: resultCanvas, scale: actualScale } = await engine.upscale(
      inputImage,
      (msg) => { statusBar.message = msg; },
      signal,
    );

    const scale = Math.min(finalScale, actualScale);
    const canvases = this.#createComparisonCanvases(resultCanvas, inputImage, scale);
    return { ...canvases, scale };
  }

  // --- Settings ---

  #restoreSettings() {
    this.#q('.runpod-endpoint').value = localStorage.getItem('upscaler_runpod_endpoint') || '';
    this.#q('.runpod-apikey').value = localStorage.getItem('upscaler_runpod_apikey') || '';

    const controls = [
      ['.model-select', 'upscaler_model'],
      ['.tilesize-select', 'upscaler_tilesize'],
      ['.backend-select', 'upscaler_backend'],
      ['.output-select', 'upscaler_output'],
      ['.pass-all-blend', 'upscaler_pass_all_blend'],
      ['.pass-all-model', 'upscaler_pass_all_model'],
      ['.detector-face-padding', 'upscaler_detector_face_padding_px'],
      ['.detector-face-score', 'upscaler_detector_face_score'],
      ['.detector-face-blend', 'upscaler_detector_face_blend'],
      ['.detector-face-model', 'upscaler_detector_face_model'],
    ];
    for (const [sel, key] of controls) {
      const saved = localStorage.getItem(key);
      if (saved !== null) this.#q(sel).value = saved;
    }
    this.#viewState.expanded = localStorage.getItem('upscaler_view_expanded') === '1';
    this.#viewState.upscaledOnly = localStorage.getItem('upscaler_view_upscaled_only') === '1';
    this.#q('.pass-all-enabled').checked = localStorage.getItem('upscaler_pass_all_enabled') === '1';
    this.#q('.detector-face-enabled').checked = localStorage.getItem('upscaler_detector_face_enabled') === '1';

    this.#q('image-cropper').setExpanded(this.#viewState.expanded);
    this.#q('upscale-preview').setExpanded(this.#viewState.expanded);
    this.#q('compare-slider').setViewState(this.#viewState);
    this.#syncViewSizeButtonLabel();
    const modelEl = this.#q('.model-select');
    if (!modelEl.selectedOptions.length) modelEl.selectedIndex = 0;

    this.#q('.model-select').dispatchEvent(new Event('change'));
    this.#q('.pass-all-blend').dispatchEvent(new Event('input'));
    this.#q('.detector-face-score').dispatchEvent(new Event('input'));
    this.#q('.detector-face-blend').dispatchEvent(new Event('input'));
    this.#updateHangWarning();
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
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        upscaler-app select.model-select,
        upscaler-app select.pass-all-model,
        upscaler-app select.detector-face-model {
          width: min(100%, 17em);
          max-width: 17em;
        }
        upscaler-app select.output-select {
          width: min(100%, calc(4ch + 0.7rem + 2.25rem));
          max-width: calc(4ch + 0.7rem + 2.25rem);
        }
        upscaler-app select.tilesize-select {
          width: min(100%, calc(4.25ch + 0.7rem + 2.25rem));
          max-width: calc(4.25ch + 0.7rem + 2.25rem);
        }
        upscaler-app select.backend-select {
          width: min(100%, calc(5ch + 0.7rem + 2.25rem));
          max-width: calc(5ch + 0.7rem + 2.25rem);
        }
        upscaler-app .delete-custom-model-btn {
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
        upscaler-app .custom-model-dialog {
          width: min(34rem, calc(100vw - 2rem));
        }
        upscaler-app .custom-model-form {
          display: grid;
          gap: 0.6rem;
          margin: 0;
        }
        upscaler-app .custom-model-form label {
          display: grid;
          gap: 0.25rem;
          margin: 0;
          font-size: 0.85rem;
        }
        upscaler-app .custom-model-row {
          display: grid;
          gap: 0.5rem;
          grid-template-columns: minmax(0, 1fr) auto auto auto auto;
          align-items: end;
        }
        upscaler-app .custom-model-scale {
          width: 8ch;
        }
        upscaler-app .custom-model-range {
          width: 9ch;
        }
        upscaler-app .custom-model-layout {
          width: 9ch;
        }
        upscaler-app .custom-model-multiple {
          width: 9ch;
        }
        @media (max-width: 900px) {
          upscaler-app .custom-model-row {
            grid-template-columns: minmax(0, 1fr) auto auto;
          }
        }
        upscaler-app .custom-model-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.8rem;
          color: var(--pico-muted-color);
        }
        upscaler-app .custom-model-detected {
          font-size: 0.8rem;
          color: var(--pico-muted-color);
        }
        upscaler-app .custom-model-error {
          color: var(--pico-del-color, #c62828);
          min-height: 1.1rem;
          font-size: 0.8rem;
        }
        upscaler-app .custom-model-actions {
          display: flex;
          justify-content: flex-end;
          gap: 0.5rem;
          margin-top: 0.4rem;
        }
      </style>

      <h2>
        <i class="fas fa-expand"></i> Image Upscaler
      </h2>

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

        <button class="upscale-btn" disabled>
          <i class="fas fa-wand-magic-sparkles"></i> Upscale 4x
        </button>
        <button class="stop-btn secondary" style="display:none">
          <i class="fas fa-stop"></i> Stop
        </button>
        <button class="startover-btn secondary outline" style="display:none">
          <i class="fas fa-redo"></i> Start Over
        </button>
        <button class="viewsize-btn secondary outline" type="button">Full Size</button>
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
        <div class="detector-row">
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
        <div class="detector-row">
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

      <dialog class="custom-model-dialog">
        <form class="custom-model-form" method="dialog">
          <h3 style="margin:0">Upload custom ONNX model</h3>
          <label>
            Model file
            <input class="custom-model-file" type="file" accept=".onnx,application/octet-stream" required>
          </label>
          <div class="custom-model-row">
            <label>
              Label
              <input class="custom-model-label" type="text" maxlength="80" placeholder="My custom model">
            </label>
            <label>
              Scale
              <input class="custom-model-scale" type="number" min="1" max="16" step="1" value="4" required>
            </label>
            <label>
              Range
              <select class="custom-model-range">
                <option value="1">1</option>
                <option value="255">255</option>
              </select>
            </label>
            <label>
              Layout
              <select class="custom-model-layout">
                <option value="nchw">NCHW</option>
                <option value="nhwc">NHWC</option>
              </select>
            </label>
            <label>
              Multiple-of
              <input class="custom-model-multiple" type="number" min="1" max="64" step="1" value="1">
            </label>
          </div>
          <div class="custom-model-detected">Auto-detect: waiting for model file…</div>
          <div class="custom-model-meta">
            <span class="custom-model-size">Model size: -</span>
          </div>
          <div class="custom-model-error"></div>
          <div class="custom-model-actions">
            <button type="button" class="secondary custom-model-cancel-btn">Cancel</button>
            <button type="submit" class="custom-model-save-btn">Save model</button>
          </div>
        </form>
      </dialog>

      <status-bar></status-bar>
      <image-drop-zone></image-drop-zone>
      <image-cropper></image-cropper>
      <upscale-preview></upscale-preview>
      <compare-slider></compare-slider>
      <perf-monitor></perf-monitor>
    `);
  }
}

customElements.define('upscaler-app', UpscalerApp);
