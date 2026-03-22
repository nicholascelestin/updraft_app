/**
 * <status-bar> — status message + progress bar.
 */

import { morph } from 'lib/morph';
import { esc } from 'lib/escape';

class StatusBar extends HTMLElement {
  #msg = '';
  #progress = -1;

  connectedCallback() {
    this.classList.add('status-bar');
    this.#render();
  }

  /** @param {string} msg */
  set message(msg) { this.#msg = msg; this.#render(); }

  /** Show progress bar at given fraction (0-1). */
  showProgress(frac) { this.#progress = frac; this.#render(); }

  hideProgress() { this.#progress = -1; this.#render(); }

  /** Show an indeterminate (pulsing) progress bar. */
  showIndeterminate() { this.#progress = -2; this.#render(); }

  #render() {
    const hidden = this.#progress === -1;
    const indeterminate = this.#progress === -2;
    const barDisplay = hidden ? 'none' : 'block';
    const fillWidth = indeterminate ? 100 : Math.max(0, this.#progress * 100);
    const fillAnim = indeterminate ? 'animation: status-indeterminate 1.5s ease-in-out infinite;' : '';

    morph(this, `
      <style>
        .status-bar .status-text {
          font-size: 0.85rem;
          color: var(--pico-muted-color, #aaa);
          min-height: 1.2em;
          margin-bottom: 0.75rem;
        }
        .status-bar .progress-track {
          width: 300px; height: 6px;
          background: var(--pico-muted-border-color, #333);
          border-radius: 3px; overflow: hidden; margin-bottom: 0.75rem;
        }
        .status-bar .progress-fill {
          height: 100%;
          background: var(--pico-primary, #4c8);
          width: 0%; transition: width 0.2s;
        }
        @keyframes status-indeterminate {
          0%   { width: 20%; margin-left: 0; }
          50%  { width: 40%; margin-left: 30%; }
          100% { width: 20%; margin-left: 80%; }
        }
      </style>
      <div class="status-text">${esc(this.#msg)}</div>
      <div class="progress-track" style="display:${barDisplay}">
        <div class="progress-fill" style="width:${fillWidth}%;${fillAnim}"></div>
      </div>
    `);
  }
}

customElements.define('status-bar', StatusBar);
