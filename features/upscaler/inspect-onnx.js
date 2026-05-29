// ONNX file probing — runs short inference passes against a candidate model
// file to infer scale, layout, input dtype, alignment multiple, and any
// hard input-size cap. Called by SRModelStore when adding a custom model.

import { readMetaEntry, isFp16InputType } from 'lib/onnx-meta';

const PROBE_SIZE = 64;
const MAX_TILE_PROBE_SIZES = [128, 256];
const MIN_SCALE = 1;
const MAX_SCALE = 16;
const DEFAULT_SCALE = 4;

// Input-alignment ladder. Each size is a multiple of `multiple` but not of any
// larger candidate's, so the first size that runs identifies the required
// multiple. A model that fails every entry needs a multiple of PROBE_SIZE.
const ALIGNMENT_CANDIDATES = [
  { multiple: 1, size: 65 },
  { multiple: 8, size: 72 },
  { multiple: 16, size: 80 },
  { multiple: 32, size: 96 },
];

function normalizeDims(dims) {
  if (!Array.isArray(dims)) return [];
  return dims.map((d) => (typeof d === 'number' ? d : Number.NaN));
}

// ORT-Web 1.20+ exposes ValueMetadata.shape; older builds used .dimensions.
function readMetaShape(meta) {
  return meta?.shape ?? meta?.dimensions ?? null;
}

function detectLayout(dims) {
  if (dims.length !== 4) return 'unknown';
  if (dims[1] === 3 || dims[1] === 1) return 'nchw';
  if (dims[3] === 3 || dims[3] === 1) return 'nhwc';
  return 'unknown';
}

function isValidScale(sx, sy) {
  return Number.isFinite(sx) && sx === sy && sx >= MIN_SCALE && sx <= MAX_SCALE;
}

// Returns the input's spatial size when both dims are pinned in the metadata,
// else null. A fixed shape makes the alignment/max-tile/non-square probes moot.
function staticSpatialSize(dims, layout) {
  if (dims.length !== 4) return null;
  const w = layout === 'nhwc' ? dims[2] : dims[3];
  const h = layout === 'nhwc' ? dims[1] : dims[2];
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

function inferScaleFromStaticDims(inDims, outDims, layout) {
  if (layout !== 'nchw' && layout !== 'nhwc') return null;
  if (inDims.length !== 4 || outDims.length !== 4) return null;
  const [inH, inW, outH, outW] = layout === 'nhwc'
    ? [inDims[1], inDims[2], outDims[1], outDims[2]]
    : [inDims[2], inDims[3], outDims[2], outDims[3]];
  if (![inH, inW, outH, outW].every(Number.isFinite)) return null;
  if (inH <= 0 || inW <= 0) return null;
  const sx = outW / inW;
  const sy = outH / inH;
  return isValidScale(sx, sy) ? Math.round(sx) : null;
}

function rangeFromInputType(inputType) {
  if (typeof inputType !== 'string') return 1;
  return (inputType.includes('uint8') || inputType.includes('int8')) ? 255 : 1;
}

function createProbeTensor(ort, inputType, layout, width, height, range) {
  const dims = layout === 'nhwc' ? [1, height, width, 3] : [1, 3, height, width];
  const count = dims.reduce((acc, v) => acc * v, 1);
  const type = String(inputType || 'float32').toLowerCase();
  if (type.includes('uint8')) {
    const data = new Uint8Array(count);
    data.fill(range === 255 ? 128 : 1);
    return new ort.Tensor('uint8', data, dims);
  }
  if (type.includes('int8')) {
    const data = new Int8Array(count);
    data.fill(range === 255 ? 127 : 1);
    return new ort.Tensor('int8', data, dims);
  }
  if (type.includes('float16')) {
    const data = new Uint16Array(count);
    data.fill(range === 255 ? 0x5800 : 0x3800); // 128.0 / 0.5 as fp16 bit patterns
    return new ort.Tensor('float16', data, dims);
  }
  const data = new Float32Array(count);
  data.fill(range === 255 ? 128 : 0.5);
  return new ort.Tensor('float32', data, dims);
}

function getPrimaryOutput(results, outputName) {
  if (!results || typeof results !== 'object') return null;
  if (outputName && results[outputName]) return results[outputName];
  return Object.values(results)[0] || null;
}

function inferScaleFromProbeOutput(layout, inputWidth, inputHeight, outDims) {
  if (!Array.isArray(outDims) || outDims.length !== 4) return null;
  if (inputWidth <= 0 || inputHeight <= 0) return null;
  const dims = normalizeDims(outDims);
  const outH = layout === 'nhwc' ? dims[1] : dims[2];
  const outW = layout === 'nhwc' ? dims[2] : dims[3];
  if (![outH, outW].every(Number.isFinite)) return null;
  const sx = outW / inputWidth;
  const sy = outH / inputHeight;
  return isValidScale(sx, sy) ? Math.round(sx) : null;
}

async function runProbe(session, ort, { inputName, outputName, inputType, layout, width, height, range }) {
  const inputTensor = createProbeTensor(ort, inputType, layout, width, height, range);
  try {
    const results = await session.run({ [inputName]: inputTensor });
    const output = getPrimaryOutput(results, outputName);
    const outDims = output?.dims || [];
    for (const tensor of Object.values(results)) {
      try { tensor?.dispose?.(); } catch {}
    }
    return { ok: true, outDims };
  } catch (error) {
    return { ok: false, error };
  } finally {
    try { inputTensor.dispose?.(); } catch {}
  }
}

async function createSession(ort, source, backend) {
  return ort.InferenceSession.create(source, {
    executionProviders: backend === 'webgpu'
      ? [{ name: 'webgpu', preferredLayout: 'NCHW' }]
      : ['wasm'],
    graphOptimizationLevel: 'all',
  });
}

function readInputType(session) {
  const name = session.inputNames?.[0];
  const meta = readMetaEntry(session.inputMetadata, name, 0);
  return meta?.type || 'float32';
}

// Many transformer SR exports (SwinIR, DAT) require both input dimensions to be
// a multiple of the traced patch/window size. Detect that multiple by which
// square sizes actually run, rather than parsing backend-specific error text.
async function probeInputMultiple(session, ort, probeArgs, report) {
  for (const { multiple, size } of ALIGNMENT_CANDIDATES) {
    report?.(`probing input alignment at ${size}×${size}…`);
    const probe = await runProbe(session, ort, { ...probeArgs, width: size, height: size });
    if (probe.ok) return multiple;
  }
  return PROBE_SIZE;
}

// Some exports also bake in a window count tied to the trace size and reject
// inputs larger than it. Sweep upward (aligned to the detected multiple) for
// the largest size that still runs; null means no cap within the tested range.
async function probeMaxInputSize(session, ort, baseProbeArgs, knownWorkingSize, multipleOf, report) {
  const m = Number.isFinite(multipleOf) && multipleOf > 1 ? multipleOf : 1;
  let lastWorking = knownWorkingSize;
  let foundUpperBound = false;
  for (const raw of MAX_TILE_PROBE_SIZES) {
    const size = Math.ceil(raw / m) * m;
    if (size <= lastWorking) continue;
    report?.(`testing maximum tile size at ${size}×${size}…`);
    const probe = await runProbe(session, ort, { ...baseProbeArgs, width: size, height: size });
    if (probe.ok) {
      lastWorking = size;
    } else {
      foundUpperBound = true;
      break;
    }
  }
  return foundUpperBound ? lastWorking : null;
}

const DEFAULT_RESULT = {
  scale: DEFAULT_SCALE, range: 1, layout: 'nchw', multipleOf: 1, maxTileSize: null,
  inputType: 'float32', precision: 'fp32',
  scaleSource: 'default', multipleOfSource: 'default', notes: [],
};

export async function inspectOnnxFile(file, { onProgress } = {}) {
  if (!(file instanceof File)) throw new Error('Expected an ONNX file.');
  const report = typeof onProgress === 'function' ? onProgress : null;
  const ort = globalThis.ort;
  if (!ort?.InferenceSession) {
    return { ...DEFAULT_RESULT, notes: ['ONNX Runtime not loaded yet; using defaults (4x, range 1).'] };
  }

  report?.('reading ONNX metadata and loading session…');
  const bytes = await file.arrayBuffer();

  // Probe fp32 models on WASM. WebGPU's first run compiles a shader per kernel
  // and handles dynamic-shape ops poorly, so large transformer graphs (SwinIR,
  // DAT) can take minutes to compile there for a probe that runs in under a
  // second on WASM. Only fp16 graphs, which WASM can't execute, use WebGPU.
  const hasWebGpu = !!(navigator.gpu && ort.env?.webgpu);
  let session = null;
  let probeBackend = null;
  report?.('loading session on CPU/WASM…');
  try {
    session = await createSession(ort, bytes, 'wasm');
    probeBackend = 'wasm';
  } catch (err) {
    console.warn('[inspectOnnxFile] WASM probe session failed:', err);
  }

  const needWebGpu = hasWebGpu && (!session || isFp16InputType(readInputType(session)));
  if (needWebGpu) {
    try {
      report?.('loading session on WebGPU…');
      const gpuSession = await createSession(ort, bytes, 'webgpu');
      if (session) { try { session.release?.(); } catch {} }
      session = gpuSession;
      probeBackend = 'webgpu';
    } catch (err) {
      console.warn('[inspectOnnxFile] WebGPU probe session failed:', err);
      if (!session) throw err;
    }
  }
  if (!session) throw new Error('Could not create an ONNX session for probing.');

  try {
    const inputName = session.inputNames?.[0];
    const outputName = session.outputNames?.[0];
    if (!inputName) {
      return { ...DEFAULT_RESULT, notes: ['Model has no detectable input tensor; using defaults.'] };
    }
    const inMeta = readMetaEntry(session.inputMetadata, inputName, 0);
    const outMeta = readMetaEntry(session.outputMetadata, outputName, 0);
    const inDims = normalizeDims(readMetaShape(inMeta));
    const outDims = normalizeDims(readMetaShape(outMeta));
    const declaredLayout = detectLayout(inDims);
    const inputType = inMeta?.type || 'float32';
    const range = rangeFromInputType(inputType);
    const precision = isFp16InputType(inputType) ? 'fp16' : 'fp32';
    const notes = [];
    if (precision === 'fp16' && probeBackend !== 'webgpu') {
      notes.push('This model is fp16 but probing fell back to CPU/WASM, which has limited fp16 op coverage. Probe results may be unreliable; the model itself will require WebGPU at run time.');
    }

    // Fixed-shape exports: the metadata pins layout and tile size, so a single
    // confirming run replaces the layout/alignment/max-tile/non-square probes.
    const fixed = declaredLayout === 'unknown' ? null : staticSpatialSize(inDims, declaredLayout);
    if (fixed && fixed.w === fixed.h) {
      report?.(`confirming fixed ${fixed.w}×${fixed.h} input…`);
      const probe = await runProbe(session, ort, {
        inputName, outputName, inputType, layout: declaredLayout,
        width: fixed.w, height: fixed.h, range,
      });
      const probeScale = probe.ok
        ? inferScaleFromProbeOutput(declaredLayout, fixed.w, fixed.h, probe.outDims)
        : null;
      const staticScale = inferScaleFromStaticDims(inDims, outDims, declaredLayout);
      if (!probe.ok) {
        notes.push('Model declares a fixed input size but the confirming run failed; values are from metadata only.');
      }
      return {
        scale: probeScale ?? staticScale ?? DEFAULT_SCALE,
        range, layout: declaredLayout,
        multipleOf: fixed.w, maxTileSize: fixed.w,
        inputType, precision,
        scaleSource: probeScale != null ? 'probe' : staticScale != null ? 'metadata' : 'default',
        multipleOfSource: 'metadata', notes,
      };
    }

    const layoutCandidates = declaredLayout === 'unknown'
      ? ['nchw', 'nhwc']
      : [declaredLayout, declaredLayout === 'nchw' ? 'nhwc' : 'nchw'];

    let chosenLayout = declaredLayout === 'nhwc' ? 'nhwc' : 'nchw';
    let probeScale = null;
    let probeWorked = false;
    for (const candidate of layoutCandidates) {
      report?.(`testing ${candidate.toUpperCase()} layout at ${PROBE_SIZE}×${PROBE_SIZE}…`);
      const probe = await runProbe(session, ort, {
        inputName, outputName, inputType, layout: candidate,
        width: PROBE_SIZE, height: PROBE_SIZE, range,
      });
      if (!probe.ok) continue;
      probeWorked = true;
      chosenLayout = candidate;
      probeScale = inferScaleFromProbeOutput(candidate, PROBE_SIZE, PROBE_SIZE, probe.outDims);
      break;
    }
    if (!probeWorked) {
      notes.push('Layout probe failed for both NCHW and NHWC; using defaults.');
    } else if (chosenLayout === 'nhwc') {
      notes.push('Detected NHWC layout from probe; this can run, but may be slower than NCHW.');
    }

    const staticScale = inferScaleFromStaticDims(inDims, outDims, declaredLayout);
    const scale = probeScale ?? staticScale ?? DEFAULT_SCALE;
    const scaleSource = probeScale != null ? 'probe' : staticScale != null ? 'metadata' : 'default';

    let multipleOf = 1;
    let multipleOfSource = 'default';
    if (probeWorked) {
      multipleOf = await probeInputMultiple(
        session, ort,
        { inputName, outputName, inputType, layout: chosenLayout, range },
        report,
      );
      if (multipleOf > 1) multipleOfSource = 'probe';
    }

    let maxTileSize = null;
    if (probeWorked) {
      maxTileSize = await probeMaxInputSize(
        session, ort,
        { inputName, outputName, inputType, layout: chosenLayout, range },
        PROBE_SIZE, multipleOf, report,
      );
      if (Number.isFinite(maxTileSize)) {
        // For models with a hard cap (e.g. DAT with baked-in window counts),
        // force alignment to equal the cap — combined with the engine's tile
        // size cap, every inference runs at exactly maxTileSize so padded
        // edge tiles stay inside the band the model accepts.
        if (maxTileSize > multipleOf) {
          multipleOf = maxTileSize;
          multipleOfSource = 'probe';
        }
        notes.push(`Model rejected inputs larger than ${maxTileSize}×${maxTileSize}; tile size will be capped at ${maxTileSize}.`);
      }
    }

    if (probeWorked && !Number.isFinite(maxTileSize)) {
      const offset = multipleOf > 1 ? multipleOf : 32;
      report?.(`testing non-square input at ${PROBE_SIZE + offset}×${PROBE_SIZE}…`);
      const nonSquare = await runProbe(session, ort, {
        inputName, outputName, inputType, layout: chosenLayout,
        width: PROBE_SIZE + offset, height: PROBE_SIZE, range,
      });
      if (!nonSquare.ok) {
        notes.push('This model only accepts square input tiles; the engine pads tile dimensions independently, so it may fail on edge tiles unless image dimensions are an exact multiple of the tile size.');
      }
    }

    return {
      scale, range, layout: chosenLayout, multipleOf, maxTileSize,
      inputType, precision, scaleSource, multipleOfSource, notes,
    };
  } finally {
    try { session.release?.(); } catch {}
  }
}
