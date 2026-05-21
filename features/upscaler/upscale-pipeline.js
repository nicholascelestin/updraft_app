/**
 * Step-based upscale pipeline — unified processing for image and video upscaling.
 * Only the Pipeline class is exported; everything else is module-private.
 */

import { UpscalerEngine } from './engine/upscaler-engine.js';
import { FaceDetectorEngine } from './engine/face-detector-engine.js';
import {
  expandRect,
  cropToCanvas,
  compositeFeathered,
  computeFeatherPx,
  ensureCanvas,
  blendCanvas,
} from 'lib/canvas';
import { buildTileGrid } from './engine/tiling.js';

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

  getUpscaler(tag, { modelUrl, scale, modelValueRange, modelLayout = 'nchw', modelInputMultiple = 1, modelPrecision = 'fp32', upscaleBefore = false, tileBlend = 'overlapCrop', profile = false }) {
    // Backend isn't a construction-time parameter — the engine's loadModel
    // handles intent transitions internally (release session, load new). The
    // pool's identity is purely the things the engine can't change after the
    // fact: model URL, layout, precision, tile-blend strategy.
    const slot = this.#slots.get(tag);
    if (
      slot &&
      slot.modelUrl === modelUrl &&
      slot.modelLayout === modelLayout &&
      slot.modelInputMultiple === modelInputMultiple &&
      slot.modelPrecision === modelPrecision &&
      slot.upscaleBefore === upscaleBefore &&
      slot.tileBlend === tileBlend
    ) {
      slot.engine.profiling = profile;
      return slot.engine;
    }
    this.#evict(tag);
    const engine = new UpscalerEngine({ modelUrl, scale, modelValueRange, modelLayout, modelInputMultiple, modelPrecision, upscaleBefore, tileBlend, profile });
    this.#slots.set(tag, { engine, modelUrl, modelLayout, modelInputMultiple, modelPrecision, upscaleBefore, tileBlend });
    return engine;
  }

  getDetector(tag) {
    // Backend transitions are handled inside FaceDetectorEngine.loadModel;
    // the pool just returns the persistent engine instance.
    let slot = this.#slots.get(tag);
    if (slot) return slot.engine;
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
    const { modelUrl, scale, modelValueRange, modelLayout, modelInputMultiple, modelPrecision, upscaleBefore, tileBlend, backend, tileSize, profile } = ctx.config;
    const engine = ctx.pool.getUpscaler('base', {
      modelUrl,
      scale,
      modelValueRange,
      modelLayout,
      modelInputMultiple,
      modelPrecision,
      upscaleBefore,
      tileBlend,
      backend,
      profile,
    });
    emitStage(cb, 'tiledUpscale', 'loading', { message: 'Loading base model…' });
    const tLoad = performance.now();
    await engine.loadModel(backend, (frac, msg) => {
      cb.onProgress?.(frac, msg);
      emitStage(cb, 'tiledUpscale', 'loading', { progress: frac, message: msg });
    });
    const modelLoadMs = Number((performance.now() - tLoad).toFixed(1));
    emitStage(cb, 'tiledUpscale', 'running', { message: 'Running base upscale pass…' });
    const { canvas, perf, ortProfile } = await engine.upscale(ctx.image, tileSize, {
      onTile: (info) => cb.onTile?.({ ...info, step: 'tiledUpscale' }),
      signal: cb.signal,
    });
    return {
      ...ctx,
      image: canvas,
      scale: engine.scale,
      perf,
      ortProfile,
      stepPerf: { ...(ctx.stepPerf || {}), tiledUpscale: { ...perf, modelLoadMs } },
    };
  },
};

const comparisonStep = {
  name: 'comparison',
  shouldRun: (ctx) => !!ctx.config.comparison,
  async run(ctx, cb) {
    const { comparison, backend, tileSize } = ctx.config;
    const passBackend = comparison.backend || backend;
    const engine = ctx.pool.getUpscaler('comparison-upscaler', {
      modelUrl: comparison.modelUrl,
      scale: comparison.scale,
      modelValueRange: comparison.modelValueRange,
      modelLayout: comparison.modelLayout,
      modelInputMultiple: comparison.modelInputMultiple,
      modelPrecision: comparison.modelPrecision,
      upscaleBefore: comparison.upscaleBefore,
      tileBlend: comparison.tileBlend,
      backend: passBackend,
    });
    emitStage(cb, 'comparison', 'loading', { message: 'Loading comparison model…' });
    const tLoad = performance.now();
    await engine.loadModel(passBackend, (progress, message) => {
      emitStage(cb, 'comparison', 'loading', { progress, message });
    });
    const modelLoadMs = Number((performance.now() - tLoad).toFixed(1));
    emitStage(cb, 'comparison', 'running', { message: 'Running comparison upscale pass…' });

    const { canvas, perf } = await engine.upscale(ctx.source, tileSize, {
      onTile: (info) => cb.onTile?.({ ...info, step: 'comparison' }),
      signal: cb.signal,
    });
    return {
      ...ctx,
      comparisonImage: canvas,
      stepPerf: { ...(ctx.stepPerf || {}), comparison: { ...perf, modelLoadMs } },
    };
  },
};

const blendAllStep = {
  name: 'blendAll',
  shouldRun: (ctx) => !!ctx.config.all,
  async run(ctx, cb) {
    const { all, backend, tileSize } = ctx.config;
    const passBackend = all.backend || backend;
    const engine = ctx.pool.getUpscaler('all-upscaler', {
      modelUrl: all.modelUrl,
      scale: all.scale,
      modelValueRange: all.modelValueRange,
      modelLayout: all.modelLayout,
      modelInputMultiple: all.modelInputMultiple,
      modelPrecision: all.modelPrecision,
      upscaleBefore: all.upscaleBefore,
      tileBlend: all.tileBlend,
      backend: passBackend,
    });
    emitStage(cb, 'blendAll', 'loading', { message: 'Loading all-pass model…' });
    const tLoad = performance.now();
    await engine.loadModel(passBackend, (progress, message) => {
      emitStage(cb, 'blendAll', 'loading', { progress, message });
    });
    const modelLoadMs = Number((performance.now() - tLoad).toFixed(1));
    emitStage(cb, 'blendAll', 'running', { message: 'Running all-pass tiled blend…' });

    const { canvas: overlayRaw, perf } = await engine.upscale(ctx.source, tileSize, {
      onTile: (info) => cb.onTile?.({ ...info, step: 'blendAll' }),
      signal: cb.signal,
    });
    let baseCanvas = ensureCanvas(ctx.image);
    let overlayCanvas = overlayRaw;
    if (overlayRaw.width !== baseCanvas.width || overlayRaw.height !== baseCanvas.height) {
      overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = baseCanvas.width;
      overlayCanvas.height = baseCanvas.height;
      overlayCanvas.getContext('2d').drawImage(overlayRaw, 0, 0, baseCanvas.width, baseCanvas.height);
    }
    baseCanvas = blendCanvas(baseCanvas, overlayCanvas, all.blendOpacity);
    return {
      ...ctx,
      image: baseCanvas,
      stepPerf: { ...(ctx.stepPerf || {}), blendAll: { ...perf, modelLoadMs } },
    };
  },
};

const detectFacesStep = {
  name: 'detectFaces',
  shouldRun: (ctx) => !!ctx.config.face,
  async run(ctx, cb) {
    const { backend, face } = ctx.config;
    const detector = ctx.pool.getDetector('face-detector');
    emitStage(cb, 'detectFaces', 'loading', { message: 'Loading face detector…' });
    const tLoad = performance.now();
    await detector.loadModel('face-yunet', backend, (progress, message) => {
      emitStage(cb, 'detectFaces', 'loading', { progress, message });
    });
    const modelLoadMs = Number((performance.now() - tLoad).toFixed(1));
    emitStage(cb, 'detectFaces', 'running', { message: 'Detecting faces…' });
    const tDetect = performance.now();
    const faces = await detector.detectFaces(ctx.source, {
      detectorKey: 'face-yunet',
      scoreThreshold: face.scoreThreshold,
      signal: cb.signal,
    });
    const detectPerf = {
      modelLoadMs,
      total: performance.now() - tDetect,
      detections: faces.length,
    };
    emitStage(cb, 'detectFaces', 'running', { message: `Detected ${faces.length} face(s).` });
    return {
      ...ctx,
      detections: { ...ctx.detections, face: faces },
      stepPerf: { ...(ctx.stepPerf || {}), detectFaces: detectPerf },
    };
  },
};

const enhanceFacesStep = {
  name: 'enhanceFaces',
  shouldRun: (ctx) => ctx.detections.face?.length > 0,
  async run(ctx, cb) {
    const { face, backend } = ctx.config;
    const faceBackend = face.backend || backend;
    const { source, scale } = ctx;

    let canvas = ensureCanvas(ctx.image);

    const engine = ctx.pool.getUpscaler('face-upscaler', {
      modelUrl: face.modelUrl,
      scale: face.scale,
      modelValueRange: face.modelValueRange,
      modelLayout: face.modelLayout,
      modelInputMultiple: face.modelInputMultiple,
      modelPrecision: face.modelPrecision,
      upscaleBefore: face.upscaleBefore,
      tileBlend: face.tileBlend,
      backend: faceBackend,
    });
    emitStage(cb, 'enhanceFaces', 'loading', { message: 'Loading face enhancer model…' });
    const tLoad = performance.now();
    await engine.loadModel(faceBackend, (progress, message) => {
      emitStage(cb, 'enhanceFaces', 'loading', { progress, message });
    });
    const modelLoadMs = Number((performance.now() - tLoad).toFixed(1));
    emitStage(cb, 'enhanceFaces', 'running', { message: 'Enhancing detected faces…' });

    const srcW = source.naturalWidth ?? source.width;
    const srcH = source.naturalHeight ?? source.height;
    const faces = ctx.detections.face || [];
    const configuredFaceTileSize = Number.isFinite(face.tileSize) ? face.tileSize : ctx.config.tileSize;
    const agg = {
      setup: 0, extract: 0, inference: 0, inferenceEstimated: 0, readback: 0, gpuRender: 0, writeTile: 0, dispose: 0, total: 0, tiles: 0, modelLoadMs,
    };

    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const det = faces[faceIndex];
      if (cb.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      emitStage(cb, 'enhanceFaces', 'running', {
        message: `Enhancing face ${faceIndex + 1}/${faces.length}…`,
      });

      const roi = expandRect(det, face.paddingPx, srcW, srcH);
      if (roi.w < 1 || roi.h < 1) continue;

      const crop = cropToCanvas(source, roi);
      if (!crop) continue;

      const maxTileForRoi = Math.max(1, Math.min(roi.w, roi.h));
      const requestedTileSize = Number.isFinite(configuredFaceTileSize) ? configuredFaceTileSize : 192;
      // Honor selected tile size for face patches so large faces are not over-tiled.
      const tileSize = requestedTileSize <= 0
        ? 0
        : Math.min(maxTileForRoi, Math.max(64, requestedTileSize));
      const faceTileTotal = buildTileGrid(roi.w, roi.h, tileSize, 16).length;
      const { canvas: patchRaw, perf } = await engine.upscale(crop, tileSize, {
        onTile: (info) => cb.onTile?.({
          ...info,
          step: 'enhanceFaces',
          faceIndex,
          faceTotal: faces.length,
          faceTileTotal,
        }),
        signal: cb.signal,
      });
      agg.setup += perf.setup;
      agg.extract += perf.extract;
      agg.inference += perf.inference;
      agg.inferenceEstimated += perf.inferenceEstimated || 0;
      agg.readback += perf.readback;
      agg.gpuRender += perf.gpuRender;
      agg.writeTile += perf.writeTile;
      agg.dispose += perf.dispose;
      agg.total += perf.total;
      agg.tiles += perf.tiles;

      const tw = roi.w * scale;
      const th = roi.h * scale;
      const patch = document.createElement('canvas');
      patch.width = tw;
      patch.height = th;
      const pctx = patch.getContext('2d');
      pctx.imageSmoothingEnabled = true;
      pctx.imageSmoothingQuality = 'high';
      pctx.drawImage(patchRaw, 0, 0, tw, th);

      const roiOutX = roi.x * scale;
      const roiOutY = roi.y * scale;
      compositeFeathered(canvas, patch, roiOutX, roiOutY, {
        featherPx: computeFeatherPx({
          configuredFeatherPx: face.featherPx ?? 16,
          regionW: det.w, regionH: det.h,
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

      cb.onTile?.({
        canvas,
        outX: roiOutX,
        outY: roiOutY,
        outW: tw,
        outH: th,
        step: 'enhanceFaces',
        faceIndex,
        faceTotal: faces.length,
        composited: true,
        index: faceIndex,
        total: faces.length,
      });

      crop.width = crop.height = 0;
      patch.width = patch.height = 0;
      patchRaw.width = patchRaw.height = 0;
    }

    return { ...ctx, image: canvas, stepPerf: { ...(ctx.stepPerf || {}), enhanceFaces: agg } };
  },
};

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

const STEPS = [tiledUpscaleStep, comparisonStep, blendAllStep, detectFacesStep, enhanceFacesStep];

function getImageSize(image) {
  if (!image) return null;
  const width = image.naturalWidth ?? image.videoWidth ?? image.width ?? 0;
  const height = image.naturalHeight ?? image.videoHeight ?? image.height ?? 0;
  return width > 0 && height > 0 ? `${width}x${height}` : null;
}

function logStep(event, stepName, details = {}) {
  console.debug(`[UpscalePipeline] ${event} ${stepName}`, details);
}

function emitStage(cb, step, phase, details = {}) {
  cb.onStage?.({ step, phase, ...details });
}

const UPSCALE_PERF_KEYS = [
  'setup',
  'extract',
  'inference',
  'inferenceEstimated',
  'readback',
  'gpuRender',
  'writeTile',
  'dispose',
];

function getImageDims(image) {
  return {
    width: image?.naturalWidth ?? image?.videoWidth ?? image?.width ?? 0,
    height: image?.naturalHeight ?? image?.videoHeight ?? image?.height ?? 0,
  };
}

function looksLikeUpscalePerf(perf) {
  return perf && typeof perf === 'object' && (
    Number.isFinite(perf.inference) ||
    Number.isFinite(perf.setup) ||
    Number.isFinite(perf.gpuRender)
  );
}

function aggregateSessionPerf(stepPerf, ctx, input, config, totalMs) {
  const src = getImageDims(input);
  const out = getImageDims(ctx.image);
  const session = {
    setup: 0,
    extract: 0,
    inference: 0,
    inferenceEstimated: 0,
    readback: 0,
    gpuRender: 0,
    writeTile: 0,
    dispose: 0,
    modelLoad: 0,
    total: totalMs,
    tiles: 0,
    tileSize: Number.isFinite(config.tileSize) ? config.tileSize : 0,
    srcW: src.width,
    srcH: src.height,
    outW: out.width,
    outH: out.height,
    pipeline: config.backend === 'webgpu' ? 'gpu' : 'cpu',
  };

  for (const { perf } of Object.values(stepPerf)) {
    if (!perf) continue;
    if (Number.isFinite(perf.modelLoadMs)) session.modelLoad += perf.modelLoadMs;
    if (!looksLikeUpscalePerf(perf)) continue;
    if (Number.isFinite(perf.tiles)) session.tiles += perf.tiles;
    if (perf.pipeline === 'gpu-gpu') session.pipeline = 'gpu-gpu';
    else if (perf.pipeline === 'gpu' && session.pipeline !== 'gpu-gpu') session.pipeline = 'gpu';
    for (const key of UPSCALE_PERF_KEYS) {
      if (Number.isFinite(perf[key])) session[key] += perf[key];
    }
  }

  return session;
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
  const stepPerf = {};
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
      emitStage(cb, step.name, 'skip');
      continue;
    }
    const tStep = performance.now();
    emitStage(cb, step.name, 'start');
    logStep('start', step.name);
    try {
      ctx = await step.run(ctx, cb);
      const durationMs = Number((performance.now() - tStep).toFixed(1));
      stepPerf[step.name] = {
        durationMs,
        ...(ctx.stepPerf?.[step.name] ? { perf: ctx.stepPerf[step.name] } : {}),
      };
      emitStage(cb, step.name, 'done', { durationMs });
      logStep('done', step.name, {
        durationMs,
        output: getImageSize(ctx.image),
      });
    } catch (error) {
      emitStage(cb, step.name, 'error', { message: error?.message || String(error) });
      console.warn(`[UpscalePipeline] failed ${step.name}`, error);
      throw error;
    }
  }
  const totalMs = Number((performance.now() - tPipeline).toFixed(1));
  emitStage(cb, 'pipeline', 'done', { durationMs: totalMs });
  logStep('done', 'pipeline', {
    durationMs: totalMs,
    output: getImageSize(ctx.image),
  });
  const sessionPerf = aggregateSessionPerf(stepPerf, ctx, input, config, totalMs);
  return { ...ctx, perf: sessionPerf, pipelinePerf: { totalMs, steps: stepPerf } };
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
    const { modelUrl, scale, modelValueRange, modelLayout, modelInputMultiple, modelPrecision, upscaleBefore, tileBlend, backend, profile } = config;
    const engine = this.#pool.getUpscaler('base', {
      modelUrl,
      scale,
      modelValueRange,
      modelLayout,
      modelInputMultiple,
      modelPrecision,
      upscaleBefore,
      tileBlend,
      backend,
      profile,
    });
    await engine.loadModel(backend, onProgress);
  }

  destroy() {
    this.#pool.destroyAll();
  }
}
