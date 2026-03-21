/**
 * <upscaler-app> — orchestrates the image upscaler feature.
 * Wraps all upscaler sub-components and control logic into a single web component.
 */

import { morph } from '../../lib/morph.js';
import '../../components/image-drop-zone.js';
import '../../components/status-bar.js';
import './image-cropper.js';
import './upscale-preview.js';
import './compare-slider.js';
import './perf-monitor.js';

class UpscalerApp extends HTMLElement {
  #loadedImage = null;
  #running = false;

  connectedCallback() {
    this.#render();
    this.#setupEvents();

    // Restore persisted RunPod settings
    this.#q('.runpod-endpoint').value = localStorage.getItem('upscaler_runpod_endpoint') || '';
    this.#q('.runpod-apikey').value = localStorage.getItem('upscaler_runpod_apikey') || '';
  }

  #q(sel) { return this.querySelector(sel); }

  #setupEvents() {
    const modeEl       = this.#q('.mode-select');
    const modelEl      = this.#q('.model-select');
    const tileSizeEl   = this.#q('.tilesize-select');
    const backendEl    = this.#q('.backend-select');
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

    statusBar.message = 'Load an image to begin.';

    // Persist RunPod settings
    endpointEl.addEventListener('input', () => localStorage.setItem('upscaler_runpod_endpoint', endpointEl.value));
    apikeyEl.addEventListener('input', () => localStorage.setItem('upscaler_runpod_apikey', apikeyEl.value));

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
          const inputRange = parseInt(selectedOption.dataset.range, 10) || 1;

          const result = await preview.upscale(
            inputImage,
            parseInt(tileSizeEl.value, 10),
            backendEl.value,
            {
              modelUrl,
              scale,
              inputRange,
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
        preview.hide();

      } catch (e) {
        if (e.name === 'AbortError') {
          statusBar.message = 'Upscale cancelled.';
        } else {
          console.error(e);
          statusBar.message = 'Error: ' + e.message;
        }
        statusBar.hideProgress();
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
              <option value="models/4x-UltraMix_Balanced.onnx" data-scale="4">4x UltraMix Balanced (ESRGAN)</option>
              <option value="models/4x-UltraSharpV2_Lite.onnx" data-scale="4">4x UltraSharp V2 Lite (RealPLKSR)</option>
              <option value="models/RMBN_M4C8_x4.onnx" data-scale="4" data-range="255">4x RMBN-M4C8 (Lightweight)</option>
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
            </select>
          </label>
          <label>Backend:
            <select class="backend-select">
              <option value="webgpu">WebGPU</option>
              <option value="webgl">WebGL</option>
              <option value="wasm">WASM</option>
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
      </div>

      <status-bar></status-bar>
      <image-drop-zone></image-drop-zone>
      <image-cropper></image-cropper>
      <upscale-preview></upscale-preview>
      <compare-slider></compare-slider>
    `);
  }
}

customElements.define('upscaler-app', UpscalerApp);
