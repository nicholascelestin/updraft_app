/**
 * <video-drop-zone> — file picker + drag-and-drop video loader.
 *
 * Events:
 *   video-loaded  — detail: { file: File, video: HTMLVideoElement, duration, width, height }
 */

import { morph } from '../lib/morph.js';

class VideoDropZone extends HTMLElement {
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
  }

  #handleFile(file) {
    if (!file.type.startsWith('video/')) return;
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;

    video.addEventListener('loadedmetadata', () => {
      // Seek to first frame to ensure videoWidth/Height are available
      video.currentTime = 0;
    });

    video.addEventListener('seeked', () => {
      this.dispatchEvent(new CustomEvent('video-loaded', {
        detail: {
          file,
          video,
          blobUrl: url,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
        },
      }));
    }, { once: true });
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
      <input type="file" accept="video/mp4,video/webm" hidden>
      <div class="drop-zone-area">
        <i class="fas fa-film" style="font-size:1.5rem; display:block; margin-bottom:0.5rem"></i>
        Drop a video file here or click to browse
      </div>
    `);
  }
}

customElements.define('video-drop-zone', VideoDropZone);
