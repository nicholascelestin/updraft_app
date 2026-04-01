/**
 * Step-based upscale pipeline — unified processing for image and video upscaling.
 * Only the Pipeline class is exported; everything else is module-private.
 */

import { UpscalerEngine } from './upscaler-engine.js';
import { FaceDetectorEngine } from './face-detector-engine.js';
import {
  expandRect,
  cropToCanvas,
  compositeFeathered,
  computeFaceFeatherPx,
} from './face-enhance.js';

// ---------------------------------------------------------------------------
// Engine pool — caches engines by tag, recreates when config diverges.
// ---------------------------------------------------------------------------

class EnginePool {
  #slots = new Map();

  #evict(tag) {
    const slot = this.#slots.get(tag);
    if (!slot) return;
    this.#slots.delete(tag);
    (slot.engine.destroy ?? slot.engine.release)?.call(slot.engine);
  }

  getUpscaler(tag, { modelUrl, scale, modelValueRange, backend, profile = false }) {
    const slot = this.#slots.get(tag);
    if (slot && slot.modelUrl === modelUrl) {
      const backendOk = !slot.engine.activeBackend || slot.engine.activeBackend === backend;
      if (backendOk) {
        slot.engine.profiling = profile;
        return slot.engine;
      }
    }
    this.#evict(tag);
    const engine = new UpscalerEngine({ modelUrl, scale, modelValueRange, profile });
    this.#slots.set(tag, { engine, modelUrl });
    return engine;
  }

  getDetector(tag, backend) {
    const slot = this.#slots.get(tag);
    if (slot) {
      const backendOk = !slot.engine.activeBackend || slot.engine.activeBackend === backend;
      if (backendOk) return slot.engine;
    }
    this.#evict(tag);
    const engine = new FaceDetectorEngine();
    this.#slots.set(tag, { engine });
    return engine;
  }

  destroyAll() {
    for (const { engine } of this.#slots.values()) {
      (engine.destroy ?? engine.release)?.call(engine);
    }
    this.#slots.clear();
  }
}

// ---------------------------------------------------------------------------
// Steps — { name, shouldRun?(ctx), run(ctx, cb) → ctx }
// ---------------------------------------------------------------------------

const tiledUpscaleStep = {
  name: 'tiledUpscale',
  async run(ctx, cb) {
    const { modelUrl, scale, modelValueRange, backend, tileSize, profile } = ctx.config;
    const engine = ctx.pool.getUpscaler('base', { modelUrl, scale, modelValueRange, backend, profile });
    await engine.loadModel(backend, cb.onProgress);
    const { canvas, perf, ortProfile } = await engine.upscale(ctx.image, tileSize, {
      onTile: cb.onTile,
      signal: cb.signal,
    });
    return { ...ctx, image: canvas, scale: engine.scale, perf, ortProfile };
  },
};

const detectFacesStep = {
  name: 'detectFaces',
  shouldRun: (ctx) => !!ctx.config.face,
  async run(ctx, cb) {
    const { backend, face } = ctx.config;
    const detector = ctx.pool.getDetector('face-detector', backend);
    await detector.loadModel('face-yunet', backend);
    const faces = await detector.detectFaces(ctx.source, {
      detectorKey: 'face-yunet',
      scoreThreshold: face.scoreThreshold,
      signal: cb.signal,
    });
    return { ...ctx, detections: { ...ctx.detections, face: faces } };
  },
};

const enhanceFacesStep = {
  name: 'enhanceFaces',
  shouldRun: (ctx) => ctx.detections.face?.length > 0,
  async run(ctx, cb) {
    const { face, backend } = ctx.config;
    const faceBackend = face.backend || backend;
    const { source, scale } = ctx;

    let canvas = ctx.image;
    if (!canvas.getContext?.('2d')) {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext('2d').drawImage(canvas, 0, 0);
      canvas = copy;
    }

    const engine = ctx.pool.getUpscaler('face-upscaler', {
      modelUrl: face.modelUrl,
      scale: face.scale,
      modelValueRange: face.modelValueRange,
      backend: faceBackend,
    });
    await engine.loadModel(faceBackend);

    const srcW = source.naturalWidth ?? source.width;
    const srcH = source.naturalHeight ?? source.height;

    for (const det of ctx.detections.face) {
      if (cb.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      const roi = expandRect(det, face.paddingPx, srcW, srcH);
      if (roi.w < 1 || roi.h < 1) continue;

      const crop = cropToCanvas(source, roi);
      if (!crop) continue;

      const tileSize = Math.min(192, Math.max(64, Math.min(roi.w, roi.h)));
      const { canvas: patchRaw } = await engine.upscale(crop, tileSize, { signal: cb.signal });

      const tw = roi.w * scale;
      const th = roi.h * scale;
      const patch = document.createElement('canvas');
      patch.width = tw;
      patch.height = th;
      const pctx = patch.getContext('2d');
      pctx.imageSmoothingEnabled = true;
      pctx.imageSmoothingQuality = 'high';
      pctx.drawImage(patchRaw, 0, 0, tw, th);

      compositeFeathered(canvas, patch, roi.x * scale, roi.y * scale, {
        featherPx: computeFaceFeatherPx({
          configuredFeatherPx: face.featherPx ?? 16,
          faceW: det.w, faceH: det.h,
          patchW: tw, patchH: th,
          paddingPx: face.paddingPx,
          scale,
        }),
        innerRect: {
          x: Math.max(0, (det.x - roi.x) * scale),
          y: Math.max(0, (det.y - roi.y) * scale),
          w: Math.max(1, det.w * scale),
          h: Math.max(1, det.h * scale),
        },
        blendOpacity: face.blendOpacity,
      });

      crop.width = crop.height = 0;
      patch.width = patch.height = 0;
      patchRaw.width = patchRaw.height = 0;
    }

    return { ...ctx, image: canvas };
  },
};

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

const STEPS = [tiledUpscaleStep, detectFacesStep, enhanceFacesStep];

function getImageSize(image) {
  if (!image) return null;
  const width = image.naturalWidth ?? image.videoWidth ?? image.width ?? 0;
  const height = image.naturalHeight ?? image.videoHeight ?? image.height ?? 0;
  return width > 0 && height > 0 ? `${width}x${height}` : null;
}

function logStep(event, stepName, details = {}) {
  console.debug(`[UpscalePipeline] ${event} ${stepName}`, details);
}

async function runSteps(steps, pool, input, config, cb = {}) {
  let ctx = {
    image: input,
    source: input,
    scale: 1,
    detections: {},
    perf: null,
    ortProfile: null,
    config,
    pool,
  };
  const tPipeline = performance.now();
  logStep('start', 'pipeline', {
    steps: steps.length,
    input: getImageSize(input),
    backend: config.backend,
    tileSize: config.tileSize,
  });
  for (const step of steps) {
    if (cb.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (step.shouldRun && !step.shouldRun(ctx)) {
      logStep('skip', step.name);
      continue;
    }
    const tStep = performance.now();
    logStep('start', step.name);
    try {
      ctx = await step.run(ctx, cb);
      logStep('done', step.name, {
        durationMs: Number((performance.now() - tStep).toFixed(1)),
        output: getImageSize(ctx.image),
      });
    } catch (error) {
      console.warn(`[UpscalePipeline] failed ${step.name}`, error);
      throw error;
    }
  }
  logStep('done', 'pipeline', {
    durationMs: Number((performance.now() - tPipeline).toFixed(1)),
    output: getImageSize(ctx.image),
  });
  return ctx;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class Pipeline {
  #pool = new EnginePool();

  async run(input, config, callbacks) {
    return runSteps(STEPS, this.#pool, input, config, callbacks);
  }

  async warmup(config, { onProgress } = {}) {
    const { modelUrl, scale, modelValueRange, backend, profile } = config;
    const engine = this.#pool.getUpscaler('base', { modelUrl, scale, modelValueRange, backend, profile });
    await engine.loadModel(backend, onProgress);
  }

  destroy() {
    this.#pool.destroyAll();
  }
}
