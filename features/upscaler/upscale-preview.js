/**
 * <upscale-preview> — canvas that shows live tile-by-tile upscale progress.
 *
 * Pure presentation component. The parent orchestrates engines and the
 * upscale pipeline; this element just renders tiles as they arrive.
 *
 * Events emitted:
 *   view-state-change — detail: { expanded }
 */

import { morph } from 'lib/morph';

class UpscalePreview extends HTMLElement {
  #labelText = '';
  #expanded = false;
  #naturalW = 0;
  #ctx = null;
  #onWindowResize = () => {
    if (this.style.display !== 'none') this.#applySize();
  };

  connectedCallback() {
    this.classList.add('upscale-preview');
    this.#render();
    window.addEventListener('resize', this.#onWindowResize);
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this.#onWindowResize);
  }

  get expanded() { return this.#expanded; }

  /**
   * Set up the canvas with a dimmed version of the source image,
   * indicating that upscaling is about to begin.
   */
  showDimmedPreview(image, outW, outH, label) {
    this.#labelText = label;
    this.#naturalW = outW;
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
    this.#ctx = ctx;
  }

  /**
   * Draw a completed tile onto the preview canvas.
   * Uses the overlap-cropped rect when available so each pixel is written
   * exactly once per step (avoids double-blend artifacts at tile seams).
   * @param {{ canvas: HTMLCanvasElement, outX: number, outY: number, outW: number, outH: number, crop?: {x:number,y:number,w:number,h:number} }} tileInfo
   * @param {{ opacity?: number }} [opts]
   */
  drawTile(tileInfo, { opacity = 1 } = {}) {
    if (!this.#ctx) return;
    const { x, y, w, h } = tileInfo.crop ?? {
      x: tileInfo.outX, y: tileInfo.outY, w: tileInfo.outW, h: tileInfo.outH,
    };
    const needsAlpha = opacity < 1;
    if (needsAlpha) { this.#ctx.save(); this.#ctx.globalAlpha = opacity; }
    this.#ctx.drawImage(tileInfo.canvas, x, y, w, h, x, y, w, h);
    if (needsAlpha) this.#ctx.restore();
  }

  cleanup() {
    this.#clearCanvas();
    this.#ctx = null;
  }

  show() { this.style.display = 'block'; }

  hide() {
    this.style.display = 'none';
    this.style.maxWidth = '';
    this.#clearCanvas();
    this.#ctx = null;
  }

  setExpanded(expanded) {
    const next = !!expanded;
    if (this.#expanded === next) return;
    this.#expanded = next;
    if (this.style.display !== 'none') this.#applySize();
  }

  #applySize() {
    const canvas = this.querySelector('canvas');
    if (!canvas || !canvas.height) { this.style.maxWidth = ''; return; }
    const maxH = this.#getViewportFitHeight();
    const aspect = canvas.width / canvas.height;
    const fittedW = Math.round(maxH * aspect);

    if (this.#expanded) {
      const naturalW = this.#naturalW || canvas.width || 0;
      const minExpandedW = Math.max(naturalW, fittedW);
      this.style.maxWidth = minExpandedW ? minExpandedW + 'px' : '';
    } else {
      this.style.maxWidth = Math.min(fittedW, this.#naturalW || Infinity) + 'px';
    }
  }

  #getViewportFitHeight() {
    const rect = this.getBoundingClientRect();
    const parent = this.parentElement;
    const parentPadBottom = parent ? (parseFloat(getComputedStyle(parent).paddingBottom) || 0) : 0;
    const viewportGap = 8;
    const top = Math.max(0, rect.top);
    const available = window.innerHeight - top - parentPadBottom - viewportGap;
    return Math.max(160, Math.round(available));
  }

  #clearCanvas() {
    const canvas = this.querySelector('canvas');
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }

  #render() {
    morph(this, `
      <style>
        .upscale-preview { display: none; position: relative; }
        .upscale-preview canvas {
          display: block; width: 100%; max-width: 100%; height: auto;
          border: 1px solid var(--pico-muted-border-color, #333);
          border-radius: var(--pico-border-radius, 4px);
          background: #000;
        }
        .upscale-preview .upscale-preview-label {
          font-size: 0.8rem;
          color: var(--pico-muted-color, #888);
          margin-bottom: 0.4rem;
        }
      </style>
      <h3 class="upscale-preview-label">${this.#labelText}</h3>
      <canvas></canvas>
    `);
  }
}

customElements.define('upscale-preview', UpscalePreview);
