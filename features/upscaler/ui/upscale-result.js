/**
 * <upscale-result> — before/after result viewer (no slider).
 *
 * Shows the upscaled (SR) image by default. Click-and-hold reveals the
 * original (LR) image for as long as the pointer is held; releasing returns
 * to SR. While held, dragging pans the image when it overflows the workspace
 * (native-size / zoomed view modes). A bubbling `lr-view-change` event fires
 * whenever the LR/SR display flips so the toolbar can surface an "LR" badge.
 *
 * Replaces the old compare-slider in the upscaler: the right-click swap is
 * now just "hold to see the original". The shared compare-slider component is
 * left untouched for other features (e.g. bg-removal).
 */

import { morph } from 'lib/morph';
import { canvasToBlobUrl } from 'lib/canvas';

class UpscaleResult extends HTMLElement {
  #beforeCanvas = null;
  #afterCanvas = null;
  #downloadSrc = '';
  #downloadName = '';
  #lazyBlobURL = '';

  // Human-readable names for the two layers. Default to the original/upscaled
  // pairing; Comparison mode overrides these with the two model names since
  // there's no "LR" involved (it's SR-vs-SR).
  #beforeLabel = 'LR';
  #afterLabel = 'HR';

  // Press + drag-to-pan bookkeeping. A press shows LR for its whole duration;
  // any movement while pressed scrolls the (overflowing) workspace.
  #pressing = false;
  #panStartX = 0;
  #panStartY = 0;
  #scrollStartLeft = 0;
  #scrollStartTop = 0;

  connectedCallback() {
    this.classList.add('result-view');
    // Hidden until show() lands a result (see compare-slider for the same
    // belt-and-suspenders against the pre-render flash).
    this.style.display = 'none';
    this.#render();

    this.addEventListener('mousedown', this.#onMouseDown);
    this.addEventListener('touchstart', this.#onTouchStart, { passive: false });
    // A right-press used to flip the slider; now there's nothing to flip, so
    // just keep the OS context menu from interrupting a peek.
    this.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', this.#onWindowMouseMove);
    window.addEventListener('touchmove', this.#onWindowTouchMove, { passive: false });
    window.addEventListener('mouseup', this.#onWindowPointerUp);
    window.addEventListener('touchend', this.#onWindowPointerUp);
    window.addEventListener('touchcancel', this.#onWindowPointerUp);
  }

  disconnectedCallback() {
    window.removeEventListener('mousemove', this.#onWindowMouseMove);
    window.removeEventListener('touchmove', this.#onWindowTouchMove);
    window.removeEventListener('mouseup', this.#onWindowPointerUp);
    window.removeEventListener('touchend', this.#onWindowPointerUp);
    window.removeEventListener('touchcancel', this.#onWindowPointerUp);
  }

  // ── Public surface ─────────────────────────────────────────────────────

  /**
   * @param {HTMLCanvasElement} beforeCanvas the held/peek layer, output-sized
   *   (the original "LR" normally; model 1's SR in Comparison mode)
   * @param {HTMLCanvasElement} afterCanvas  the default layer (the "SR")
   * @param {{ downloadName?: string, beforeLabel?: string, afterLabel?: string }} [opts]
   */
  async show(beforeCanvas, afterCanvas, opts = {}) {
    this.#beforeCanvas = beforeCanvas;
    this.#afterCanvas = afterCanvas;
    this.#downloadSrc = '';
    this.#downloadName = opts.downloadName || 'download.png';
    this.#beforeLabel = opts.beforeLabel || 'LR';
    this.#afterLabel = opts.afterLabel || 'HR';
    this.#render();

    const w = afterCanvas?.width || 0;
    const h = afterCanvas?.height || 0;
    if (w && h) {
      this.style.setProperty('--ar', `${w} / ${h}`);
      this.style.setProperty('--ar-num', `${w / h}`);
      this.style.setProperty('--natural-w', `${w}px`);
    }

    // Drop the inline display:none so the mode-driven class rules (block /
    // flex) take over.
    this.style.removeProperty('display');
    this.classList.remove('showing-lr');
    this.classList.add('is-visible');
    this.#prepareLazyDownload();
    // Announce the default (after) layer so the toolbar badge starts populated
    // with the right name/glyph rather than waiting for the first press.
    this.#emitView(false);
  }

  hide() {
    this.classList.remove('is-visible', 'showing-lr', 'panning');
    this.style.display = 'none';
    this.style.removeProperty('--ar');
    this.style.removeProperty('--ar-num');
    this.style.removeProperty('--natural-w');
    this.#pressing = false;
    this.#beforeCanvas = null;
    this.#afterCanvas = null;
    if (this.#lazyBlobURL) {
      URL.revokeObjectURL(this.#lazyBlobURL);
      this.#lazyBlobURL = '';
      this.#downloadSrc = '';
    }
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

  // ── Press → show LR; drag → pan ────────────────────────────────────────

  #onMouseDown = (e) => {
    if (e.button !== 0) return; // left button only
    e.preventDefault();
    this.#beginPress(e.clientX, e.clientY);
  };

  #onTouchStart = (e) => {
    const t = e.touches[0];
    if (!t) return;
    e.preventDefault();
    this.#beginPress(t.clientX, t.clientY);
  };

  #onWindowMouseMove = (e) => {
    if (this.#pressing) this.#pan(e.clientX, e.clientY);
  };

  #onWindowTouchMove = (e) => {
    if (!this.#pressing) return;
    const t = e.touches[0];
    if (!t) return;
    e.preventDefault();
    this.#pan(t.clientX, t.clientY);
  };

  #onWindowPointerUp = () => {
    if (!this.#pressing) return;
    this.#pressing = false;
    this.classList.remove('panning');
    this.#setShowingLR(false);
  };

  #beginPress(clientX, clientY) {
    this.#pressing = true;
    this.#panStartX = clientX;
    this.#panStartY = clientY;
    this.#scrollStartLeft = this.scrollLeft;
    this.#scrollStartTop = this.scrollTop;
    this.classList.add('panning');
    this.#setShowingLR(true);
  }

  // Drag pans the workspace: moving the pointer right reveals content to the
  // left, like grabbing the image. No-op in fit modes (host doesn't scroll).
  #pan(clientX, clientY) {
    this.scrollLeft = this.#scrollStartLeft - (clientX - this.#panStartX);
    this.scrollTop = this.#scrollStartTop - (clientY - this.#panStartY);
  }

  #setShowingLR(showing) {
    const next = !!showing;
    if (this.classList.contains('showing-lr') === next) return;
    this.classList.toggle('showing-lr', next);
    this.#emitView(next);
  }

  // Report which layer is now on screen and its name, so the toolbar can label
  // the badge correctly (e.g. "LR" vs a model name in Comparison).
  #emitView(showing) {
    this.dispatchEvent(new CustomEvent('lr-view-change', {
      bubbles: true,
      detail: { showing, label: showing ? this.#beforeLabel : this.#afterLabel },
    }));
  }

  // ── Internal ───────────────────────────────────────────────────────────

  #drawCanvases() {
    const afterEl = this.querySelector('canvas.result-after');
    if (afterEl && this.#afterCanvas) {
      afterEl.getContext('2d').drawImage(this.#afterCanvas, 0, 0);
    }
    const beforeEl = this.querySelector('canvas.result-before');
    if (beforeEl && this.#beforeCanvas) {
      beforeEl.getContext('2d').drawImage(this.#beforeCanvas, 0, 0);
    }
  }

  async #ensureDownloadURL() {
    if (this.#downloadSrc) return this.#downloadSrc;
    if (!this.#afterCanvas) return '';
    this.#lazyBlobURL = await canvasToBlobUrl(this.#afterCanvas);
    this.#downloadSrc = this.#lazyBlobURL;
    return this.#downloadSrc;
  }

  async #prepareLazyDownload() {
    const canvas = this.#afterCanvas;
    if (!canvas) return;
    const url = await canvasToBlobUrl(canvas);
    if (this.#afterCanvas !== canvas) {
      URL.revokeObjectURL(url);
      return;
    }
    this.#lazyBlobURL = url;
    this.#downloadSrc = this.#lazyBlobURL;
  }

  #render() {
    const aw = this.#afterCanvas?.width || 0;
    const ah = this.#afterCanvas?.height || 0;
    const bw = this.#beforeCanvas?.width || aw;
    const bh = this.#beforeCanvas?.height || ah;
    morph(this, `
      <style>
        .result-view {
          display: none; position: relative;
          border: 1px solid var(--pico-muted-border-color, #333);
          border-radius: var(--pico-border-radius, 4px);
          overflow: hidden;
          user-select: none; -webkit-user-select: none;
          cursor: grab; max-width: 100%;
        }
        .result-view.panning { cursor: grabbing; }
        .result-view.is-visible { display: block; }

        .result-view.is-visible:not(.expanded):not(.native-size):not(.zoomed) {
          width: 100%;
          max-width: 100%;
          aspect-ratio: var(--ar, auto);
          margin-inline: auto;
        }
        .result-view.is-visible.expanded {
          height: calc(100vh - 1rem);
          width: calc((100vh - 1rem) * var(--ar-num, 1));
          max-width: none;
          margin-inline: auto;
        }
        /* native-size / zoomed render at native (or scaled) pixel dimensions
           inside a workspace-sized scroll container, centered when smaller
           than the workspace and pannable when larger. */
        .result-view.is-visible.native-size,
        .result-view.is-visible.zoomed {
          width: 100%;
          max-width: 100%;
          height: calc(100vh - 1rem);
          max-height: calc(100vh - 1rem);
          aspect-ratio: auto;
          overflow: auto;
          display: flex;
        }

        .result-view .result-stage {
          position: relative;
          display: block;
          width: 100%;
        }
        .result-view.native-size .result-stage,
        .result-view.zoomed .result-stage {
          margin: auto;
          width: max-content;
          height: max-content;
          flex: 0 0 auto;
        }

        .result-view canvas {
          display: block;
          width: 100%;
          height: auto;
          max-width: 100%;
          background: #000;
          pointer-events: none;
        }
        .result-view.native-size .result-after {
          width: auto;
          max-width: none;
          height: auto;
        }
        .result-view.zoomed .result-after {
          width: calc(var(--natural-w, 100%) * var(--zoom, 1));
          max-width: none;
          height: auto;
        }

        /* The LR (before) canvas overlays the SR one exactly and is hidden
           until a press. Both canvases share output dimensions, so filling the
           stage box keeps them pixel-aligned across every view mode. */
        .result-view .result-before {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          max-width: none;
          visibility: hidden;
        }
        .result-view.showing-lr .result-before {
          visibility: visible;
        }
      </style>
      <div class="result-stage">
        <canvas class="result-after" width="${aw}" height="${ah}"></canvas>
        <canvas class="result-before" width="${bw}" height="${bh}"></canvas>
      </div>
    `);
    this.#drawCanvases();
  }
}

customElements.define('upscale-result', UpscaleResult);
