/**
 * RunPodEngine — sends images to a RunPod serverless endpoint for upscaling.
 */

const POLL_INTERVAL_MS = 2000;

export class RunPodEngine {
  #baseUrl;
  #apiKey;
  #scale;

  constructor({ endpointId, apiKey, scale = 4 }) {
    if (endpointId.startsWith('https://')) {
      this.#baseUrl = endpointId.replace(/\/(run|runsync)\/?$/, '');
    } else {
      this.#baseUrl = `https://api.runpod.ai/v2/${endpointId}`;
    }
    this.#apiKey = apiKey;
    this.#scale = scale;
  }

  get scale() { return this.#scale; }

  async upscale(image, onStatus, signal) {
    const imageBase64 = this.#imageToBase64(image);

    onStatus?.('Submitting to RunPod...');

    const submitResp = await fetch(
      `${this.#baseUrl}/run`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: {
            image: imageBase64,
            output_format: 'png',
          },
        }),
        signal,
      },
    );

    if (!submitResp.ok) {
      const text = await submitResp.text();
      throw new Error(`RunPod submit failed (HTTP ${submitResp.status}): ${text}`);
    }

    const { id } = await submitResp.json();
    onStatus?.('Waiting for RunPod worker...');

    while (true) {
      if (signal?.aborted) throw new DOMException('Upscale cancelled', 'AbortError');

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const statusResp = await fetch(
        `${this.#baseUrl}/status/${id}`,
        {
          headers: { 'Authorization': `Bearer ${this.#apiKey}` },
          signal,
        },
      );

      if (!statusResp.ok) {
        throw new Error(`RunPod status check failed (HTTP ${statusResp.status})`);
      }

      const statusData = await statusResp.json();

      if (statusData.status === 'COMPLETED') {
        onStatus?.('Processing result...');
        return this.#decodeResult(statusData.output);
      }

      if (statusData.status === 'FAILED') {
        throw new Error(`RunPod job failed: ${JSON.stringify(statusData.error || statusData)}`);
      }

      onStatus?.(`RunPod status: ${statusData.status}...`);
    }
  }

  #imageToBase64(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.replace(/^data:image\/\w+;base64,/, '');
  }

  async #decodeResult(output) {
    const base64 = output.image;
    if (!base64) throw new Error('RunPod output missing "image" field');

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Failed to decode upscaled image'));
      img.src = `data:image/png;base64,${base64}`;
    });

    if (output.upscaled_size) {
      this.#scale = Math.round(output.upscaled_size[0] / (output.original_size?.[0] || img.width / 4));
    }

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return canvas;
  }
}
