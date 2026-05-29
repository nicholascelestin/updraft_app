import 'components/image-drop-zone';
import 'components/image-cropper';
import './upscale-preview.js';
import 'components/compare-slider';
import { VIEW_MODE, isViewMode } from 'components/view-mode-controls';

class UpscalerCanvasArea extends HTMLElement {
  #image = null;
  #viewMode = VIEW_MODE.FIT_WIDTH;

  connectedCallback() {
    this.#render();
    this.#wireEvents();
  }

  #q(sel) { return this.querySelector(sel); }

  // ── Public surface ─────────────────────────────────────────────────────

  get image() { return this.#image; }

  get currentCrop() {
    return this.#q('image-cropper')?.crop || null;
  }

  /**
   * Extract the image (cropped or not) to feed the pipeline. Throws if no
   * image is loaded.
   */
  get croppedImage() {
    return this.#q('image-cropper').extractImage();
  }

  get viewMode() { return this.#viewMode; }
  set viewMode(mode) {
    if (!isViewMode(mode)) return;
    if (mode === this.#viewMode) return;
    this.#viewMode = mode;
    this.#applyViewState();
  }

  /**
   * Pick a default mode based on the loaded image's aspect ratio vs. the
   * viewport: fit-width when the image is at least as wide (relative to
   * height) as the viewport, fit-height otherwise.
   */
  defaultModeForImage(image) {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const imgRatio = image.width / image.height;
    const vpRatio = vw / vh;
    return imgRatio >= vpRatio ? VIEW_MODE.FIT_WIDTH : VIEW_MODE.FIT_HEIGHT;
  }

  showInitial() {
    this.#q('image-cropper').hide();
    this.#q('upscale-preview').hide();
    this.#q('compare-slider').hide();
    this.#q('image-drop-zone').show();
  }

  showCropping(image) {
    this.#image = image;
    this.#q('upscale-preview').hide();
    this.#q('compare-slider').hide();
    this.#q('image-drop-zone').hide();
    this.#q('image-cropper').show(image);
  }

  showPreview(image, outW, outH) {
    this.#q('image-cropper').style.display = 'none';
    this.#q('compare-slider').hide();
    this.#q('upscale-preview').showDimmedPreview(image, outW, outH);
  }

  drawPreviewTile(info, opts) {
    this.#q('upscale-preview').drawTile(info, opts);
  }

  async showResult(beforeCanvas, afterCanvas, opts) {
    this.#q('image-cropper').style.display = 'none';
    this.#q('upscale-preview').hide();
    await this.#q('compare-slider').show(beforeCanvas, afterCanvas, opts);
    this.#applyViewState();
  }

  clearCrop() { this.#q('image-cropper').clearCrop(); }
  openInTab() { this.#q('compare-slider').openInTab(); }
  download()  { this.#q('compare-slider').download(); }

  /**
   * Scroll the currently-visible stage into view. Useful after a view-mode
   * change resizes the stage and pushes it offscreen.
   */
  snapCenterVisible() {
    const el = this.#visibleStage();
    if (!el) return;
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const fullyVisible = rect.top >= 0 && rect.bottom <= vh;
      if (fullyVisible) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  // ── Internal ───────────────────────────────────────────────────────────

  #visibleStage() {
    for (const sel of ['compare-slider', 'upscale-preview', 'image-cropper', 'image-drop-zone']) {
      const el = this.#q(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  #applyViewState() {
    const mode = this.#viewMode;
    const isFitHeight = mode === VIEW_MODE.FIT_HEIGHT;
    const isOneToOne = mode === VIEW_MODE.ONE_TO_ONE;
    for (const sel of ['image-cropper', 'upscale-preview', 'compare-slider']) {
      const el = this.#q(sel);
      if (!el) continue;
      el.classList.toggle('expanded', isFitHeight);
      el.classList.toggle('native-size', isOneToOne);
    }
  }

  #wireEvents() {
    // Hold the image reference locally; image-loaded also bubbles up so the
    // orchestrator can react. crop-changed similarly bubbles from the cropper.
    this.#q('image-drop-zone').addEventListener('image-loaded', (e) => {
      this.#image = e.detail.image;
    });
  }

  #render() {
    this.innerHTML = `
      <image-drop-zone></image-drop-zone>
      <image-cropper></image-cropper>
      <upscale-preview></upscale-preview>
      <compare-slider></compare-slider>
    `;
  }
}

customElements.define('upscaler-canvas-area', UpscalerCanvasArea);
