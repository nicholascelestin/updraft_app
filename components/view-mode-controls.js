/**
 * <view-mode-controls> -- segmented icon-button radio for the canvas view mode.
 *
 * Renders one button per mode; the currently-selected mode is marked with
 * `aria-pressed="true"`. Clicking a different button switches and emits
 * `mode-change` { detail: { mode } }.
 */

// Canonical mode values. Callers should reference VIEW_MODE.X rather than
// raw strings so a typo becomes a compile-loud error.
export const VIEW_MODE = Object.freeze({
  FIT_WIDTH: 'fit-width',
  FIT_HEIGHT: 'fit-height',
  ONE_TO_ONE: 'one-to-one',
});

const VIEW_MODES = [
  { key: VIEW_MODE.FIT_WIDTH,  label: 'Fit Width',   icon: 'fa-arrows-left-right' },
  { key: VIEW_MODE.FIT_HEIGHT, label: 'Fit Height',  icon: 'fa-arrows-up-down' },
  { key: VIEW_MODE.ONE_TO_ONE, label: '1:1',         icon: 'fa-vector-square' },
];

const VIEW_MODE_VALUES = Object.values(VIEW_MODE);
export function isViewMode(value) {
  return VIEW_MODE_VALUES.includes(value);
}

class ViewModeControls extends HTMLElement {
  #mode = VIEW_MODE.FIT_WIDTH;

  connectedCallback() {
    this.#render();
    this.addEventListener('click', this.#onClick);
  }

  get mode() { return this.#mode; }
  set mode(value) {
    if (!VIEW_MODES.find(m => m.key === value)) return;
    if (this.#mode === value) return;
    this.#mode = value;
    this.#render();
  }

  #onClick = (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.mode === this.#mode) return;
    this.#mode = btn.dataset.mode;
    this.#render();
    this.dispatchEvent(new CustomEvent('mode-change', { detail: { mode: this.#mode } }));
  };

  #render() {
    const buttons = VIEW_MODES.map(m => `
      <button type="button" class="secondary outline" data-mode="${m.key}"
              aria-pressed="${m.key === this.#mode}"
              title="${m.label}" aria-label="${m.label}">
        <i class="fas ${m.icon}"></i>
      </button>
    `).join('');
    this.innerHTML = `
      <style>
        view-mode-controls {
          display: inline-flex;
          vertical-align: middle;
        }
        view-mode-controls .vm-row {
          display: inline-flex;
          gap: 0;
        }
        view-mode-controls .vm-row > button {
          border-radius: 0;
        }
        view-mode-controls .vm-row > button:first-child {
          border-top-left-radius: var(--pico-border-radius);
          border-bottom-left-radius: var(--pico-border-radius);
        }
        view-mode-controls .vm-row > button:last-child {
          border-top-right-radius: var(--pico-border-radius);
          border-bottom-right-radius: var(--pico-border-radius);
        }
        view-mode-controls .vm-row > button:not(:first-child) {
          margin-left: -1px;
        }
        view-mode-controls button .fas {
          margin-right: 0 !important;
        }
        /* Pressed state: disable the host toolbar's mix-blend-mode trick and
           paint a solid filled background so the active mode is unambiguous
           against the surrounding outline buttons. */
        view-mode-controls button[aria-pressed="true"] {
          mix-blend-mode: normal !important;
          background: rgba(255, 255, 255, 0.22) !important;
          opacity: 1 !important;
          border-color: #fff !important;
          color: #fff !important;
          z-index: 1;
        }
      </style>
      <div class="vm-row" role="radiogroup" aria-label="View mode">
        ${buttons}
      </div>
    `;
  }
}

customElements.define('view-mode-controls', ViewModeControls);
