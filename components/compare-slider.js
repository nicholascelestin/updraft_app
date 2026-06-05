/**
 * <compare-slider> — before/after image comparison slider.
 *
 * The slider is always on. Left-click / drag positions the divider. Right-click
 * snaps the divider to whichever extreme it isn't currently nearer to (left
 * or right edge), so a single right-click flips between the before-only and
 * after-only views.
 */

import { morph } from 'lib/morph';
import { canvasToBlobUrl } from 'lib/canvas';

class CompareSlider extends HTMLElement {
  #dragging = false;
  #beforeSrc = '';
  #afterSrc = '';
  #positionFrac = 0.5;
  #downloadSrc = '';
  #downloadName = '';
  #beforeCanvas = null;
  #afterCanvas = null;
  #lazyBlobURL = '';

  #onWindowMouseMove = (e) => { if (this.#dragging) this.#setPosition(this.#getFrac(e)); };
  #onWindowTouchMove = (e) => { if (this.#dragging) this.#setPosition(this.#getFrac(e)); };
  #onWindowMouseUp = () => {
    this.#dragging = false;
    this.classList.remove('dragging');
  };
  #onWindowTouchEnd = () => {
    this.#dragging = false;
    this.classList.remove('dragging');
  };

  #knobScheduled = false;
  #knobFullWidth = 0;
  #resizeObserver = null;
  #scheduleKnobUpdate = () => {
    if (this.#knobScheduled) return;
    this.#knobScheduled = true;
    requestAnimationFrame(() => {
      this.#knobScheduled = false;
      this.#updateKnobPosition();
    });
  };
  #onResize = () => {
    // Knob's measured full width may change with font-metric / DPR shifts.
    this.#knobFullWidth = 0;
    this.#scheduleKnobUpdate();
  };

  connectedCallback() {
    this.classList.add('compare');
    // Belt-and-suspenders: also set display:none inline so the slider is
    // definitely hidden before show() has been called. The class CSS rule
    // does this too, but it lives inside our own <style> block — there's a
    // brief window between when the host is added to the DOM (with the
    // class but no inner content) and when #render() lands the style tag,
    // during which the absolutely-positioned handle would render.
    this.style.display = 'none';
    this.#render();

    this.addEventListener('mousedown', e => {
      if (e.button !== 0) return; // left-button only — right-click handled below
      e.preventDefault(); this.#dragging = true; this.classList.add('dragging');
      this.#setPosition(this.#getFrac(e));
    });
    this.addEventListener('touchstart', e => {
      this.#dragging = true; this.classList.add('dragging');
      this.#setPosition(this.#getFrac(e));
    }, { passive: true });

    this.addEventListener('contextmenu', (e) => {
      // Right-click flips the divider to whichever extreme it's currently
      // farther from — single click toggles between full-before and full-after.
      e.preventDefault();
      this.#setPosition(this.#positionFrac < 0.5 ? 1 : 0);
    });

    window.addEventListener('mousemove', this.#onWindowMouseMove);
    window.addEventListener('touchmove', this.#onWindowTouchMove, { passive: true });
    window.addEventListener('mouseup', this.#onWindowMouseUp);
    window.addEventListener('touchend', this.#onWindowTouchEnd);
    // Keep the (fixed-position) knob aligned as the user scrolls / resizes.
    window.addEventListener('scroll', this.#scheduleKnobUpdate, { passive: true });
    window.addEventListener('resize', this.#onResize);
    // native-size mode scrolls inside the slider itself, not the page.
    this.addEventListener('scroll', this.#scheduleKnobUpdate, { passive: true });
    // Catch view-mode swaps (e.g. .expanded ↔ .native-size) where the host
    // class flips but no scroll/resize fires — without this the knob keeps
    // its previous logical position until the next drag.
    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(this.#scheduleKnobUpdate);
      this.#resizeObserver.observe(this);
    }
  }

  disconnectedCallback() {
    window.removeEventListener('mousemove', this.#onWindowMouseMove);
    window.removeEventListener('touchmove', this.#onWindowTouchMove);
    window.removeEventListener('mouseup', this.#onWindowMouseUp);
    window.removeEventListener('touchend', this.#onWindowTouchEnd);
    window.removeEventListener('scroll', this.#scheduleKnobUpdate);
    window.removeEventListener('resize', this.#onResize);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
  }

  /**
   * @param {string|HTMLCanvasElement} beforeSrc
   * @param {string|HTMLCanvasElement} afterSrc
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

    const afterEl = this.querySelector('.compare-after');
    const natW = canvasMode
      ? (this.#afterCanvas?.width || 0)
      : (afterEl?.naturalWidth || 0);
    const natH = canvasMode
      ? (this.#afterCanvas?.height || 0)
      : (afterEl?.naturalHeight || 0);
    if (natW && natH) {
      this.style.setProperty('--ar', `${natW} / ${natH}`);
      // --ar-num is a plain number (w/h) used by calc() to derive the host
      // width in fit-height mode. Block elements with width:auto +
      // aspect-ratio don't reliably derive width from the aspect — the
      // "stretch to containing block" default often wins. Computing the
      // width explicitly via calc avoids that ambiguity.
      this.style.setProperty('--ar-num', `${natW / natH}`);
      this.style.setProperty('--natural-w', `${natW}px`);
    }

    this.style.display = 'block';
    this.#setPosition(this.#positionFrac);
    this.#updateKnobPosition();
    if (canvasMode) this.#prepareLazyDownload();
  }

  hide() {
    this.style.display = 'none';
    const knob = this.querySelector('.handle-knob');
    if (knob) knob.style.visibility = 'hidden';
    this.style.removeProperty('--ar');
    this.style.removeProperty('--ar-num');
    this.style.removeProperty('--natural-w');
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

  #getFrac(e) {
    // Use the stage rect (the natural-size box that wraps the after canvas
    // and the before-wrap clip) instead of the host. In normal modes the
    // stage fills the host so this is equivalent, but in native-size mode
    // the host is a scrollable container while the stage is at the canvas's
    // natural pixel size — only the stage rect tracks the actual image
    // coordinates the slider divides.
    const stage = this.querySelector('.compare-stage');
    const rect = (stage || this).getBoundingClientRect();
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
    this.#updateKnobPosition();
  }

  /**
   * Position the (fixed) knob inside the visible portion of the slider's
   * stage — i.e. the image area, which is the "workspace" the divider
   * actually lives in. The knob follows the user vertically (target =
   * viewport center) but is clamped to the stage's visible rect on both
   * axes. When clamped to a horizontal edge, only the icon for the side
   * currently in view is shown, matching the "icon-clipped-by-canvas"
   * behavior the slider had at extreme drag positions when the image fit
   * the workspace.
   */
  #updateKnobPosition() {
    const knob = this.querySelector('.handle-knob');
    if (!knob) return;
    if (getComputedStyle(this).display === 'none') {
      knob.style.visibility = 'hidden';
      return;
    }
    const stage = this.querySelector('.compare-stage');
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Visible stage = intersection of stage bounds and viewport.
    const visLeft = Math.max(stageRect.left, 0);
    const visRight = Math.min(stageRect.right, vw);
    const visTop = Math.max(stageRect.top, 0);
    const visBottom = Math.min(stageRect.bottom, vh);
    if (visRight <= visLeft || visBottom <= visTop ||
        stageRect.width === 0 || stageRect.height === 0) {
      knob.style.visibility = 'hidden';
      return;
    }
    knob.style.visibility = '';

    // Cache the knob's full (unclipped) width. The clip classes hide one
    // half of the knob, which would otherwise shrink offsetWidth and cause
    // the would-clip threshold to oscillate as the user drags near an edge.
    if (this.#knobFullWidth === 0) {
      const hadClipLeft = knob.classList.contains('clip-at-left');
      const hadClipRight = knob.classList.contains('clip-at-right');
      if (hadClipLeft) knob.classList.remove('clip-at-left');
      if (hadClipRight) knob.classList.remove('clip-at-right');
      this.#knobFullWidth = knob.offsetWidth;
      if (hadClipLeft) knob.classList.add('clip-at-left');
      if (hadClipRight) knob.classList.add('clip-at-right');
    }
    const halfKnob = this.#knobFullWidth / 2;

    const logicalX = stageRect.left + this.#positionFrac * stageRect.width;
    // The knob clips when its bounding box (not just its centerline) would
    // extend past the visible stage. Before the knob was position:fixed it
    // got this for free from the slider's overflow:hidden; now we have to
    // detect it ourselves.
    const wouldClipLeft = logicalX - halfKnob < visLeft;
    const wouldClipRight = logicalX + halfKnob > visRight && !wouldClipLeft;
    knob.classList.toggle('clip-at-left', wouldClipLeft);
    knob.classList.toggle('clip-at-right', wouldClipRight);

    let leftPx;
    if (wouldClipLeft) leftPx = visLeft;
    else if (wouldClipRight) leftPx = visRight;
    else leftPx = logicalX;
    const targetY = vh / 2;
    const clampedY = Math.max(visTop, Math.min(visBottom, targetY));
    knob.style.left = leftPx + 'px';
    knob.style.top = clampedY + 'px';
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
        .compare:not(.expanded):not(.native-size):not(.zoomed) {
          width: 100%;
          max-width: 100%;
          aspect-ratio: var(--ar, auto);
          margin-inline: auto;
        }
        .compare.expanded {
          height: calc(100vh - 1rem);
          width: calc((100vh - 1rem) * var(--ar-num, 1));
          max-width: none;
          margin-inline: auto;
        }
        .compare img, .compare canvas { display: block; width: 100%; height: auto; pointer-events: none; }
        /* compare-stage is the natural-size containing block for the after
           canvas, the before-wrap clip and the slider handle. In normal modes
           it just fills the host (width: 100%); in native-size it shrinks to
           the canvas's natural dimensions so before-wrap's percentage width
           / handle's percentage left line up with the same native pixels the
           after canvas is showing. */
        .compare .compare-stage {
          position: relative;
          display: block;
          width: 100%;
        }
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
          left: 50%; margin-left: -1px; z-index: 2; pointer-events: none;
          opacity: 0.35;
          transition: opacity 0.2s ease;
        }
        .compare.dragging .compare-handle {
          opacity: 1;
        }
        /* The knob is positioned in viewport coordinates (position: fixed)
           and re-placed on scroll/resize/drag by #updateKnobPosition. JS
           sets its top/left; transform anchors the box around that point
           (centered by default, left-anchored when clamped to the viewport's
           left edge, right-anchored when clamped to the right edge). */
        .compare .compare-handle .handle-knob {
          position: fixed; top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          display: inline-flex; align-items: center; gap: 8px;
          padding: 4px 8px;
          border-radius: 999px;
          background: rgba(255,255,255,0.92);
          border: 2px solid #333;
          box-shadow: 0 0 6px rgba(0,0,0,0.5);
          color: #333;
          white-space: nowrap;
          z-index: 3;
          pointer-events: none;
        }
        .compare .compare-handle .handle-knob.clip-at-left {
          transform: translate(0, -50%);
        }
        .compare .compare-handle .handle-knob.clip-at-right {
          transform: translate(-100%, -50%);
        }
        /* When clamped to a viewport edge, drop the icon for the side the
           user *isn't* looking at so the knob unambiguously labels what's
           currently in view. */
        .compare .compare-handle .handle-knob.clip-at-left .handle-side-before {
          display: none;
        }
        .compare .compare-handle .handle-knob.clip-at-right .handle-side-after {
          display: none;
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
        /* native-size renders content at native pixel dimensions inline.
           The host stays in normal flow but scrolls internally when content
           exceeds its bounds. Flex + margin:auto centers the stage when the
           image is smaller than the host and keeps it scrollable when
           larger. */
        .compare.native-size {
          width: 100%;
          max-width: 100%;
          height: calc(100vh - 1rem);
          max-height: calc(100vh - 1rem);
          aspect-ratio: auto;
          overflow: auto;
          cursor: default;
          display: flex;
        }
        .compare.native-size .compare-stage {
          margin: auto;
          width: max-content;
          height: max-content;
          flex: 0 0 auto;
        }
        .compare.native-size .compare-after {
          width: auto;
          max-width: none;
          height: auto;
          display: block;
        }
        /* zoomed: like native-size, but the after canvas is sized to
           natural-width × --zoom (and the before-wrap/handle track it via the
           stage's max-content box, exactly as in native-size). */
        .compare.zoomed {
          width: 100%;
          max-width: 100%;
          height: calc(100vh - 1rem);
          max-height: calc(100vh - 1rem);
          aspect-ratio: auto;
          overflow: auto;
          cursor: default;
          display: flex;
        }
        .compare.zoomed .compare-stage {
          margin: auto;
          width: max-content;
          height: max-content;
          flex: 0 0 auto;
        }
        .compare.zoomed .compare-after {
          width: calc(var(--natural-w, 100%) * var(--zoom, 1));
          max-width: none;
          height: auto;
          display: block;
        }
      </style>
      <div class="compare-stage">
        ${afterTag}
        <div class="compare-before-wrap">
          ${beforeTag}
        </div>
        <div class="compare-handle" aria-hidden="true">
          <div class="handle-knob">
            <span class="handle-side handle-side-before" aria-label="Original">
              <i class="fas fa-eye-low-vision"></i>
              <span class="handle-arrow">◀</span>
            </span>
            <span class="handle-side handle-side-after" aria-label="Enhanced">
              <span class="handle-arrow">▶</span>
              <i class="fas fa-eye"></i>
            </span>
          </div>
        </div>
      </div>
    `);
    if (cm) this.#drawCanvasSources();
  }
}

customElements.define('compare-slider', CompareSlider);
