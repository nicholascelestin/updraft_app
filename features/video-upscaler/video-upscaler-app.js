/**
 * <video-upscaler-app> — orchestrates the video upscaler feature.
 * Accepts an MP4 video, upscales every frame via ONNX, and outputs a new MP4.
 */

import { morph } from 'lib/morph';
import { modelOptionsHTML } from '../upscaler/model-registry.js';
import { Pipeline } from '../upscaler/upscale-pipeline.js';
import 'components/video-drop-zone';
import 'components/status-bar';
import { VideoUpscalerEngine } from './video-upscaler-engine.js';

class VideoUpscalerApp extends HTMLElement {
  #videoInfo = null;   // { file, video, blobUrl, duration, width, height }
  #running = false;
  #abortController = null;
  #resultBlobUrl = null;
  #pipeline = new Pipeline();

  connectedCallback() {
    this.#render();
    this.#setupEvents();
    this.#restoreSettings();
  }

  #q(sel) { return this.querySelector(sel); }

  #setupEvents() {
    const modelEl    = this.#q('.model-select');
    const tileSizeEl = this.#q('.tilesize-select');
    const backendEl  = this.#q('.backend-select');
    const fpsEl      = this.#q('.fps-select');
    const outputEl   = this.#q('.output-select');
    const upscaleBtn = this.#q('.upscale-btn');
    const stopBtn    = this.#q('.stop-btn');
    const startOverBtn = this.#q('.startover-btn');
    const statusBar  = this.#q('status-bar');
    const dropZone   = this.#q('video-drop-zone');
    // Persist settings on change
    modelEl.addEventListener('change', () => localStorage.setItem('video_upscaler_model', modelEl.value));
    tileSizeEl.addEventListener('change', () => localStorage.setItem('video_upscaler_tilesize', tileSizeEl.value));
    backendEl.addEventListener('change', () => localStorage.setItem('video_upscaler_backend', backendEl.value));
    fpsEl.addEventListener('change', () => localStorage.setItem('video_upscaler_fps', fpsEl.value));
    outputEl.addEventListener('change', () => localStorage.setItem('video_upscaler_output', outputEl.value));


    statusBar.message = 'Load a video to begin.';

    // Check WebCodecs support
    if (typeof VideoEncoder === 'undefined') {
      statusBar.message = 'WebCodecs API not available — use Chrome or Edge.';
    }

    // Reset helper
    const resetToStart = () => {
      if (this.#videoInfo?.blobUrl) URL.revokeObjectURL(this.#videoInfo.blobUrl);
      if (this.#resultBlobUrl) URL.revokeObjectURL(this.#resultBlobUrl);
      this.#videoInfo = null;
      this.#running = false;
      this.#resultBlobUrl = null;
      upscaleBtn.disabled = true;
      stopBtn.style.display = 'none';
      startOverBtn.style.display = 'none';
      this.#q('.video-info').style.display = 'none';
      this.#q('.result-area').style.display = 'none';
      dropZone.show();
      statusBar.message = 'Load a video to begin.';
      statusBar.hideProgress();
    };

    // Video loaded
    dropZone.addEventListener('video-loaded', (e) => {
      if (this.#videoInfo?.blobUrl) URL.revokeObjectURL(this.#videoInfo.blobUrl);
      this.#videoInfo = e.detail;
      upscaleBtn.disabled = false;
      startOverBtn.style.display = 'inline-block';
      dropZone.hide();
      this.#q('.result-area').style.display = 'none';

      const { width, height, duration } = this.#videoInfo;
      const info = this.#q('.video-info');
      info.style.display = 'block';
      info.textContent = `${width}\u00d7${height}, ${duration.toFixed(1)}s`;

      statusBar.message = `Video loaded \u2014 ${width}\u00d7${height}, ${duration.toFixed(1)}s \u2014 ready to upscale.`;
      statusBar.hideProgress();
    });

    // Upscale button
    upscaleBtn.addEventListener('click', async () => {
      if (this.#running || !this.#videoInfo) return;
      this.#running = true;
      this.#abortController = new AbortController();
      upscaleBtn.disabled = true;
      stopBtn.style.display = 'inline-block';
      startOverBtn.style.display = 'none';
      this.#q('.result-area').style.display = 'none';
      if (this.#resultBlobUrl) { URL.revokeObjectURL(this.#resultBlobUrl); this.#resultBlobUrl = null; }

      const selectedModel = modelEl.selectedOptions[0];
      const modelUrl = selectedModel.value;
      const scale = parseInt(selectedModel.dataset.scale, 10);
      const modelValueRange = parseInt(selectedModel.dataset.range, 10) || 1;
      const tileSize = parseInt(tileSizeEl.value, 10);
      const backend = selectedModel.dataset.backend || backendEl.value;
      const fps = parseInt(fpsEl.value, 10);
      const outputScale = parseInt(outputEl.value, 10);

      const engine = new VideoUpscalerEngine({
        pipeline: this.#pipeline,
        config: { modelUrl, scale, modelValueRange, tileSize, backend },
        fps,
        outputScale,
      });

      const { width, height } = this.#videoInfo;
      const outW = width * outputScale;
      const outH = height * outputScale;

      try {
        statusBar.showProgress(0);
        const t0 = performance.now();

        const result = await engine.process(this.#videoInfo.video, {
          onModelProgress(frac, msg) {
            statusBar.showProgress(frac);
            statusBar.message = msg;
          },
          onFrameProgress(frame, total, phase) {
            const frac = (frame + (phase === 'encoding' ? 0.9 : phase === 'upscaling' ? 0.5 : 0)) / total;
            statusBar.showProgress(frac);
            const phaseLabel = phase === 'extracting' ? 'Extracting' : phase === 'upscaling' ? 'Upscaling' : phase === 'encoding' ? 'Encoding' : 'Finalizing';
            statusBar.message = `${phaseLabel} frame ${frame + 1} / ${total} \u2014 ${width}\u00d7${height} \u2192 ${outW}\u00d7${outH}`;
          },
          signal: this.#abortController.signal,
        });

        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        statusBar.hideProgress();
        statusBar.message = `Done \u2014 ${result.frameCount} frames, ${outW}\u00d7${outH}, ${elapsed}s total.`;

        // Show result
        this.#resultBlobUrl = URL.createObjectURL(result.blob);
        const resultArea = this.#q('.result-area');
        resultArea.style.display = 'block';

        const resultVideo = this.#q('.result-video');
        resultVideo.src = this.#resultBlobUrl;
        resultVideo.style.maxWidth = Math.min(outW, 960) + 'px';

        const dlBtn = this.#q('.download-btn');
        dlBtn.href = this.#resultBlobUrl;
        dlBtn.download = `upscaled_${outputScale}x.mp4`;

      } catch (e) {
        if (e.name === 'AbortError') {
          statusBar.message = 'Video upscale cancelled.';
        } else {
          console.error(e);
          statusBar.message = 'Error: ' + e.message;
        }
        statusBar.hideProgress();
      }

      this.#running = false;
      this.#abortController = null;
      stopBtn.style.display = 'none';
      startOverBtn.style.display = 'inline-block';
      upscaleBtn.disabled = false;
    });

    // Stop
    stopBtn.addEventListener('click', () => {
      this.#abortController?.abort();
    });

    // Start over
    startOverBtn.addEventListener('click', () => {
      if (this.#running) this.#abortController?.abort();
      resetToStart();
    });
  }

  #restoreSettings() {
    const controls = [
      ['.model-select', 'video_upscaler_model'],
      ['.tilesize-select', 'video_upscaler_tilesize'],
      ['.backend-select', 'video_upscaler_backend'],
      ['.fps-select', 'video_upscaler_fps'],
      ['.output-select', 'video_upscaler_output'],
    ];
    for (const [sel, key] of controls) {
      const saved = localStorage.getItem(key);
      if (saved !== null) this.#q(sel).value = saved;
    }
  }

  #render() {
    morph(this, `
      <style>
        video-upscaler-app .controls {
          display: flex; flex-wrap: wrap; gap: 0.4rem 0.75rem;
          align-items: center; margin-bottom: 1rem;
        }
        video-upscaler-app .controls label {
          display: inline-flex; align-items: center; gap: 0.35rem;
          font-size: 0.85rem; margin-bottom: 0; white-space: nowrap;
        }
        video-upscaler-app .controls select {
          margin-bottom: 0; padding: 0.3rem 0.5rem;
          font-size: 0.85rem; width: auto;
        }
        video-upscaler-app .controls button {
          margin-bottom: 0; padding: 0.4rem 0.8rem;
          font-size: 0.85rem; width: auto;
        }
        video-upscaler-app .video-info {
          display: none;
          font-size: 0.85rem;
          color: var(--pico-muted-color);
          margin-bottom: 0.5rem;
        }
        video-upscaler-app .result-area {
          display: none;
          margin-top: 1rem;
        }
        video-upscaler-app .result-video {
          display: block; width: 100%;
          border: 1px solid var(--pico-muted-border-color, #333);
          border-radius: var(--pico-border-radius, 4px);
          background: #000;
        }
        video-upscaler-app .result-toolbar {
          display: flex; gap: 0.5rem; margin-top: 0.5rem;
        }
        video-upscaler-app .result-toolbar a {
          font-size: 0.85rem;
        }
      </style>

      <h2><i class="fas fa-film"></i> Video Upscaler</h2>

      <div class="controls">
        <label>Model:
          <select class="model-select">
              ${modelOptionsHTML()}
          </select>
        </label>
        <label>Tile size:
          <select class="tilesize-select">
            <option value="64">64</option>
            <option value="128">128</option>
            <option value="192" selected>192</option>
            <option value="256">256</option>
            <option value="384">384</option>
            <option value="512">512</option>
            <option value="768">768</option>
            <option value="1024">1024</option>
            <option value="0">Full frame (no tiling)</option>
          </select>
        </label>
        <label>Backend:
          <select class="backend-select">
            <option value="webgpu">WebGPU</option>
            <option value="webgl">WebGL</option>
            <option value="wasm">WASM</option>
          </select>
        </label>
        <label>FPS:
          <select class="fps-select">
            <option value="24">24</option>
            <option value="25">25</option>
            <option value="30" selected>30</option>
            <option value="60">60</option>
          </select>
        </label>
        <label>Final Output:
          <select class="output-select">
            <option value="1">1x</option>
            <option value="2" selected>2x</option>
            <option value="3">3x</option>
            <option value="4">4x (no downscale)</option>
          </select>
        </label>

        <button class="upscale-btn" disabled>
          <i class="fas fa-wand-magic-sparkles"></i> Upscale 4x
        </button>
        <button class="stop-btn secondary" style="display:none">
          <i class="fas fa-stop"></i> Stop
        </button>
        <button class="startover-btn secondary outline" style="display:none">
          <i class="fas fa-redo"></i> Start Over
        </button>
      </div>

      <div class="video-info"></div>
      <status-bar></status-bar>
      <video-drop-zone></video-drop-zone>

      <div class="result-area">
        <video class="result-video" controls loop muted autoplay></video>
        <div class="result-toolbar">
          <a class="download-btn" role="button">
            <i class="fas fa-download"></i> Download MP4
          </a>
        </div>
      </div>
    `);
  }
}

customElements.define('video-upscaler-app', VideoUpscalerApp);
