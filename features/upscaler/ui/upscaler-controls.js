import { morph } from 'lib/morph';
import { modelOptionsHTML } from '../model-registry.js';
import {
  deleteCustomModelByUrl,
  getCustomModelByUrl,
  getUploadCustomOptionHTML,
  listCustomModels,
} from '../custom-models/custom-model-store.js';
import '../custom-models/custom-model-upload-dialog.js';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const UPLOAD_CUSTOM_VALUE = '__upload_custom__';

// Single source of truth for localStorage <-> form control wiring.
// `kind` is 'value' for inputs/selects, 'checked' for checkboxes.
const PERSISTED_CONTROLS = [
  { selector: '.tilesize-select',         key: 'upscaler_tilesize',                kind: 'value',   event: 'change' },
  { selector: '.backend-select',          key: 'upscaler_backend',                 kind: 'value',   event: 'change' },
  { selector: '.output-select',           key: 'upscaler_output',                  kind: 'value',   event: 'change' },
  { selector: '.pass-all-enabled',        key: 'upscaler_pass_all_enabled',        kind: 'checked', event: 'change' },
  { selector: '.pass-all-blend',          key: 'upscaler_pass_all_blend',          kind: 'value',   event: 'input' },
  { selector: '.pass-all-model',          key: 'upscaler_pass_all_model',          kind: 'value',   event: 'change' },
  { selector: '.pass-compare-enabled',    key: 'upscaler_pass_compare_enabled',    kind: 'checked', event: 'change' },
  { selector: '.pass-compare-model',      key: 'upscaler_pass_compare_model',      kind: 'value',   event: 'change' },
  { selector: '.detector-face-enabled',   key: 'upscaler_detector_face_enabled',   kind: 'checked', event: 'change' },
  { selector: '.detector-face-padding',   key: 'upscaler_detector_face_padding_px', kind: 'value',   event: 'input' },
  { selector: '.detector-face-score',     key: 'upscaler_detector_face_score',     kind: 'value',   event: 'input' },
  { selector: '.detector-face-blend',     key: 'upscaler_detector_face_blend',     kind: 'value',   event: 'input' },
  { selector: '.detector-face-model',     key: 'upscaler_detector_face_model',     kind: 'value',   event: 'change' },
];

function readControl(el, kind) {
  return kind === 'checked' ? (el.checked ? '1' : '0') : el.value;
}
function writeControl(el, kind, saved) {
  if (kind === 'checked') el.checked = saved === '1';
  else el.value = saved;
}

class UpscalerControls extends HTMLElement {
  #customModels = [];
  #previousModelValue = '';
  #outputBaseLabels = null;
  #isRunning = false;

  connectedCallback() {
    this.#render();
    this.#customModels = listCustomModels();
    this.#refreshModelSelectOptions(localStorage.getItem('upscaler_model') || undefined);
    this.#setupPersistence();
    this.#wireEvents();
    this.#restoreSettings();
  }

  #q(sel) { return this.querySelector(sel); }
  #isBuiltInResampler(modelOpt) { return !!modelOpt?.value?.startsWith('builtin:'); }

  // ── Public surface ─────────────────────────────────────────────────────

  get selectedModelOption() {
    return this.#q('.model-select')?.selectedOptions?.[0] || null;
  }

  get outputScale() {
    const parsed = parseInt(this.#q('.output-select')?.value, 10);
    return Number.isFinite(parsed) ? parsed : 4;
  }

  get backend() {
    return this.selectedModelOption?.dataset.backend
      || this.#q('.backend-select')?.value
      || 'webgpu';
  }

  set isRunning(b) {
    this.#isRunning = !!b;
    this.#q('.clear-cache-btn').disabled = this.#isRunning;
    this.#updateCustomDeleteVisibility();
  }

  refreshAfterCustomModelChange(url) {
    this.#customModels = listCustomModels();
    this.#refreshModelSelectOptions(url);
    if (url) {
      this.#previousModelValue = url;
      localStorage.setItem('upscaler_model', url);
    }
    this.#updateModelBoundControls();
    this.#updateCustomDeleteVisibility();
  }

  /**
   * Build the Pipeline config from current form state. Caller adds `profile`
   * from the perf-monitor's visibility — the controls component doesn't see
   * the perf monitor (lives at the orchestrator level).
   */
  get config() {
    const opt = this.#q('.model-select').selectedOptions[0];
    const modelUrl = opt.value;
    const scale = parseInt(opt.dataset.scale, 10) || 4;
    const modelValueRange = parseInt(opt.dataset.range, 10) || 1;
    const modelLayout = opt.dataset.layout || 'nchw';
    const modelInputMultiple = parseInt(opt.dataset.multipleof, 10) || 1;
    const modelPrecision = opt.dataset.precision === 'fp16' ? 'fp16' : 'fp32';
    const upscaleBefore = opt.dataset.upscalebefore === 'true';
    const tileBlend = opt.dataset.tileblend === 'gaussian' ? 'gaussian' : 'overlapCrop';
    const backend = opt.dataset.backend || this.#q('.backend-select').value;
    let tileSize = parseInt(this.#q('.tilesize-select').value, 10);

    const config = { modelUrl, scale, modelValueRange, modelLayout, modelInputMultiple, modelPrecision, upscaleBefore, tileBlend, backend, tileSize };

    const optionsForClamp = [opt];

    // Comparison runs the base + a second SR pass and shows them side-by-
    // side; All/Faces would mutate the base canvas the slider is supposed to
    // expose, so we suppress them entirely whenever Comparison is on. The UI
    // already disables those rows — this is the matching defensive guard at
    // the config layer.
    const compareOn = this.#q('.pass-compare-enabled').checked;

    if (compareOn) {
      const copt = this.#q('.pass-compare-model').selectedOptions[0];
      if (copt) optionsForClamp.push(copt);
      config.comparison = {
        modelUrl: copt?.value || modelUrl,
        scale: parseInt(copt?.dataset.scale, 10) || scale,
        modelValueRange: parseInt(copt?.dataset.range, 10) || 1,
        modelLayout: copt?.dataset.layout || 'nchw',
        modelInputMultiple: parseInt(copt?.dataset.multipleof, 10) || 1,
        modelPrecision: copt?.dataset.precision === 'fp16' ? 'fp16' : 'fp32',
        upscaleBefore: copt?.dataset.upscalebefore === 'true',
        tileBlend: copt?.dataset.tileblend === 'gaussian' ? 'gaussian' : 'overlapCrop',
        backend: copt?.dataset.backend || backend,
      };
    } else {
      if (this.#q('.pass-all-enabled').checked) {
        const aopt = this.#q('.pass-all-model').selectedOptions[0];
        if (aopt) optionsForClamp.push(aopt);
        config.all = {
          modelUrl: aopt?.value || modelUrl,
          scale: parseInt(aopt?.dataset.scale, 10) || scale,
          modelValueRange: parseInt(aopt?.dataset.range, 10) || 1,
          modelLayout: aopt?.dataset.layout || 'nchw',
          modelInputMultiple: parseInt(aopt?.dataset.multipleof, 10) || 1,
          modelPrecision: aopt?.dataset.precision === 'fp16' ? 'fp16' : 'fp32',
          upscaleBefore: aopt?.dataset.upscalebefore === 'true',
          tileBlend: aopt?.dataset.tileblend === 'gaussian' ? 'gaussian' : 'overlapCrop',
          backend: aopt?.dataset.backend || backend,
          blendOpacity: parseFloat(this.#q('.pass-all-blend').value),
        };
      }

      if (this.#q('.detector-face-enabled').checked) {
        const fopt = this.#q('.detector-face-model').selectedOptions[0];
        if (fopt) optionsForClamp.push(fopt);
        config.face = {
          modelUrl: fopt?.value || modelUrl,
          scale: parseInt(fopt?.dataset.scale, 10) || scale,
          modelValueRange: parseInt(fopt?.dataset.range, 10) || 1,
          modelLayout: fopt?.dataset.layout || 'nchw',
          modelInputMultiple: parseInt(fopt?.dataset.multipleof, 10) || 1,
          modelPrecision: fopt?.dataset.precision === 'fp16' ? 'fp16' : 'fp32',
          upscaleBefore: fopt?.dataset.upscalebefore === 'true',
          tileBlend: fopt?.dataset.tileblend === 'gaussian' ? 'gaussian' : 'overlapCrop',
          backend: fopt?.dataset.backend || backend,
          paddingPx: parseInt(this.#q('.detector-face-padding').value, 10) || 0,
          featherPx: 16,
          blendOpacity: parseFloat(this.#q('.detector-face-blend').value),
          scoreThreshold: parseFloat(this.#q('.detector-face-score').value),
        };
      }
    }

    // Models with a hard input-size cap (e.g. DAT exports with baked-in
    // window counts) only accept tiles up to a fixed dim. Clamp the shared
    // tile size to the strictest selected model. When multipleOf ===
    // maxTileSize the model has a fixed input size: smaller tiles still
    // work via edge-replication padding but pay the same per-tile cost over
    // a smaller real region, so floor to the fixed size too.
    const fixedSizes = optionsForClamp
      .map((o) => {
        const m = parseInt(o?.dataset?.multipleof, 10);
        const c = parseInt(o?.dataset?.maxtilesize, 10);
        return (Number.isFinite(m) && Number.isFinite(c) && m === c && m >= 1) ? c : null;
      })
      .filter((v) => v != null);
    if (fixedSizes.length) {
      const floor = Math.max(...fixedSizes);
      if (tileSize > 0 && tileSize < floor) tileSize = floor;
    }
    const caps = optionsForClamp
      .map((o) => parseInt(o?.dataset?.maxtilesize, 10))
      .filter((v) => Number.isFinite(v) && v >= 1);
    if (caps.length) {
      const minCap = Math.min(...caps);
      if (tileSize <= 0 || tileSize > minCap) tileSize = minCap;
      config.tileSize = tileSize;
    }

    return config;
  }

  // ── Custom model select rendering ──────────────────────────────────────

  #getCustomModelOptionsHTML(selected) {
    if (!this.#customModels.length) return '';
    return this.#customModels.map((model) => {
      const attrs = [
        `value="${model.url}"`,
        `data-scale="${model.scale}"`,
        `data-range="${model.range || 1}"`,
        `data-layout="${model.layout || 'nchw'}"`,
        `data-multipleof="${model.multipleOf || 1}"`,
        `data-sizemb="${model.sizeMB}"`,
      ];
      if (Number.isFinite(model.maxTileSize)) {
        attrs.push(`data-maxtilesize="${model.maxTileSize}"`);
      }
      if (model.precision === 'fp16') attrs.push(`data-precision="fp16"`);
      if (model.url === selected) attrs.push('selected');
      const sizeStr = model.sizeMB != null ? ` (~${model.sizeMB}MB)` : '';
      return `<option ${attrs.join(' ')}>${escapeHtml(model.label)}${sizeStr}</option>`;
    }).join('\n              ');
  }

  #refreshModelSelectOptions(selected) {
    const modelEl = this.#q('.model-select');
    if (!modelEl) return;
    modelEl.innerHTML = [
      modelOptionsHTML(undefined, { selected, includeResamplers: true }),
      this.#getCustomModelOptionsHTML(selected),
      getUploadCustomOptionHTML(),
    ].filter(Boolean).join('\n              ');
    if (selected) modelEl.value = selected;
    if (!modelEl.selectedOptions.length) modelEl.selectedIndex = 0;

    // Pass selectors share the same custom-model list as the primary select.
    // We only refresh their option lists — never their selection — so adding
    // or editing a custom model from the main select doesn't disturb whatever
    // the user has chosen for the all-pass / face-pass.
    this.#refreshPassModelSelect('.pass-all-model');
    this.#refreshPassModelSelect('.pass-compare-model');
    this.#refreshPassModelSelect('.detector-face-model');
  }

  #refreshPassModelSelect(selector) {
    const el = this.#q(selector);
    if (!el) return;
    const previousValue = el.value;
    el.innerHTML = [
      modelOptionsHTML(undefined, { selected: previousValue }),
      this.#getCustomModelOptionsHTML(previousValue),
    ].filter(Boolean).join('\n              ');
    if (previousValue) {
      el.value = previousValue;
      if (!el.selectedOptions.length) el.selectedIndex = 0;
    } else if (!el.selectedOptions.length) {
      el.selectedIndex = 0;
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────

  #setupPersistence() {
    for (const { selector, key, kind, event } of PERSISTED_CONTROLS) {
      const el = this.#q(selector);
      el.addEventListener(event, () => localStorage.setItem(key, readControl(el, kind)));
    }
  }

  #restoreSettings() {
    for (const { selector, key, kind } of PERSISTED_CONTROLS) {
      const saved = localStorage.getItem(key);
      if (saved === null) continue;
      writeControl(this.#q(selector), kind, saved);
    }
    const modelEl = this.#q('.model-select');
    if (!modelEl.selectedOptions.length) modelEl.selectedIndex = 0;
    this.#previousModelValue = modelEl.value;
    this.#syncComparisonExclusion();
    this.#updateModelBoundControls();
    this.#updateInputMirrors();
    this.#updateCustomDeleteVisibility();
  }

  // ── Event wiring ───────────────────────────────────────────────────────

  #wireEvents() {
    const modelEl = this.#q('.model-select');
    const editCustomBtn = this.#q('.edit-custom-model-btn');
    const deleteCustomBtn = this.#q('.delete-custom-model-btn');
    const dialog = this.#q('custom-model-upload-dialog');

    modelEl.addEventListener('change', async () => {
      if (modelEl.value === UPLOAD_CUSTOM_VALUE) {
        const previousOption = Array.from(modelEl.options).find((opt) => opt.value === this.#previousModelValue);
        const defaultScale = parseInt(previousOption?.dataset.scale, 10) || 4;
        const customModel = await dialog.open({ defaultScale });
        if (!customModel) {
          modelEl.value = this.#previousModelValue;
        } else {
          this.refreshAfterCustomModelChange(customModel.url);
          this.#emitStatus(`Added "${customModel.label}" (${customModel.scale}x, ~${customModel.sizeMB}MB).`);
          return;
        }
      } else {
        this.#previousModelValue = modelEl.value;
      }
      localStorage.setItem('upscaler_model', modelEl.value);
      this.#updateModelBoundControls();
      this.#updateCustomDeleteVisibility();
    });

    editCustomBtn.addEventListener('click', async () => {
      if (this.#isRunning) return;
      const selected = getCustomModelByUrl(modelEl.value);
      if (!selected) return;
      const updated = await dialog.open({ editModel: selected });
      if (!updated) return;
      this.refreshAfterCustomModelChange(updated.url);
      this.#emitStatus(`Updated "${updated.label}".`);
    });

    deleteCustomBtn.addEventListener('click', async () => {
      if (this.#isRunning) return;
      const selected = getCustomModelByUrl(modelEl.value);
      if (!selected) return;
      const ok = globalThis.confirm(`Delete custom model "${selected.label}"?\n\nThis will remove it from the local model cache.`);
      if (!ok) return;
      await deleteCustomModelByUrl(selected.url);
      this.#customModels = listCustomModels();
      this.#refreshModelSelectOptions();
      if (modelEl.value === UPLOAD_CUSTOM_VALUE && modelEl.options.length > 1) {
        modelEl.selectedIndex = 0;
      }
      this.#previousModelValue = modelEl.value;
      localStorage.setItem('upscaler_model', modelEl.value);
      this.#updateModelBoundControls();
      this.#updateCustomDeleteVisibility();
      this.#emitStatus(`Deleted "${selected.label}".`);
    });

    this.#q('.tilesize-select').addEventListener('change', () => this.#updateHangWarning());
    this.#q('.backend-select').addEventListener('change', () => this.#updateHangWarning());

    // Toggling a pass on/off or switching its model can change the strictest
    // selected max-tile cap, so refresh the tile-size dropdown the same way
    // a primary-model change does.
    for (const sel of [
      '.pass-all-enabled',
      '.pass-all-model',
      '.pass-compare-enabled',
      '.pass-compare-model',
      '.detector-face-enabled',
      '.detector-face-model',
    ]) {
      this.#q(sel)?.addEventListener('change', () => this.#updateModelBoundControls());
    }

    this.#q('.pass-compare-enabled').addEventListener('change', () => this.#syncComparisonExclusion());

    const wireMirror = (selector, mirrorSelector) => {
      this.#q(selector).addEventListener('input', (e) => {
        this.#q(mirrorSelector).textContent = e.target.value;
      });
    };
    wireMirror('.pass-all-blend',      '.pass-all-blend-val');
    wireMirror('.detector-face-score', '.detector-face-score-val');
    wireMirror('.detector-face-blend', '.detector-face-blend-val');

    const bubble = (name) => this.dispatchEvent(new CustomEvent(name, { bubbles: true }));
    this.#q('.perf-toggle-btn').addEventListener('click', () => bubble('perf-toggle'));
    this.#q('.clear-cache-btn').addEventListener('click', () => bubble('clear-cache'));
  }

  #emitStatus(message) {
    this.dispatchEvent(new CustomEvent('status-message', {
      bubbles: true, detail: { message },
    }));
  }

  #emitModelChange() {
    const opt = this.selectedModelOption;
    const scale = parseInt(opt?.dataset.scale, 10) || 4;
    const verb = scale === 1 ? 'Enhance' : 'Upscale';
    this.dispatchEvent(new CustomEvent('model-change', {
      bubbles: true, detail: { scale, verb, isBuiltInResampler: this.#isBuiltInResampler(opt) },
    }));
  }

  // ── Model-bound UI sync ────────────────────────────────────────────────

  #updateModelBoundControls() {
    const modelEl = this.#q('.model-select');
    const outputEl = this.#q('.output-select');
    const tileEl = this.#q('.tilesize-select');

    if (!this.#outputBaseLabels) {
      this.#outputBaseLabels = new Map(Array.from(outputEl.options).map(opt => [
        opt.value,
        opt.textContent.replace(/\s+\(no downscale\)$/i, ''),
      ]));
    }

    const modelOpt = modelEl.selectedOptions[0];
    const scale = parseInt(modelOpt?.dataset.scale, 10) || 4;
    const maxOutputScale = Math.max(1, Math.min(scale, 4));
    const isBuiltInResampler = this.#isBuiltInResampler(modelOpt);
    const previousOutputScale = parseInt(outputEl.value, 10);

    for (const opt of outputEl.options) {
      const optionScale = parseInt(opt.value, 10) || 1;
      const baseLabel = this.#outputBaseLabels.get(opt.value) || `${optionScale}x`;
      opt.textContent = !isBuiltInResampler && optionScale === maxOutputScale
        ? `${baseLabel} (no downscale)`
        : baseLabel;
      opt.disabled = optionScale > maxOutputScale;
    }

    const preferredScale = Number.isFinite(previousOutputScale) ? previousOutputScale : maxOutputScale;
    const nextOutputScale = Math.max(1, Math.min(maxOutputScale, preferredScale));
    outputEl.value = String(nextOutputScale);
    localStorage.setItem('upscaler_output', outputEl.value);
    this.#q('.backend-select').disabled = isBuiltInResampler;
    tileEl.disabled = isBuiltInResampler;

    // Strictest tile-size cap from the main model plus enabled pass models.
    const capCandidates = [modelOpt];
    if (this.#q('.pass-all-enabled')?.checked) {
      capCandidates.push(this.#q('.pass-all-model')?.selectedOptions[0]);
    }
    if (this.#q('.pass-compare-enabled')?.checked) {
      capCandidates.push(this.#q('.pass-compare-model')?.selectedOptions[0]);
    }
    if (this.#q('.detector-face-enabled')?.checked) {
      capCandidates.push(this.#q('.detector-face-model')?.selectedOptions[0]);
    }
    const caps = capCandidates
      .map((o) => parseInt(o?.dataset?.maxtilesize, 10))
      .filter((v) => Number.isFinite(v) && v >= 1);
    const hasMaxTile = caps.length > 0;
    const maxTileSize = hasMaxTile ? Math.min(...caps) : Infinity;
    const fixedSizes = capCandidates
      .map((o) => {
        const m = parseInt(o?.dataset?.multipleof, 10);
        const c = parseInt(o?.dataset?.maxtilesize, 10);
        return (Number.isFinite(m) && Number.isFinite(c) && m === c && m >= 1) ? c : null;
      })
      .filter((v) => v != null);
    const tileFloor = fixedSizes.length ? Math.max(...fixedSizes) : 0;
    let largestEnabledTileVal = null;
    for (const opt of tileEl.options) {
      const optVal = parseInt(opt.value, 10);
      const isFullImage = optVal === 0;
      const exceeds = hasMaxTile && (isFullImage || optVal > maxTileSize);
      const belowFloor = tileFloor > 0 && !isFullImage && optVal < tileFloor;
      opt.disabled = exceeds || belowFloor;
      if (!opt.disabled && Number.isFinite(optVal) && optVal > 0) {
        if (largestEnabledTileVal === null || optVal > largestEnabledTileVal) {
          largestEnabledTileVal = optVal;
        }
      }
    }
    if ((hasMaxTile || tileFloor > 0) && tileEl.selectedOptions[0]?.disabled && largestEnabledTileVal != null) {
      tileEl.value = String(largestEnabledTileVal);
      localStorage.setItem('upscaler_tilesize', tileEl.value);
    }

    this.#updateHangWarning();
    this.#emitModelChange();
  }

  #updateCustomDeleteVisibility() {
    const modelEl = this.#q('.model-select');
    const editCustomBtn = this.#q('.edit-custom-model-btn');
    const deleteCustomBtn = this.#q('.delete-custom-model-btn');
    const selected = getCustomModelByUrl(modelEl.value);
    deleteCustomBtn.hidden = !selected;
    deleteCustomBtn.disabled = !selected || this.#isRunning;
    deleteCustomBtn.title = selected ? `Delete custom model "${selected.label}"` : 'Delete selected custom model';
    editCustomBtn.hidden = !selected;
    editCustomBtn.disabled = !selected || this.#isRunning;
    editCustomBtn.title = selected ? `Edit custom model "${selected.label}"` : 'Edit selected custom model';
  }

  #updateInputMirrors() {
    this.#q('.pass-all-blend-val').textContent = this.#q('.pass-all-blend').value;
    this.#q('.detector-face-score-val').textContent = this.#q('.detector-face-score').value;
    this.#q('.detector-face-blend-val').textContent = this.#q('.detector-face-blend').value;
  }

  // When Comparison is on, the All/Faces passes are mutually exclusive — they
  // would muddy what the slider is showing. Disable their controls and dim
  // the rows, but leave the underlying values untouched so toggling
  // Comparison off restores the user's prior pass setup verbatim.
  #syncComparisonExclusion() {
    const compareOn = !!this.#q('.pass-compare-enabled')?.checked;
    const otherRows = this.querySelectorAll('.detector-row:not(.pass-compare-row)');
    for (const row of otherRows) {
      row.classList.toggle('passes-disabled', compareOn);
      for (const ctrl of row.querySelectorAll('input, select')) {
        ctrl.disabled = compareOn;
      }
    }
  }

  #updateHangWarning() {
    const warnEl = this.#q('.hang-warn');
    const tipEl = this.#q('.hang-warn-tip');
    const modelOpt = this.#q('.model-select').selectedOptions[0];
    if (this.#isBuiltInResampler(modelOpt)) {
      warnEl.classList.remove('visible');
      return;
    }
    const sizeMB = parseFloat(modelOpt?.dataset.sizemb) || 0;
    const tileSize = parseInt(this.#q('.tilesize-select').value, 10);
    const isLargeOnBigTile = sizeMB > 10 && tileSize > 128;

    // fp16 inference effectively requires WebGPU — ORT-Web's WASM EP has very
    // limited fp16 op coverage so most fp16 models throw a kernel-not-found
    // or input-dtype error. Surface this before the user runs.
    const backend = modelOpt?.dataset.backend || this.#q('.backend-select').value;
    const isFp16OnCpu = modelOpt?.dataset.precision === 'fp16' && backend !== 'webgpu';

    const show = isLargeOnBigTile || isFp16OnCpu;
    warnEl.classList.toggle('visible', show);
    if (!show) return;

    const messages = [];
    if (isFp16OnCpu) {
      messages.push(
        `<strong>fp16 model on CPU backend:</strong> this model uses 16-bit precision, which ONNX Runtime's WASM backend has very limited support for. Inference will almost certainly fail with an "unexpected input data type" or "kernel not found" error. Switch <em>Backend</em> to <em>GPU (WebGPU)</em>.`,
      );
    }
    if (isLargeOnBigTile) {
      messages.push(
        `<strong>Large model with big tiles:</strong> models &gt;10 MB combined with tile sizes above 128 can block the browser's main thread for extended periods, causing the UI to freeze. You may not be able to click Stop until the current tile finishes. Consider reducing the tile size or using a smaller model.`,
      );
    }
    tipEl.innerHTML = messages.join('<br><br>');
  }

  // ── Template ───────────────────────────────────────────────────────────

  #render() {
    morph(this, `
      <style>
        upscaler-controls .controls {
          display: flex; flex-wrap: wrap; gap: 0.4rem 0.75rem;
          align-items: center; margin-bottom: 1rem;
        }
        upscaler-controls .controls label {
          display: inline-flex; align-items: center; gap: 0.35rem;
          font-size: 0.85rem; margin-bottom: 0; white-space: nowrap;
        }
        upscaler-controls .controls select,
        upscaler-controls .controls input {
          margin-bottom: 0; padding: 0.3rem 0.5rem;
          font-size: 0.85rem; width: auto;
        }
        upscaler-controls select:not([multiple], [size]) {
          max-width: 100%;
          padding-left: 0.7rem;
          padding-right: 2.25rem;
          padding-inline-start: 0.7rem;
          padding-inline-end: 2.25rem;
          background-position: center right 0.7rem;
          overflow: hidden;
          white-space: nowrap;
        }
        upscaler-controls select.model-select,
        upscaler-controls select.pass-all-model,
        upscaler-controls select.pass-compare-model,
        upscaler-controls select.detector-face-model {
          width: min(100%, 25em);
          max-width: 25em;
          text-overflow: ellipsis;
        }
        upscaler-controls select.output-select {
          width: min(100%, calc(2ch + 0.7rem + 2.25rem));
          max-width: calc(2ch + 0.7rem + 2.25rem);
        }
        upscaler-controls select.tilesize-select {
          width: min(100%, calc(3ch + 0.7rem + 2.25rem));
          max-width: calc(3ch + 0.7rem + 2.25rem);
        }
        upscaler-controls select.backend-select {
          width: min(100%, calc(4ch + 0.7rem + 2.25rem));
          max-width: calc(4ch + 0.7rem + 2.25rem);
        }
        upscaler-controls .delete-custom-model-btn,
        upscaler-controls .edit-custom-model-btn {
          padding: 0.3rem 0.55rem;
          min-width: 2rem;
        }
        upscaler-controls .controls button {
          margin-bottom: 0; padding: 0.4rem 0.8rem;
          font-size: 0.85rem; width: auto;
        }
        upscaler-controls .local-controls {
          display: inline-flex; flex-wrap: wrap; gap: 0.4rem 0.75rem;
          align-items: center;
        }
        upscaler-controls .passes-panel {
          margin-bottom: 1rem;
          padding: 0.6rem 0.7rem;
          border: 1px solid var(--pico-muted-border-color);
          border-radius: var(--pico-border-radius);
        }
        upscaler-controls .passes-panel > summary {
          cursor: pointer;
          font-size: 0.9rem;
          user-select: none;
          margin-bottom: 0;
          padding: 0.15rem 0;
        }
        upscaler-controls .detector-row {
          display: grid;
          grid-template-columns:
            minmax(11rem, 1fr)
            minmax(17rem, 2.2fr)
            minmax(13rem, 1.2fr)
            minmax(14rem, 1.35fr);
          gap: 0.35rem 0.55rem;
          align-items: center;
          width: 100%;
          max-width: none;
          margin-top: 0.45rem;
        }
        upscaler-controls .detector-row:first-of-type {
          margin-top: 0;
        }
        upscaler-controls .detector-row.passes-disabled {
          opacity: 0.5;
        }
        upscaler-controls .detector-row label {
          margin-bottom: 0;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          column-gap: 0.35rem;
          font-size: 0.85rem;
          min-height: 2rem;
          width: 100%;
        }
        upscaler-controls .detector-row .check-control {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          width: auto;
        }
        upscaler-controls .detector-row .range-control {
          grid-template-columns: auto auto;
        }
        upscaler-controls .detector-row .range-field {
          display: inline-grid;
          grid-auto-flow: column;
          align-items: center;
          column-gap: 0.3rem;
        }
        upscaler-controls .detector-row .range-input {
          width: 7rem;
          vertical-align: middle;
        }
        upscaler-controls .detector-row .range-value {
          min-width: 4ch;
          font-variant-numeric: tabular-nums;
        }
        upscaler-controls .detector-row input,
        upscaler-controls .detector-row select {
          margin-bottom: 0;
        }
        upscaler-controls .detector-row input[type="checkbox"] {
          margin-top: 0;
        }
        upscaler-controls .detector-row .model-control select {
          width: 100%;
          min-width: 0;
        }
        upscaler-controls .detector-row .model-control {
          grid-template-columns: minmax(0, 1fr);
        }
        @media (max-width: 980px) {
          upscaler-controls .detector-row {
            grid-template-columns: 1fr;
          }
        }
        upscaler-controls .hang-warn {
          display: none;
          position: relative;
          color: var(--pico-del-color, #c62828);
          font-size: 1rem;
          cursor: help;
          align-self: center;
        }
        upscaler-controls .hang-warn.visible {
          display: inline-flex;
        }
        upscaler-controls .hang-warn .hang-warn-tip {
          display: none;
          position: absolute;
          bottom: calc(100% + 0.45rem);
          left: 50%;
          transform: translateX(-50%);
          background: var(--pico-card-background-color, #1e1e2e);
          color: var(--pico-color, #cdd6f4);
          border: 1px solid var(--pico-muted-border-color);
          border-radius: var(--pico-border-radius);
          padding: 0.5rem 0.65rem;
          font-size: 0.78rem;
          line-height: 1.4;
          white-space: normal;
          width: max-content;
          max-width: 26rem;
          z-index: 10;
          pointer-events: none;
          box-shadow: 0 2px 8px rgba(0,0,0,.25);
        }
        upscaler-controls .hang-warn:hover .hang-warn-tip {
          display: block;
        }
      </style>

      <div class="controls">
        <span class="local-controls">
          <label>Model:
            <select class="model-select">
              ${modelOptionsHTML(undefined, { includeResamplers: true })}
              ${getUploadCustomOptionHTML()}
            </select>
          </label>
          <button class="secondary outline edit-custom-model-btn" type="button" hidden title="Edit selected custom model" aria-label="Edit selected custom model">
            <i class="fas fa-pen"></i>
          </button>
          <button class="secondary outline delete-custom-model-btn" type="button" hidden title="Delete selected custom model" aria-label="Delete selected custom model">
            <i class="fas fa-trash"></i>
          </button>
          <label>Backend:
            <select class="backend-select">
              <option value="webgpu">GPU (WebGPU)</option>
              <option value="wasm">CPU (WASM)</option>
            </select>
          </label>
          <label>Tile size:
            <select class="tilesize-select">
              <option value="64">64</option>
              <option value="80">80</option>
              <option value="128">128</option>
              <option value="192" selected>192</option>
              <option value="256">256</option>
              <option value="384">384</option>
              <option value="512">512</option>
              <option value="0">Full image (no tiling)</option>
            </select>
          </label>
          <label>Final Output:
            <select class="output-select">
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="3">3x</option>
              <option value="4" selected>4x (no downscale)</option>
            </select>
          </label>
        </span>

        <button class="perf-toggle-btn secondary outline" title="Toggle performance monitor">
          <i class="fas fa-gauge-high"></i>
        </button>
        <span class="hang-warn" aria-label="Performance warning">
          <i class="fas fa-triangle-exclamation"></i>
          <span class="hang-warn-tip"></span>
        </span>
        <button class="clear-cache-btn secondary outline" hidden title="Clear cached ONNX models (frees memory)">
          <i class="fas fa-broom"></i> Clear Cache
        </button>
      </div>

      <details class="passes-panel">
        <summary><i class="fas fa-user-check"></i> Additional Passes</summary>
        <div class="detector-row pass-compare-row">
          <label class="check-control">
            <input class="pass-compare-enabled" type="checkbox">
            Comparison
          </label>
          <label class="model-control">
            <select class="pass-compare-model" aria-label="Comparison pass model">
              ${modelOptionsHTML()}
            </select>
          </label>
        </div>
        <div class="detector-row pass-all-row">
          <label class="check-control">
            <input class="pass-all-enabled" type="checkbox">
            All (full image blend)
          </label>
          <label class="model-control">
            <select class="pass-all-model" aria-label="All pass model">
              ${modelOptionsHTML()}
            </select>
          </label>
          <label class="range-control" title="Blend opacity of the secondary full-image pass over the base upscale">
            Blend:
            <span class="range-field">
              <input class="pass-all-blend range-input" type="range" min="0" max="1" step="0.05" value="0.40">
              <span class="pass-all-blend-val range-value">0.40</span>
            </span>
          </label>
        </div>
        <div class="detector-row pass-faces-row">
          <label class="check-control">
            <input class="detector-face-enabled" type="checkbox">
            Faces (YuNet)
          </label>
          <label class="model-control">
            <select class="detector-face-model" aria-label="Face pass model">
              ${modelOptionsHTML(undefined, { selected: 'models/RMBN_M4C8_FACES_x4.onnx' })}
            </select>
          </label>
          <label class="range-control" title="Blend opacity of the face patch over the base upscale (1 = full replace, lower = transparent blend)">
            Blend:
            <span class="range-field">
              <input class="detector-face-blend range-input" type="range" min="0" max="1" step="0.05" value="0.65">
              <span class="detector-face-blend-val range-value">0.65</span>
            </span>
          </label>
          <label hidden>Padding:
            <input class="detector-face-padding" type="number" min="0" max="512" step="1" value="20" style="width:7ch">
            px
          </label>
          <label class="range-control" title="Minimum face detection confidence">
            Confidence Threshold:
            <span class="range-field">
              <input class="detector-face-score range-input" type="range" min="0.3" max="0.95" step="0.01" value="0.70">
              <span class="detector-face-score-val range-value">0.70</span>
            </span>
          </label>
        </div>
      </details>

      <custom-model-upload-dialog></custom-model-upload-dialog>
    `);
  }
}

customElements.define('upscaler-controls', UpscalerControls);
