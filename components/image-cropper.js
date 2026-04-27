/**
 * <image-cropper> — optional bounding-box selection on the source image.
 *
 * Events:
 *   crop-changed  — detail: { crop: { x, y, w, h } | null }
 */

import { morph } from 'lib/morph';

class ImageCropper extends HTMLElement {
  #image = null;
  #crop = null;
  #dragging = false;
  #dragStart = null;
  #dragCurrent = null;

  #onWindowMouseMove = (e) => { if (this.#dragging) { this.#dragCurrent = this.#eventToElement(e); this.#drawOverlay(); } };
  #onWindowTouchMove = (e) => { if (this.#dragging) { this.#dragCurrent = this.#eventToElement(e); this.#drawOverlay(); } };
  #onWindowMouseUp = () => { if (this.#dragging) this.#finishDrag(); };
  #onWindowTouchEnd = () => { if (this.#dragging) this.#finishDrag(); };

  connectedCallback() {
    this.classList.add('image-cropper');
    this.#render();

    this.addEventListener('mousedown', e => {
      if (e.target.closest('.crop-clear')) { this.clearCrop(); return; }
      const canvas = e.target.closest('canvas');
      if (!canvas) return;
      this.#dragging = true;
      this.#dragStart = this.#eventToElement(e);
      this.#dragCurrent = this.#dragStart;
      this.#crop = null;
      this.#drawOverlay();
    });
    this.addEventListener('touchstart', e => {
      const canvas = e.target.closest('canvas');
      if (!canvas) return;
      this.#dragging = true;
      this.#dragStart = this.#eventToElement(e);
      this.#dragCurrent = this.#dragStart;
      this.#crop = null;
      this.#drawOverlay();
    }, { passive: true });

    window.addEventListener('mousemove', this.#onWindowMouseMove);
    window.addEventListener('touchmove', this.#onWindowTouchMove, { passive: true });
    window.addEventListener('mouseup', this.#onWindowMouseUp);
    window.addEventListener('touchend', this.#onWindowTouchEnd);
  }

  disconnectedCallback() {
    window.removeEventListener('mousemove', this.#onWindowMouseMove);
    window.removeEventListener('touchmove', this.#onWindowTouchMove);
    window.removeEventListener('mouseup', this.#onWindowMouseUp);
    window.removeEventListener('touchend', this.#onWindowTouchEnd);
  }

  show(image) {
    this.#image = image;
    this.#crop = null;
    this.style.setProperty('--ar', `${image.width} / ${image.height}`);
    this.style.setProperty('--natural-w', `${image.width}px`);
    this.#render();
    this.style.display = 'block';
    this.#resizeCanvas();
    this.#drawOverlay();
  }

  hide() {
    this.style.display = 'none';
    this.style.removeProperty('--ar');
    this.style.removeProperty('--natural-w');
    this.#image = null;
    this.#crop = null;
    const canvas = this.querySelector('canvas');
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }

  clearCrop() {
    this.#crop = null;
    this.#render();
    this.#resizeCanvas();
    this.#drawOverlay();
    this.dispatchEvent(new CustomEvent('crop-changed', { detail: { crop: null } }));
  }

  get crop() { return this.#crop; }

  extractImage() {
    const img = this.#image;
    if (!img) throw new Error('No image loaded');
    if (!this.#crop) return img;

    const { x, y, w, h } = this.#crop;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
    return canvas;
  }

  #resizeCanvas() {
    if (!this.#image) return;
    const canvas = this.querySelector('canvas');
    if (!canvas) return;
    canvas.width = this.#image.width;
    canvas.height = this.#image.height;
  }

  #eventToElement(e) {
    const canvas = this.querySelector('canvas');
    if (!canvas) return { ex: 0, ey: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      ex: Math.max(0, Math.min(rect.width, clientX - rect.left)),
      ey: Math.max(0, Math.min(rect.height, clientY - rect.top)),
    };
  }

  #finishDrag() {
    this.#dragging = false;
    if (!this.#dragStart || !this.#dragCurrent || !this.#image) return;

    const canvas = this.querySelector('canvas');
    const scaleX = this.#image.width / canvas.clientWidth;
    const scaleY = this.#image.height / canvas.clientHeight;

    const x1 = Math.min(this.#dragStart.ex, this.#dragCurrent.ex);
    const y1 = Math.min(this.#dragStart.ey, this.#dragCurrent.ey);
    const x2 = Math.max(this.#dragStart.ex, this.#dragCurrent.ex);
    const y2 = Math.max(this.#dragStart.ey, this.#dragCurrent.ey);

    const ix = Math.round(x1 * scaleX);
    const iy = Math.round(y1 * scaleY);
    const iw = Math.round((x2 - x1) * scaleX);
    const ih = Math.round((y2 - y1) * scaleY);

    if (iw < 16 || ih < 16) {
      this.#crop = null;
      this.#render();
      this.#resizeCanvas();
      this.#drawOverlay();
      this.dispatchEvent(new CustomEvent('crop-changed', { detail: { crop: null } }));
      return;
    }

    this.#crop = { x: ix, y: iy, w: iw, h: ih };
    this.#render();
    this.#resizeCanvas();
    this.#drawOverlay();
    this.dispatchEvent(new CustomEvent('crop-changed', { detail: { crop: this.#crop } }));
  }

  #drawOverlay() {
    const canvas = this.querySelector('canvas');
    if (!canvas || !this.#image) return;
    const ctx = canvas.getContext('2d');
    const cw = canvas.width;
    const ch = canvas.height;

    ctx.drawImage(this.#image, 0, 0, cw, ch);

    let sx, sy, sw, sh;
    if (this.#dragging && this.#dragStart && this.#dragCurrent) {
      const scaleX = cw / canvas.clientWidth;
      const scaleY = ch / canvas.clientHeight;
      sx = Math.min(this.#dragStart.ex, this.#dragCurrent.ex) * scaleX;
      sy = Math.min(this.#dragStart.ey, this.#dragCurrent.ey) * scaleY;
      sw = Math.abs(this.#dragCurrent.ex - this.#dragStart.ex) * scaleX;
      sh = Math.abs(this.#dragCurrent.ey - this.#dragStart.ey) * scaleY;
    } else if (this.#crop) {
      sx = this.#crop.x;
      sy = this.#crop.y;
      sw = this.#crop.w;
      sh = this.#crop.h;
    } else {
      return;
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, cw, sy);
    ctx.fillRect(0, sy, sx, sh);
    ctx.fillRect(sx + sw, sy, cw - sx - sw, sh);
    ctx.fillRect(0, sy + sh, cw, ch - sy - sh);

    ctx.strokeStyle = 'var(--pico-primary, #4c8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy, sw, sh);
  }

  #render() {
    const label = this.#crop
      ? `${this.#crop.w}\u00d7${this.#crop.h} selected`
      : 'Click and drag to select a region (optional)';
    const clearBtn = this.#crop
      ? '<button type="button" class="crop-clear">Clear Selection</button>'
      : '';

    morph(this, `
      <style>
        .image-cropper { display: none; }
        .image-cropper:not(.expanded) {
          width: auto;
          max-width: min(100%, var(--natural-w, 100%));
          max-height: 100vh;
          aspect-ratio: var(--ar, auto);
        }
        .image-cropper.expanded {
          width: 100%;
        }
        .image-cropper canvas {
          display: block;
          width: 100%;
          height: auto;
          max-width: 100%;
          border: 1px solid var(--pico-muted-border-color, #333);
          border-radius: var(--pico-border-radius, 4px);
          cursor: crosshair;
        }
        .image-cropper .crop-info {
          display: flex; align-items: center; gap: 0.75rem;
          font-size: 0.8rem; color: var(--pico-muted-color, #888); margin-bottom: 0.4rem;
        }
        .image-cropper .crop-info .crop-clear {
          padding: 0.3rem 0.6rem;
          font-size: 0.75rem;
          background: rgba(0,0,0,0.65);
          color: #eee;
          border: 1px solid rgba(255,255,255,0.3);
          border-radius: 4px;
          cursor: pointer;
          white-space: nowrap;
          backdrop-filter: blur(4px);
          width: auto;
          margin: 0;
        }
        .image-cropper .crop-info .crop-clear:hover {
          background: rgba(0,0,0,0.85);
          border-color: rgba(255,255,255,0.5);
        }
      </style>
      <div class="crop-info">
        <span>${label}</span>
        ${clearBtn}
      </div>
      <canvas></canvas>
    `);
  }
}

customElements.define('image-cropper', ImageCropper);
