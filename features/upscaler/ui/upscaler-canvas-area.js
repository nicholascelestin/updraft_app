import 'components/image-drop-zone';
import 'components/image-cropper';
import './upscale-preview.js';
import './upscale-result.js';
import { VIEW_MODE, isViewMode } from 'components/view-mode-controls';
import { ZOOM_MIN, ZOOM_MAX } from 'components/zoom-control';

class UpscalerCanvasArea extends HTMLElement {
  #image = null;
  #viewMode = VIEW_MODE.FIT_WIDTH;
  // Explicit numeric zoom factor (1 = native 1:1). null means "follow the
  // discrete view mode" (fit-width / fit-height / 1:1).
  #zoom = null;
  #emitScheduled = false;

  connectedCallback() {
    this.#render();
    this.#wireEvents();
    // The on-screen zoom of the fit modes depends on the viewport, so keep the
    // readout honest across resizes.
    window.addEventListener('resize', this.#onResize);
    // Wheel over the canvas zooms toward the cursor. passive:false so we can
    // suppress the page scroll while a zoomable stage is showing.
    this.addEventListener('wheel', this.#onWheel, { passive: false });
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this.#onResize);
    this.removeEventListener('wheel', this.#onWheel);
  }

  #onResize = () => this.#emitEffectiveZoom();

  #onWheel = (e) => {
    // Only engage when there's something measurable to zoom (a visible canvas);
    // otherwise let the page scroll normally.
    const current = this.#zoom ?? this.getEffectiveZoom();
    if (current == null) return;
    e.preventDefault();
    // Normalise across deltaMode (pixels / lines / pages) so a notch feels the
    // same on a mouse wheel and a trackpad.
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 100;
    const step = Math.exp(-dy * 0.0015);
    this.zoomAround(current * step, e.clientX, e.clientY);
    // Let the orchestrator repaint the zoom button as the active control.
    this.dispatchEvent(new CustomEvent('wheel-zoom', { bubbles: true }));
  };

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
    // Centre the new mode on what was centred before (e.g. 1:1 lands on the
    // middle of the image, not its top-left corner).
    this.#applyViewStatePreservingCenter();
  }

  get zoom() { return this.#zoom; }

  /**
   * Measure the zoom currently on screen (displayed canvas width / its natural
   * pixel width) so a freshly-opened zoom slider can adopt whatever the active
   * view mode is showing without changing it. Returns null when nothing
   * measurable is visible.
   */
  getEffectiveZoom() {
    const canvas = this.#visibleCanvas();
    if (!canvas || !canvas.width) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return null;
    return rect.width / canvas.width;
  }

  /** Apply an explicit zoom factor, overriding the discrete view mode. */
  setZoom(factor) {
    const n = Number(factor);
    if (!Number.isFinite(n)) return;
    this.#zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
    // Grow/shrink around the centred region rather than the top-left corner.
    this.#applyViewStatePreservingCenter();
  }

  /**
   * Apply an explicit zoom factor while keeping the image point under the
   * given viewport coordinates pinned in place -- the natural behaviour for
   * wheel-zoom, where the spot under the cursor shouldn't drift. Falls back to
   * a no-op when nothing measurable is on screen.
   */
  zoomAround(factor, clientX, clientY) {
    const n = Number(factor);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));

    // Record which image-relative point (0..1 within the canvas) sits under
    // the cursor *before* the resize, so we can put it back afterwards.
    const before = this.#visibleCanvas();
    let u = 0.5, v = 0.5;
    if (before) {
      const r = before.getBoundingClientRect();
      if (r.width && r.height) {
        u = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        v = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
      }
    }

    this.#zoom = clamped;
    this.#applyViewState();

    // After the new layout, nudge the stage's scroll so the same image point
    // lands back under the cursor. getBoundingClientRect forces the reflow we
    // need first. When the content now fits (not scrollable) the assignment
    // simply clamps to 0 and the image stays centred -- which is fine.
    const stage = this.#visibleStage();
    const after = this.#visibleCanvas();
    if (stage && after) {
      const r = after.getBoundingClientRect();
      stage.scrollLeft += (r.left + u * r.width) - clientX;
      stage.scrollTop += (r.top + v * r.height) - clientY;
    }
  }

  // Re-apply the view state while keeping whatever was under the visible
  // stage's centre still centred -- shared by zoom and view-mode changes.
  #applyViewStatePreservingCenter() {
    const stage = this.#visibleStage();
    const anchor = stage ? this.#captureScrollCenter(stage) : null;
    this.#applyViewState();
    if (stage && anchor) this.#restoreScrollCenter(stage, anchor);
  }

  // Fraction of the scrollable content that sits under the stage's visual
  // centre, per axis (0.5 == middle). Works whether the page or the stage
  // itself is doing the scrolling.
  #captureScrollCenter(stage) {
    const { scrollWidth: sw, scrollHeight: sh, clientWidth: cw, clientHeight: ch } = stage;
    return {
      x: sw > 0 ? (stage.scrollLeft + cw / 2) / sw : 0.5,
      y: sh > 0 ? (stage.scrollTop + ch / 2) / sh : 0.5,
    };
  }

  // Re-centre on the captured point after the new view state is laid out.
  // Reading scrollWidth/Height forces the reflow we need before scrolling.
  #restoreScrollCenter(stage, anchor) {
    const { scrollWidth: sw, scrollHeight: sh, clientWidth: cw, clientHeight: ch } = stage;
    stage.scrollLeft = anchor.x * sw - cw / 2;
    stage.scrollTop = anchor.y * sh - ch / 2;
  }

  /** Drop back to the discrete view mode (fit-width / fit-height / 1:1). */
  clearZoom() {
    if (this.#zoom == null) return;
    this.#zoom = null;
    this.#applyViewStatePreservingCenter();
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
    this.#q('upscale-result').hide();
    this.#q('image-drop-zone').show();
  }

  showCropping(image) {
    this.#image = image;
    this.#q('upscale-preview').hide();
    this.#q('upscale-result').hide();
    this.#q('image-drop-zone').hide();
    this.#q('image-cropper').show(image);
    this.#emitEffectiveZoom();
  }

  showPreview(image, outW, outH) {
    this.#q('image-cropper').style.display = 'none';
    this.#q('upscale-result').hide();
    this.#q('upscale-preview').showDimmedPreview(image, outW, outH);
    this.#emitEffectiveZoom();
    // Upscale just started -- bring the workspace fully into view, same as the
    // zoom / view-mode buttons do.
    this.snapCenterVisible();
  }

  drawPreviewTile(info, opts) {
    this.#q('upscale-preview').drawTile(info, opts);
  }

  async showResult(beforeCanvas, afterCanvas, opts) {
    // The preview and the result share the same output dimensions, so carry
    // the centred region across so finishing doesn't jump the user's view.
    const from = this.#visibleStage();
    const anchor = from ? this.#captureScrollCenter(from) : null;
    this.#q('image-cropper').style.display = 'none';
    this.#q('upscale-preview').hide();
    await this.#q('upscale-result').show(beforeCanvas, afterCanvas, opts);
    this.#applyViewState();
    if (anchor) this.#restoreScrollCenter(this.#q('upscale-result'), anchor);
  }

  clearCrop() { this.#q('image-cropper').clearCrop(); }
  openInTab() { this.#q('upscale-result').openInTab(); }
  download()  { this.#q('upscale-result').download(); }

  /**
   * Scroll the currently-visible stage into view -- used whenever a change
   * (view mode, zoom, or starting an upscale) may have pushed it offscreen.
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
    for (const sel of ['upscale-result', 'upscale-preview', 'image-cropper', 'image-drop-zone']) {
      const el = this.#q(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  // The drawing surface of whichever stage is on screen. upscale-result has
  // two canvases; the "after" one carries the natural dimensions we measure.
  #visibleCanvas() {
    const stage = this.#visibleStage();
    if (!stage) return null;
    return stage.querySelector('canvas.result-after') || stage.querySelector('canvas');
  }

  #applyViewState() {
    const mode = this.#viewMode;
    const zoomed = this.#zoom != null;
    // An explicit zoom takes over the layout entirely; the discrete modes are
    // suppressed while it's active.
    const isFitHeight = !zoomed && mode === VIEW_MODE.FIT_HEIGHT;
    const isOneToOne = !zoomed && mode === VIEW_MODE.ONE_TO_ONE;
    for (const sel of ['image-cropper', 'upscale-preview', 'upscale-result']) {
      const el = this.#q(sel);
      if (!el) continue;
      el.classList.toggle('expanded', isFitHeight);
      el.classList.toggle('native-size', isOneToOne);
      el.classList.toggle('zoomed', zoomed);
      if (zoomed) el.style.setProperty('--zoom', this.#zoom);
      else el.style.removeProperty('--zoom');
    }
    this.#emitEffectiveZoom();
  }

  /**
   * Report the zoom currently on screen so the toolbar readout can follow it.
   * Coalesced to one measurement per frame; deferred so it runs after the
   * layout class/style changes above have been applied.
   */
  #emitEffectiveZoom() {
    if (this.#emitScheduled) return;
    this.#emitScheduled = true;
    requestAnimationFrame(() => {
      this.#emitScheduled = false;
      const value = this.getEffectiveZoom();
      if (value == null) return;
      this.dispatchEvent(new CustomEvent('effective-zoom-change', {
        bubbles: true, detail: { value },
      }));
    });
  }

  #wireEvents() {
    // Hold the image reference locally; image-loaded also bubbles up so the
    // orchestrator can react. crop-changed similarly bubbles from the cropper.
    this.#q('image-drop-zone').addEventListener('image-loaded', (e) => {
      this.#image = e.detail.image;
      // A new image starts from its default view mode, not a stale zoom.
      this.#zoom = null;
    });
  }

  #render() {
    this.innerHTML = `
      <image-drop-zone></image-drop-zone>
      <image-cropper></image-cropper>
      <upscale-preview></upscale-preview>
      <upscale-result></upscale-result>
    `;
  }
}

customElements.define('upscaler-canvas-area', UpscalerCanvasArea);
