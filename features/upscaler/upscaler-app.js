/**
 * <upscaler-app> — orchestrates the image upscaler feature.
 * Delegates inference to Pipeline; owns abort control and presentation.
 */

import { morph } from 'lib/morph';
import { Pipeline } from './upscale-pipeline.js';
import { modelOptionsHTML } from './model-registry.js';
import 'components/image-drop-zone';
import 'components/status-bar';
import 'components/image-cropper';
import 'components/compare-slider';
import './upscale-preview.js';
import './perf-monitor.js';

class UpscalerApp extends HTMLElement {
  #loadedImage = null;
  #running = false;
  #generation = 0;
  #viewState = { expanded: false, upscaledOnly: false };

  #pipeline = new Pipeline();
  #abortController = null;

  connectedCallback() {
    this.#render();
    this.#setupPersistence();
    this.#setupModeSwitch();
    this.#setupViewStateSync();
    this.#setupUpscaleActions();
    this.#restoreSettings();
  }

  #q(sel) { return this.querySelector(sel); }

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
    persist('.model-select', 'upscaler_model');
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
    const preview = this.#q('upscale-preview');
    const compareSlider = this.#q('compare-slider');
    const persistViewState = () => {
      localStorage.setItem('upscaler_view_expanded', this.#viewState.expanded ? '1' : '0');
      localStorage.setItem('upscaler_view_upscaled_only', this.#viewState.upscaledOnly ? '1' : '0');
    };

    preview.addEventListener('view-state-change', (e) => {
      this.#viewState.expanded = !!e.detail.expanded;
      compareSlider.setExpanded(this.#viewState.expanded);
      persistViewState();
    });
    compareSlider.addEventListener('view-state-change', (e) => {
      if (typeof e.detail.expanded === 'boolean') {
        this.#viewState.expanded = e.detail.expanded;
      }
      if (typeof e.detail.upscaledOnly === 'boolean') {
        this.#viewState.upscaledOnly = e.detail.upscaledOnly;
      }
      preview.setExpanded(this.#viewState.expanded);
      persistViewState();
    });
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

    modelEl.addEventListener('change', () => {
      const scale = modelEl.selectedOptions[0].dataset.scale;
      upscaleBtn.textContent = `Upscale ${scale}x`;
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
        statusBar.message = `Done \u2014 ${inputImage.width}\u00d7${inputImage.height} \u2192 ${outW}\u00d7${outH}. Drag the slider to compare.`;

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
          statusBar.message = 'Error: ' + e.message;
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
  }

  // --- Config extraction ---

  #extractConfig() {
    const opt = this.#q('.model-select').selectedOptions[0];
    const modelUrl = opt.value;
    const scale = parseInt(opt.dataset.scale, 10) || 4;
    const modelValueRange = parseInt(opt.dataset.range, 10) || 1;
    const backend = opt.dataset.backend || this.#q('.backend-select').value;
    const tileSize = parseInt(this.#q('.tilesize-select').value, 10);
    const profile = this.#q('perf-monitor').visible;

    const config = { modelUrl, scale, modelValueRange, backend, tileSize, profile };

    if (this.#q('.pass-all-enabled').checked) {
      const aopt = this.#q('.pass-all-model').selectedOptions[0];
      config.all = {
        modelUrl: aopt?.value || modelUrl,
        scale: parseInt(aopt?.dataset.scale, 10) || scale,
        modelValueRange: parseInt(aopt?.dataset.range, 10) || 1,
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
        backend: fopt?.dataset.backend || backend,
        paddingPx: parseInt(this.#q('.detector-face-padding').value, 10) || 0,
        featherPx: 16,
        blendOpacity: parseFloat(this.#q('.detector-face-blend').value),
        scoreThreshold: parseFloat(this.#q('.detector-face-score').value),
      };
    }

    return config;
  }

  // --- Pipeline branches ---

  async #runLocalUpscale(inputImage, signal, requestedOutputScale, statusBar, preview, perfMonitor) {
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
    this.#q('.detector-face-enabled').checked = localStorage.getItem('upscaler_detector_face_enabled') !== '0';

    this.#q('upscale-preview').setExpanded(this.#viewState.expanded);
    this.#q('compare-slider').setViewState(this.#viewState);
    const modelEl = this.#q('.model-select');
    if (!modelEl.selectedOptions.length) modelEl.selectedIndex = 0;

    this.#q('.model-select').dispatchEvent(new Event('change'));
    this.#q('.pass-all-blend').dispatchEvent(new Event('input'));
    this.#q('.detector-face-score').dispatchEvent(new Event('input'));
    this.#q('.detector-face-blend').dispatchEvent(new Event('input'));
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
          margin-bottom: 0.6rem;
        }
        upscaler-app .detector-row {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem 0.75rem;
          align-items: center;
          margin-top: 0;
        }
        upscaler-app .detector-row label {
          margin-bottom: 0;
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.85rem;
        }
        upscaler-app .detector-row input,
        upscaler-app .detector-row select {
          margin-bottom: 0;
        }
        upscaler-app .detector-row input[type="checkbox"] {
          margin-top: 0;
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
              ${modelOptionsHTML()}
            </select>
          </label>
          <label>Backend:
            <select class="backend-select">
              <option value="webgpu">GPU (WebGPU)</option>
              <option value="wasm">CPU (WASM)</option>
            </select>
          </label>
          <label>Tile size:
            <select class="tilesize-select">
              <option value="64">64</option>
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
        <button class="perf-toggle-btn secondary outline" title="Toggle performance monitor">
          <i class="fas fa-gauge-high"></i>
        </button>
        <button class="clear-cache-btn secondary outline" hidden title="Clear cached ONNX models (frees memory)">
          <i class="fas fa-broom"></i> Clear Cache
        </button>
      </div>

      <details class="passes-panel">
        <summary><i class="fas fa-user-check"></i> Additional Passes</summary>
        <div class="detector-row">
          <label>
            <input class="pass-all-enabled" type="checkbox">
            All (full image blend)
          </label>
          <label title="Blend opacity of the secondary full-image pass over the base upscale">
            Blend:
            <span style="display:inline-flex;align-items:center;gap:0.3rem">
              <input class="pass-all-blend" type="range" min="0" max="1" step="0.05" value="0.40" style="width:7rem;vertical-align:middle">
              <span class="pass-all-blend-val" style="min-width:4ch;font-variant-numeric:tabular-nums">0.40</span>
            </span>
          </label>
          <label>All model:
            <select class="pass-all-model">
              ${modelOptionsHTML()}
            </select>
          </label>
        </div>
        <div class="detector-row">
          <label>
            <input class="detector-face-enabled" type="checkbox" checked>
            Faces (YuNet)
          </label>
          <label>Padding:
            <input class="detector-face-padding" type="number" min="0" max="512" step="1" value="24" style="width:7ch">
            px
          </label>
          <label title="Minimum face detection confidence">
            Score:
            <span style="display:inline-flex;align-items:center;gap:0.3rem">
              <input class="detector-face-score" type="range" min="0.3" max="0.95" step="0.01" value="0.70" style="width:7rem;vertical-align:middle">
              <span class="detector-face-score-val" style="min-width:4ch;font-variant-numeric:tabular-nums">0.70</span>
            </span>
          </label>
          <label title="Blend opacity of the face patch over the base upscale (1 = full replace, lower = transparent blend)">
            Blend:
            <span style="display:inline-flex;align-items:center;gap:0.3rem">
              <input class="detector-face-blend" type="range" min="0" max="1" step="0.05" value="0.65" style="width:7rem;vertical-align:middle">
              <span class="detector-face-blend-val" style="min-width:4ch;font-variant-numeric:tabular-nums">0.65</span>
            </span>
          </label>
          <label>Face model:
            <select class="detector-face-model">
              ${modelOptionsHTML(undefined, { selected: 'models/RMBN_M4C8_FACES_x4.onnx' })}
            </select>
          </label>
        </div>
      </details>

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
