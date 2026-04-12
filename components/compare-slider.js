/**
 * <compare-slider> — before/after image comparison slider.
 */

import { morph } from 'lib/morph';
import { esc } from 'lib/escape';

class CompareSlider extends HTMLElement {
  #dragging = false;
  #resizeObserver;
  #beforeSrc = '';
  #afterSrc = '';
  #expanded = false;
  #upscaledOnly = false;
  #positionFrac = 0.5;
  #naturalMaxWidth = 0;
  #downloadSrc = '';
  #downloadName = '';
  #beforeCanvas = null;
  #afterCanvas = null;
  #lazyBlobURL = '';

  #onWindowMouseMove = (e) => { if (this.#dragging) this.#setPosition(this.#getFrac(e)); };
  #onWindowTouchMove = (e) => { if (this.#dragging) this.#setPosition(this.#getFrac(e)); };
  #onWindowMouseUp = () => { this.#dragging = false; };
  #onWindowTouchEnd = () => { this.#dragging = false; };

  connectedCallback() {
    this.classList.add('compare');
    this.#render();

    this.addEventListener('mousedown', e => {
      if (this.#upscaledOnly) return;
      if (e.target.closest('.compare-toolbar')) return;
      e.preventDefault(); this.#dragging = true; this.#setPosition(this.#getFrac(e));
    });
    this.addEventListener('touchstart', e => {
      if (this.#upscaledOnly) return;
      if (e.target.closest('.compare-toolbar')) return;
      this.#dragging = true; this.#setPosition(this.#getFrac(e));
    }, { passive: true });

    window.addEventListener('mousemove', this.#onWindowMouseMove);
    window.addEventListener('touchmove', this.#onWindowTouchMove, { passive: true });
    window.addEventListener('mouseup', this.#onWindowMouseUp);
    window.addEventListener('touchend', this.#onWindowTouchEnd);

    this.addEventListener('click', async e => {
      const openBtn = e.target.closest('.compare-open-btn');
      const expandBtn = e.target.closest('.compare-expand-btn');
      const toggleBtn = e.target.closest('.compare-toggle-upscaled-btn');
      const downloadBtn = e.target.closest('.compare-download-btn');
      if (openBtn) {
        const url = this.#downloadSrc || await this.#ensureDownloadURL();
        if (url) window.open(url, '_blank');
        return;
      }
      if (expandBtn) {
        this.toggleExpand();
        expandBtn.textContent = this.#expanded ? 'Fit to View' : 'Full Size';
      }
      if (toggleBtn) {
        this.toggleUpscaledView();
        toggleBtn.textContent = this.#upscaledOnly ? 'Show Compare' : 'Show Upscaled';
      }
      if (downloadBtn) {
        const url = this.#downloadSrc || await this.#ensureDownloadURL();
        if (url) {
          const a = document.createElement('a');
          a.download = this.#downloadName;
          a.href = url;
          a.click();
        }
      }
    });

    this.#resizeObserver = new ResizeObserver(() => {
      if (this.style.display !== 'none') {
        const el = this.querySelector('.compare-before-wrap img, .compare-before-wrap canvas');
        if (el) el.style.width = this.offsetWidth + 'px';
      }
    });
    this.#resizeObserver.observe(this);
  }

  disconnectedCallback() {
    this.#resizeObserver?.disconnect();
    window.removeEventListener('mousemove', this.#onWindowMouseMove);
    window.removeEventListener('touchmove', this.#onWindowTouchMove);
    window.removeEventListener('mouseup', this.#onWindowMouseUp);
    window.removeEventListener('touchend', this.#onWindowTouchEnd);
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
    this.#render();

    if (!canvasMode) {
      const imgs = this.querySelectorAll('.compare-after, .compare-before-wrap img');
      await Promise.all([...imgs].map(img =>
        img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; })
      ));
    }

    this.#naturalMaxWidth = parseInt(this.style.maxWidth, 10) || 0;
    this.style.display = 'block';
    this.#applySize();
    this.#setPosition(this.#positionFrac);
    this.#syncModeClass();
    if (canvasMode) this.#prepareLazyDownload();
  }

  hide() {
    this.style.display = 'none';
    this.style.maxWidth = '';
    this.#beforeCanvas = null;
    this.#afterCanvas = null;
    if (this.#lazyBlobURL) {
      URL.revokeObjectURL(this.#lazyBlobURL);
      this.#lazyBlobURL = '';
      this.#downloadSrc = '';
    }
  }

  get afterSrc() { return this.#afterSrc; }

  toggleExpand() {
    this.#expanded = !this.#expanded;
    this.#applySize();
    this.#emitViewState();
  }

  get expanded() { return this.#expanded; }
  get upscaledOnly() { return this.#upscaledOnly; }

  toggleUpscaledView() {
    this.#upscaledOnly = !this.#upscaledOnly;
    this.#syncModeClass();
    if (!this.#upscaledOnly) this.#setPosition(this.#positionFrac);
    this.#emitViewState();
  }

  setExpanded(expanded) {
    const next = !!expanded;
    if (this.#expanded === next) return;
    this.#expanded = next;
    if (this.style.display !== 'none') this.#applySize();
    this.#render();
    this.#syncModeClass();
  }

  setViewState({ expanded, upscaledOnly } = {}) {
    if (typeof expanded === 'boolean') this.#expanded = expanded;
    if (typeof upscaledOnly === 'boolean') this.#upscaledOnly = upscaledOnly;
    this.#render();
    if (this.style.display !== 'none') {
      this.#applySize();
      this.#setPosition(this.#positionFrac);
    }
    this.#syncModeClass();
  }

  #applySize() {
    const afterEl = this.querySelector('.compare-after');
    if (!afterEl) return;
    const natW = afterEl.naturalWidth || afterEl.width;
    const natH = afterEl.naturalHeight || afterEl.height;
    const maxH = window.innerHeight - 160;
    const aspect = natW / natH;
    const fittedW = Math.round(maxH * aspect);

    if (this.#expanded) {
      const expandedNatW = this.#naturalMaxWidth || natW || 0;
      const minExpandedW = Math.max(expandedNatW, fittedW);
      this.style.maxWidth = minExpandedW ? minExpandedW + 'px' : '';
    } else {
      const callerMax = this.#naturalMaxWidth || Infinity;
      this.style.maxWidth = Math.min(fittedW, callerMax) + 'px';
    }

    requestAnimationFrame(() => {
      const el = this.querySelector('.compare-before-wrap img, .compare-before-wrap canvas');
      if (el) el.style.width = this.offsetWidth + 'px';
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
    const media = this.querySelector('.compare-before-wrap img, .compare-before-wrap canvas');
    if (wrap) wrap.style.width = pct;
    if (handle) handle.style.left = pct;
    if (media) media.style.width = this.offsetWidth + 'px';
  }

  #syncModeClass() {
    this.classList.toggle('upscaled-only', this.#upscaledOnly);
  }

  #emitViewState() {
    this.dispatchEvent(new CustomEvent('view-state-change', {
      detail: {
        expanded: this.#expanded,
        upscaledOnly: this.#upscaledOnly,
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

  #render() {
    const expandLabel = this.#expanded ? 'Fit to View' : 'Full Size';
    const toggleLabel = this.#upscaledOnly ? 'Show Compare' : 'Show Upscaled';
    const beforeLabel = esc(this.getAttribute('before-label') || 'Original');
    const afterLabel = esc(this.getAttribute('after-label') || '4x Upscaled');
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
        .compare img, .compare canvas { display: block; width: 100%; height: auto; pointer-events: none; }
        .compare .compare-before-wrap {
          position: absolute; top: 0; left: 0; height: 100%; overflow: hidden;
          width: 50%; border-right: 2px solid #fff;
        }
        .compare .compare-before-wrap img,
        .compare .compare-before-wrap canvas { width: auto; height: 100%; max-width: none; }
        .compare .compare-handle {
          position: absolute; top: 0; bottom: 0; width: 2px; background: #fff;
          left: 50%; transform: translateX(-1px); z-index: 2; pointer-events: none;
        }
        .compare .compare-handle::after {
          content: ''; position: absolute; top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          width: 36px; height: 36px; border-radius: 50%;
          background: rgba(255,255,255,0.9); border: 2px solid #333;
          box-shadow: 0 0 6px rgba(0,0,0,0.5);
        }
        .compare .compare-handle::before {
          content: '\\25C0  \\25B6'; position: absolute; top: 50%; left: 50%;
          transform: translate(-50%, -50%); z-index: 1;
          font-size: 10px; color: #333; white-space: nowrap;
        }
        .compare .compare-label {
          position: absolute; top: 8px; padding: 2px 8px; font-size: 0.7rem;
          background: rgba(0,0,0,0.6); color: #ccc; border-radius: 3px; z-index: 1;
          pointer-events: none;
        }
        .compare .compare-label-before { left: 8px; }
        .compare .compare-label-after { right: 8px; }
        .compare .compare-toolbar {
          position: absolute; bottom: 10px; right: 10px; z-index: 3;
          display: flex; gap: 0.4rem; cursor: default;
        }
        .compare .compare-toolbar button {
          padding: 0.3rem 0.6rem; font-size: 0.75rem;
          background: rgba(0,0,0,0.65); color: #eee; border: 1px solid rgba(255,255,255,0.3);
          border-radius: 4px; cursor: pointer; white-space: nowrap;
          backdrop-filter: blur(4px); width: auto; margin: 0;
        }
        .compare .compare-toolbar button:hover {
          background: rgba(0,0,0,0.85); border-color: rgba(255,255,255,0.5);
        }
        .compare.upscaled-only { cursor: default; }
        .compare.upscaled-only .compare-before-wrap,
        .compare.upscaled-only .compare-handle,
        .compare.upscaled-only .compare-label-before {
          display: none;
        }
      </style>
      ${afterTag}
      <div class="compare-before-wrap">
        ${beforeTag}
      </div>
      <div class="compare-handle"></div>
      <span class="compare-label compare-label-before">${beforeLabel}</span>
      <span class="compare-label compare-label-after">${afterLabel}</span>
      <div class="compare-toolbar">
        <button type="button" class="compare-toggle-upscaled-btn">${toggleLabel}</button>
        <button type="button" class="compare-open-btn">Open in Tab</button>
        <button type="button" class="compare-expand-btn">${expandLabel}</button>
        <button type="button" class="compare-download-btn"><i class="fas fa-download"></i> Download</button>
      </div>
    `);
    if (cm) this.#drawCanvasSources();
  }
}

customElements.define('compare-slider', CompareSlider);
