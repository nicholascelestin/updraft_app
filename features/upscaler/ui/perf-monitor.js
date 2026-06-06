/**
 * <perf-monitor> — fixed-position performance overlay.
 * Consumes events from the upscaler engine to display live tile stats,
 * session timing breakdowns, and optional ORT kernel profiles.
 */

import { morph } from 'lib/morph';

function fmtTime(ms) {
  if (ms < 1000) return ms.toFixed(0) + ' ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + ' s';
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

function fmtMs(ms) {
  return ms.toFixed(1) + ' ms';
}

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function humanStepName(step) {
  const names = {
    tiledUpscale: 'Base pass',
    blendAll: 'All-pass blend',
    detectFaces: 'Face detection',
    enhanceFaces: 'Face enhance',
    colorMatch: 'Preserve tone',
    restoreAlpha: 'Transparency',
    pipeline: 'Pipeline',
  };
  return names[step] || step || '—';
}

class PerfMonitor extends HTMLElement {
  #tileTimes = [];
  #startTime = 0;
  #heapInterval = null;
  #state = 'idle';
  #tilePerf = null;
  #currentStep = null;

  #stats = {
    backend: '\u2014', tile: '\u2014', tileTime: '\u2014', avgTile: '\u2014',
    elapsed: '\u2014', eta: '\u2014', heap: '\u2014', heapLimit: '\u2014',
    heapPct: 0, heapClass: '', throughput: '\u2014', stage: '\u2014',
  };

  #results = null;

  connectedCallback() {
    this.classList.add('perf-monitor');
    this.style.display = 'none';
    this.#render();
    this.addEventListener('click', (e) => {
      if (e.target.closest('.perf-close')) this.hide();
    });
  }

  disconnectedCallback() {
    if (this.#heapInterval) {
      clearInterval(this.#heapInterval);
      this.#heapInterval = null;
    }
  }

  start(backend) {
    this.#tileTimes = [];
    this.#startTime = performance.now();
    this.#state = 'running';
    this.#tilePerf = null;
    this.#currentStep = null;
    this.#results = null;

    const s = this.#stats;
    s.backend = backend.toUpperCase();
    s.tile = '\u2014'; s.tileTime = '\u2014'; s.avgTile = '\u2014';
    s.elapsed = '0 s'; s.eta = '\u2014'; s.throughput = '\u2014';
    s.stage = '\u2014';

    this.#refreshHeap();
    this.style.display = 'block';
    this.#render();
    this.#heapInterval = setInterval(() => { this.#refreshHeap(); this.#render(); }, 500);
  }

  update({ step, index, total, tileMs, tilePixels, perf: tilePerf }) {
    if (step && step !== this.#currentStep) {
      this.#currentStep = step;
      this.#tileTimes = [];
    }
    this.#tileTimes.push(tileMs);
    this.#tilePerf = tilePerf || null;
    const elapsed = performance.now() - this.#startTime;
    const avg = this.#tileTimes.reduce((a, b) => a + b, 0) / this.#tileTimes.length;
    const remaining = (total - index - 1) * avg;
    const totalPixels = this.#tileTimes.length * tilePixels;
    const mpxPerSec = (totalPixels / (elapsed / 1000)) / 1e6;

    const s = this.#stats;
    s.stage = humanStepName(step);
    s.tile = `${index + 1} / ${total}`;
    s.tileTime = fmtTime(tileMs);
    s.avgTile = fmtTime(avg);
    s.elapsed = fmtTime(elapsed);
    s.eta = remaining > 0 ? '~' + fmtTime(remaining) : '\u2014';
    s.throughput = mpxPerSec.toFixed(2) + ' Mpx/s';

    this.#refreshHeap();
    this.#render();
  }

  updateStage({ step, phase, message }) {
    if (this.#state !== 'running') return;
    const label = humanStepName(step);
    this.#stats.stage = phase === 'done' && label ? `${label} done` : label;
    if (message) this.#stats.tile = message;
    this.#render();
  }

  showResults(perf, ortProfile, pipelinePerf) {
    this.#state = 'done';
    this.#results = { perf, ortProfile, pipelinePerf };
    if (this.#heapInterval) {
      clearInterval(this.#heapInterval);
      this.#heapInterval = null;
    }
    this.#refreshHeap();
    this.#render();
  }

  stop() {
    if (this.#heapInterval) {
      clearInterval(this.#heapInterval);
      this.#heapInterval = null;
    }
    if (this.#state === 'running') {
      this.#stats.eta = 'Done';
      this.#state = 'done';
    }
    this.#render();
  }

  get elapsedFormatted() {
    return fmtTime(performance.now() - this.#startTime);
  }

  show() { this.style.display = 'block'; this.#render(); }
  hide() { this.style.display = 'none'; }
  get visible() { return this.style.display !== 'none'; }

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
    const r = this.#results;
    const tp = this.#tilePerf;
    const isRunning = this.#state === 'running';
    const isDone = this.#state === 'done';

    let tileBreakdownHtml = '';
    if (isRunning && tp) {
      tileBreakdownHtml = `
        <div class="perf-row sub"><span class="perf-label">Extract</span><span class="perf-value">${fmtMs(tp.extractMs)}</span></div>
        <div class="perf-row sub"><span class="perf-label">Inference</span><span class="perf-value">${fmtMs(tp.inferenceMs)}</span></div>
        <div class="perf-row sub"><span class="perf-label">Render</span><span class="perf-value">${fmtMs(tp.renderMs)}</span></div>
        <div class="perf-row sub"><span class="perf-label">Dispose</span><span class="perf-value">${fmtMs(tp.disposeMs)}</span></div>`;
    }

    let resultsHtml = '';
    if (isDone && r?.perf) {
      const p = r.perf;
      const pipelineLabel = p.pipeline === 'gpu-gpu' ? 'GPU\u2192GPU' : p.pipeline === 'gpu' ? 'GPU' : 'CPU';
      const tileSizeLabel = p.tileSize > 0 ? p.tileSize + 'px' : 'full';
      const isGpuPipeline = p.pipeline === 'gpu' || p.pipeline === 'gpu-gpu';
      resultsHtml = `
        <div class="perf-divider"></div>
        <div class="perf-section-title">Session Summary</div>
        <div class="perf-row"><span class="perf-label">Pipeline</span><span class="perf-value">${pipelineLabel}</span></div>
        <div class="perf-row"><span class="perf-label">Resolution</span><span class="perf-value">${p.srcW}\u00d7${p.srcH} \u2192 ${p.outW}\u00d7${p.outH}</span></div>
        <div class="perf-row"><span class="perf-label">Tiles</span><span class="perf-value">${p.tiles} @ ${tileSizeLabel}</span></div>
        <div class="perf-row"><span class="perf-label">Total</span><span class="perf-value em">${fmtMs(p.total)}</span></div>
        ${p.modelLoad > 0 ? `<div class="perf-row sub"><span class="perf-label">Model load</span><span class="perf-value">${fmtMs(p.modelLoad)}</span></div>` : ''}
        <div class="perf-row sub"><span class="perf-label">Setup</span><span class="perf-value">${fmtMs(p.setup)}</span></div>
        <div class="perf-row sub"><span class="perf-label">Extract</span><span class="perf-value">${fmtMs(p.extract)}</span></div>
        <div class="perf-row sub"><span class="perf-label">${isGpuPipeline ? 'Inference est.' : 'Inference'}</span><span class="perf-value">${fmtMs(isGpuPipeline ? (p.inferenceEstimated || 0) : p.inference)}</span></div>
        ${p.readback > 0 ? `<div class="perf-row sub"><span class="perf-label">Readback</span><span class="perf-value">${fmtMs(p.readback)}</span></div>` : ''}
        ${p.gpuRender > 0 ? `<div class="perf-row sub"><span class="perf-label">GPU render</span><span class="perf-value">${fmtMs(p.gpuRender)}</span></div>` : ''}
        ${p.writeTile > 0 ? `<div class="perf-row sub"><span class="perf-label">Write tiles</span><span class="perf-value">${fmtMs(p.writeTile)}</span></div>` : ''}
        <div class="perf-row sub"><span class="perf-label">Dispose</span><span class="perf-value">${fmtMs(p.dispose)}</span></div>`;

      if (r.ortProfile) {
        const ort = r.ortProfile;
        const ms = us => (us / 1000).toFixed(1) + 'ms';
        const gpuTotal = Object.values(ort.gpuOps).reduce((acc, e) => acc + e.us, 0);
        const cpuTotal = Object.values(ort.cpuOps).reduce((acc, e) => acc + e.us, 0);
        const topGpuOps = Object.entries(ort.gpuOps)
          .sort(([, a], [, b]) => b.us - a.us)
          .slice(0, 4)
          .map(([op, { us, n }]) => `${op}\u00d7${n} ${ms(us)}`)
          .join(', ');

        resultsHtml += `
        <div class="perf-divider"></div>
        <div class="perf-section-title">ORT Profile</div>
        <div class="perf-row"><span class="perf-label">Runs</span><span class="perf-value">${ort.runs}, model_run ${ms(ort.modelRunUs)}</span></div>
        ${gpuTotal ? `<div class="perf-row"><span class="perf-label">GPU ops</span><span class="perf-value">${ms(gpuTotal)}</span></div>
        <div class="perf-row sub"><span class="perf-label"></span><span class="perf-value dim">${topGpuOps}</span></div>` : ''}
        ${cpuTotal ? `<div class="perf-row"><span class="perf-label">CPU ops</span><span class="perf-value">${ms(cpuTotal)}</span></div>` : ''}
        ${ort.memcpy.toHost.n ? `<div class="perf-row"><span class="perf-label">GPU\u2192CPU</span><span class="perf-value">${ms(ort.memcpy.toHost.us)} \u00d7${ort.memcpy.toHost.n}</span></div>` : ''}
        ${ort.memcpy.fromHost.n ? `<div class="perf-row"><span class="perf-label">CPU\u2192GPU</span><span class="perf-value">${ms(ort.memcpy.fromHost.us)} \u00d7${ort.memcpy.fromHost.n}</span></div>` : ''}`;
      }
      if (r.pipelinePerf?.steps) {
        const rows = Object.entries(r.pipelinePerf.steps)
          .map(([name, data]) => {
            const tiles = data.perf?.tiles ? ` (${data.perf.tiles} tiles)` : '';
            return `<div class="perf-row sub"><span class="perf-label">${humanStepName(name)}</span><span class="perf-value dim">${fmtMs(data.durationMs)}${tiles}</span></div>`;
          })
          .join('');
        resultsHtml += `
        <div class="perf-divider"></div>
        <div class="perf-section-title">Pipeline Steps</div>
        ${rows}
        <div class="perf-row"><span class="perf-label">Pipeline total</span><span class="perf-value">${fmtMs(r.pipelinePerf.totalMs || 0)}</span></div>`;
      }
    }

    morph(this, `
      <style>
        .perf-monitor {
          display: none; position: fixed; bottom: 12px; right: 12px; z-index: 9999;
          background: rgba(0,0,0,0.85); border: 1px solid #333; border-radius: 6px;
          padding: 10px 14px; font-family: 'SF Mono', 'Consolas', monospace; font-size: 0.72rem;
          color: #ccc; min-width: 240px; max-height: calc(100vh - 24px); overflow-y: auto;
          backdrop-filter: blur(8px); box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        .perf-monitor .perf-title {
          font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em;
          color: #666; margin-bottom: 6px; border-bottom: 1px solid #333; padding-bottom: 4px;
          display: flex; justify-content: space-between; align-items: center;
        }
        .perf-monitor .perf-close {
          background: none; border: none; color: #666; cursor: pointer; font-size: 0.85rem;
          padding: 0 2px; line-height: 1; width: auto; margin: 0;
        }
        .perf-monitor .perf-close:hover { color: #ccc; }
        .perf-monitor .perf-row { display: flex; justify-content: space-between; padding: 1px 0; gap: 1rem; }
        .perf-monitor .perf-row.sub { padding-left: 10px; }
        .perf-monitor .perf-row.sub .perf-label { color: #666; font-size: 0.68rem; }
        .perf-monitor .perf-row.sub .perf-value { color: #999; font-size: 0.68rem; }
        .perf-monitor .perf-label { color: #888; white-space: nowrap; }
        .perf-monitor .perf-value { color: var(--pico-primary, #4c8); font-weight: 600; text-align: right; }
        .perf-monitor .perf-value.em { color: #fff; }
        .perf-monitor .perf-value.dim { color: #777; font-weight: 400; font-size: 0.65rem; }
        .perf-monitor .perf-bar-track {
          height: 3px; background: #333; border-radius: 2px; margin-top: 4px; overflow: hidden;
        }
        .perf-monitor .perf-bar-fill { height: 100%; background: var(--pico-primary, #4c8); transition: width 0.3s; width: 0%; }
        .perf-monitor .perf-bar-fill.warn { background: #c84; }
        .perf-monitor .perf-bar-fill.crit { background: #c44; }
        .perf-monitor .perf-divider { border-top: 1px solid #333; margin: 6px 0; }
        .perf-monitor .perf-section-title {
          font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em;
          color: #555; margin-bottom: 4px;
        }
      </style>
      <div class="perf-title">
        <span>Performance${isDone ? ' \u2014 Done' : ''}</span>
        <button class="perf-close" title="Close">\u00d7</button>
      </div>
      <div class="perf-row"><span class="perf-label">Backend</span><span class="perf-value">${s.backend}</span></div>
      <div class="perf-row"><span class="perf-label">Stage</span><span class="perf-value">${s.stage}</span></div>
      <div class="perf-row"><span class="perf-label">Tile</span><span class="perf-value">${s.tile}</span></div>
      <div class="perf-row"><span class="perf-label">Tile time</span><span class="perf-value">${s.tileTime}</span></div>
      ${tileBreakdownHtml}
      <div class="perf-row"><span class="perf-label">Avg tile</span><span class="perf-value">${s.avgTile}</span></div>
      <div class="perf-row"><span class="perf-label">Elapsed</span><span class="perf-value">${s.elapsed}</span></div>
      <div class="perf-row"><span class="perf-label">ETA</span><span class="perf-value">${s.eta}</span></div>
      <div class="perf-row"><span class="perf-label">JS Heap</span><span class="perf-value">${s.heap}</span></div>
      <div class="perf-bar-track">
        <div class="perf-bar-fill${s.heapClass}" style="width:${s.heapPct.toFixed(1)}%"></div>
      </div>
      <div class="perf-row" style="margin-top:4px"><span class="perf-label">Heap limit</span><span class="perf-value">${s.heapLimit}</span></div>
      <div class="perf-row"><span class="perf-label">Throughput</span><span class="perf-value">${s.throughput}</span></div>
      ${resultsHtml}
    `);
  }
}

customElements.define('perf-monitor', PerfMonitor);
