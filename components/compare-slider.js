/**
 * <compare-slider> — before/after image comparison slider.
 */

import { morph } from 'lib/morph';

const PROBE_PREFS_KEY = 'upscaler_compare_probe_prefs_v1';

class CompareSlider extends HTMLElement {
  #dragging = false;
  #beforeSrc = '';
  #afterSrc = '';
  #upscaledOnly = false;
  #pixelZoomed = false;
  #positionFrac = 0.5;
  #downloadSrc = '';
  #downloadName = '';
  #beforeCanvas = null;
  #afterCanvas = null;
  #lazyBlobURL = '';
  #probeRadius = 57;
  #probeRadiusMin = 16;
  #probeRadiusMax = 140;
  #probeRadiusStep = 4;
  #probeZoomLevel = 1;
  #probeZoomLevelMin = 0;
  #probeZoomLevelMax = 1;
  #probeZoomStep = 0.08;
  #probeCompareHeld = false;
  #lastProbePoint = null;

  #onWindowMouseMove = (e) => { if (this.#dragging) this.#setPosition(this.#getFrac(e)); };
  #onWindowTouchMove = (e) => { if (this.#dragging) this.#setPosition(this.#getFrac(e)); };
  #onWindowMouseUp = () => {
    this.#dragging = false;
    this.classList.remove('dragging');
    if (this.#probeCompareHeld) {
      this.#probeCompareHeld = false;
      this.#refreshPixelProbe();
    }
  };
  #onWindowTouchEnd = () => {
    this.#dragging = false;
    this.classList.remove('dragging');
  };
  #onWheel = (e) => {
    if (!(this.#upscaledOnly && !this.#pixelZoomed)) return;
    if (e.ctrlKey) {
      e.preventDefault();
      const nextZoom = this.#probeZoomLevel + (e.deltaY < 0 ? this.#probeZoomStep : -this.#probeZoomStep);
      this.#setProbeZoomLevel(nextZoom);
      this.#updatePixelProbe(e);
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      const nextRadius = this.#probeRadius + (e.deltaY < 0 ? this.#probeRadiusStep : -this.#probeRadiusStep);
      this.#setProbeRadius(nextRadius);
      this.#updatePixelProbe(e);
      return;
    }
    requestAnimationFrame(() => this.#refreshPixelProbe());
  };

  connectedCallback() {
    this.#loadProbePrefs();
    this.classList.add('compare');
    this.#render();

    this.addEventListener('mousedown', e => {
      if (this.#upscaledOnly) return;
      e.preventDefault(); this.#dragging = true; this.classList.add('dragging');
      this.#setPosition(this.#getFrac(e));
    });
    this.addEventListener('touchstart', e => {
      if (this.#upscaledOnly) return;
      this.#dragging = true; this.classList.add('dragging');
      this.#setPosition(this.#getFrac(e));
    }, { passive: true });

    window.addEventListener('mousemove', this.#onWindowMouseMove);
    window.addEventListener('touchmove', this.#onWindowTouchMove, { passive: true });
    window.addEventListener('mouseup', this.#onWindowMouseUp);
    window.addEventListener('touchend', this.#onWindowTouchEnd);

    this.addEventListener('click', e => {
      if (this.#upscaledOnly) {
        this.#togglePixelZoomAtPoint(e.clientX, e.clientY);
      }
    });
    this.addEventListener('mousemove', (e) => {
      this.#updatePixelProbe(e);
    });
    this.addEventListener('mousedown', (e) => {
      if (!(this.#upscaledOnly && !this.#pixelZoomed)) return;
      if (e.button !== 2) return;
      e.preventDefault();
      this.#probeCompareHeld = true;
      this.#updatePixelProbe(e);
    });
    this.addEventListener('contextmenu', (e) => {
      if (!(this.#upscaledOnly && !this.#pixelZoomed)) return;
      e.preventDefault();
    });
    this.addEventListener('mouseleave', () => {
      this.#hidePixelProbe();
    });
    this.addEventListener('wheel', this.#onWheel, { passive: false });
  }

  disconnectedCallback() {
    window.removeEventListener('mousemove', this.#onWindowMouseMove);
    window.removeEventListener('touchmove', this.#onWindowTouchMove);
    window.removeEventListener('mouseup', this.#onWindowMouseUp);
    window.removeEventListener('touchend', this.#onWindowTouchEnd);
    this.removeEventListener('wheel', this.#onWheel);
  }

  /**
   * @param {string} beforeSrc
   * @param {string} afterSrc
   * @param {{ downloadSrc?: string, downloadName?: string }} [opts]
   */
  async show(beforeSrc, afterSrc, opts = {}) {
    const canvasMode = beforeSrc instanceof HTMLCanvasElement;
    if (canvasMode) {
      this.#beforeCanvas = beforeSrc;
      this.#afterCanvas = afterSrc;
      this.#beforeSrc = '';
      this.#afterSrc = '';
      this.#downloadSrc = '';
    } else {
      this.#beforeCanvas = null;
      this.#afterCanvas = null;
      this.#beforeSrc = beforeSrc;
      this.#afterSrc = afterSrc;
      this.#downloadSrc = opts.downloadSrc || afterSrc;
    }
    this.#downloadName = opts.downloadName || 'download.png';
    this.#pixelZoomed = false;
    this.#render();

    if (!canvasMode) {
      const imgs = this.querySelectorAll('.compare-after, .compare-before-wrap img');
      await Promise.all([...imgs].map(img =>
        img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; })
      ));
    }

    const afterEl = this.querySelector('.compare-after');
    const natW = canvasMode
      ? (this.#afterCanvas?.width || 0)
      : (afterEl?.naturalWidth || 0);
    const natH = canvasMode
      ? (this.#afterCanvas?.height || 0)
      : (afterEl?.naturalHeight || 0);
    if (natW && natH) {
      this.style.setProperty('--ar', `${natW} / ${natH}`);
      this.style.setProperty('--natural-w', `${natW}px`);
    }

    this.style.display = 'block';
    this.#setPosition(this.#positionFrac);
    this.#syncModeClass();
    if (canvasMode) this.#prepareLazyDownload();
  }

  hide() {
    this.style.display = 'none';
    this.style.removeProperty('--ar');
    this.style.removeProperty('--natural-w');
    this.#hidePixelProbe();
    this.#beforeCanvas = null;
    this.#afterCanvas = null;
    this.#pixelZoomed = false;
    this.#probeCompareHeld = false;
    this.#lastProbePoint = null;
    if (this.#lazyBlobURL) {
      URL.revokeObjectURL(this.#lazyBlobURL);
      this.#lazyBlobURL = '';
      this.#downloadSrc = '';
    }
  }

  setUpscaledOnly(upscaledOnly) {
    this.#upscaledOnly = !!upscaledOnly;
    this.#pixelZoomed = false;
    this.#probeCompareHeld = false;
    this.#lastProbePoint = null;
    this.#hidePixelProbe();
    this.#render();
    if (!this.#upscaledOnly) this.#setPosition(this.#positionFrac);
    this.#syncModeClass();
    this.title = this.#upscaledOnly
      ? 'Click: Fullscreen Zoom \u00b7 Right-Click: Compare \u00b7 Shift+Scroll: Bubble Size \u00b7 Ctrl+Scroll: Zoom Factor'
      : '';
  }

  toggleUpscaledView() {
    this.setUpscaledOnly(!this.#upscaledOnly);
    this.#emitViewState();
  }

  async openInTab() {
    const url = this.#downloadSrc || await this.#ensureDownloadURL();
    if (url) window.open(url, '_blank');
  }

  async download() {
    const url = this.#downloadSrc || await this.#ensureDownloadURL();
    if (!url) return;
    const a = document.createElement('a');
    a.download = this.#downloadName || 'download.png';
    a.href = url;
    a.click();
  }

  #togglePixelZoom() {
    if (!this.#upscaledOnly) return;
    this.#pixelZoomed = !this.#pixelZoomed;
    this.#probeCompareHeld = false;
    if (!this.#pixelZoomed) {
      this.scrollLeft = 0;
      this.scrollTop = 0;
    }
    this.#hidePixelProbe();
    this.#syncModeClass();
    this.#emitViewState();
  }

  #togglePixelZoomAtPoint(clientX, clientY) {
    if (!this.#upscaledOnly || this.#pixelZoomed) {
      this.#togglePixelZoom();
      return;
    }
    const afterEl = this.querySelector('.compare-after');
    if (!afterEl) {
      this.#togglePixelZoom();
      return;
    }
    const rect = afterEl.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      this.#togglePixelZoom();
      return;
    }
    const fracX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const fracY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    this.#togglePixelZoom();
    requestAnimationFrame(() => {
      const zoomedAfter = this.querySelector('.compare-after');
      if (!zoomedAfter || !this.#pixelZoomed) return;
      const targetX = fracX * zoomedAfter.clientWidth;
      const targetY = fracY * zoomedAfter.clientHeight;
      const maxScrollLeft = Math.max(0, this.scrollWidth - this.clientWidth);
      const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight);
      this.scrollLeft = Math.max(0, Math.min(maxScrollLeft, targetX - this.clientWidth / 2));
      this.scrollTop = Math.max(0, Math.min(maxScrollTop, targetY - this.clientHeight / 2));
    });
  }

  #getFrac(e) {
    const rect = this.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  #setPosition(frac) {
    const clamped = Math.max(0, Math.min(1, frac));
    this.#positionFrac = clamped;
    const pct = (clamped * 100).toFixed(2) + '%';
    const wrap = this.querySelector('.compare-before-wrap');
    const handle = this.querySelector('.compare-handle');
    if (wrap) wrap.style.width = pct;
    if (handle) handle.style.left = pct;
  }

  #syncModeClass() {
    this.classList.toggle('upscaled-only', this.#upscaledOnly);
    this.classList.toggle('pixel-zoom', this.#upscaledOnly && this.#pixelZoomed);
    if (!(this.#upscaledOnly && !this.#pixelZoomed)) this.#hidePixelProbe();
  }

  #emitViewState() {
    this.dispatchEvent(new CustomEvent('view-state-change', {
      detail: {
        upscaledOnly: this.#upscaledOnly,
        pixelZoomed: this.#pixelZoomed,
      },
    }));
  }

  #drawCanvasSources() {
    const afterEl = this.querySelector('canvas.compare-after');
    if (afterEl && this.#afterCanvas) {
      afterEl.getContext('2d').drawImage(this.#afterCanvas, 0, 0);
    }
    const beforeEl = this.querySelector('.compare-before-wrap canvas');
    if (beforeEl && this.#beforeCanvas) {
      beforeEl.getContext('2d').drawImage(this.#beforeCanvas, 0, 0);
    }
  }

  async #ensureDownloadURL() {
    if (this.#downloadSrc) return this.#downloadSrc;
    if (!this.#afterCanvas) return '';
    const blob = await new Promise(r => this.#afterCanvas.toBlob(r, 'image/png'));
    this.#lazyBlobURL = URL.createObjectURL(blob);
    this.#downloadSrc = this.#lazyBlobURL;
    return this.#downloadSrc;
  }

  async #prepareLazyDownload() {
    const canvas = this.#afterCanvas;
    if (!canvas) return;
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (this.#afterCanvas !== canvas) return;
    this.#lazyBlobURL = URL.createObjectURL(blob);
    this.#downloadSrc = this.#lazyBlobURL;
  }

  #hidePixelProbe() {
    const probe = this.querySelector('.compare-pixel-probe');
    if (probe) {
      probe.classList.remove('visible');
      probe.classList.remove('no-content');
    }
  }

  #setProbeRadius(nextRadius) {
    const clamped = Math.max(this.#probeRadiusMin, Math.min(this.#probeRadiusMax, Math.round(nextRadius)));
    const changed = this.#probeRadius !== clamped;
    this.#probeRadius = clamped;
    const diameter = this.#probeRadius * 2 + 1;
    const probe = this.querySelector('.compare-pixel-probe');
    const probeCanvas = this.querySelector('.compare-pixel-probe-canvas');
    if (probe) {
      probe.style.width = `${diameter}px`;
      probe.style.height = `${diameter}px`;
    }
    if (probeCanvas) {
      probeCanvas.style.width = `${diameter}px`;
      probeCanvas.style.height = `${diameter}px`;
    }
    if (changed) this.#persistProbePrefs();
    this.#refreshPixelProbe();
  }

  #setProbeZoomLevel(nextLevel) {
    const clamped = Math.max(this.#probeZoomLevelMin, Math.min(this.#probeZoomLevelMax, nextLevel));
    const changed = this.#probeZoomLevel !== clamped;
    this.#probeZoomLevel = clamped;
    if (changed) this.#persistProbePrefs();
    this.#refreshPixelProbe();
  }

  #loadProbePrefs() {
    try {
      const raw = localStorage.getItem(PROBE_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      if (Number.isFinite(parsed.radius)) {
        this.#probeRadius = Math.max(this.#probeRadiusMin, Math.min(this.#probeRadiusMax, Math.round(parsed.radius)));
      }
      if (Number.isFinite(parsed.zoomLevel)) {
        this.#probeZoomLevel = Math.max(this.#probeZoomLevelMin, Math.min(this.#probeZoomLevelMax, parsed.zoomLevel));
      }
    } catch {
      // Ignore malformed or unavailable localStorage.
    }
  }

  #persistProbePrefs() {
    try {
      localStorage.setItem(PROBE_PREFS_KEY, JSON.stringify({
        radius: this.#probeRadius,
        zoomLevel: Number(this.#probeZoomLevel.toFixed(3)),
      }));
    } catch {
      // Ignore storage write failures.
    }
  }

  #refreshPixelProbe() {
    if (!this.#lastProbePoint) return;
    this.#updatePixelProbe({
      clientX: this.#lastProbePoint.clientX,
      clientY: this.#lastProbePoint.clientY,
      target: this,
    });
  }

  #updatePixelProbe(e) {
    if (!(this.#upscaledOnly && !this.#pixelZoomed)) {
      this.#hidePixelProbe();
      return;
    }
    const afterEl = this.querySelector('.compare-after');
    const beforeEl = this.querySelector('.compare-before-wrap img, .compare-before-wrap canvas');
    const probe = this.querySelector('.compare-pixel-probe');
    const probeCanvas = this.querySelector('.compare-pixel-probe-canvas');
    if (!afterEl || !probe || !probeCanvas) return;

    const rect = afterEl.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) {
      this.#hidePixelProbe();
      return;
    }
    this.#lastProbePoint = { clientX: e.clientX, clientY: e.clientY };

    const sourceEl = (this.#probeCompareHeld && beforeEl) ? beforeEl : afterEl;
    const natW = sourceEl.naturalWidth || sourceEl.width || 0;
    const natH = sourceEl.naturalHeight || sourceEl.height || 0;
    if (!natW || !natH || !rect.width || !rect.height) return;

    // Keep srcX/srcY in floating point so the bubble contents track the cursor
    // smoothly instead of stepping in integer source-pixel jumps.
    const srcX = (relX / rect.width) * natW;
    const srcY = (relY / rect.height) * natH;

    const diameter = this.#probeRadius * 2 + 1;
    const ctx = probeCanvas.getContext('2d');
    if (probeCanvas.width !== diameter || probeCanvas.height !== diameter) {
      probeCanvas.width = diameter;
      probeCanvas.height = diameter;
    }
    const noZoom = this.#probeZoomLevel <= this.#probeZoomLevelMin + 0.0001;
    const hideBubbleContent = noZoom && !this.#probeCompareHeld;
    probe.classList.toggle('no-content', hideBubbleContent);
    ctx.clearRect(0, 0, diameter, diameter);
    if (!hideBubbleContent) {
      ctx.imageSmoothingEnabled = false;
      const baseScaleX = rect.width ? (natW / rect.width) : 1;
      const baseScaleY = rect.height ? (natH / rect.height) : 1;
      const mixX = 1 + (1 - this.#probeZoomLevel) * (Math.max(1, baseScaleX) - 1);
      const mixY = 1 + (1 - this.#probeZoomLevel) * (Math.max(1, baseScaleY) - 1);
      const fSampleW = Math.max(1, diameter * mixX);
      const fSampleH = Math.max(1, diameter * mixY);

      // Float sample rect centered on the cursor, clamped to source bounds.
      const fSx = Math.max(0, Math.min(natW - fSampleW, srcX - fSampleW / 2));
      const fSy = Math.max(0, Math.min(natH - fSampleH, srcY - fSampleH / 2));

      // Magnification (display px per source px) — kept stable across frames
      // since fSampleW/H only change when radius/zoom change.
      const magX = diameter / fSampleW;
      const magY = diameter / fSampleH;

      // Snap the source sample rect outward to the integer pixel grid so
      // drawImage's nearest-neighbor sampling gets a stable source. Then
      // shift the destination by the rounding remainder * magnification so
      // the visible content slides smoothly with sub-pixel cursor motion.
      const sxInt = Math.floor(fSx);
      const syInt = Math.floor(fSy);
      const swInt = Math.min(natW - sxInt, Math.ceil(fSx + fSampleW) - sxInt);
      const shInt = Math.min(natH - syInt, Math.ceil(fSy + fSampleH) - syInt);
      const dx = -(fSx - sxInt) * magX;
      const dy = -(fSy - syInt) * magY;
      const dw = swInt * magX;
      const dh = shInt * magY;

      if (swInt > 0 && shInt > 0 && dw > 0 && dh > 0) {
        ctx.drawImage(sourceEl, sxInt, syInt, swInt, shInt, dx, dy, dw, dh);
      }
    }

    const bubbleSize = diameter + 2;
    const half = bubbleSize / 2;
    const intendedLeft = e.clientX - half;
    const intendedTop = e.clientY - half;
    const hostRect = this.getBoundingClientRect();
    const minLeft = hostRect.left;
    const minTop = hostRect.top;
    const maxLeft = hostRect.right - bubbleSize;
    const maxTop = hostRect.bottom - bubbleSize;
    let left = intendedLeft;
    let top = intendedTop;
    left = Math.max(minLeft, Math.min(maxLeft, left));
    top = Math.max(minTop, Math.min(maxTop, top));
    probe.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    probe.classList.add('visible');
  }

  #render() {
    const cm = !!this.#afterCanvas;
    const afterTag = cm
      ? `<canvas class="compare-after" width="${this.#afterCanvas.width}" height="${this.#afterCanvas.height}"></canvas>`
      : `<img class="compare-after" src="${this.#afterSrc}">`;
    const beforeTag = cm
      ? `<canvas width="${this.#beforeCanvas.width}" height="${this.#beforeCanvas.height}"></canvas>`
      : `<img src="${this.#beforeSrc}">`;
    morph(this, `
      <style>
        .compare {
          display: none; position: relative; overflow: hidden;
          border: 1px solid var(--pico-muted-border-color, #333);
          border-radius: var(--pico-border-radius, 4px);
          cursor: col-resize; user-select: none; max-width: 100%;
        }
        .compare:not(.expanded) {
          width: auto;
          max-width: min(100%, var(--natural-w, 100%));
          max-height: calc(100vh - 2rem);
          aspect-ratio: var(--ar, auto);
          margin-inline: auto;
        }
        .compare.expanded {
          width: auto;
          max-width: min(100%, var(--natural-w, 100%));
          margin-inline: auto;
        }
        .compare img, .compare canvas { display: block; width: 100%; height: auto; pointer-events: none; }
        .compare .compare-before-wrap {
          position: absolute; top: 0; left: 0; height: 100%; overflow: hidden;
          width: 50%; border-right: 2px solid rgba(255,255,255,0.35);
          transition: border-color 0.2s ease;
        }
        .compare.dragging .compare-before-wrap {
          border-right-color: #fff;
        }
        .compare .compare-before-wrap img,
        .compare .compare-before-wrap canvas { width: auto; height: 100%; max-width: none; }
        .compare .compare-handle {
          position: absolute; top: 0; bottom: 0; width: 2px; background: #fff;
          left: 50%; transform: translateX(-1px); z-index: 2; pointer-events: none;
          opacity: 0.35;
          transition: opacity 0.2s ease;
        }
        .compare.dragging .compare-handle {
          opacity: 1;
        }
        .compare .compare-handle .handle-knob {
          position: absolute; top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          display: inline-flex; align-items: center; gap: 8px;
          padding: 4px 8px;
          border-radius: 999px;
          background: rgba(255,255,255,0.92);
          border: 2px solid #333;
          box-shadow: 0 0 6px rgba(0,0,0,0.5);
          color: #333;
          white-space: nowrap;
        }
        .compare .compare-handle .handle-side {
          display: inline-flex; align-items: center; gap: 3px;
        }
        .compare .compare-handle .handle-side .fas {
          font-size: 11px;
        }
        .compare .compare-handle .handle-arrow {
          font-size: 9px; line-height: 1;
        }
        .compare.upscaled-only { cursor: crosshair; }
        .compare.upscaled-only.pixel-zoom {
          position: fixed;
          inset: 0;
          z-index: 1000;
          cursor: zoom-out;
          overflow: auto;
          max-width: none;
          max-height: none;
          width: 100vw;
          height: 100vh;
          border-radius: 0;
        }
        .compare.upscaled-only.pixel-zoom .compare-after {
          width: auto;
          max-width: none;
          height: auto;
        }
        .compare.upscaled-only .compare-before-wrap,
        .compare.upscaled-only .compare-handle {
          display: none;
        }
        .compare .compare-pixel-probe {
          position: fixed;
          top: 0;
          left: 0;
          width: 115px;
          height: 115px;
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,0.9);
          box-shadow: 0 2px 10px rgba(0,0,0,0.45);
          overflow: hidden;
          pointer-events: none;
          z-index: 2;
          display: none;
          background: #111;
          transform: translate3d(0, 0, 0);
          will-change: transform;
        }
        .compare .compare-pixel-probe.no-content {
          background: transparent;
        }
        .compare .compare-pixel-probe.no-content .compare-pixel-probe-canvas {
          display: none;
        }
        .compare .compare-pixel-probe.visible {
          display: block;
        }
        .compare .compare-pixel-probe-canvas {
          width: 115px;
          height: 115px;
          image-rendering: pixelated;
          display: block;
        }
      </style>
      ${afterTag}
      <div class="compare-before-wrap">
        ${beforeTag}
      </div>
      <div class="compare-handle" aria-hidden="true">
        <div class="handle-knob">
          <span class="handle-side handle-side-before" aria-label="Original">
            <i class="fas fa-eye-low-vision"></i>
            <span class="handle-arrow">\u25C0</span>
          </span>
          <span class="handle-side handle-side-after" aria-label="Enhanced">
            <span class="handle-arrow">\u25B6</span>
            <i class="fas fa-eye"></i>
          </span>
        </div>
      </div>
      <div class="compare-pixel-probe" aria-hidden="true">
        <canvas class="compare-pixel-probe-canvas" width="${this.#probeRadius * 2 + 1}" height="${this.#probeRadius * 2 + 1}"></canvas>
      </div>
    `);
    this.#setProbeRadius(this.#probeRadius);
    if (cm) this.#drawCanvasSources();
  }
}

customElements.define('compare-slider', CompareSlider);
