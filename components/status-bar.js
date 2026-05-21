/**
 * <status-bar> — colored state icon + title + details (tooltip) + progress row.
 *
 * State icon: filled circle (FA fa-circle) colored by state:
 *   idle    — grey
 *   running — blue (subtle pulse)
 *   success — green
 *   warning — orange (success with a non-fatal fallback/skip)
 *   error   — red
 *
 * Title is the brief "what's happening right now" line. Details live in a
 * hover tooltip on the icon — used for the longer narrative (which EP,
 * what error, etc.). Progress row shows a fractional bar with an optional
 * tile count to the right.
 *
 * Primary API:
 *   sb.set({ title, state, details, progress, tileCount })
 *     - any subset; unspecified fields are left as-is
 *     - state: 'idle' | 'running' | 'success' | 'warning' | 'error'
 *     - progress: 0..1, -1 to hide, -2 indeterminate
 *     - tileCount: { done, total } or null
 *
 * Convenience aliases preserved for incremental callers:
 *   sb.message = '...'        ≡ sb.set({ title })
 *   sb.showProgress(frac)     ≡ sb.set({ progress: frac })
 *   sb.hideProgress()         ≡ sb.set({ progress: -1, tileCount: null })
 *   sb.showIndeterminate()    ≡ sb.set({ progress: -2 })
 */

import { morph } from 'lib/morph';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const STATES = ['idle', 'running', 'success', 'warning', 'error'];

class StatusBar extends HTMLElement {
  #title = '';
  #state = 'idle';
  #details = '';
  #progress = -1;
  #tileCount = null;

  connectedCallback() {
    this.classList.add('status-bar');
    this.#render();
  }

  set(fields) {
    if (fields.title !== undefined) this.#title = fields.title;
    if (fields.state !== undefined && STATES.includes(fields.state)) this.#state = fields.state;
    if (fields.details !== undefined) this.#details = fields.details;
    if (fields.progress !== undefined) this.#progress = fields.progress;
    if (fields.tileCount !== undefined) this.#tileCount = fields.tileCount;
    this.#render();
  }

  set message(msg) { this.set({ title: msg }); }
  showProgress(frac) { this.set({ progress: frac }); }
  hideProgress() { this.set({ progress: -1, tileCount: null }); }
  showIndeterminate() { this.set({ progress: -2 }); }

  #render() {
    const showProgress = this.#progress !== -1;
    const indeterminate = this.#progress === -2;
    const fillWidth = indeterminate ? 100 : Math.max(0, Math.min(1, this.#progress)) * 100;
    const fillAnim = indeterminate ? 'animation: status-indeterminate 1.5s ease-in-out infinite;' : '';
    const tc = this.#tileCount;
    const hasTileCount = tc && Number.isFinite(tc.done) && Number.isFinite(tc.total);
    const tileText = hasTileCount ? `${tc.done} / ${tc.total}` : '';
    const ariaLabel = this.#details ? `${this.#title} — ${this.#details}` : this.#title;

    morph(this, `
      <style>
        .status-bar .status-row {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          min-width: 0;
          width: 100%;
        }
        .status-bar .status-icon-wrap {
          position: relative;
          display: inline-flex;
          align-items: center;
          flex-shrink: 0;
          outline: none;
        }
        .status-bar .status-icon {
          font-size: 0.7em;
          line-height: 1;
        }
        .status-bar .status-icon.idle    { color: var(--pico-muted-color, #888); }
        .status-bar .status-icon.running { color: #3b82f6; animation: status-pulse 1.4s ease-in-out infinite; }
        .status-bar .status-icon.success { color: #16a34a; }
        .status-bar .status-icon.warning { color: #d97706; }
        .status-bar .status-icon.error   { color: var(--pico-del-color, #c62828); }
        @keyframes status-pulse {
          0%, 100% { opacity: 0.55; }
          50%      { opacity: 1; }
        }
        .status-bar .status-tooltip {
          display: none;
          position: absolute;
          bottom: calc(100% + 0.45rem);
          left: 0;
          background: var(--pico-card-background-color, #1e1e2e);
          color: var(--pico-color, #cdd6f4);
          border: 1px solid var(--pico-muted-border-color);
          border-radius: var(--pico-border-radius);
          padding: 0.4rem 0.55rem;
          font-size: 0.75rem;
          line-height: 1.4;
          white-space: pre-wrap;
          width: max-content;
          max-width: 22rem;
          z-index: 100;
          pointer-events: none;
          box-shadow: 0 2px 8px rgba(0,0,0,.25);
          mix-blend-mode: normal;
        }
        .status-bar .status-icon-wrap:hover .status-tooltip,
        .status-bar .status-icon-wrap:focus-within .status-tooltip {
          display: block;
        }
        .status-bar .status-text {
          font-size: 0.85rem;
          color: var(--pico-muted-color, #aaa);
          margin-bottom: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 0 1 auto;
          min-width: 0;
        }
        .status-bar .progress-track {
          flex: 1 1 auto;
          height: 6px;
          background: var(--pico-muted-border-color, #333);
          border-radius: 3px;
          overflow: hidden;
          min-width: 0;
        }
        .status-bar .progress-fill {
          height: 100%;
          background: var(--pico-primary, #4c8);
          width: 0%;
          transition: width 0.2s;
        }
        .status-bar .progress-count {
          font-size: 0.72rem;
          color: var(--pico-muted-color, #aaa);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          flex-shrink: 0;
        }
        @keyframes status-indeterminate {
          0%   { width: 20%; margin-left: 0; }
          50%  { width: 40%; margin-left: 30%; }
          100% { width: 20%; margin-left: 80%; }
        }
      </style>

      <div class="status-row">
        <span class="status-icon-wrap" ${this.#details ? 'tabindex="0"' : ''} aria-label="${esc(ariaLabel)}">
          <i class="fas fa-circle status-icon ${this.#state}" aria-hidden="true"></i>
          ${this.#details ? `<span class="status-tooltip" role="tooltip">${esc(this.#details)}</span>` : ''}
        </span>
        <div class="status-text">${esc(this.#title)}</div>
        ${showProgress ? `
          <div class="progress-track" aria-hidden="true">
            <div class="progress-fill" style="width:${fillWidth}%;${fillAnim}"></div>
          </div>
          ${hasTileCount ? `<span class="progress-count">${esc(tileText)}</span>` : ''}
        ` : ''}
      </div>
    `);
  }
}

customElements.define('status-bar', StatusBar);
