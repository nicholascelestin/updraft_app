/**
 * <upscale-preview> — canvas that drives tiled inference and shows live progress.
 *
 * Events:
 *   tile-complete     — detail: { index, total, tileMs, tilePixels }
 *   upscale-complete  — detail: { beforeSrc, afterSrc, elapsed }
 *   runpod-status     — detail: { message }
 */

import { morph } from 'lib/morph';
import { UpscalerEngine } from './upscaler-engine.js';

class UpscalePreview extends HTMLElement {
  #engine = null;
  #currentModelUrl = null;
  #labelText = '';
  #abortController = null;
  #blobURLs = [];
  #expanded = false;
  #naturalW = 0;

  connectedCallback() {
    this.classList.add('upscale-preview');
    this.#render();

    this.addEventListener('click', e => {
      const expandBtn = e.target.closest('.preview-expand-btn');
      if (!expandBtn) return;
      this.#expanded = !this.#expanded;
      this.#applySize();
      expandBtn.textContent = this.#expanded ? 'Fit to View' : 'Full Size';
    });
  }

  get engine() { return this.#engine; }
  get running() { return this.#abortController !== null; }

  async upscale(image, tileSize, backend, opts = {}) {
    this.#revokeBlobURLs();
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    const { modelUrl = 'models/4x-UltraMix_Balanced.onnx', scale = 4, inputRange = 1, denoise = 0, onModelProgress } = opts;

    const backendChanged = this.#engine?.activeBackend && this.#engine.activeBackend !== backend;
    if (!this.#engine || this.#currentModelUrl !== modelUrl || this.#engine.denoise !== denoise || backendChanged) {
      this.#engine = new UpscalerEngine({ modelUrl, scale, inputRange, denoise });
      this.#currentModelUrl = modelUrl;
    }

    await this.#engine.loadModel(backend, onModelProgress);

    const srcW = image.width;
    const srcH = image.height;
    const outW = srcW * this.#engine.scale;
    const outH = srcH * this.#engine.scale;

    this.#labelText = `Upscaling ${srcW}\u00d7${srcH} \u2192 ${outW}\u00d7${outH}\u2026`;
    this.#naturalW = outW;
    this.#expanded = false;
    this.#render();
    this.style.display = 'block';

    const canvas = this.querySelector('canvas');
    canvas.width = outW;
    canvas.height = outH;
    this.#applySize();
    const ctx = canvas.getContext('2d');

    // Draw source scaled up, then dim it
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, outW, outH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, outW, outH);

    try {
      const resultCanvas = await this.#engine.upscale(image, tileSize, (info) => {
        // Draw just the completed tile region at full brightness
        const { outX, outY, outW: tw, outH: th } = info;
        ctx.drawImage(info.canvas, outX, outY, tw, th, outX, outY, tw, th);
        this.dispatchEvent(new CustomEvent('tile-complete', {
          detail: { index: info.index, total: info.total, tileMs: info.tileMs, tilePixels: info.tilePixels },
        }));
      }, signal);

      const elapsed = performance.now();

      const beforeCanvas = document.createElement('canvas');
      beforeCanvas.width = outW;
      beforeCanvas.height = outH;
      const bCtx = beforeCanvas.getContext('2d');
      bCtx.imageSmoothingEnabled = false;
      bCtx.drawImage(image, 0, 0, outW, outH);

      const [afterBlob, beforeBlob] = await Promise.all([
        new Promise(r => resultCanvas.toBlob(r, 'image/png')),
        new Promise(r => beforeCanvas.toBlob(r, 'image/png')),
      ]);

      const afterSrc = URL.createObjectURL(afterBlob);
      const beforeSrc = URL.createObjectURL(beforeBlob);
      this.#blobURLs = [afterSrc, beforeSrc];

      this.dispatchEvent(new CustomEvent('upscale-complete', {
        detail: { beforeSrc, afterSrc, elapsed },
      }));

      return { beforeSrc, afterSrc, elapsed };
    } finally {
      this.#abortController = null;
    }
  }

  async upscaleRunPod(image, { endpointId, apiKey, scale = 4 }) {
    this.#revokeBlobURLs();
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    const { RunPodEngine } = await import('./runpod-engine.js');
    const engine = new RunPodEngine({ endpointId, apiKey, scale });

    const srcW = image.width;
    const srcH = image.height;
    const outW = srcW * scale;
    const outH = srcH * scale;

    this.#labelText = `Upscaling ${srcW}\u00d7${srcH} via RunPod\u2026`;
    this.#naturalW = outW;
    this.#expanded = false;
    this.#render();
    this.style.display = 'block';

    const canvas = this.querySelector('canvas');
    canvas.width = outW;
    canvas.height = outH;
    this.#applySize();
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, outW, outH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, outW, outH);

    try {
      const { canvas: resultCanvas, scale: actualScale } = await engine.upscale(image, (msg) => {
        this.dispatchEvent(new CustomEvent('runpod-status', { detail: { message: msg } }));
      }, signal);

      const beforeCanvas = document.createElement('canvas');
      beforeCanvas.width = resultCanvas.width;
      beforeCanvas.height = resultCanvas.height;
      const bCtx = beforeCanvas.getContext('2d');
      bCtx.imageSmoothingEnabled = false;
      bCtx.drawImage(image, 0, 0, resultCanvas.width, resultCanvas.height);

      const [afterBlob, beforeBlob] = await Promise.all([
        new Promise(r => resultCanvas.toBlob(r, 'image/png')),
        new Promise(r => beforeCanvas.toBlob(r, 'image/png')),
      ]);

      const afterSrc = URL.createObjectURL(afterBlob);
      const beforeSrc = URL.createObjectURL(beforeBlob);
      this.#blobURLs = [afterSrc, beforeSrc];

      return { beforeSrc, afterSrc, scale: actualScale };
    } finally {
      this.#abortController = null;
    }
  }

  stop() {
    this.#abortController?.abort();
  }

  cleanup() {
    this.#revokeBlobURLs();
    this.#clearCanvas();
  }

  show() { this.style.display = 'block'; }

  hide() {
    this.style.display = 'none';
    this.style.maxWidth = '';
    this.#expanded = false;
    this.#clearCanvas();
  }

  #applySize() {
    if (this.#expanded) {
      this.style.maxWidth = this.#naturalW ? this.#naturalW + 'px' : '';
    } else {
      const canvas = this.querySelector('canvas');
      if (!canvas || !canvas.height) { this.style.maxWidth = ''; return; }
      const maxH = window.innerHeight - 160;
      const aspect = canvas.width / canvas.height;
      const fittedW = Math.round(maxH * aspect);
      this.style.maxWidth = Math.min(fittedW, this.#naturalW || Infinity) + 'px';
    }
  }

  #revokeBlobURLs() {
    for (const url of this.#blobURLs) URL.revokeObjectURL(url);
    this.#blobURLs = [];
  }

  #clearCanvas() {
    const canvas = this.querySelector('canvas');
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }

  #render() {
    const expandLabel = this.#expanded ? 'Fit to View' : 'Full Size';
    morph(this, `
      <style>
        .upscale-preview { display: none; position: relative; }
        .upscale-preview canvas {
          display: block; max-width: 100%; height: auto;
          border: 1px solid var(--pico-muted-border-color, #333);
          border-radius: var(--pico-border-radius, 4px);
          background: #000;
        }
        .upscale-preview .upscale-preview-label {
          font-size: 0.8rem;
          color: var(--pico-muted-color, #888);
          margin-bottom: 0.4rem;
        }
        .upscale-preview .preview-toolbar {
          position: absolute; bottom: 14px; right: 10px; z-index: 3;
          display: flex; gap: 0.4rem;
        }
        .upscale-preview .preview-toolbar button {
          padding: 0.3rem 0.6rem; font-size: 0.75rem;
          background: rgba(0,0,0,0.65); color: #eee; border: 1px solid rgba(255,255,255,0.3);
          border-radius: 4px; cursor: pointer; white-space: nowrap;
          backdrop-filter: blur(4px); width: auto; margin: 0;
        }
        .upscale-preview .preview-toolbar button:hover {
          background: rgba(0,0,0,0.85); border-color: rgba(255,255,255,0.5);
        }
      </style>
      <h3 class="upscale-preview-label">${this.#labelText}</h3>
      <canvas></canvas>
      <div class="preview-toolbar">
        <button class="preview-expand-btn">${expandLabel}</button>
      </div>
    `);
  }
}

customElements.define('upscale-preview', UpscalePreview);
