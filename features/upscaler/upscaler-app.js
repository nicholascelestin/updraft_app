/**
 * <upscaler-app> — orchestrates the image upscaler feature.
 * Wraps all upscaler sub-components and control logic into a single web component.
 */

import { morph } from 'lib/morph';
import 'components/image-drop-zone';
import 'components/status-bar';
import 'components/image-cropper';
import 'components/compare-slider';
import './upscale-preview.js';
import './perf-monitor.js';

class UpscalerApp extends HTMLElement {
  #loadedImage = null;
  #running = false;
  #viewState = {
    expanded: false,
    upscaledOnly: false,
  };

  connectedCallback() {
    this.#render();
    this.#setupEvents();
    this.#restoreSettings();
  }

  #q(sel) { return this.querySelector(sel); }

  #setupEvents() {
    const modeEl       = this.#q('.mode-select');
    const modelEl      = this.#q('.model-select');
    const tileSizeEl   = this.#q('.tilesize-select');
    const backendEl    = this.#q('.backend-select');
    const denoiseEl    = this.#q('.denoise-range');
    const denoiseValEl = this.#q('.denoise-val');
    const upscaleBtn   = this.#q('.upscale-btn');
    const stopBtn      = this.#q('.stop-btn');
    const startOverBtn = this.#q('.startover-btn');
    const modeLabel    = this.#q('.mode-label');
    const localCtrl    = this.#q('.local-controls');
    const runpodCtrl   = this.#q('.runpod-controls');
    const endpointEl   = this.#q('.runpod-endpoint');
    const apikeyEl     = this.#q('.runpod-apikey');

    const statusBar     = this.#q('status-bar');
    const dropZone      = this.#q('image-drop-zone');
    const cropper       = this.#q('image-cropper');
    const preview       = this.#q('upscale-preview');
    const compareSlider = this.#q('compare-slider');
    const perfMonitor   = this.#q('perf-monitor');
    const perfToggle    = this.#q('.perf-toggle-btn');
    const VIEW_STATE_KEYS = {
      expanded: 'upscaler_view_expanded',
      upscaledOnly: 'upscaler_view_upscaled_only',
    };

    statusBar.message = 'Load an image to begin.';

    perfToggle.addEventListener('click', () => {
      perfMonitor.visible ? perfMonitor.hide() : perfMonitor.show();
    });

    // Persist settings on change
    endpointEl.addEventListener('input', () => localStorage.setItem('upscaler_runpod_endpoint', endpointEl.value));
    apikeyEl.addEventListener('input', () => localStorage.setItem('upscaler_runpod_apikey', apikeyEl.value));
    modeEl.addEventListener('change', () => localStorage.setItem('upscaler_mode', modeEl.value));
    modelEl.addEventListener('change', () => localStorage.setItem('upscaler_model', modelEl.value));
    tileSizeEl.addEventListener('change', () => localStorage.setItem('upscaler_tilesize', tileSizeEl.value));
    backendEl.addEventListener('change', () => localStorage.setItem('upscaler_backend', backendEl.value));
    denoiseEl.addEventListener('input', () => localStorage.setItem('upscaler_denoise', denoiseEl.value));
    const persistViewState = () => {
      localStorage.setItem(VIEW_STATE_KEYS.expanded, this.#viewState.expanded ? '1' : '0');
      localStorage.setItem(VIEW_STATE_KEYS.upscaledOnly, this.#viewState.upscaledOnly ? '1' : '0');
    };

    // Mode switching
    modeEl.addEventListener('change', () => {
      const isRunPod = modeEl.value === 'runpod';
      localCtrl.style.display = isRunPod ? 'none' : '';
      runpodCtrl.style.display = isRunPod ? '' : 'none';
      modeLabel.textContent = isRunPod ? '(RunPod Serverless)' : '(in-browser, ONNX Runtime)';
    });

    // Reset helper
    const resetToStart = () => {
      this.#loadedImage = null;
      this.#running = false;
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

    // Image loaded — transition to ready state
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
      this.#loadedImage = e.detail.image;
      showReady();
    });

    // Crop changed
    cropper.addEventListener('crop-changed', (e) => {
      const crop = e.detail.crop;
      if (crop) {
        statusBar.message = `Loaded ${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 crop ${crop.w}\u00d7${crop.h} selected \u2014 ready to upscale.`;
      } else {
        statusBar.message = `Loaded ${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 ready to upscale.`;
      }
    });

    // Tile progress
    preview.addEventListener('tile-complete', (e) => {
      const { index, total } = e.detail;
      statusBar.showProgress((index + 1) / total);
      statusBar.message = `Tile ${index + 1} / ${total}`;
      if (perfMonitor.visible) perfMonitor.update(e.detail);
    });

    // Keep preview/compare view mode in sync.
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

    // Session summary
    preview.addEventListener('upscale-complete', (e) => {
      if (e.detail.perf) perfMonitor.showResults(e.detail.perf, e.detail.ortProfile);
    });

    // RunPod status
    preview.addEventListener('runpod-status', (e) => {
      statusBar.message = e.detail.message;
    });

    // Upscale button
    upscaleBtn.addEventListener('click', async () => {
      if (this.#running || !this.#loadedImage) return;
      this.#running = true;
      upscaleBtn.disabled = true;
      stopBtn.style.display = 'inline-block';
      startOverBtn.style.display = 'none';
      compareSlider.hide();
      preview.cleanup();

      try {
        statusBar.showProgress(0);
        const inputImage = cropper.extractImage();
        cropper.style.display = 'none';

        let beforeSrc, afterSrc, scale;

        if (modeEl.value === 'runpod') {
          if (!endpointEl.value || !apikeyEl.value) {
            throw new Error('Enter your RunPod Endpoint ID and API Key.');
          }
          statusBar.showIndeterminate();
          const result = await preview.upscaleRunPod(inputImage, {
            endpointId: endpointEl.value.trim(),
            apiKey: apikeyEl.value.trim(),
            scale: 4,
          });
          beforeSrc = result.beforeSrc;
          afterSrc = result.afterSrc;
          scale = result.scale;
        } else {
          const selectedOption = modelEl.selectedOptions[0];
          const modelUrl = selectedOption.value;
          scale = parseInt(selectedOption.dataset.scale, 10);
          const modelValueRange = parseInt(selectedOption.dataset.range, 10) || 1;
          const backend = selectedOption.dataset.backend || backendEl.value;
          const denoise = parseFloat(denoiseEl.value);

          if (perfMonitor.visible) perfMonitor.start(backend);

          const result = await preview.upscale(
            inputImage,
            parseInt(tileSizeEl.value, 10),
            backend,
            {
              modelUrl,
              scale,
              modelValueRange,
              denoise,
              onModelProgress(frac, msg) {
                statusBar.showProgress(frac);
                statusBar.message = msg;
              },
            },
          );
          beforeSrc = result.beforeSrc;
          afterSrc = result.afterSrc;
        }

        statusBar.hideProgress();

        const outW = inputImage.width * scale;
        const outH = inputImage.height * scale;
        statusBar.message = `Done \u2014 ${inputImage.width}\u00d7${inputImage.height} \u2192 ${outW}\u00d7${outH}. Drag the slider to compare.`;

        compareSlider.style.maxWidth = outW + 'px';
        await compareSlider.show(beforeSrc, afterSrc, {
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

      this.#running = false;
      stopBtn.style.display = 'none';
      startOverBtn.style.display = 'inline-block';
      upscaleBtn.disabled = false;
    });

    // Stop
    stopBtn.addEventListener('click', () => preview.stop());

    // Start over
    startOverBtn.addEventListener('click', () => {
      if (this.#running) preview.stop();
      resetToStart();
    });

    // Model selector updates button text
    modelEl.addEventListener('change', () => {
      const scale = modelEl.selectedOptions[0].dataset.scale;
      upscaleBtn.textContent = `Upscale ${scale}x`;
    });

    // Denoise slider live value
    denoiseEl.addEventListener('input', () => {
      denoiseValEl.textContent = denoiseEl.value;
    });
  }

  #restoreSettings() {
    this.#q('.runpod-endpoint').value = localStorage.getItem('upscaler_runpod_endpoint') || '';
    this.#q('.runpod-apikey').value = localStorage.getItem('upscaler_runpod_apikey') || '';

    const controls = [
      ['.mode-select', 'upscaler_mode'],
      ['.model-select', 'upscaler_model'],
      ['.tilesize-select', 'upscaler_tilesize'],
      ['.backend-select', 'upscaler_backend'],
      ['.denoise-range', 'upscaler_denoise'],
    ];
    for (const [sel, key] of controls) {
      const saved = localStorage.getItem(key);
      if (saved !== null) this.#q(sel).value = saved;
    }
    this.#viewState.expanded = localStorage.getItem('upscaler_view_expanded') === '1';
    this.#viewState.upscaledOnly = localStorage.getItem('upscaler_view_upscaled_only') === '1';

    this.#q('upscale-preview').setExpanded(this.#viewState.expanded);
    this.#q('compare-slider').setViewState(this.#viewState);
    const modelEl = this.#q('.model-select');
    if (!modelEl.selectedOptions.length) modelEl.selectedIndex = 0;

    this.#q('.mode-select').dispatchEvent(new Event('change'));
    this.#q('.model-select').dispatchEvent(new Event('change'));
    this.#q('.denoise-range').dispatchEvent(new Event('input'));
  }

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
        upscaler-app .mode-label {
          font-size: 0.7rem;
          color: var(--pico-muted-color);
        }
      </style>

      <h2>
        <i class="fas fa-expand"></i> Image Upscaler
        <span class="mode-label">(in-browser, ONNX Runtime)</span>
      </h2>

      <div class="controls">
        <label>Mode:
          <select class="mode-select">
            <option value="local">Local (ONNX)</option>
            <option value="runpod">RunPod Serverless</option>
          </select>
        </label>

        <span class="local-controls">
          <label>Model:
            <select class="model-select">
              <option value="models/RMBN_M4C8_x4.onnx" data-scale="4" data-range="255">4x Lightweight M8C16 (RMBN)</option>
              <option value="models/4x-ClearRealityV1.onnx" data-scale="4" data-backend="wasm">4x ClearReality V1 (SPAN)</option>
              <option value="models/4x-UltraSharpV2_Lite.onnx" data-scale="4">4x UltraSharp V2 Lite (RealPLKSR)</option>
              <option value="models/4x-UltraMix_Balanced.onnx" data-scale="4">4x UltraMix Balanced (ESRGAN)</option>
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
          <label>Backend:
            <select class="backend-select">
              <option value="webgpu">WebGPU</option>
              <option value="webgl">WebGL</option>
              <option value="wasm">WASM</option>
            </select>
          </label>
          <label title="3×3 bilateral denoise — smooths compression noise while preserving edges">Smooth artifacts:
            <span style="display:inline-flex;align-items:center;gap:0.3rem">
              <input class="denoise-range" type="range" min="0" max="1" step="0.05" value="0" style="width:7rem;vertical-align:middle">
              <span class="denoise-val" style="min-width:2.2ch;font-variant-numeric:tabular-nums">0</span>
            </span>
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
      </div>

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
