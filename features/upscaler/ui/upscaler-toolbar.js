import 'components/status-bar';
import 'components/view-mode-controls';
import 'components/zoom-control';

// Canonical toolbar state values. Drives button visibility (vs STATUS_STATE
// in status-bar, which drives icon color -- different vocabulary on purpose).
export const TOOLBAR_STATE = Object.freeze({
  EMPTY: 'empty',
  READY: 'ready',
  RUNNING: 'running',
  DONE: 'done',
});

const STATES = Object.values(TOOLBAR_STATE);

class UpscalerToolbar extends HTMLElement {
  #state = TOOLBAR_STATE.EMPTY;
  #hasCrop = false;

  connectedCallback() {
    this.#render();
    this.#wireEvents();
    this.#applyState();
  }

  #q(sel) { return this.querySelector(sel); }

  // ── Public surface ─────────────────────────────────────────────────────

  get state() { return this.#state; }
  set state(s) {
    if (!STATES.includes(s)) return;
    this.#state = s;
    this.#applyState();
  }

  set hasCrop(b) {
    this.#hasCrop = !!b;
    this.#applyState();
  }

  // Reflect which result layer is currently on screen. The badge is always
  // present once a result exists (visibility is driven by toolbar state); only
  // its glyph + label swap here. `peeking` is true while the user holds to see
  // the "before" layer (the original LR, or model 1 in Comparison); false for
  // the default layer (the HR/SR result, or model 2). The two-eye metaphor is
  // lifted from the old slider handle.
  setCompareBadge(peeking, label) {
    const el = this.#q('.compare-indicator');
    if (!el) return;
    const icon = el.querySelector('.compare-icon');
    if (icon) {
      icon.classList.toggle('fa-eye-low-vision', !!peeking);
      icon.classList.toggle('fa-eye', !peeking);
    }
    if (label != null) {
      const labelEl = el.querySelector('.compare-label');
      if (labelEl) labelEl.textContent = label;
      el.setAttribute('aria-label', `Showing ${label}`);
    }
  }

  get viewMode() { return this.#q('view-mode-controls').mode; }
  set viewMode(mode) {
    const vmc = this.#q('view-mode-controls');
    if (vmc) vmc.mode = mode;
  }

  get zoomControl() { return this.#q('zoom-control'); }

  // Whether the view-mode segment shows a pressed button. False while an
  // explicit zoom owns the view (so only the zoom button reads as selected).
  set viewModeActive(b) {
    const vmc = this.#q('view-mode-controls');
    if (vmc) vmc.active = b;
  }

  setUpscaleLabel(label) {
    const span = this.#q('.upscale-btn .btn-label');
    if (span) span.textContent = label;
  }

  // status-bar lives inside this component visually; expose it so the
  // orchestrator can write progress/messages directly during a run.
  get statusBar() { return this.#q('status-bar'); }

  // ── Internal ───────────────────────────────────────────────────────────

  #applyState() {
    const setDisplay = (sel, show) => {
      const el = this.#q(sel);
      if (el) el.style.display = show ? 'inline-block' : 'none';
    };
    const setHidden = (sel, hidden) => {
      const el = this.#q(sel);
      if (el) el.hidden = hidden;
    };

    const s = this.#state;
    const upscaleBtn = this.#q('.upscale-btn');
    upscaleBtn.disabled = s === TOOLBAR_STATE.EMPTY || s === TOOLBAR_STATE.RUNNING;

    setDisplay('.stop-btn',         s === TOOLBAR_STATE.RUNNING);
    setDisplay('.startover-btn',    s === TOOLBAR_STATE.READY || s === TOOLBAR_STATE.DONE);
    setDisplay('.back-to-crop-btn', s === TOOLBAR_STATE.DONE);
    setDisplay('.clear-crop-btn',   s === TOOLBAR_STATE.READY && this.#hasCrop);

    setHidden('.canvas-toolbar-left',   s === TOOLBAR_STATE.EMPTY);
    setHidden('.canvas-toolbar-right',  s !== TOOLBAR_STATE.DONE);
    // The compare badge belongs to a finished result; it's always shown there
    // (labelled for whichever layer is in view) and hidden in every other phase.
    setHidden('.compare-indicator', s !== TOOLBAR_STATE.DONE);
  }

  #wireEvents() {
    const fire = (name) => () => this.dispatchEvent(
      new CustomEvent(name, { bubbles: true }),
    );

    this.#q('.upscale-btn'      ).addEventListener('click', fire('upscale-click'));
    this.#q('.stop-btn'         ).addEventListener('click', fire('stop-click'));
    this.#q('.startover-btn'    ).addEventListener('click', fire('start-over-click'));
    this.#q('.clear-crop-btn'   ).addEventListener('click', fire('clear-crop-click'));
    this.#q('.back-to-crop-btn' ).addEventListener('click', fire('back-to-crop-click'));
    this.#q('.open-in-tab-btn'  ).addEventListener('click', fire('open-in-tab-click'));
    this.#q('.download-btn'     ).addEventListener('click', fire('download-click'));

    // Re-emit view-mode-controls' change as a bubbling event so the
    // orchestrator can forward to canvas-area without poking through.
    this.#q('view-mode-controls').addEventListener('mode-change', (e) => {
      this.dispatchEvent(new CustomEvent('view-mode-change', {
        bubbles: true, detail: { mode: e.detail.mode },
      }));
    });

    // Same pattern for the zoom control: opening asks the orchestrator to seed
    // the slider with the current effective zoom; dragging requests a new one.
    const zoom = this.#q('zoom-control');
    zoom.addEventListener('zoom-open', () => {
      this.dispatchEvent(new CustomEvent('zoom-open', { bubbles: true }));
    });
    zoom.addEventListener('zoom-change', (e) => {
      this.dispatchEvent(new CustomEvent('zoom-change', {
        bubbles: true, detail: { value: e.detail.value },
      }));
    });
  }

  #render() {
    this.innerHTML = `
      <style>
        upscaler-toolbar {
          position: sticky;
          top: 0.75rem;
          height: 0;
          z-index: 10;
          pointer-events: none;
          display: block;
        }
        upscaler-toolbar .canvas-toolbar-stack-left {
          position: absolute;
          top: 0;
          left: 0.75rem;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 0.25rem;
          max-width: calc(100% - 1.5rem);
          pointer-events: none;
        }
        upscaler-toolbar .canvas-toolbar-stack-left > * {
          pointer-events: auto;
        }
        upscaler-toolbar .canvas-toolbar {
          display: inline-flex;
          gap: 0.25rem;
          align-items: center;
          padding: 0.25rem 0.3rem;
          background: color-mix(in oklab, var(--pico-card-background-color, #1e1e2e) 32%, transparent);
          border: 1px solid color-mix(in oklab, var(--pico-muted-border-color) 45%, transparent);
          border-radius: var(--pico-border-radius);
          box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(10px) saturate(1.1);
          -webkit-backdrop-filter: blur(10px) saturate(1.1);
          pointer-events: auto;
          max-width: 100%;
        }
        upscaler-toolbar .canvas-toolbar-right {
          position: absolute;
          top: 0;
          right: 0.75rem;
          max-width: calc(100% - 1.5rem);
          pointer-events: auto;
        }
        upscaler-toolbar .canvas-toolbar[hidden] {
          display: none;
        }
        upscaler-toolbar .canvas-toolbar button {
          margin-bottom: 0;
          padding: 0.25rem 0.5rem;
          font-size: 0.72rem;
          line-height: 1.2;
          width: auto;
          white-space: nowrap;
        }
        upscaler-toolbar .canvas-toolbar button.secondary,
        upscaler-toolbar .canvas-toolbar button.outline {
          opacity: 0.78;
          transition: opacity 0.15s ease;
          background: transparent;
          border-color: currentColor;
          color: #fff;
          mix-blend-mode: difference;
        }
        upscaler-toolbar .canvas-toolbar button.secondary:hover,
        upscaler-toolbar .canvas-toolbar button.outline:hover,
        upscaler-toolbar .canvas-toolbar button.secondary:focus-visible,
        upscaler-toolbar .canvas-toolbar button.outline:focus-visible {
          opacity: 1;
          background: transparent;
          border-color: currentColor;
          color: #fff;
        }
        upscaler-toolbar .canvas-toolbar button .fas {
          font-size: 0.78em;
          margin-right: 0.15rem;
        }
        upscaler-toolbar .canvas-toolbar button .btn-label {
          display: inline;
        }
        @media (max-width: 768px) {
          upscaler-toolbar .canvas-toolbar button .btn-label {
            display: none;
          }
          upscaler-toolbar .canvas-toolbar button .fas {
            margin-right: 0;
          }
        }
        upscaler-toolbar .canvas-toolbar status-bar {
          display: inline-flex;
          align-items: center;
          margin-left: 0.3rem;
          flex: 1 1 8rem;
          min-width: 0;
          max-width: 22rem;
        }
        upscaler-toolbar .canvas-toolbar status-bar .status-text {
          font-size: 0.68rem;
          line-height: 1.25;
          margin-bottom: 0;
          color: #fff;
          mix-blend-mode: difference;
          flex-shrink: 0;
          overflow: visible;
        }
        upscaler-toolbar .canvas-toolbar status-bar .progress-track {
          height: 5px;
          margin-bottom: 0;
          flex: 1 1 10rem;
          min-width: 3rem;
        }
        upscaler-toolbar .canvas-toolbar status-bar .progress-count {
          font-size: 0.62rem;
          color: #fff;
          mix-blend-mode: difference;
        }
        /* The compare badge surfaces only while the user holds the result
           viewer to peek at the other layer. Matches the toolbar's outline
           buttons (transparent fill, mix-blend-mode) so it reads as part of
           this section rather than a floating chip. */
        upscaler-toolbar .canvas-toolbar .compare-indicator {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          margin-left: 0.3rem;
          padding: 0.1rem 0.45rem;
          flex: 0 0 auto;
          border-radius: 999px;
          background: transparent;
          border: 1px solid currentColor;
          color: #fff;
          mix-blend-mode: difference;
          font-size: 0.66rem;
          font-weight: 600;
          line-height: 1.2;
          letter-spacing: 0.02em;
          white-space: nowrap;
        }
        upscaler-toolbar .canvas-toolbar .compare-indicator[hidden] {
          display: none;
        }
        upscaler-toolbar .canvas-toolbar .compare-indicator .fas {
          font-size: 0.82em;
          margin-right: 0;
          flex: 0 0 auto;
        }
        /* Long model names (Comparison mode) shouldn't blow out the toolbar;
           clip with an ellipsis instead. */
        upscaler-toolbar .canvas-toolbar .compare-indicator .compare-label {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 14rem;
        }
      </style>

      <div class="canvas-toolbar-stack-left">
        <div class="canvas-toolbar canvas-toolbar-left" hidden>
          <button class="back-to-crop-btn secondary outline" style="display:none" type="button" title="Back to crop / change selection">
            <i class="fas fa-arrow-left"></i><i class="fas fa-crop-simple"></i> <span class="btn-label">Edit Crop</span>
          </button>
          <button class="upscale-btn" disabled title="Upscale image">
            <i class="fas fa-wand-magic-sparkles"></i> <span class="btn-label">Upscale 4x</span>
          </button>
          <button class="stop-btn secondary" style="display:none" title="Stop upscale">
            <i class="fas fa-stop"></i> <span class="btn-label">Stop</span>
          </button>
          <view-mode-controls></view-mode-controls>
          <zoom-control></zoom-control>
          <button class="clear-crop-btn secondary outline" style="display:none" type="button" title="Clear the selected crop region">
            <i class="fas fa-eraser"></i> <span class="btn-label">Clear Selection</span>
          </button>
          <button class="startover-btn secondary outline" style="display:none" title="Clear and start over with a new image">
            <i class="fas fa-xmark"></i> <span class="btn-label">Clear</span>
          </button>
          <status-bar></status-bar>
          <span class="compare-indicator" hidden aria-label="Showing upscaled result">
            <i class="fas fa-eye compare-icon"></i><span class="compare-label">HR</span>
          </span>
        </div>
      </div>
      <div class="canvas-toolbar canvas-toolbar-right" hidden>
        <button class="open-in-tab-btn secondary outline" type="button" title="Open the upscaled image in a new tab">
          <i class="fas fa-up-right-from-square"></i> <span class="btn-label">Open in Tab</span>
        </button>
        <button class="download-btn secondary outline" type="button" title="Download the upscaled image">
          <i class="fas fa-download"></i> <span class="btn-label">Download</span>
        </button>
      </div>
    `;
  }
}

customElements.define('upscaler-toolbar', UpscalerToolbar);
