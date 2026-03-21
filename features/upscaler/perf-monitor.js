/**
 * <perf-monitor> — fixed-position performance overlay.
 */

import { morph } from '../../lib/morph.js';

function fmtTime(ms) {
  if (ms < 1000) return ms.toFixed(0) + ' ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + ' s';
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

class PerfMonitor extends HTMLElement {
  #tileTimes = [];
  #startTime = 0;
  #heapInterval = null;

  #stats = {
    backend: '\u2014', tile: '\u2014', tileTime: '\u2014', avgTile: '\u2014',
    elapsed: '\u2014', eta: '\u2014', heap: '\u2014', heapLimit: '\u2014',
    heapPct: 0, heapClass: '', throughput: '\u2014',
  };

  connectedCallback() {
    this.classList.add('perf-monitor');
    this.#render();
  }

  start(backend) {
    this.#tileTimes = [];
    this.#startTime = performance.now();

    const s = this.#stats;
    s.backend = backend.toUpperCase();
    s.tile = '\u2014'; s.tileTime = '\u2014'; s.avgTile = '\u2014';
    s.elapsed = '0 s'; s.eta = '\u2014'; s.throughput = '\u2014';

    this.#refreshHeap();
    this.style.display = 'block';
    this.#render();
    this.#heapInterval = setInterval(() => { this.#refreshHeap(); this.#render(); }, 500);
  }

  update({ index, total, tileMs, tilePixels }) {
    this.#tileTimes.push(tileMs);
    const elapsed = performance.now() - this.#startTime;
    const avg = this.#tileTimes.reduce((a, b) => a + b, 0) / this.#tileTimes.length;
    const remaining = (total - index - 1) * avg;
    const totalPixels = this.#tileTimes.length * tilePixels;
    const mpxPerSec = (totalPixels / (elapsed / 1000)) / 1e6;

    const s = this.#stats;
    s.tile = `${index + 1} / ${total}`;
    s.tileTime = fmtTime(tileMs);
    s.avgTile = fmtTime(avg);
    s.elapsed = fmtTime(elapsed);
    s.eta = remaining > 0 ? '~' + fmtTime(remaining) : '\u2014';
    s.throughput = mpxPerSec.toFixed(2) + ' Mpx/s';

    this.#refreshHeap();
    this.#render();
  }

  stop() {
    if (this.#heapInterval) {
      clearInterval(this.#heapInterval);
      this.#heapInterval = null;
    }
    this.#stats.eta = 'Done';
    this.#render();
  }

  get elapsedFormatted() {
    return fmtTime(performance.now() - this.#startTime);
  }

  hide() { this.style.display = 'none'; }

  #refreshHeap() {
    const s = this.#stats;
    const mem = performance.memory;
    if (!mem) {
      s.heap = 'N/A'; s.heapLimit = 'N/A'; s.heapPct = 0; s.heapClass = '';
      return;
    }
    const used = mem.usedJSHeapSize;
    const limit = mem.jsHeapSizeLimit;
    const pct = (used / limit) * 100;
    s.heap = fmtMB(used);
    s.heapLimit = fmtMB(limit);
    s.heapPct = pct;
    s.heapClass = pct > 80 ? ' crit' : pct > 60 ? ' warn' : '';
  }

  #render() {
    const s = this.#stats;
    morph(this, `
      <style>
        .perf-monitor {
          display: none; position: fixed; top: 12px; right: 12px; z-index: 9999;
          background: rgba(0,0,0,0.85); border: 1px solid #333; border-radius: 6px;
          padding: 10px 14px; font-family: 'SF Mono', 'Consolas', monospace; font-size: 0.72rem;
          color: #ccc; min-width: 220px; backdrop-filter: blur(8px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        .perf-monitor .perf-title {
          font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em;
          color: #666; margin-bottom: 6px; border-bottom: 1px solid #333; padding-bottom: 4px;
        }
        .perf-monitor .perf-row { display: flex; justify-content: space-between; padding: 1px 0; }
        .perf-monitor .perf-label { color: #888; }
        .perf-monitor .perf-value { color: var(--pico-primary, #4c8); font-weight: 600; text-align: right; }
        .perf-monitor .perf-bar-track {
          height: 3px; background: #333; border-radius: 2px; margin-top: 4px; overflow: hidden;
        }
        .perf-monitor .perf-bar-fill { height: 100%; background: var(--pico-primary, #4c8); transition: width 0.3s; width: 0%; }
        .perf-monitor .perf-bar-fill.warn { background: #c84; }
        .perf-monitor .perf-bar-fill.crit { background: #c44; }
      </style>
      <div class="perf-title">Performance</div>
      <div class="perf-row"><span class="perf-label">Backend</span><span class="perf-value">${s.backend}</span></div>
      <div class="perf-row"><span class="perf-label">Tile</span><span class="perf-value">${s.tile}</span></div>
      <div class="perf-row"><span class="perf-label">Tile time</span><span class="perf-value">${s.tileTime}</span></div>
      <div class="perf-row"><span class="perf-label">Avg tile</span><span class="perf-value">${s.avgTile}</span></div>
      <div class="perf-row"><span class="perf-label">Elapsed</span><span class="perf-value">${s.elapsed}</span></div>
      <div class="perf-row"><span class="perf-label">ETA</span><span class="perf-value">${s.eta}</span></div>
      <div class="perf-row"><span class="perf-label">JS Heap</span><span class="perf-value">${s.heap}</span></div>
      <div class="perf-bar-track">
        <div class="perf-bar-fill${s.heapClass}" style="width:${s.heapPct.toFixed(1)}%"></div>
      </div>
      <div class="perf-row" style="margin-top:4px"><span class="perf-label">Heap limit</span><span class="perf-value">${s.heapLimit}</span></div>
      <div class="perf-row"><span class="perf-label">Throughput</span><span class="perf-value">${s.throughput}</span></div>
    `);
  }
}

customElements.define('perf-monitor', PerfMonitor);
