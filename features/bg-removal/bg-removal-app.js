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
  #viewState = { expanded: false, upscaledOnly: false };

  connectedCallback() {
    this.#render();
    this.#setupEvents();
    this.#restoreViewState();
  }

  #q(sel) { return this.querySelector(sel); }

  #cleanup() {
    if (this.#resultBlobUrl) { URL.revokeObjectURL(this.#resultBlobUrl); this.#resultBlobUrl = null; }
    if (this.#checkerBlobUrl) { URL.revokeObjectURL(this.#checkerBlobUrl); this.#checkerBlobUrl = null; }
    if (this.#beforeBlobUrl) { URL.revokeObjectURL(this.#beforeBlobUrl); this.#beforeBlobUrl = null; }
    if (this.#transparentBlobUrl) { URL.revokeObjectURL(this.#transparentBlobUrl); this.#transparentBlobUrl = null; }
  }

  #syncViewSizeButtonLabel() {
    const btn = this.#q('.viewsize-btn');
    if (!btn) return;
    const expanded = this.#viewState.expanded;
    const icon = expanded ? 'fa-arrows-up-down' : 'fa-arrows-left-right-to-line';
    const label = expanded ? 'Fit Height' : 'Fit Width';
    btn.innerHTML = `<i class="fas ${icon}"></i> <span class="btn-label">${label}</span>`;
    btn.title = label;
  }

  #applyViewState() {
    const expanded = this.#viewState.expanded;
    this.#q('image-cropper').classList.toggle('expanded', expanded);
    this.#q('compare-slider').classList.toggle('expanded', expanded);
    this.#syncViewSizeButtonLabel();
  }

  #persistViewState() {
    localStorage.setItem('bgremoval_view_expanded', this.#viewState.expanded ? '1' : '0');
    localStorage.setItem('bgremoval_view_upscaled_only', this.#viewState.upscaledOnly ? '1' : '0');
  }

  #restoreViewState() {
    this.#viewState.expanded = localStorage.getItem('bgremoval_view_expanded') === '1';
    this.#viewState.upscaledOnly = localStorage.getItem('bgremoval_view_upscaled_only') === '1';
    this.#applyViewState();
    this.#q('compare-slider').setUpscaledOnly(this.#viewState.upscaledOnly);
  }

  #getVisibleCanvasElement() {
    for (const sel of ['compare-slider', 'image-cropper', 'image-drop-zone']) {
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

  #setupEvents() {
    const backendEl   = this.#q('.backend-select');
    const removeBtn   = this.#q('.remove-btn');
    const stopBtn     = this.#q('.stop-btn');
    const startOverBtn = this.#q('.startover-btn');
    const backToCropBtn = this.#q('.back-to-crop-btn');
    const clearCropBtn = this.#q('.clear-crop-btn');
    const viewSizeBtn = this.#q('.viewsize-btn');
    const zoomToggleBtn = this.#q('.zoom-toggle-btn');
    const openInTabBtn = this.#q('.open-in-tab-btn');
    const downloadBtn = this.#q('.download-btn');
    const toolbarLeft = this.#q('.canvas-toolbar-left');
    const toolbarRight = this.#q('.canvas-toolbar-right');
    const zoomHint = this.#q('.canvas-zoom-hint');

    const statusBar     = this.#q('status-bar');
    const dropZone      = this.#q('image-drop-zone');
    const cropper       = this.#q('image-cropper');
    const compareSlider = this.#q('compare-slider');

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
      backToCropBtn.style.display = 'inline-block';
      toolbarRight.hidden = false;
      syncZoomToggleLabel();
    };
    const hideCompareControls = () => {
      zoomToggleBtn.style.display = 'none';
      backToCropBtn.style.display = 'none';
      toolbarRight.hidden = true;
      zoomHint.hidden = true;
    };

    statusBar.message = 'Load an image to begin.';

    const resetToStart = () => {
      this.#loadedImage = null;
      this.#running = false;
      this.#abortController = null;
      this.#cleanup();
      removeBtn.disabled = true;
      stopBtn.style.display = 'none';
      startOverBtn.style.display = 'none';
      clearCropBtn.style.display = 'none';
      hideCompareControls();
      toolbarLeft.hidden = true;
      cropper.hide();
      compareSlider.hide();
      dropZone.show();
      statusBar.message = 'Load an image to begin.';
      statusBar.hideProgress();
    };

    const showReady = () => {
      removeBtn.disabled = false;
      startOverBtn.style.display = 'inline-block';
      hideCompareControls();
      toolbarLeft.hidden = false;
      compareSlider.hide();
      dropZone.hide();
      cropper.show(this.#loadedImage);
      const existingCrop = cropper.crop;
      if (existingCrop) {
        clearCropBtn.style.display = 'inline-block';
        statusBar.message = `${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 crop ${existingCrop.w}\u00d7${existingCrop.h} \u2014 ready to remove background.`;
      } else {
        clearCropBtn.style.display = 'none';
        statusBar.message = `${this.#loadedImage.width}\u00d7${this.#loadedImage.height}${CROP_HINT}`;
      }
      statusBar.hideProgress();
    };

    dropZone.addEventListener('image-loaded', (e) => {
      if (this.#running) {
        this.#abortController?.abort();
        this.#running = false;
        this.#abortController = null;
        stopBtn.style.display = 'none';
      }
      this.#loadedImage = e.detail.image;
      showReady();
    });

    cropper.addEventListener('crop-changed', (e) => {
      const crop = e.detail.crop;
      if (crop) {
        clearCropBtn.style.display = 'inline-block';
        statusBar.message = `${this.#loadedImage.width}\u00d7${this.#loadedImage.height} \u2014 crop ${crop.w}\u00d7${crop.h} \u2014 ready to remove background.`;
      } else {
        clearCropBtn.style.display = 'none';
        statusBar.message = `${this.#loadedImage.width}\u00d7${this.#loadedImage.height}${CROP_HINT}`;
      }
    });

    clearCropBtn.addEventListener('click', () => {
      cropper.clearCrop();
    });

    backToCropBtn.addEventListener('click', () => {
      if (this.#running || !this.#loadedImage) return;
      showReady();
    });

    viewSizeBtn.addEventListener('click', () => {
      this.#viewState.expanded = !this.#viewState.expanded;
      this.#applyViewState();
      this.#persistViewState();
      if (!this.#viewState.expanded) this.#snapCenterVisibleCanvas();
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

    compareSlider.addEventListener('view-state-change', (e) => {
      if (typeof e.detail.upscaledOnly === 'boolean') {
        this.#viewState.upscaledOnly = e.detail.upscaledOnly;
      }
      if (typeof e.detail.pixelZoomed === 'boolean') {
        this.classList.toggle('canvas-fullscreen', e.detail.pixelZoomed);
      }
      this.#persistViewState();
      syncZoomToggleLabel();
    });

    removeBtn.addEventListener('click', async () => {
      if (this.#running || !this.#loadedImage) return;
      this.#running = true;
      this.#cleanup();
      removeBtn.disabled = true;
      stopBtn.style.display = 'inline-block';
      startOverBtn.style.display = 'none';
      clearCropBtn.style.display = 'none';
      hideCompareControls();
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

        this.#transparentBlobUrl = await canvasToBlobUrl(resultCanvas);
        this.#checkerBlobUrl = await checkerboardComposite(resultCanvas);
        this.#beforeBlobUrl = await imageToBlobUrl(inputImage);

        compareSlider.classList.toggle('expanded', this.#viewState.expanded);
        await compareSlider.show(this.#beforeBlobUrl, this.#checkerBlobUrl, {
          downloadSrc: this.#transparentBlobUrl,
          downloadName: 'bg_removed.png',
        });
        compareSlider.setUpscaledOnly(this.#viewState.upscaledOnly);
        showCompareControls();

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

    stopBtn.addEventListener('click', () => {
      this.#abortController?.abort();
    });

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
        bg-removal-app .canvas-stack {
          position: relative;
          background: rgba(0, 0, 0, 0.4);
          border-radius: var(--pico-border-radius);
          padding: 0.5rem;
        }
        bg-removal-app .canvas-toolbar-rail {
          position: sticky;
          top: 0.75rem;
          height: 0;
          z-index: 10;
          pointer-events: none;
        }
        /* When the compare-slider is in pixel-zoom (fullscreen) mode it covers
           the page at z-index 1000, hiding the toolbars. Promote the rail to
           a fixed-position overlay above it so the canvas controls stay
           reachable without leaving fullscreen. */
        bg-removal-app.canvas-fullscreen .canvas-toolbar-rail {
          position: fixed;
          top: 0.75rem;
          left: 0;
          right: 0;
          z-index: 1001;
        }
        bg-removal-app .canvas-toolbar {
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
        bg-removal-app .canvas-toolbar-left {
          left: 0.75rem;
        }
        bg-removal-app .canvas-toolbar-right {
          right: 0.75rem;
        }
        bg-removal-app .canvas-toolbar[hidden] {
          display: none;
        }
        bg-removal-app .canvas-toolbar-stack-left {
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
        bg-removal-app .canvas-toolbar-stack-left > * {
          pointer-events: auto;
        }
        bg-removal-app .canvas-toolbar-stack-left > .canvas-toolbar {
          position: static;
          left: auto;
          top: auto;
          max-width: 100%;
        }
        bg-removal-app .canvas-zoom-hint {
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
        bg-removal-app .canvas-zoom-hint[hidden] {
          display: none;
        }
        bg-removal-app .canvas-toolbar button {
          margin-bottom: 0;
          padding: 0.25rem 0.5rem;
          font-size: 0.72rem;
          line-height: 1.2;
          width: auto;
          white-space: nowrap;
        }
        bg-removal-app .canvas-toolbar button.secondary,
        bg-removal-app .canvas-toolbar button.outline {
          opacity: 0.78;
          transition: opacity 0.15s ease;
          background: transparent;
          border-color: currentColor;
          color: #fff;
          mix-blend-mode: difference;
        }
        bg-removal-app .canvas-toolbar button.secondary:hover,
        bg-removal-app .canvas-toolbar button.outline:hover,
        bg-removal-app .canvas-toolbar button.secondary:focus-visible,
        bg-removal-app .canvas-toolbar button.outline:focus-visible {
          opacity: 1;
          background: transparent;
          border-color: currentColor;
          color: #fff;
        }
        bg-removal-app .canvas-toolbar button .fas {
          font-size: 0.78em;
          margin-right: 0.15rem;
        }
        bg-removal-app .canvas-toolbar button .btn-label {
          display: inline;
        }
        @media (max-width: 768px) {
          bg-removal-app .canvas-toolbar button .btn-label {
            display: none;
          }
          bg-removal-app .canvas-toolbar button .fas {
            margin-right: 0;
          }
        }
        bg-removal-app .canvas-toolbar status-bar {
          display: inline-flex;
          flex-direction: column;
          align-items: stretch;
          justify-content: center;
          gap: 0.15rem;
          margin-left: 0.3rem;
          min-width: 0;
          max-width: 20rem;
        }
        bg-removal-app .canvas-toolbar status-bar .status-text {
          font-size: 0.68rem;
          line-height: 1.25;
          min-height: 0;
          margin-bottom: 0;
          color: #fff;
          mix-blend-mode: difference;
        }
        bg-removal-app .canvas-toolbar status-bar .progress-track {
          width: 100%;
          max-width: 180px;
          height: 3px;
          margin-bottom: 0;
          mix-blend-mode: difference;
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
      </div>

      <div class="canvas-stack">
        <div class="canvas-toolbar-rail" aria-hidden="true">
          <div class="canvas-toolbar-stack-left">
            <div class="canvas-toolbar canvas-toolbar-left" hidden>
              <button class="back-to-crop-btn secondary outline" style="display:none" type="button" title="Back to crop / change selection">
                <i class="fas fa-arrow-left"></i><i class="fas fa-crop-simple"></i> <span class="btn-label">Edit Crop</span>
              </button>
              <button class="remove-btn" disabled title="Remove background">
                <i class="fas fa-eraser"></i> <span class="btn-label">Remove Background</span>
              </button>
              <button class="stop-btn secondary" style="display:none" title="Stop background removal">
                <i class="fas fa-stop"></i> <span class="btn-label">Stop</span>
              </button>
              <button class="viewsize-btn secondary outline" type="button" title="Fit Width">
                <i class="fas fa-arrows-left-right-to-line"></i> <span class="btn-label">Fit Width</span>
              </button>
              <button class="zoom-toggle-btn secondary outline" type="button" style="display:none" title="Toggle between slider compare and result-only inspection">
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
            <button class="open-in-tab-btn secondary outline" type="button" title="Open the result image in a new tab">
              <i class="fas fa-up-right-from-square"></i> <span class="btn-label">Open in Tab</span>
            </button>
            <button class="download-btn secondary outline" type="button" title="Download the transparent PNG">
              <i class="fas fa-download"></i> <span class="btn-label">Download</span>
            </button>
          </div>
        </div>
        <image-drop-zone></image-drop-zone>
        <image-cropper></image-cropper>
        <compare-slider after-label="BG Removed"></compare-slider>
      </div>
    `);
  }
}

customElements.define('bg-removal-app', BgRemovalApp);
