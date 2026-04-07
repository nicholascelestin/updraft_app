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

  connectedCallback() {
    this.classList.add('upscale-preview');
    this.#render();

    this.addEventListener('click', e => {
      const expandBtn = e.target.closest('.preview-expand-btn');
      if (!expandBtn) return;
      this.setExpanded(!this.#expanded);
    });
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
    this.#syncExpandButtonLabel();
    if (this.style.display !== 'none') this.#applySize();
    this.#emitViewState();
  }

  #syncExpandButtonLabel() {
    const btn = this.querySelector('.preview-expand-btn');
    if (!btn) return;
    btn.textContent = this.#expanded ? 'Fit to View' : 'Full Size';
  }

  #applySize() {
    const canvas = this.querySelector('canvas');
    if (!canvas || !canvas.height) { this.style.maxWidth = ''; return; }
    const maxH = window.innerHeight - 160;
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

  #emitViewState() {
    this.dispatchEvent(new CustomEvent('view-state-change', {
      detail: { expanded: this.#expanded },
    }));
  }
}

customElements.define('upscale-preview', UpscalePreview);
