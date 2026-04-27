/**
 * <custom-model-upload-dialog> — modal for uploading a custom ONNX model.
 *
 * Self-contained UX: file selection, automatic ONNX inspection, manual
 * overrides for scale / range / layout / multiple-of, validation, and save
 * via the custom-model store.
 *
 * Usage:
 *   const dialog = document.querySelector('custom-model-upload-dialog');
 *   const model = await dialog.open({ defaultScale: 4 });
 *   if (model) { ... } else { user cancelled }
 */

import { morph } from 'lib/morph';
import { saveCustomModel, updateCustomModelByUrl } from './custom-model-store.js';
import { inspectCustomModelFile } from './custom-model-inspector.js';

class CustomModelUploadDialog extends HTMLElement {
  connectedCallback() {
    this.classList.add('custom-model-upload-dialog');
    this.#render();
  }

  /**
   * Show the modal and resolve with the saved CustomModel — or null if the
   * user cancelled or closed the dialog.
   *
   * When `editModel` is provided, the dialog opens in edit mode: the file
   * picker is hidden, fields are pre-filled, auto-detection is skipped, and
   * Save updates the existing record's metadata in place.
   *
   * @param {{ defaultScale?: number, editModel?: import('./custom-model-store.js').CustomModel }} [opts]
   */
  open({ defaultScale = 4, editModel = null } = {}) {
    const dialog        = this.querySelector('dialog');
    const form          = this.querySelector('.custom-model-form');
    const titleEl       = this.querySelector('.custom-model-title');
    const fileLabel     = this.querySelector('.custom-model-file-label');
    const fileInput     = this.querySelector('.custom-model-file');
    const analyzeRow    = this.querySelector('.custom-model-analyze-row');
    const analyzeBtn    = this.querySelector('.custom-model-analyze-btn');
    const labelInput    = this.querySelector('.custom-model-label');
    const scaleInput    = this.querySelector('.custom-model-scale');
    const rangeInput    = this.querySelector('.custom-model-range');
    const layoutInput   = this.querySelector('.custom-model-layout');
    const multipleInput = this.querySelector('.custom-model-multiple');
    const maxTileInput  = this.querySelector('.custom-model-maxtile');
    const sizeLabel     = this.querySelector('.custom-model-size');
    const detectLabel   = this.querySelector('.custom-model-detected');
    const errorLabel    = this.querySelector('.custom-model-error');
    const saveBtn       = this.querySelector('.custom-model-save-btn');
    const cancelBtn     = this.querySelector('.custom-model-cancel-btn');

    const isEdit = !!editModel;
    const ANALYZE_BTN_HTML = '<i class="fas fa-flask"></i> Analyze model';
    titleEl.textContent = isEdit ? 'Edit custom ONNX model' : 'Upload custom ONNX model';
    fileLabel.hidden = isEdit;
    fileInput.required = !isEdit;
    analyzeRow.hidden = isEdit;
    detectLabel.hidden = isEdit;
    analyzeBtn.innerHTML = ANALYZE_BTN_HTML;
    analyzeBtn.disabled = true;
    saveBtn.textContent = isEdit ? 'Save changes' : 'Save model';

    fileInput.value = '';
    if (isEdit) {
      labelInput.value = editModel.label || '';
      scaleInput.value = String(editModel.scale ?? defaultScale);
      rangeInput.value = String(editModel.range === 255 ? 255 : 1);
      layoutInput.value = editModel.layout === 'nhwc' ? 'nhwc' : 'nchw';
      multipleInput.value = String(Math.max(1, editModel.multipleOf || 1));
      maxTileInput.value = editModel.maxTileSize != null ? String(editModel.maxTileSize) : '';
      sizeLabel.textContent = editModel.sizeMB != null
        ? `Model size: ~${editModel.sizeMB} MB`
        : 'Model size: -';
    } else {
      labelInput.value = '';
      scaleInput.value = String(defaultScale);
      rangeInput.value = '1';
      layoutInput.value = 'nchw';
      multipleInput.value = '1';
      maxTileInput.value = '';
      sizeLabel.textContent = 'Model size: -';
    }
    errorLabel.textContent = '';
    detectLabel.innerHTML = isEdit
      ? ''
      : 'Auto-detect: <em>pick an ONNX file, then click <strong>Analyze model</strong> to probe it.</em>';
    saveBtn.disabled = false;

    return new Promise((resolve) => {
      let settled = false;
      let inspectSeq = 0;
      const cleanup = () => {
        form.removeEventListener('submit', onSubmit);
        fileInput.removeEventListener('change', onFileChange);
        analyzeBtn.removeEventListener('click', onAnalyzeClick);
        cancelBtn.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onCancel);
        dialog.removeEventListener('close', onClose);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onFileChange = () => {
        // Bumping inspectSeq cancels any in-flight analysis whose result is
        // about to come back: we don't want stale probe data overwriting
        // form values for the file the user just switched to.
        ++inspectSeq;
        const file = fileInput.files?.[0];
        errorLabel.textContent = '';
        if (!file) {
          sizeLabel.textContent = 'Model size: -';
          detectLabel.innerHTML = 'Auto-detect: <em>pick an ONNX file, then click <strong>Analyze model</strong> to probe it.</em>';
          analyzeBtn.disabled = true;
          analyzeBtn.innerHTML = ANALYZE_BTN_HTML;
          return;
        }
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        sizeLabel.textContent = `Model size: ~${sizeMB} MB`;
        if (!labelInput.value.trim()) {
          labelInput.value = file.name.replace(/\.onnx$/i, '');
        }
        const sizeHint = parseFloat(sizeMB) > 50
          ? ' (this model is large — probing may take 30s+)'
          : ' (probing typically takes 5–20s)';
        detectLabel.innerHTML = `Auto-detect: <em>ready — click <strong>Analyze model</strong> to probe the file${sizeHint}.</em>`;
        analyzeBtn.disabled = false;
        analyzeBtn.innerHTML = ANALYZE_BTN_HTML;
      };
      const onAnalyzeClick = () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const seq = ++inspectSeq;
        errorLabel.textContent = '';
        analyzeBtn.disabled = true;
        analyzeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing…';
        saveBtn.disabled = true;
        detectLabel.textContent = 'Auto-detect: starting — running CPU inference probes (no GPU); this can take a while on large models.';
        inspectCustomModelFile(file, {
          onProgress: (message) => {
            if (seq !== inspectSeq || settled) return;
            detectLabel.textContent = `Auto-detect: ${message}`;
          },
        }).then((result) => {
          if (seq !== inspectSeq || settled) return;
          if (Number.isFinite(result?.scale)) {
            scaleInput.value = String(result.scale);
          }
          rangeInput.value = String(result?.range === 255 ? 255 : 1);
          layoutInput.value = result?.layout === 'nhwc' ? 'nhwc' : 'nchw';
          if (Number.isFinite(result?.multipleOf)) {
            multipleInput.value = String(Math.max(1, result.multipleOf));
          }
          maxTileInput.value = Number.isFinite(result?.maxTileSize)
            ? String(result.maxTileSize)
            : '';
          const parts = [];
          if (result?.layout) parts.push(`layout ${result.layout.toUpperCase()}`);
          if (Number.isFinite(result?.multipleOf)) {
            const suffix = result?.multipleOfSource === 'probe' ? ' (probed)' : '';
            parts.push(`multiple ${result.multipleOf}${suffix}`);
          }
          if (Number.isFinite(result?.maxTileSize)) {
            parts.push(`max tile ${result.maxTileSize}\u00d7${result.maxTileSize} (probed)`);
          }
          if (result?.inputType) parts.push(`input ${result.inputType}`);
          if (Number.isFinite(result?.scale)) {
            const suffix = result?.scaleSource === 'probe' ? ' (probed)' : result?.scaleSource === 'metadata' ? ' (metadata)' : ' (default)';
            parts.push(`scale ${result.scale}x${suffix}`);
          }
          detectLabel.textContent = parts.length
            ? `Auto-detected: ${parts.join(', ')}.`
            : 'Auto-detect finished with defaults.';
          if (Array.isArray(result?.notes) && result.notes.length) {
            errorLabel.textContent = result.notes[0];
          }
          analyzeBtn.disabled = false;
          analyzeBtn.innerHTML = '<i class="fas fa-rotate"></i> Re-analyze';
          saveBtn.disabled = false;
        }).catch((err) => {
          if (seq !== inspectSeq || settled) return;
          detectLabel.textContent = 'Auto-detect failed; you can adjust the fields manually and save anyway.';
          errorLabel.textContent = err?.message || 'Could not inspect model metadata.';
          analyzeBtn.disabled = false;
          analyzeBtn.innerHTML = ANALYZE_BTN_HTML;
          saveBtn.disabled = false;
        });
      };
      const onCancel = (e) => {
        e?.preventDefault?.();
        if (dialog.open) dialog.close();
        finish(null);
      };
      const onClose = () => finish(null);
      const onSubmit = async (e) => {
        e.preventDefault();
        errorLabel.textContent = '';
        if (isEdit) {
          saveBtn.disabled = true;
          try {
            const model = updateCustomModelByUrl(editModel.url, {
              label: labelInput.value,
              scale: scaleInput.value,
              range: rangeInput.value,
              layout: layoutInput.value,
              multipleOf: multipleInput.value,
              maxTileSize: maxTileInput.value,
            });
            if (!model) {
              errorLabel.textContent = 'Model not found; it may have been removed.';
              saveBtn.disabled = false;
              return;
            }
            if (dialog.open) dialog.close();
            finish(model);
          } catch (err) {
            errorLabel.textContent = err?.message || 'Failed to update model.';
            saveBtn.disabled = false;
          }
          return;
        }
        const file = fileInput.files?.[0];
        if (!file) {
          errorLabel.textContent = 'Choose an ONNX model file first.';
          return;
        }
        if (!/\.onnx$/i.test(file.name)) {
          errorLabel.textContent = 'Only .onnx files are supported.';
          return;
        }
        saveBtn.disabled = true;
        try {
          const model = await saveCustomModel({
            file,
            label: labelInput.value,
            scale: scaleInput.value,
            range: rangeInput.value,
            layout: layoutInput.value,
            multipleOf: multipleInput.value,
            maxTileSize: maxTileInput.value,
          });
          if (dialog.open) dialog.close();
          finish(model);
        } catch (err) {
          errorLabel.textContent = err?.message || 'Failed to save model.';
          saveBtn.disabled = false;
        }
      };

      form.addEventListener('submit', onSubmit);
      if (!isEdit) {
        fileInput.addEventListener('change', onFileChange);
        analyzeBtn.addEventListener('click', onAnalyzeClick);
      }
      cancelBtn.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onCancel);
      dialog.addEventListener('close', onClose);
      dialog.showModal();
    });
  }

  #render() {
    morph(this, `
      <style>
        .custom-model-upload-dialog dialog {
          width: min(34rem, calc(100vw - 2rem));
        }
        .custom-model-upload-dialog .custom-model-form {
          display: grid;
          gap: 0.6rem;
          margin: 0;
        }
        .custom-model-upload-dialog .custom-model-form label {
          display: grid;
          gap: 0.25rem;
          margin: 0;
          font-size: 0.85rem;
        }
        .custom-model-upload-dialog .custom-model-row {
          display: grid;
          gap: 0.5rem;
          grid-template-columns: minmax(0, 1fr) auto auto auto auto auto;
          align-items: end;
        }
        .custom-model-upload-dialog .custom-model-scale { width: 8ch; }
        .custom-model-upload-dialog .custom-model-range { width: 9ch; }
        .custom-model-upload-dialog .custom-model-layout { width: 9ch; }
        .custom-model-upload-dialog .custom-model-multiple { width: 9ch; }
        .custom-model-upload-dialog .custom-model-maxtile { width: 9ch; }
        @media (max-width: 900px) {
          .custom-model-upload-dialog .custom-model-row {
            grid-template-columns: minmax(0, 1fr) auto auto;
          }
        }
        .custom-model-upload-dialog .custom-model-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.8rem;
          color: var(--pico-muted-color);
        }
        .custom-model-upload-dialog .custom-model-detected {
          font-size: 0.8rem;
          color: var(--pico-muted-color);
        }
        .custom-model-upload-dialog .custom-model-detected em {
          font-style: normal;
          opacity: 0.85;
        }
        .custom-model-upload-dialog .custom-model-analyze-row {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          flex-wrap: wrap;
          margin: -0.3rem 0 0.1rem;
        }
        .custom-model-upload-dialog .custom-model-analyze-btn {
          margin: 0;
          padding: 0.35rem 0.75rem;
          font-size: 0.85rem;
          width: auto;
          flex: 0 0 auto;
        }
        .custom-model-upload-dialog .custom-model-analyze-hint {
          font-size: 0.75rem;
          color: var(--pico-muted-color);
          flex: 1 1 18ch;
          min-width: 0;
        }
        .custom-model-upload-dialog .custom-model-error {
          color: var(--pico-del-color, #c62828);
          min-height: 1.1rem;
          font-size: 0.8rem;
        }
        .custom-model-upload-dialog .custom-model-actions {
          display: flex;
          justify-content: flex-end;
          gap: 0.5rem;
          margin-top: 0.4rem;
        }
      </style>
      <dialog>
        <form class="custom-model-form" method="dialog">
          <h3 class="custom-model-title" style="margin:0">Upload custom ONNX model</h3>
          <label class="custom-model-file-label">
            Model file
            <input class="custom-model-file" type="file" accept=".onnx,application/octet-stream" required>
          </label>
          <div class="custom-model-analyze-row">
            <button type="button" class="secondary custom-model-analyze-btn" disabled>
              <i class="fas fa-flask"></i> Analyze model
            </button>
            <span class="custom-model-analyze-hint">
              Runs CPU inference probes on the ONNX file to auto-fill scale, layout, multiple-of, and max-tile-size. Optional — you can also fill in the fields manually.
            </span>
          </div>
          <div class="custom-model-row">
            <label>
              Label
              <input class="custom-model-label" type="text" maxlength="80" placeholder="My custom model">
            </label>
            <label>
              Scale
              <input class="custom-model-scale" type="number" min="1" max="16" step="1" value="4" required>
            </label>
            <label>
              Range
              <select class="custom-model-range">
                <option value="1">1</option>
                <option value="255">255</option>
              </select>
            </label>
            <label>
              Layout
              <select class="custom-model-layout">
                <option value="nchw">NCHW</option>
                <option value="nhwc">NHWC</option>
              </select>
            </label>
            <label>
              Multiple-of
              <input class="custom-model-multiple" type="number" min="1" max="256" step="1" value="1">
            </label>
            <label title="Hard upper bound on input tile size accepted by the model. Leave blank if the model is fully dynamic.">
              Max tile
              <input class="custom-model-maxtile" type="number" min="1" max="4096" step="1" placeholder="auto">
            </label>
          </div>
          <div class="custom-model-detected">Auto-detect: waiting for model file…</div>
          <div class="custom-model-meta">
            <span class="custom-model-size">Model size: -</span>
          </div>
          <div class="custom-model-error"></div>
          <div class="custom-model-actions">
            <button type="button" class="secondary custom-model-cancel-btn">Cancel</button>
            <button type="submit" class="custom-model-save-btn">Save model</button>
          </div>
        </form>
      </dialog>
    `);
  }
}

customElements.define('custom-model-upload-dialog', CustomModelUploadDialog);
