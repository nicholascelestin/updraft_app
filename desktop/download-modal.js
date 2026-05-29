// "Download Desktop App" modal — opens on header-button click.
//
// State machine:
//   idle        — model checkboxes + platform override visible, Download button enabled
//   downloading — progress bars, Cancel button (best-effort)
//   done        — success message + install hint
//   error       — error message + Retry / Close
//
// Lazy-imports the heavyweight compose/sources modules only when the
// user actually clicks Download, so this module stays cheap on page load.

import { detectPlatform, PLATFORM_TARGETS, targetById } from './download-platform.js';
import { modelStore } from '../features/upscaler/sr-model-store.js';
import { CUSTOM_MODEL_URL_PREFIX } from '../lib/model-cache.js';

let dialog = null;

const TINY_BUILTIN_THRESHOLD_MB = 10;
const ELECTRON_BASE_ESTIMATE_MB = 250;
const ORT_NODE_ESTIMATE_MB = 50;
const STATIC_TREE_ESTIMATE_MB = 95; // aitools static + vendor + WASMs
const NODE_BINARY_ESTIMATE_MB = 40; // bundled Node binary (compressed ~30-50 MB per platform)

export async function openDownloadModal() {
  if (dialog) {
    dialog.showModal();
    return;
  }
  dialog = makeDialog();
  document.body.appendChild(dialog);
  injectStyles();
  await renderIdle();
  dialog.showModal();
}

function makeDialog() {
  const d = document.createElement('dialog');
  d.className = 'desktop-download-modal';
  d.addEventListener('cancel', (e) => {
    // Don't auto-close while a download is in flight — make user explicitly cancel.
    if (d.dataset.state === 'downloading') e.preventDefault();
  });
  return d;
}

// Set dialog state + render an <article> body. All four state-renderers go
// through this to keep the shell consistent.
function setDialog(state, articleHtml) {
  dialog.dataset.state = state;
  dialog.innerHTML = `<article>${articleHtml}</article>`;
}

// Wire a button selector to close + remove + reset the module-level dialog
// ref. renderDone and renderError both want the same teardown.
function wireDismiss(selector) {
  dialog.querySelector(selector).addEventListener('click', () => {
    dialog.close();
    dialog.remove();
    dialog = null;
  });
}

function injectStyles() {
  if (document.getElementById('desktop-download-modal-styles')) return;
  const s = document.createElement('style');
  s.id = 'desktop-download-modal-styles';
  s.textContent = `
    /* Pico styles the <dialog> itself as the full-viewport backdrop
       (position: fixed, min-width: 100%, dark bg). Width clamps belong on
       the inner <article> — the visible card — or the dialog shrinks to a
       narrow vertical strip and the dark backdrop only covers that strip. */
    .desktop-download-modal > article { max-width: 640px; min-width: 480px; }
    .desktop-download-modal h3 { margin: 0 0 0.5rem; }
    .desktop-download-modal .platform-row {
      display: flex; gap: 0.75rem; align-items: center; margin: 0.75rem 0 1rem;
    }
    .desktop-download-modal .platform-row select { margin: 0; width: auto; }
    .desktop-download-modal .model-list {
      max-height: 280px; overflow-y: auto;
      border: 1px solid var(--pico-muted-border-color); border-radius: 4px;
      padding: 0.4rem 0.6rem; margin-bottom: 0.75rem;
    }
    .desktop-download-modal .model-row {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.2rem 0; font-size: 0.9rem;
    }
    .desktop-download-modal .model-row input[type=checkbox] { margin: 0; }
    .desktop-download-modal .model-row .size {
      margin-left: auto; opacity: 0.7; font-variant-numeric: tabular-nums;
    }
    .desktop-download-modal .model-empty { font-style: italic; opacity: 0.6; padding: 0.4rem 0; }
    .desktop-download-modal .size-estimate {
      display: flex; justify-content: space-between; align-items: baseline;
      margin: 0.5rem 0 1rem; font-weight: 500;
    }
    .desktop-download-modal .size-estimate .hint {
      font-size: 0.75rem; font-weight: 400; opacity: 0.7;
    }
    .desktop-download-modal .stages {
      display: grid; grid-template-columns: max-content 1fr;
      gap: 0.5rem 0.75rem; margin: 1rem 0; align-items: center;
    }
    .desktop-download-modal .stage-label { font-size: 0.85rem; }
    .desktop-download-modal .stage-label.done { opacity: 0.6; }
    .desktop-download-modal .stage-label.queued { opacity: 0.4; }
    .desktop-download-modal progress { width: 100%; margin: 0; }
    .desktop-download-modal .actions {
      display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem;
    }
    .desktop-download-modal .actions button { margin: 0; }
    .desktop-download-modal .error {
      color: var(--pico-del-color, #c62828); margin: 0.5rem 0; font-size: 0.85rem;
      white-space: pre-wrap;
    }
    .desktop-download-modal .install-hint {
      background: var(--pico-card-sectioning-background-color, #1a1a1a);
      padding: 0.75rem 1rem; border-radius: 4px; margin: 0.75rem 0;
      font-size: 0.85rem;
    }
    .desktop-download-modal .install-hint code {
      background: rgba(0,0,0,0.3); padding: 0.1rem 0.3rem; border-radius: 2px;
    }
  `;
  document.head.appendChild(s);
}

// ───── State 1: idle (pick what to download) ─────────────────────────────

async function renderIdle() {
  const detected = await detectPlatform();
  const platformOptions = PLATFORM_TARGETS.map(t =>
    `<option value="${t.id}"${detected?.id === t.id ? ' selected' : ''}>${t.label}</option>`
  ).join('');

  const all = modelStore.list();
  const modelChecks = all.map(m => {
    if (m.custom) {
      const id = m.url.slice(CUSTOM_MODEL_URL_PREFIX.length);
      return {
        key: m.url, label: `${m.label} (custom)`, sizeMB: m.sizeMB ?? 0,
        preChecked: false,
        kind: 'custom', url: m.url, outPath: `models/${id}.onnx`,
      };
    }
    return {
      key: m.url, label: m.label, sizeMB: m.sizeMB ?? 0,
      preChecked: (m.sizeMB ?? 0) < TINY_BUILTIN_THRESHOLD_MB,
      kind: 'builtin', url: m.url, outPath: m.url, // built-in URLs are already relative paths like 'models/X.onnx'
    };
  });

  setDialog('idle', `
    <h3><i class="fas fa-download"></i> Download Desktop App</h3>
    <p style="font-size:0.85rem; opacity:0.75; margin: 0 0 0.5rem;">
      Packages aitools as a standalone Electron app for offline use with
      native ONNX acceleration. Models are not included by default; pick
      which to bundle below.
    </p>

    <div class="platform-row">
      <label style="margin:0;">Platform:</label>
      <select class="platform-select">${platformOptions}</select>
    </div>

    <div class="model-list">
      ${modelChecks.length === 0
        ? '<div class="model-empty">No models available.</div>'
        : modelChecks.map((m, i) => `
          <label class="model-row">
            <input type="checkbox"
                   data-model-index="${i}"
                   ${m.preChecked ? 'checked' : ''}>
            <span>${escapeHtml(m.label)}</span>
            <span class="size">${formatSize(m.sizeMB)}</span>
          </label>
        `).join('')
      }
    </div>

    <div class="size-estimate">
      <span>Estimated download size: <span class="total-size">…</span></span>
      <span class="hint">Electron runtime + selected content</span>
    </div>

    <div class="error" hidden></div>

    <div class="actions">
      <button class="secondary cancel-btn">Cancel</button>
      <button class="download-btn">Download</button>
    </div>
  `);

  dialog._modelChecks = modelChecks;

  const updateSize = () => {
    let mb = ELECTRON_BASE_ESTIMATE_MB + ORT_NODE_ESTIMATE_MB + STATIC_TREE_ESTIMATE_MB + NODE_BINARY_ESTIMATE_MB;
    for (const cb of dialog.querySelectorAll('input[data-model-index]')) {
      if (cb.checked) mb += modelChecks[parseInt(cb.dataset.modelIndex, 10)].sizeMB;
    }
    dialog.querySelector('.total-size').textContent = formatSize(mb);
  };
  for (const cb of dialog.querySelectorAll('input[data-model-index]')) {
    cb.addEventListener('change', updateSize);
  }
  updateSize();

  dialog.querySelector('.cancel-btn').addEventListener('click', () => dialog.close());
  dialog.querySelector('.download-btn').addEventListener('click', () => {
    const selectedTargetId = dialog.querySelector('.platform-select').value;
    const target = targetById(selectedTargetId);
    const selected = [...dialog.querySelectorAll('input[data-model-index]:checked')]
      .map(cb => modelChecks[parseInt(cb.dataset.modelIndex, 10)]);
    startDownload(target, selected).catch(e => renderError(e));
  });
}

// ───── State 2: downloading ──────────────────────────────────────────────

async function startDownload(target, selectedModels) {
  setDialog('downloading', `
    <h3><i class="fas fa-download"></i> Building Desktop App…</h3>
    <p style="font-size:0.85rem; opacity:0.75;">${escapeHtml(target.label)} — please wait, do not close this window.</p>

    <div class="stages">
      <span class="stage-label" data-stage="electron">Electron framework</span>
      <progress data-stage="electron" max="100" value="0"></progress>

      <span class="stage-label" data-stage="ort"      >ORT-Node runtime</span>
      <progress data-stage="ort"      max="100" value="0"></progress>

      <span class="stage-label" data-stage="node"     >Node.js runtime</span>
      <progress data-stage="node"     max="100" value="0"></progress>

      <span class="stage-label" data-stage="static"   >Aitools static + models</span>
      <progress data-stage="static"   max="100" value="0"></progress>

      <span class="stage-label" data-stage="package"  >Packaging</span>
      <progress data-stage="package"  max="100" value="0"></progress>
    </div>

    <div class="error" hidden></div>
  `);

  // Lazy-load the heavy modules now that we're actually downloading.
  const sources = await import('./download-sources.js');
  const compose = await import('./download-compose.js');

  const setStage = (stage, pct) => {
    const p = dialog.querySelector(`progress[data-stage="${stage}"]`);
    if (p) p.value = Math.max(0, Math.min(100, pct));
  };
  const finishStage = (stage) => {
    setStage(stage, 100);
    dialog.querySelector(`.stage-label[data-stage="${stage}"]`)?.classList.add('done');
  };

  try {
    // Four independent fetches in parallel.
    const electronP = sources.fetchElectronBase(target, (loaded, total) => {
      setStage('electron', total ? (loaded / total) * 100 : 50);
    });
    // ORT-Node + its runtime dep onnxruntime-common. The two combined are
    // small enough that we treat them as one "ort" stage in the UI.
    const versions = await sources.getVersions();
    const ortP = sources.fetchNpmTarball('onnxruntime-node', versions['onnxruntime-node'], (loaded, total) => {
      setStage('ort', total ? (loaded / total) * 50 : 25);
    });
    const ortCommonP = sources.fetchNpmTarball('onnxruntime-common', versions['onnxruntime-common'] || versions['onnxruntime-node'], (loaded, total) => {
      // Second half of the ort stage bar.
      setStage('ort', 50 + (total ? (loaded / total) * 50 : 25));
    });
    // Node.js binary — bundled so users don't need Node installed. Fetch
    // failures are non-fatal: the build still completes, but the user
    // will need system Node at launch.
    const nodeP = sources.fetchNodeBinary(target, (loaded, total) => {
      setStage('node', total ? (loaded / total) * 100 : 50);
    }).catch(e => {
      console.warn('[desktop] Node binary fetch failed, build will proceed without bundled Node:', e?.message || e);
      dialog.querySelector(`.stage-label[data-stage="node"]`)?.classList.add('done');
      return null;
    });

    // Static + models: serial, with progress within the stage.
    const paths = await sources.getBundleManifest();
    const modelByteCount = selectedModels.length;
    const totalStaticUnits = paths.length + modelByteCount;
    let staticUnitsDone = 0;
    const tickStatic = () => setStage('static', (staticUnitsDone / Math.max(1, totalStaticUnits)) * 100);

    const staticFiles = await sources.fetchStaticBundle(paths, (i, total) => {
      staticUnitsDone = i;
      tickStatic();
    });
    const fetchedModels = [];
    for (const m of selectedModels) {
      const bytes = await sources.fetchModelBytes(m.url);
      fetchedModels.push({ outPath: m.outPath, bytes });
      staticUnitsDone++;
      tickStatic();
    }
    finishStage('static');

    const [electronBuf, ortBuf, ortCommonBuf, nodeBuf] = await Promise.all([electronP, ortP, ortCommonP, nodeP]);
    finishStage('electron');
    finishStage('ort');
    if (nodeBuf) finishStage('node');

    const blob = await compose.composeDesktopZip({
      target, electronZipBuf: electronBuf, ortTgzBuf: ortBuf, ortCommonTgzBuf: ortCommonBuf,
      nodeArchiveBuf: nodeBuf,
      staticFiles, selectedModels: fetchedModels,
      onProgress: (msg) => {
        // We don't get sub-step progress from fflate's async API, so just
        // bump the bar in chunks at each phase boundary.
        const map = {
          'Unpacking Electron framework': 25,
          'Unpacking ORT-Node runtime': 50,
          'Composing app layout': 70,
          'Generating final zip': 90,
        };
        setStage('package', map[msg] ?? 50);
      },
    });
    finishStage('package');

    triggerBlobDownload(blob, target.downloadName);
    renderDone(target, blob.size);
  } catch (e) {
    renderError(e);
  }
}

// ───── State 3: done ─────────────────────────────────────────────────────

function renderDone(target, blobBytes) {
  const hint = installHintFor(target);
  setDialog('done', `
    <h3><i class="fas fa-check"></i> Saved <code>${escapeHtml(target.downloadName)}</code></h3>
    <p style="font-size:0.85rem;">Size: ${formatSize(blobBytes / 1e6)}</p>
    <div class="install-hint">${hint}</div>
    <div class="actions">
      <button class="close-btn">Close</button>
    </div>
  `);
  wireDismiss('.close-btn');
}

function installHintFor(target) {
  if (target.os === 'darwin') {
    return `
      <strong>Next steps</strong> (macOS):
      <ol style="margin: 0.4rem 0 0 1.2rem; padding: 0;">
        <li>Unzip the archive in Finder.</li>
        <li>Open Terminal in the folder containing <code>Updraft.app</code> and run:
          <pre style="margin: 0.3rem 0; padding: 0.4rem 0.6rem; background: rgba(0,0,0,0.3); border-radius: 3px; font-size: 0.8rem; overflow-x: auto;"><code>xattr -cr Updraft.app &amp;&amp; open Updraft.app</code></pre>
          <span style="font-size: 0.75rem; opacity: 0.75;">
            This strips the browser-applied "downloaded from internet" marker. Without it,
            macOS Gatekeeper sees the Electron binary's embedded ad-hoc signature, expects
            a corresponding bundle seal (which we have to remove because we add files to
            <code>Contents/Resources/app/</code>), finds none, and refuses to launch with
            the unhelpful "damaged and can't be opened" error.
          </span>
        </li>
        <li>Subsequent launches: double-click <code>Updraft.app</code> normally.</li>
        <li>Optionally drag <code>Updraft.app</code> to <code>/Applications</code>.</li>
        <li>Models go in <code>Updraft.app/Contents/Resources/app/models/</code>.</li>
      </ol>`;
  }
  if (target.os === 'win32') {
    return `
      <strong>Next steps</strong> (Windows):
      <ol style="margin: 0.4rem 0 0 1.2rem; padding: 0;">
        <li>Unzip the archive.</li>
        <li>Run <code>electron.exe</code>.
            (SmartScreen may warn about the unsigned binary —
            click "More info" → "Run anyway".)</li>
        <li>You may also need the
            <a href="https://aka.ms/vs/17/release/vc_redist.x64.exe" target="_blank" rel="noopener">VC++ Redistributable</a>
            if you don't have it (most modern Windows installs do).</li>
        <li>Models go in <code>resources/app/models/</code>.</li>
      </ol>`;
  }
  return `
    <strong>Next steps</strong> (Linux):
    <ol style="margin: 0.4rem 0 0 1.2rem; padding: 0;">
      <li>Unzip the archive: <code>unzip aitools-desktop-…zip</code></li>
      <li>Make the binary executable: <code>chmod +x electron</code></li>
      <li>Run: <code>./electron</code></li>
      <li>Models go in <code>resources/app/models/</code>.</li>
    </ol>`;
}

// ───── State 4: error ────────────────────────────────────────────────────

function renderError(err) {
  const msg = err?.stack || err?.message || String(err);
  setDialog('error', `
    <h3><i class="fas fa-triangle-exclamation"></i> Download failed</h3>
    <div class="error">${escapeHtml(msg)}</div>
    <div class="actions">
      <button class="secondary close-btn">Close</button>
      <button class="retry-btn">Retry</button>
    </div>
  `);
  wireDismiss('.close-btn');
  dialog.querySelector('.retry-btn').addEventListener('click', () => {
    renderIdle().catch(e => renderError(e));
  });
}

// ───── helpers ───────────────────────────────────────────────────────────

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a moment before revoking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function formatSize(mb) {
  if (!Number.isFinite(mb)) return '?';
  if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
