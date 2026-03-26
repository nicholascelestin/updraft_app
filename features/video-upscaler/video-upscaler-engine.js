/**
 * VideoUpscalerEngine — extracts frames from a video, upscales each via
 * Pipeline, and encodes the result into an MP4 via WebCodecs + mp4-muxer.
 *
 * Audio is intentionally dropped.
 */

const MP4_MUXER_CDN = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs';

function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Video seek failed')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = time;
  });
}

function waitForPresentedFrame(video, timeoutMs = 150) {
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(settle, timeoutMs);
    video.requestVideoFrameCallback(() => settle());
  });
}

/**
 * Pick an H.264 High-profile codec string with a level that supports
 * the given output resolution and frame rate.
 */
function pickH264Codec(width, height, fps) {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbPerSec = macroblocks * fps;

  const levels = [
    { level: '1e', mb: 1620,   mbps: 48600,   hex: '640028' },
    { level: '4.1', mb: 8192,   mbps: 245760,  hex: '640029' },
    { level: '4.2', mb: 8704,   mbps: 522240,  hex: '64002a' },
    { level: '5.0', mb: 22080,  mbps: 589824,  hex: '640032' },
    { level: '5.1', mb: 36864,  mbps: 983040,  hex: '640033' },
    { level: '5.2', mb: 36864,  mbps: 2073600, hex: '640034' },
    { level: '6.0', mb: 139264, mbps: 4177920, hex: '64003c' },
  ];

  for (const l of levels) {
    if (macroblocks <= l.mb && mbPerSec <= l.mbps) {
      return 'avc1.' + l.hex;
    }
  }
  return 'avc1.64003c';
}

export class VideoUpscalerEngine {
  #pipeline;
  #config;
  #fps;
  #outputScale;

  /**
   * @param {object} opts
   * @param {import('../upscaler/upscale-pipeline.js').Pipeline} opts.pipeline
   * @param {object} opts.config — { modelUrl, scale, modelValueRange, tileSize, backend }
   * @param {number} [opts.fps=30]
   * @param {number} [opts.outputScale] — defaults to config.scale (no downscale)
   */
  constructor({ pipeline, config, fps = 30, outputScale }) {
    this.#pipeline = pipeline;
    this.#config = config;
    this.#fps = fps;
    this.#outputScale = outputScale ?? config.scale;
  }

  /**
   * Process a loaded <video> element end-to-end.
   *
   * @param {HTMLVideoElement} video — must have metadata loaded
   * @param {object} callbacks
   * @param {function} callbacks.onModelProgress  — (frac, msg)
   * @param {function} callbacks.onFrameProgress  — (frameIndex, totalFrames, phase)
   * @param {AbortSignal} [callbacks.signal]
   * @returns {Promise<{ blob: Blob, frameCount: number, outputWidth: number, outputHeight: number }>}
   */
  async process(video, { onModelProgress, onFrameProgress, signal } = {}) {
    if (typeof VideoEncoder === 'undefined') {
      throw new Error('WebCodecs API is not available in this browser. Please use Chrome or Edge.');
    }

    await this.#pipeline.warmup(this.#config, { onProgress: onModelProgress });

    const { Muxer, ArrayBufferTarget } = await import(/* webpackIgnore: true */ MP4_MUXER_CDN);

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const scale = this.#config.scale;
    const outW = srcW * this.#outputScale;
    const outH = srcH * this.#outputScale;
    const needsDownscale = this.#outputScale < scale;
    const duration = video.duration;
    const fps = this.#fps;
    const totalFrames = Math.floor(duration * fps);

    if (totalFrames === 0) throw new Error('Video has no frames (duration may be zero).');

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: outW, height: outH },
      fastStart: 'in-memory',
    });

    const codecString = pickH264Codec(outW, outH, fps);
    const pixels = outW * outH;
    const bitrate = Math.max(4_000_000, Math.min(pixels * 8, 50_000_000));

    const encoderConfig = {
      codec: codecString,
      width: outW,
      height: outH,
      bitrate,
      framerate: fps,
    };

    const support = await VideoEncoder.isConfigSupported(encoderConfig);
    if (!support.supported) {
      throw new Error(
        `VideoEncoder does not support ${outW}\u00d7${outH} H.264 encoding in this browser. ` +
        'Try a smaller source video or lower scale.'
      );
    }

    let encodeError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encodeError = e; },
    });
    encoder.configure(support.config);

    const frameDurationMicros = 1_000_000 / fps;

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) {
        if (encoder.state !== 'closed') encoder.close();
        throw new DOMException('Video upscale cancelled', 'AbortError');
      }
      if (encodeError) {
        if (encoder.state !== 'closed') encoder.close();
        throw encodeError;
      }

      const time = i / fps;
      onFrameProgress?.(i, totalFrames, 'extracting');

      await seekTo(video, time);
      await waitForPresentedFrame(video);

      onFrameProgress?.(i, totalFrames, 'upscaling');
      const { image: upscaledCanvas } = await this.#pipeline.run(video, this.#config, { signal });

      let encodeCanvas = upscaledCanvas;
      if (needsDownscale) {
        encodeCanvas = document.createElement('canvas');
        encodeCanvas.width = outW;
        encodeCanvas.height = outH;
        const dsCtx = encodeCanvas.getContext('2d');
        dsCtx.imageSmoothingEnabled = true;
        dsCtx.imageSmoothingQuality = 'high';
        dsCtx.drawImage(upscaledCanvas, 0, 0, outW, outH);
      }

      onFrameProgress?.(i, totalFrames, 'encoding');
      const timestamp = Math.round(i * frameDurationMicros);
      const videoFrame = new VideoFrame(encodeCanvas, { timestamp });
      const keyFrame = i % (fps * 2) === 0;

      if (encoder.state !== 'configured') {
        videoFrame.close();
        throw new Error('VideoEncoder entered an unexpected state: ' + encoder.state);
      }

      encoder.encode(videoFrame, { keyFrame });
      videoFrame.close();

      upscaledCanvas.width = 0;
      upscaledCanvas.height = 0;
      if (needsDownscale) { encodeCanvas.width = 0; encodeCanvas.height = 0; }

      await new Promise(r => setTimeout(r, 0));
    }

    onFrameProgress?.(totalFrames, totalFrames, 'finalizing');
    if (encoder.state === 'configured') await encoder.flush();
    if (encoder.state !== 'closed') encoder.close();
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    return { blob, frameCount: totalFrames, outputWidth: outW, outputHeight: outH };
  }
}
