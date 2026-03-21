/**
 * <i2v-app> — RunPod Image-to-Video generation feature.
 * Self-contained web component wrapping API key inputs, prompt,
 * image upload, job submission, polling, and video playback.
 */

import { morph } from '../../lib/morph.js';

class I2vApp extends HTMLElement {
  #imageBase64 = null;
  #lastJobId = null;
  #lastBlobUrl = null;

  // Backend defaults
  static DEFAULTS = {
    num_frames: 97,
    num_inference_steps: 40,
    guidance_scale: 4.0,
    fps: 24,
    negative_prompt: 'worst quality, inconsistent motion, blurry, jittery, distorted',
  };

  connectedCallback() {
    this.#render();
    this.#setupEvents();

    // Restore persisted settings
    const savedKey = localStorage.getItem('i2v_api_key');
    if (savedKey) this.#q('.api-key').value = savedKey;
    const savedEndpoint = localStorage.getItem('i2v_endpoint');
    if (savedEndpoint) this.#q('.endpoint').value = savedEndpoint;
  }

  #q(sel) { return this.querySelector(sel); }

  #setupEvents() {
    const fileDrop  = this.#q('.file-drop');
    const fileInput = this.#q('.file-input');
    const submitBtn = this.#q('.submit-btn');
    const refetchBtn = this.#q('.refetch-btn');

    // File drop / click
    fileDrop.addEventListener('click', () => fileInput.click());
    fileDrop.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('dragover'); });
    fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('dragover'));
    fileDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      fileDrop.classList.remove('dragover');
      if (e.dataTransfer.files.length) this.#handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) this.#handleFile(fileInput.files[0]);
    });

    // Submit
    submitBtn.addEventListener('click', () => this.#submit());

    // Re-fetch
    refetchBtn.addEventListener('click', () => this.#refetch());
  }

  #handleFile(file) {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.#imageBase64 = e.target.result;
      this.#q('.file-label').textContent = file.name;
      let img = this.#q('.file-drop img');
      if (!img) {
        img = document.createElement('img');
        this.#q('.file-drop').appendChild(img);
      }
      img.src = this.#imageBase64;
    };
    reader.readAsDataURL(file);
  }

  #showStatus(msg) {
    const el = this.#q('.status-output');
    el.style.display = 'block';
    el.innerHTML = msg;
  }

  async #submit() {
    const apiKey = this.#q('.api-key').value.trim();
    const endpointId = this.#q('.endpoint').value.trim();
    const prompt = this.#q('.prompt-input').value.trim();

    if (!apiKey) return this.#showStatus('Please enter your API key.');
    if (!endpointId) return this.#showStatus('Please enter an endpoint ID.');
    if (!this.#imageBase64) return this.#showStatus('Please provide an input image (required).');

    localStorage.setItem('i2v_api_key', apiKey);
    localStorage.setItem('i2v_endpoint', endpointId);

    const btn = this.#q('.submit-btn');
    btn.disabled = true;
    this.#q('.result-video').style.display = 'none';

    const D = I2vApp.DEFAULTS;
    const input = {
      image: this.#imageBase64.replace(/^data:image\/[^;]+;base64,/, ''),
      prompt,
      num_frames: parseInt(this.#q('.num-frames').value) || D.num_frames,
      num_inference_steps: parseInt(this.#q('.num-steps').value) || D.num_inference_steps,
      guidance_scale: parseFloat(this.#q('.guidance-scale').value) || D.guidance_scale,
      fps: parseInt(this.#q('.fps').value) || D.fps,
      negative_prompt: this.#q('.negative-prompt').value || D.negative_prompt,
    };

    const widthVal = parseInt(this.#q('.out-width').value);
    const heightVal = parseInt(this.#q('.out-height').value);
    if (widthVal) input.width = widthVal;
    if (heightVal) input.height = heightVal;

    const seedVal = this.#q('.seed').value.trim();
    if (seedVal) input.seed = parseInt(seedVal);

    const runUrl = `https://api.runpod.ai/v2/${endpointId}/run`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };

    this.#showStatus('<span class="spinner"></span> Submitting job...');

    try {
      const runRes = await fetch(runUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input }),
      });
      if (!runRes.ok) throw new Error(`Submit failed: ${runRes.status} ${await runRes.text()}`);
      const runData = await runRes.json();
      const jobId = runData.id;
      this.#lastJobId = jobId;
      this.#showStatus(`<span class="spinner"></span> Job submitted: ${jobId}<br>Polling for result...`);

      const statusUrl = `https://api.runpod.ai/v2/${endpointId}/status/${jobId}`;
      while (true) {
        await new Promise((r) => setTimeout(r, 3000));
        const pollRes = await fetch(statusUrl, { headers });
        if (!pollRes.ok) throw new Error(`Poll failed: ${pollRes.status}`);
        const pollData = await pollRes.json();
        const st = pollData.status;

        if (st === 'COMPLETED') {
          this.#displayVideo(pollData.output);
          break;
        } else if (st === 'FAILED') {
          throw new Error('Job failed: ' + JSON.stringify(pollData.error || pollData));
        } else {
          this.#showStatus(`<span class="spinner"></span> Job ${jobId}<br>Status: ${st}...`);
        }
      }
    } catch (err) {
      this.#showStatus('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      if (this.#lastJobId) this.#q('.refetch-btn').style.display = 'block';
    }
  }

  async #refetch() {
    if (!this.#lastJobId) return;
    const apiKey = this.#q('.api-key').value.trim();
    const endpointId = this.#q('.endpoint').value.trim();
    if (!apiKey || !endpointId) return this.#showStatus('Need API key and endpoint to re-fetch.');

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    const statusUrl = `https://api.runpod.ai/v2/${endpointId}/status/${this.#lastJobId}`;

    this.#showStatus(`<span class="spinner"></span> Re-fetching job ${this.#lastJobId}...`);
    this.#q('.refetch-btn').disabled = true;

    try {
      const res = await fetch(statusUrl, { headers });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const data = await res.json();

      if (data.status === 'COMPLETED') {
        this.#displayVideo(data.output);
      } else {
        this.#showStatus(`Job ${this.#lastJobId} status: ${data.status}`);
      }
    } catch (err) {
      this.#showStatus('Re-fetch error: ' + err.message);
    } finally {
      this.#q('.refetch-btn').disabled = false;
    }
  }

  #displayVideo(result) {
    if (this.#lastBlobUrl) { URL.revokeObjectURL(this.#lastBlobUrl); this.#lastBlobUrl = null; }

    const video = this.#q('.result-video');
    const dl = this.#q('.download-link');
    let videoData = null;

    if (result && result.video) {
      videoData = result.video;
    } else {
      videoData = this.#findUrl(result);
    }

    if (!videoData) {
      this.#showStatus('Done! Output (no video found):\n' + JSON.stringify(result, null, 2));
      return;
    }

    if (videoData.startsWith('data:') || !videoData.startsWith('http')) {
      this.#lastBlobUrl = this.#base64ToBlobUrl(videoData);
      video.src = this.#lastBlobUrl;
    } else {
      video.src = videoData;
    }

    video.style.display = 'block';
    video.load();
    dl.href = video.src;
    dl.download = 'runpod-video.mp4';
    dl.style.display = 'inline-block';

    const meta = [];
    if (result.seed != null) meta.push(`Seed: ${result.seed}`);
    if (result.num_frames) meta.push(`${result.num_frames} frames`);
    if (result.fps) meta.push(`${result.fps} fps`);
    if (result.width && result.height) meta.push(`${result.width}x${result.height}`);
    if (result.duration_seconds) meta.push(`${result.duration_seconds}s`);
    this.#showStatus('Done!' + (meta.length ? ' — ' + meta.join(', ') : ''));
  }

  #base64ToBlobUrl(b64, mimeType = 'video/mp4') {
    const raw = b64.replace(/^data:[^;]+;base64,/, '');
    const bytes = atob(raw);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const blob = new Blob([arr], { type: mimeType });
    return URL.createObjectURL(blob);
  }

  #findUrl(obj) {
    if (!obj) return null;
    if (typeof obj === 'string' && (obj.startsWith('http://') || obj.startsWith('https://'))) return obj;
    if (typeof obj === 'object') {
      for (const v of Object.values(obj)) {
        const found = this.#findUrl(v);
        if (found) return found;
      }
    }
    return null;
  }

  #render() {
    morph(this, `
      <style>
        i2v-app { display: block; max-width: 640px; }
        i2v-app label { display: block; font-size: 0.85rem; margin-bottom: 0.3rem; }
        i2v-app .file-drop {
          border: 2px dashed var(--pico-muted-border-color, #333);
          border-radius: 8px; padding: 1.5rem; text-align: center;
          cursor: pointer; margin-bottom: 1rem;
          transition: border-color 0.2s;
        }
        i2v-app .file-drop:hover,
        i2v-app .file-drop.dragover {
          border-color: var(--pico-primary);
        }
        i2v-app .file-drop img {
          max-width: 100%; max-height: 240px;
          border-radius: 4px; margin-top: 0.5rem;
        }
        i2v-app .param-details {
          margin-bottom: 1rem;
        }
        i2v-app .param-details summary {
          cursor: pointer; font-size: 0.9rem; margin-bottom: 0.75rem;
        }
        i2v-app .param-grid {
          display: grid; grid-template-columns: 1fr 1fr;
          gap: 0.5rem 1rem;
        }
        i2v-app .param-grid input {
          margin-bottom: 0;
        }
        i2v-app .param-grid label {
          margin-bottom: 0.15rem;
        }
        i2v-app .param-grid label small {
          color: var(--pico-muted-color, #888);
        }
        i2v-app .status-output {
          display: none; margin-top: 1.5rem; padding: 1rem;
          background: var(--pico-card-background-color, #1a1a1a);
          border-radius: 8px; font-size: 0.9rem;
          white-space: pre-wrap; word-break: break-all;
        }
        i2v-app .result-video {
          margin-top: 1rem; width: 100%;
          border-radius: 8px;
        }
        i2v-app .spinner {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid var(--pico-muted-border-color, #555);
          border-top-color: var(--pico-primary);
          border-radius: 50%;
          animation: i2v-spin 0.8s linear infinite;
          vertical-align: middle; margin-right: 0.4rem;
        }
        @keyframes i2v-spin { to { transform: rotate(360deg); } }
      </style>

      <h2><i class="fas fa-video"></i> Image to Video</h2>

      <label for="i2v-apikey"><i class="fas fa-key"></i> API Key</label>
      <input type="password" class="api-key" id="i2v-apikey" placeholder="Your RunPod API key">

      <label for="i2v-endpoint"><i class="fas fa-server"></i> Endpoint ID</label>
      <input type="text" class="endpoint" id="i2v-endpoint" placeholder="e.g. knvf1hcsntpmob">

      <label for="i2v-prompt"><i class="fas fa-pen"></i> Prompt</label>
      <textarea class="prompt-input" id="i2v-prompt" placeholder="Describe the motion you want..." rows="3"></textarea>

      <label><i class="fas fa-image"></i> Input Image</label>
      <div class="file-drop">
        <span class="file-label">
          <i class="fas fa-cloud-upload-alt"></i> Click or drag an image here
        </span>
      </div>
      <input type="file" class="file-input" accept="image/*" hidden>

      <details class="param-details">
        <summary><i class="fas fa-sliders-h"></i> Generation Parameters</summary>
        <div class="param-grid">
          <div>
            <label for="i2v-frames">Frames <small>(8n+1, default 97)</small></label>
            <input type="number" class="num-frames" id="i2v-frames" value="97" min="9" step="8">
          </div>
          <div>
            <label for="i2v-steps">Inference Steps <small>(default 40)</small></label>
            <input type="number" class="num-steps" id="i2v-steps" value="40" min="1" max="100">
          </div>
          <div>
            <label for="i2v-guidance">Guidance Scale <small>(default 4.0)</small></label>
            <input type="number" class="guidance-scale" id="i2v-guidance" value="4.0" min="0" max="20" step="0.5">
          </div>
          <div>
            <label for="i2v-fps">FPS <small>(default 24)</small></label>
            <input type="number" class="fps" id="i2v-fps" value="24" min="1" max="60">
          </div>
          <div>
            <label for="i2v-width">Width <small>(blank = auto)</small></label>
            <input type="number" class="out-width" id="i2v-width" placeholder="auto" min="32" step="32">
          </div>
          <div>
            <label for="i2v-height">Height <small>(blank = auto)</small></label>
            <input type="number" class="out-height" id="i2v-height" placeholder="auto" min="32" step="32">
          </div>
          <div>
            <label for="i2v-seed">Seed <small>(blank = random)</small></label>
            <input type="number" class="seed" id="i2v-seed" placeholder="random">
          </div>
        </div>
        <label for="i2v-neg">Negative Prompt</label>
        <textarea class="negative-prompt" id="i2v-neg" rows="2">worst quality, inconsistent motion, blurry, jittery, distorted</textarea>
      </details>

      <button class="submit-btn">
        <i class="fas fa-play"></i> Generate Video
      </button>
      <button class="refetch-btn secondary" style="display:none; margin-top:0.5rem">
        <i class="fas fa-sync"></i> Re-fetch Last Result
      </button>

      <div class="status-output"></div>
      <video class="result-video" controls style="display:none"></video>
      <a class="download-link" style="display:none; margin-top:0.5rem; cursor:pointer">
        <i class="fas fa-download"></i> Download Video
      </a>
    `);
  }
}

customElements.define('i2v-app', I2vApp);
