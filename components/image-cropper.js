/**
 * <image-cropper> — optional bounding-box selection on the source image.
 *
 * Events:
 *   crop-changed  — detail: { crop: { x, y, w, h } | null }
 */

import { morph } from 'lib/morph';
import { cropToCanvas } from 'lib/canvas';

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
    // Preserve the existing crop selection when re-shown with the same image
    // reference (e.g. when the upscaler navigates back to crop mode from the
    // compare view). A genuinely new image still resets the crop.
    const sameImage = image === this.#image;
    this.#image = image;
    if (!sameImage) this.#crop = null;
    this.style.setProperty('--ar', `${image.width} / ${image.height}`);
    this.style.setProperty('--ar-num', `${image.width / image.height}`);
    this.style.setProperty('--natural-w', `${image.width}px`);
    this.#render();
    this.style.display = 'flex';
    this.#resizeCanvas();
    this.#drawOverlay();
  }

  hide() {
    this.style.display = 'none';
    this.style.removeProperty('--ar');
    this.style.removeProperty('--ar-num');
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
    this.dispatchEvent(new CustomEvent('crop-changed', { bubbles: true, detail: { crop: null } }));
  }

  get crop() { return this.#crop; }

  extractImage() {
    const img = this.#image;
    if (!img) throw new Error('No image loaded');
    if (!this.#crop) return img;
    return cropToCanvas(img, this.#crop);
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
      this.dispatchEvent(new CustomEvent('crop-changed', { bubbles: true, detail: { crop: null } }));
      return;
    }

    this.#crop = { x: ix, y: iy, w: iw, h: ih };
    this.#render();
    this.#resizeCanvas();
    this.#drawOverlay();
    this.dispatchEvent(new CustomEvent('crop-changed', { bubbles: true, detail: { crop: this.#crop } }));
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
    morph(this, `
      <style>
        /* The workspace is always a viewport-sized scroll container, so the
           image can be panned (scrollbar / trackpad / wheel) in every mode --
           not just when explicitly zoomed. The view modes only change how the
           canvas is sized *inside* this constant box. */
        .image-cropper {
          display: none;
          width: 100%;
          max-width: 100%;
          height: calc(100vh - 1rem);
          max-height: calc(100vh - 1rem);
          overflow: auto;
          margin-inline: auto;
        }
        .image-cropper canvas {
          display: block;
          margin: auto;
          flex: 0 0 auto;
          background: #000;
          border: 1px solid var(--pico-muted-border-color, #333);
          border-radius: var(--pico-border-radius, 4px);
          cursor: crosshair;
        }
        /* fit-width: fill the box width; overflow (and pan) vertically when the
           image is taller than the viewport. */
        .image-cropper:not(.expanded):not(.native-size):not(.zoomed) canvas {
          width: 100%;
          height: auto;
          max-width: 100%;
        }
        /* fit-height: fill the box height; overflow horizontally when wide. */
        .image-cropper.expanded canvas {
          height: 100%;
          width: auto;
          max-width: none;
        }
        /* 1:1 -- native pixels. */
        .image-cropper.native-size canvas {
          width: auto;
          height: auto;
          max-width: none;
        }
        /* explicit zoom factor (natural width × --zoom). */
        .image-cropper.zoomed canvas {
          width: calc(var(--natural-w, 100%) * var(--zoom, 1));
          height: auto;
          max-width: none;
        }
      </style>
      <canvas></canvas>
    `);
  }
}

customElements.define('image-cropper', ImageCropper);
