/**
 * <i2v-app> — RunPod Image-to-Video generation feature.
 * Wraps API key inputs, prompt, image upload, job submission,
 * polling, and video playback into a single web component.
 */

import { morph } from '../../lib/morph.js';
import '../../components/image-drop-zone.js';
import '../../components/status-bar.js';

/**
 * Submit a RunPod job and poll until completion.
 * @param {{ baseUrl: string, apiKey: string, input: object, onStatus?: (msg: string) => void, pollInterval?: number }} opts
 * @returns {Promise<{ id: string, output: object }>}
 */
async function runpodRun({ baseUrl, apiKey, input, onStatus, pollInterval = 3000 }) {
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };

  onStatus?.('Submitting job\u2026');
  const runRes = await fetch(`${baseUrl}/run`, { method: 'POST', headers, body: JSON.stringify({ input }) });
  if (!runRes.ok) throw new Error(`Submit failed: ${runRes.status} ${await runRes.text()}`);
  const { id } = await runRes.json();

  onStatus?.(`Job submitted: ${id}. Polling for result\u2026`);

  while (true) {
    await new Promise(r => setTimeout(r, pollInterval));
    const pollRes = await fetch(`${baseUrl}/status/${id}`, { headers });
    if (!pollRes.ok) throw new Error(`Poll failed: ${pollRes.status}`);
    const data = await pollRes.json();

    if (data.status === 'COMPLETED') return { id, output: data.output };
    if (data.status === 'FAILED') throw new Error('Job failed: ' + JSON.stringify(data.error || data));
    onStatus?.(`Job ${id} \u2014 Status: ${data.status}\u2026`);
  }
}

class I2vApp extends HTMLElement {
  #imageBase64 = null;
  #lastJobId = null;
  #lastBlobUrl = null;

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
    const dropZone   = this.#q('image-drop-zone');
    const submitBtn  = this.#q('.submit-btn');
    const refetchBtn = this.#q('.refetch-btn');
    const statusBar  = this.#q('status-bar');

    statusBar.message = 'Provide an image and prompt, then generate.';

    // Image loaded via shared drop zone
    dropZone.addEventListener('image-loaded', (e) => {
      const img = e.detail.image;
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      this.#imageBase64 = c.toDataURL('image/png');

      const preview = this.#q('.preview-img');
      preview.src = this.#imageBase64;
      preview.style.display = 'block';
      dropZone.hide();

      statusBar.message = `Image loaded (${img.width}\u00d7${img.height}) \u2014 ready to generate.`;
    });

    // Submit
    submitBtn.addEventListener('click', () => this.#submit());

    // Re-fetch
    refetchBtn.addEventListener('click', () => this.#refetch());

    // Click preview image to re-show drop zone
    this.addEventListener('click', (e) => {
      if (e.target.closest('.preview-img')) {
        this.#q('.preview-img').style.display = 'none';
        dropZone.show();
      }
    });
  }

  #showStatus(msg, indeterminate = false) {
    const statusBar = this.#q('status-bar');
    statusBar.message = msg;
    if (indeterminate) {
      statusBar.showIndeterminate();
    } else {
      statusBar.hideProgress();
    }
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

    try {
      const { id, output } = await runpodRun({
        baseUrl: `https://api.runpod.ai/v2/${endpointId}`,
        apiKey,
        input,
        onStatus: (msg) => this.#showStatus(msg, true),
      });
      this.#lastJobId = id;
      this.#displayVideo(output);
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

    this.#showStatus(`Re-fetching job ${this.#lastJobId}\u2026`, true);
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
    let videoData = result?.video || this.#findUrl(result);

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
    this.#showStatus('Done!' + (meta.length ? ' \u2014 ' + meta.join(', ') : ''));
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
        i2v-app .preview-img {
          display: none; max-width: 100%; max-height: 240px;
          border-radius: 4px; margin-bottom: 1rem; cursor: pointer;
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
        i2v-app .result-video {
          margin-top: 1rem; width: 100%;
          border-radius: 8px;
        }
      </style>

      <h2><i class="fas fa-video"></i> Image to Video</h2>

      <label for="i2v-apikey"><i class="fas fa-key"></i> API Key</label>
      <input type="password" class="api-key" id="i2v-apikey" placeholder="Your RunPod API key">

      <label for="i2v-endpoint"><i class="fas fa-server"></i> Endpoint ID</label>
      <input type="text" class="endpoint" id="i2v-endpoint" placeholder="e.g. knvf1hcsntpmob">

      <label for="i2v-prompt"><i class="fas fa-pen"></i> Prompt</label>
      <textarea class="prompt-input" id="i2v-prompt" placeholder="Describe the motion you want..." rows="3"></textarea>

      <label><i class="fas fa-image"></i> Input Image</label>
      <image-drop-zone></image-drop-zone>
      <img class="preview-img">

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

      <status-bar></status-bar>
      <video class="result-video" controls style="display:none"></video>
      <a class="download-link" style="display:none; margin-top:0.5rem; cursor:pointer">
        <i class="fas fa-download"></i> Download Video
      </a>
    `);
  }
}

customElements.define('i2v-app', I2vApp);
