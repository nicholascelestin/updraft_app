/**
 * <image-drop-zone> — file picker + drag-and-drop image loader.
 *
 * Events:
 *   image-loaded  — detail: { image: HTMLImageElement }
 */

import { morph } from 'lib/morph';

class ImageDropZone extends HTMLElement {
  connectedCallback() {
    this.classList.add('drop-zone');
    this.#render();

    this.addEventListener('click', e => {
      if (e.target.closest('.drop-zone-area')) this.querySelector('input[type="file"]').click();
    });
    this.addEventListener('dragover', e => {
      if (e.target.closest('.drop-zone-area')) { e.preventDefault(); e.target.closest('.drop-zone-area').classList.add('dragover'); }
    });
    this.addEventListener('dragleave', e => {
      if (e.target.closest('.drop-zone-area')) e.target.closest('.drop-zone-area').classList.remove('dragover');
    });
    this.addEventListener('drop', e => {
      const area = e.target.closest('.drop-zone-area');
      if (!area) return;
      e.preventDefault();
      area.classList.remove('dragover');
      if (e.dataTransfer.files.length) this.#handleFile(e.dataTransfer.files[0]);
    });
    this.addEventListener('change', e => {
      if (e.target.matches('input[type="file"]') && e.target.files.length) this.#handleFile(e.target.files[0]);
    });
    document.addEventListener('paste', e => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          this.#handleFile(item.getAsFile());
          return;
        }
      }
    });
  }

  #handleFile(file) {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        this.dispatchEvent(new CustomEvent('image-loaded', { bubbles: true, detail: { image: img } }));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  show() {
    this.style.display = '';
    const input = this.querySelector('input[type="file"]');
    if (input) input.value = '';
  }
  hide() { this.style.display = 'none'; }

  #render() {
    morph(this, `
      <style>
        .drop-zone .drop-zone-area {
          border: 2px dashed var(--pico-muted-border-color, #444);
          border-radius: 8px; padding: 3rem; text-align: center;
          color: var(--pico-muted-color, #666); font-size: 0.9rem;
          cursor: pointer; transition: border-color 0.2s;
        }
        .drop-zone .drop-zone-area.dragover {
          border-color: var(--pico-primary, #4c8);
          color: var(--pico-primary, #4c8);
        }
      </style>
      <input type="file" accept="image/*" hidden>
      <div class="drop-zone-area">
        <i class="fas fa-cloud-upload-alt" style="font-size:1.5rem; display:block; margin-bottom:0.5rem"></i>
        Drop an image here, paste from clipboard, or click to browse
      </div>
    `);
  }
}

customElements.define('image-drop-zone', ImageDropZone);
