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
  #naturalMaxWidth = 0;
  #downloadSrc = '';   // separate src for download (e.g. transparent PNG for bg-removal)
  #downloadName = '';

  #onWindowMouseMove = (e) => { if (this.#dragging) this.#setPosition(this.#getFrac(e)); };
  #onWindowTouchMove = (e) => { if (this.#dragging) this.#setPosition(this.#getFrac(e)); };
  #onWindowMouseUp = () => { this.#dragging = false; };
  #onWindowTouchEnd = () => { this.#dragging = false; };

  connectedCallback() {
    this.classList.add('compare');
    this.#render();

    this.addEventListener('mousedown', e => {
      if (e.target.closest('.compare-toolbar')) return;
      e.preventDefault(); this.#dragging = true; this.#setPosition(this.#getFrac(e));
    });
    this.addEventListener('touchstart', e => {
      if (e.target.closest('.compare-toolbar')) return;
      this.#dragging = true; this.#setPosition(this.#getFrac(e));
    }, { passive: true });

    window.addEventListener('mousemove', this.#onWindowMouseMove);
    window.addEventListener('touchmove', this.#onWindowTouchMove, { passive: true });
    window.addEventListener('mouseup', this.#onWindowMouseUp);
    window.addEventListener('touchend', this.#onWindowTouchEnd);

    this.addEventListener('click', e => {
      const openBtn = e.target.closest('.compare-open-btn');
      const expandBtn = e.target.closest('.compare-expand-btn');
      const downloadBtn = e.target.closest('.compare-download-btn');
      if (openBtn && this.#downloadSrc) {
        window.open(this.#downloadSrc, '_blank');
        return;
      }
      if (expandBtn) {
        this.toggleExpand();
        expandBtn.textContent = this.#expanded ? 'Fit to View' : 'Full Size';
      }
      if (downloadBtn) {
        const a = document.createElement('a');
        a.download = this.#downloadName;
        a.href = this.#downloadSrc;
        a.click();
      }
    });

    this.#resizeObserver = new ResizeObserver(() => {
      if (this.style.display !== 'none') {
        const img = this.querySelector('.compare-before-wrap img');
        if (img) img.style.width = this.offsetWidth + 'px';
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
    this.#beforeSrc = beforeSrc;
    this.#afterSrc = afterSrc;
    this.#downloadSrc = opts.downloadSrc || afterSrc;
    this.#downloadName = opts.downloadName || 'download.png';
    this.#render();

    const imgs = this.querySelectorAll('.compare-after, .compare-before-wrap img');
    await Promise.all([...imgs].map(img =>
      img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; })
    ));

    this.#naturalMaxWidth = parseInt(this.style.maxWidth, 10) || 0;
    this.style.display = 'block';
    this.#applySize();
    this.#setPosition(0.5);
  }

  hide() {
    this.style.display = 'none';
    this.style.maxWidth = '';
    this.#expanded = false;
  }

  get afterSrc() { return this.#afterSrc; }

  toggleExpand() {
    this.#expanded = !this.#expanded;
    this.#applySize();
  }

  get expanded() { return this.#expanded; }

  #applySize() {
    const afterImg = this.querySelector('.compare-after');
    if (!afterImg) return;

    if (this.#expanded) {
      this.style.maxWidth = this.#naturalMaxWidth ? this.#naturalMaxWidth + 'px' : '';
    } else {
      const maxH = window.innerHeight - 160;
      const aspect = afterImg.naturalWidth / afterImg.naturalHeight;
      const fittedW = Math.round(maxH * aspect);
      const callerMax = this.#naturalMaxWidth || Infinity;
      this.style.maxWidth = Math.min(fittedW, callerMax) + 'px';
    }

    requestAnimationFrame(() => {
      const img = this.querySelector('.compare-before-wrap img');
      if (img) img.style.width = this.offsetWidth + 'px';
    });
  }

  #getFrac(e) {
    const rect = this.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  #setPosition(frac) {
    const pct = (frac * 100).toFixed(2) + '%';
    const wrap = this.querySelector('.compare-before-wrap');
    const handle = this.querySelector('.compare-handle');
    const img = this.querySelector('.compare-before-wrap img');
    if (wrap) wrap.style.width = pct;
    if (handle) handle.style.left = pct;
    if (img) img.style.width = this.offsetWidth + 'px';
  }

  #render() {
    const expandLabel = this.#expanded ? 'Fit to View' : 'Full Size';
    const beforeLabel = esc(this.getAttribute('before-label') || 'Original');
    const afterLabel = esc(this.getAttribute('after-label') || '4x Upscaled');
    morph(this, `
      <style>
        .compare {
          display: none; position: relative; overflow: hidden;
          border: 1px solid var(--pico-muted-border-color, #333);
          border-radius: var(--pico-border-radius, 4px);
          cursor: col-resize; user-select: none; max-width: 100%;
        }
        .compare img { display: block; width: 100%; height: auto; pointer-events: none; }
        .compare .compare-before-wrap {
          position: absolute; top: 0; left: 0; height: 100%; overflow: hidden;
          width: 50%; border-right: 2px solid #fff;
        }
        .compare .compare-before-wrap img { width: auto; height: 100%; max-width: none; }
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
      </style>
      <img class="compare-after" src="${this.#afterSrc}">
      <div class="compare-before-wrap">
        <img src="${this.#beforeSrc}">
      </div>
      <div class="compare-handle"></div>
      <span class="compare-label compare-label-before">${beforeLabel}</span>
      <span class="compare-label compare-label-after">${afterLabel}</span>
      <div class="compare-toolbar">
        <button type="button" class="compare-open-btn">Open in Tab</button>
        <button type="button" class="compare-expand-btn">${expandLabel}</button>
        <button type="button" class="compare-download-btn"><i class="fas fa-download"></i> Download</button>
      </div>
    `);
  }
}

customElements.define('compare-slider', CompareSlider);
