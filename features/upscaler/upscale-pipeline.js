// Step-based upscale pipeline. Only Pipeline is exported; the rest is private.

import { UpscalerEngine } from './engine/upscaler-engine.js';
import { FaceDetectorEngine } from './engine/face-detector-engine.js';
import {
  expandRect,
  cropToCanvas,
  compositeFeathered,
  computeFeatherPx,
  ensureCanvas,
  blendCanvas,
  matchColorToReference,
  hasTransparency,
  applyAlphaMask,
} from 'lib/canvas';
import { buildTileGrid } from './engine/tiling.js';

// ---------------------------------------------------------------------------
// Tile-size constraints. Some models cap input size (e.g. DAT exports with
// baked-in window counts); some require a fixed input size (multipleOf ===
// maxTileSize). Aggregating across the base model + enabled passes gives the
// effective bounds for one run. Exported for controls' dropdown disabler.
// ---------------------------------------------------------------------------

export function tileSizeBounds(models) {
  const floors = models.filter((m) => m?.hasFixedInputSize).map((m) => m.maxTileSize);
  const caps = models
    .map((m) => m?.maxTileSize)
    .filter((v) => Number.isFinite(v) && v >= 1);
  return {
    floor: floors.length ? Math.max(...floors) : 0,
    cap: caps.length ? Math.min(...caps) : Infinity,
  };
}

export function computeEffectiveTileSize(models, requested) {
  const { floor, cap } = tileSizeBounds(models);
  let size = requested;
  if (floor > 0 && size > 0 && size < floor) size = floor;
  if (cap < Infinity && (size <= 0 || size > cap)) size = cap;
  return size;
}

// ---------------------------------------------------------------------------
// Engine pool — caches engines by tag, recreates when the SRModel changes.
// Identity is enough: SRModels are immutable per URL, and SRModelStore replaces
// the instance on update, so `slot.model === model` correctly detects both
// "different model" and "same URL but edited custom record".
// ---------------------------------------------------------------------------

class EnginePool {
  #slots = new Map();

  #evict(tag) {
    const slot = this.#slots.get(tag);
    if (!slot) return;
    this.#slots.delete(tag);
    (slot.engine.destroy ?? slot.engine.release)?.call(slot.engine);
  }

  getUpscaler(tag, model, { profile = false } = {}) {
    const slot = this.#slots.get(tag);
    if (slot && slot.model === model) {
      slot.engine.profiling = profile;
      return slot.engine;
    }
    this.#evict(tag);
    const engine = new UpscalerEngine(model, { profile });
    this.#slots.set(tag, { engine, model });
    return engine;
  }

  getDetector(tag) {
    const slot = this.#slots.get(tag);
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
    const { model, backend, tileSize, profile } = ctx.config;
    const engine = ctx.pool.getUpscaler('base', model, { profile });
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
    const engine = ctx.pool.getUpscaler('comparison-upscaler', comparison.model);
    emitStage(cb, 'comparison', 'loading', { message: 'Loading comparison model…' });
    const tLoad = performance.now();
    await engine.loadModel(backend, (progress, message) => {
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
    const engine = ctx.pool.getUpscaler('all-upscaler', all.model);
    emitStage(cb, 'blendAll', 'loading', { message: 'Loading all-pass model…' });
    const tLoad = performance.now();
    await engine.loadModel(backend, (progress, message) => {
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
    const { source, scale } = ctx;

    let canvas = ensureCanvas(ctx.image);

    const engine = ctx.pool.getUpscaler('face-upscaler', face.model);
    emitStage(cb, 'enhanceFaces', 'loading', { message: 'Loading face enhancer model…' });
    const tLoad = performance.now();
    await engine.loadModel(backend, (progress, message) => {
      emitStage(cb, 'enhanceFaces', 'loading', { progress, message });
    });
    const modelLoadMs = Number((performance.now() - tLoad).toFixed(1));
    emitStage(cb, 'enhanceFaces', 'running', { message: 'Enhancing detected faces…' });

    const srcW = source.naturalWidth ?? source.width;
    const srcH = source.naturalHeight ?? source.height;
    const faces = ctx.detections.face || [];
    const configuredFaceTileSize = Number.isFinite(face.tileSize) ? face.tileSize : ctx.config.tileSize;
    const agg = {
      setup: 0, extract: 0, inference: 0, inferenceEstimated: 0, readback: 0,
      gpuRender: 0, writeTile: 0, dispose: 0, total: 0, tiles: 0, modelLoadMs,
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
      // Honor selected tile size for face patches so large faces aren't over-tiled.
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

// Runs last so it corrects the final composited result (and the comparison
// pass, when present), matching the result's tone -- color, brightness, and
// contrast -- back to the reference. The reference is always the original LR
// input, which the pipeline carries on ctx.source untouched.
const colorMatchStep = {
  name: 'colorMatch',
  shouldRun: (ctx) => !!ctx.config.colorMatch,
  async run(ctx, cb) {
    emitStage(cb, 'colorMatch', 'running', { message: 'Matching tone to input…' });
    const t = performance.now();
    const opts = { matchContrast: true };
    const image = matchColorToReference(ensureCanvas(ctx.image), ctx.source, opts);
    let comparisonImage = ctx.comparisonImage;
    if (comparisonImage) {
      comparisonImage = matchColorToReference(ensureCanvas(comparisonImage), ctx.source, opts);
    }
    return {
      ...ctx,
      image,
      comparisonImage,
      stepPerf: {
        ...(ctx.stepPerf || {}),
        colorMatch: { total: Number((performance.now() - t).toFixed(1)) },
      },
    };
  },
};

// Runs dead last so it masks the fully-composited result (every prior pass
// emits an opaque canvas because the SR models are RGB-only). Transparent
// regions of the original input are restored to transparent in the output,
// rather than showing whatever RGB the model hallucinated underneath. Skipped
// entirely for opaque inputs. ctx.source is the untouched original input.
const restoreAlphaStep = {
  name: 'restoreAlpha',
  shouldRun: (ctx) => hasTransparency(ctx.source),
  async run(ctx, cb) {
    emitStage(cb, 'restoreAlpha', 'running', { message: 'Restoring transparency…' });
    const t = performance.now();
    const image = applyAlphaMask(ensureCanvas(ctx.image), ctx.source);
    let comparisonImage = ctx.comparisonImage;
    if (comparisonImage) {
      comparisonImage = applyAlphaMask(ensureCanvas(comparisonImage), ctx.source);
    }
    return {
      ...ctx,
      image,
      comparisonImage,
      stepPerf: {
        ...(ctx.stepPerf || {}),
        restoreAlpha: { total: Number((performance.now() - t).toFixed(1)) },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

const STEPS = [tiledUpscaleStep, comparisonStep, blendAllStep, detectFacesStep, enhanceFacesStep, colorMatchStep, restoreAlphaStep];

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
  'setup', 'extract', 'inference', 'inferenceEstimated',
  'readback', 'gpuRender', 'writeTile', 'dispose',
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
    setup: 0, extract: 0, inference: 0, inferenceEstimated: 0,
    readback: 0, gpuRender: 0, writeTile: 0, dispose: 0,
    modelLoad: 0, total: totalMs, tiles: 0,
    tileSize: Number.isFinite(config.tileSize) ? config.tileSize : 0,
    srcW: src.width, srcH: src.height,
    outW: out.width, outH: out.height,
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
    // Authoritative tile-size clamp lives here — controls' UI mirror uses the
    // same tileSizeBounds helper to disable dropdown options that would get
    // clamped anyway.
    const models = [
      config.model,
      config.comparison?.model,
      config.all?.model,
      config.face?.model,
    ].filter(Boolean);
    const effective = { ...config, tileSize: computeEffectiveTileSize(models, config.tileSize) };
    return runSteps(STEPS, this.#pool, input, effective, callbacks);
  }

  async warmup(config, { onProgress } = {}) {
    const engine = this.#pool.getUpscaler('base', config.model, { profile: config.profile });
    await engine.loadModel(config.backend, onProgress);
  }

  destroy() {
    this.#pool.destroyAll();
  }
}
