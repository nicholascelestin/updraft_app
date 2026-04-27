/**
 * <bg-removal-app> — orchestrates the background removal feature.
 */

import { morph } from 'lib/morph';
import 'components/image-drop-zone';
import 'components/status-bar';
import 'components/compare-slider';
import 'components/image-cropper';
import { BgRemovalEngine } from './bg-removal-engine.js';

/**
 * Draw a checkerboard pattern + transparent image onto a canvas, return as blob URL.
 */
function checkerboardComposite(transparentCanvas) {
  const w = transparentCanvas.width;
  const h = transparentCanvas.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  // Draw checkerboard
  const size = 16;
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = ((x / size + y / size) & 1) ? '#ccc' : '#fff';
      ctx.fillRect(x, y, size, size);
    }
  }

  ctx.drawImage(transparentCanvas, 0, 0);
  return new Promise(resolve => c.toBlob(blob => resolve(URL.createObjectURL(blob)), 'image/png'));
}

function canvasToBlobUrl(canvas) {
  return new Promise(resolve => canvas.toBlob(blob => resolve(URL.createObjectURL(blob)), 'image/png'));
}

function imageToBlobUrl(image) {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d').drawImage(image, 0, 0);
  return new Promise(resolve => c.toBlob(blob => resolve(URL.createObjectURL(blob)), 'image/png'));
}

class BgRemovalApp extends HTMLElement {
  static BRIA_MODEL_KEY = 'rmbg-1.4';

  #loadedImage = null;
  #running = false;
  #engine = new BgRemovalEngine();
  #abortController = null;
  #resultBlobUrl = null;
  #checkerBlobUrl = null;
  #beforeBlobUrl = null;
  #transparentBlobUrl = null;

  connectedCallback() {
    this.#render();
    this.#setupEvents();
  }

  #q(sel) { return this.querySelector(sel); }

  #cleanup() {
    if (this.#resultBlobUrl) { URL.revokeObjectURL(this.#resultBlobUrl); this.#resultBlobUrl = null; }
    if (this.#checkerBlobUrl) { URL.revokeObjectURL(this.#checkerBlobUrl); this.#checkerBlobUrl = null; }
    if (this.#beforeBlobUrl) { URL.revokeObjectURL(this.#beforeBlobUrl); this.#beforeBlobUrl = null; }
    if (this.#transparentBlobUrl) { URL.revokeObjectURL(this.#transparentBlobUrl); this.#transparentBlobUrl = null; }
  }

  #setupEvents() {
    const backendEl   = this.#q('.backend-select');
    const removeBtn   = this.#q('.remove-btn');
    const stopBtn     = this.#q('.stop-btn');
    const startOverBtn = this.#q('.startover-btn');

    const statusBar     = this.#q('status-bar');
    const dropZone      = this.#q('image-drop-zone');
    const cropper       = this.#q('image-cropper');
    const compareSlider = this.#q('compare-slider');

    statusBar.message = 'Load an image to begin.';

    // Reset helper
    const resetToStart = () => {
      this.#loadedImage = null;
      this.#running = false;
      this.#cleanup();
      removeBtn.disabled = true;
      stopBtn.style.display = 'none';
      startOverBtn.style.display = 'none';
      cropper.hide();
      compareSlider.hide();
      dropZone.show();
      statusBar.message = 'Load an image to begin.';
      statusBar.hideProgress();
    };

    // Transition to ready state (image loaded, can run or re-run)
    const showReady = () => {
      removeBtn.disabled = false;
      startOverBtn.style.display = 'inline-block';
      dropZone.hide();
      cropper.show(this.#loadedImage);
      statusBar.message = `Loaded ${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 ready to remove background.`;
      statusBar.hideProgress();
    };

    // Image loaded
    dropZone.addEventListener('image-loaded', (e) => {
      this.#loadedImage = e.detail.image;
      compareSlider.hide();
      showReady();
    });

    // Crop changed
    cropper.addEventListener('crop-changed', (e) => {
      const crop = e.detail.crop;
      if (crop) {
        statusBar.message = `Loaded ${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 crop ${crop.w}\u00d7${crop.h} selected \u2014 ready to remove background.`;
      } else {
        statusBar.message = `Loaded ${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 ready to remove background.`;
      }
    });

    // Remove button
    removeBtn.addEventListener('click', async () => {
      if (this.#running || !this.#loadedImage) return;
      this.#running = true;
      this.#cleanup();
      removeBtn.disabled = true;
      stopBtn.style.display = 'inline-block';
      startOverBtn.style.display = 'none';
      compareSlider.hide();

      this.#abortController = new AbortController();
      const { signal } = this.#abortController;
      const inputImage = cropper.extractImage();
      cropper.style.display = 'none';

      try {
        await this.#engine.loadModel(BgRemovalApp.BRIA_MODEL_KEY, backendEl.value, (frac, msg) => {
          statusBar.showProgress(frac);
          statusBar.message = msg;
        });

        statusBar.showIndeterminate();
        statusBar.message = 'Running inference\u2026';

        const resultCanvas = await this.#engine.removeBackground(inputImage, signal);

        statusBar.hideProgress();
        const w = inputImage.width;
        const h = inputImage.height;
        statusBar.message = `Done \u2014 ${w}\u00d7${h}. Drag the slider to compare.`;

        // Create blob URLs for display
        this.#transparentBlobUrl = await canvasToBlobUrl(resultCanvas);
        this.#checkerBlobUrl = await checkerboardComposite(resultCanvas);
        this.#beforeBlobUrl = await imageToBlobUrl(inputImage);

        // Show compare slider: original vs result-on-checkerboard
        await compareSlider.show(this.#beforeBlobUrl, this.#checkerBlobUrl, {
          downloadSrc: this.#transparentBlobUrl,
          downloadName: 'bg_removed.png',
        });

      } catch (e) {
        if (e.name === 'AbortError') {
          statusBar.message = 'Cancelled.';
        } else {
          console.error(e);
          statusBar.message = 'Error: ' + e.message;
        }
        statusBar.hideProgress();
      }

      this.#running = false;
      this.#abortController = null;
      stopBtn.style.display = 'none';
      startOverBtn.style.display = 'inline-block';
      removeBtn.disabled = false;
    });

    // Stop
    stopBtn.addEventListener('click', () => {
      this.#abortController?.abort();
    });

    // Start over
    startOverBtn.addEventListener('click', () => {
      if (this.#running) this.#abortController?.abort();
      resetToStart();
    });

  }

  #render() {
    morph(this, `
      <style>
        bg-removal-app .controls {
          display: flex; flex-wrap: wrap; gap: 0.4rem 0.75rem;
          align-items: center; margin-bottom: 1rem;
        }
        bg-removal-app .controls label {
          display: inline-flex; align-items: center; gap: 0.35rem;
          font-size: 0.85rem; margin-bottom: 0; white-space: nowrap;
        }
        bg-removal-app .controls select {
          margin-bottom: 0; padding: 0.3rem 0.5rem;
          font-size: 0.85rem; width: auto;
        }
        bg-removal-app .controls button {
          margin-bottom: 0; padding: 0.4rem 0.8rem;
          font-size: 0.85rem; width: auto;
        }
      </style>

      <h2>
        <i class="fas fa-eraser"></i> Background Removal
        <span style="font-size:0.7rem; color:var(--pico-muted-color)">(in-browser, ONNX Runtime)</span>
      </h2>

      <div class="controls">
        <label>Backend:
          <select class="backend-select">
            <option value="webgpu">GPU (WebGPU)</option>
            <option value="wasm">CPU (WASM)</option>
          </select>
        </label>

        <button class="remove-btn" disabled>
          <i class="fas fa-eraser"></i> Remove Background
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
      <compare-slider after-label="BG Removed"></compare-slider>
    `);
  }
}

customElements.define('bg-removal-app', BgRemovalApp);
