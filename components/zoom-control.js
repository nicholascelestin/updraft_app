/**
 * <zoom-control> -- a single toolbar button (magnifying-glass icon · divider ·
 * live zoom readout) that reveals a vertical zoom slider when clicked.
 *
 * Clicking the button does NOT change the zoom; it emits `zoom-open` (so the
 * host can set `.value` to the current effective zoom first) and then drops a
 * vertical slider directly below the button. Dragging the slider emits
 * `zoom-change` { detail: { value } }.
 *
 * `selected` is a host-controlled flag: the host sets it true when an explicit
 * zoom (one that matches none of the fit/1:1 presets) is active, so the button
 * paints as pressed even while the slider is closed.
 *
 * The slider track is log2-scaled so the markers (0.25/0.5/1/2/4) -- each a
 * doubling -- sit at even intervals. `value` is always a linear zoom factor.
 */

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

// Marker stops, top (max) to bottom (min). Powers of two -> even log spacing.
const ZOOM_MARKS = [4, 2, 1, 0.5, 0.25];

const T_MIN = Math.log2(ZOOM_MIN); // -2
const T_MAX = Math.log2(ZOOM_MAX); //  2

const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
const clampT = (t) => Math.max(T_MIN, Math.min(T_MAX, t));
const zoomToT = (z) => Math.log2(clampZoom(z));
const tToZoom = (t) => Math.pow(2, clampT(t));
const formatZoom = (z) => `${z.toFixed(2)}×`;

class ZoomControl extends HTMLElement {
  #open = false;
  #selected = false;
  #value = 1;

  connectedCallback() {
    this.#render();
    this.addEventListener('click', this.#onClick);
    this.addEventListener('input', this.#onInput);
    document.addEventListener('click', this.#onDocClick);
  }

  disconnectedCallback() {
    document.removeEventListener('click', this.#onDocClick);
  }

  // ── Public surface ─────────────────────────────────────────────────────

  get value() { return this.#value; }
  set value(z) {
    const n = Number(z);
    if (!Number.isFinite(n) || n <= 0) return;
    // Stored/readout value is the true on-screen zoom (the fit modes can land
    // outside 0.25–4); only the slider thumb is clamped to its track range.
    this.#value = n;
    this.#updateReadout();
    // While the slider is open the user is the authority on the thumb; only
    // the readout tracks external updates so we don't fight an active drag.
    if (!this.#open) this.#setSliderFromValue();
  }

  // Host-controlled pressed state (true when a custom zoom is active).
  get selected() { return this.#selected; }
  set selected(b) {
    this.#selected = !!b;
    this.#reflectSelected();
  }

  show() {
    if (this.#open) return;
    this.#open = true;
    this.#reflectOpen();
  }

  close() {
    if (!this.#open) return;
    this.#open = false;
    this.#reflectOpen();
  }

  // ── Internal ───────────────────────────────────────────────────────────

  #onClick = (e) => {
    const btn = e.target.closest('.zoom-btn');
    if (!btn) return;
    // Stop the toggle click from reaching the document-level close handler.
    e.stopPropagation();
    if (this.#open) { this.close(); return; }
    // Let the host fill in the current zoom before the slider appears.
    this.dispatchEvent(new CustomEvent('zoom-open'));
    this.show();
  };

  #onInput = (e) => {
    if (!e.target.classList.contains('zoom-range')) return;
    this.#value = tToZoom(Number(e.target.value));
    this.#updateReadout();
    this.dispatchEvent(new CustomEvent('zoom-change', { detail: { value: this.#value } }));
  };

  #onDocClick = (e) => {
    if (!this.#open) return;
    if (this.contains(e.target)) return;
    this.close();
  };

  #reflectOpen() {
    const panel = this.querySelector('.zoom-panel');
    const btn = this.querySelector('.zoom-btn');
    if (panel) panel.hidden = !this.#open;
    if (btn) btn.setAttribute('aria-expanded', String(this.#open));
    // Seed the thumb from the current value as the slider becomes visible.
    if (this.#open) this.#setSliderFromValue();
  }

  #reflectSelected() {
    const btn = this.querySelector('.zoom-btn');
    if (btn) btn.setAttribute('aria-pressed', String(this.#selected));
  }

  #setSliderFromValue() {
    const input = this.querySelector('.zoom-range');
    if (input) input.value = String(zoomToT(this.#value));
  }

  #updateReadout() {
    const readout = this.querySelector('.zoom-readout');
    if (readout) readout.textContent = formatZoom(this.#value);
  }

  #render() {
    const ticks = ZOOM_MARKS.map((z) => `<span>${z}×</span>`).join('');
    this.innerHTML = `
      <style>
        zoom-control {
          position: relative;
          display: inline-flex;
          vertical-align: middle;
        }
        /* Single combined control: icon | divider | readout. The readout is
           just a label inside the button, not a separately-clickable thing. */
        zoom-control .zoom-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
        }
        zoom-control .zoom-btn .fas {
          margin: 0 !important;
        }
        zoom-control .zoom-divider {
          width: 1px;
          align-self: stretch;
          background: currentColor;
          opacity: 0.45;
        }
        /* Pressed look: slider open (aria-expanded) or a custom zoom active
           (aria-pressed). Matches the segmented control's filled state so it
           stays legible against the surrounding mix-blend outline buttons. */
        zoom-control .zoom-btn[aria-expanded="true"],
        zoom-control .zoom-btn[aria-pressed="true"] {
          mix-blend-mode: normal !important;
          background: rgba(255, 255, 255, 0.22) !important;
          opacity: 1 !important;
          border-color: #fff !important;
          color: #fff !important;
          z-index: 1;
        }
        /* Live zoom readout, sitting inside the button after the divider. */
        zoom-control .zoom-readout {
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          text-align: right;
          min-width: 4.5ch;
        }
        zoom-control .zoom-panel {
          position: absolute;
          top: calc(100% + 0.35rem);
          left: 0;
          z-index: 20;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.4rem;
          padding: 0.5rem 0.55rem;
          background: color-mix(in oklab, var(--pico-card-background-color, #1e1e2e) 92%, transparent);
          border: 1px solid color-mix(in oklab, var(--pico-muted-border-color) 60%, transparent);
          border-radius: var(--pico-border-radius);
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
          backdrop-filter: blur(8px) saturate(1.1);
          -webkit-backdrop-filter: blur(8px) saturate(1.1);
        }
        zoom-control .zoom-panel[hidden] {
          display: none;
        }
        zoom-control .zoom-slider-row {
          display: flex;
          align-items: stretch;
          gap: 0.45rem;
          height: 150px;
        }
        zoom-control .zoom-range {
          writing-mode: vertical-lr;
          direction: rtl;
          width: 1.1rem;
          height: 100%;
          margin: 0;
          padding: 0;
          accent-color: #fff;
          cursor: pointer;
        }
        zoom-control .zoom-ticks {
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          font-size: 0.58rem;
          line-height: 1;
          color: #fff;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
      </style>
      <button type="button" class="zoom-btn secondary outline"
              title="Zoom" aria-label="Zoom" aria-haspopup="true"
              aria-expanded="false" aria-pressed="false">
        <i class="fas fa-magnifying-glass"></i>
        <span class="zoom-divider" aria-hidden="true"></span>
        <span class="zoom-readout" aria-label="Current zoom">1.00×</span>
      </button>
      <div class="zoom-panel" hidden>
        <div class="zoom-slider-row">
          <input class="zoom-range" type="range"
                 min="${T_MIN}" max="${T_MAX}" step="0.01" value="0"
                 aria-label="Zoom level">
          <div class="zoom-ticks" aria-hidden="true">${ticks}</div>
        </div>
      </div>
    `;
    this.#updateReadout();
    this.#setSliderFromValue();
  }
}

customElements.define('zoom-control', ZoomControl);
