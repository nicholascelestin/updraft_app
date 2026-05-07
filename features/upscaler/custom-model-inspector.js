function normalizeDims(dims) {
  if (!Array.isArray(dims)) return [];
  return dims.map((d) => (typeof d === 'number' ? d : Number.NaN));
}

/**
 * ORT-Web 1.18+ exposes `session.inputMetadata` / `outputMetadata` as a
 * readonly array of ValueMetadata, ordered to match `inputNames` /
 * `outputNames`. Older versions exposed it as a Record keyed by tensor
 * name. We support both shapes so the inspector keeps working across ORT
 * upgrades, with a name-keyed fallback to the positional entry.
 */
function readMetaEntry(metaCollection, name, index = 0) {
  if (!metaCollection) return null;
  if (Array.isArray(metaCollection)) {
    if (name) {
      const byName = metaCollection.find((m) => m?.name === name);
      if (byName) return byName;
    }
    return metaCollection[index] || null;
  }
  return (name && metaCollection[name]) || null;
}

/**
 * The ValueMetadata shape array is `shape` in ORT-Web 1.20+; older
 * versions called the same field `dimensions`. Read either and let the
 * caller handle the array of (number | string) entries.
 */
function readMetaShape(meta) {
  return meta?.shape ?? meta?.dimensions ?? null;
}

function detectLayout(dims) {
  if (dims.length !== 4) return 'unknown';
  const cAt1 = dims[1];
  const cAt3 = dims[3];
  if (cAt1 === 3 || cAt1 === 1) return 'nchw';
  if (cAt3 === 3 || cAt3 === 1) return 'nhwc';
  return 'unknown';
}

function inferScaleFromStaticDims(inDims, outDims, layout) {
  if (inDims.length !== 4 || outDims.length !== 4) return null;
  let inH, inW, outH, outW;
  if (layout === 'nhwc') {
    inH = inDims[1];
    inW = inDims[2];
    outH = outDims[1];
    outW = outDims[2];
  } else {
    inH = inDims[2];
    inW = inDims[3];
    outH = outDims[2];
    outW = outDims[3];
  }
  if (![inH, inW, outH, outW].every(Number.isFinite)) return null;
  if (inH <= 0 || inW <= 0) return null;
  const sx = outW / inW;
  const sy = outH / inH;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx !== sy) return null;
  if (sx < 1 || sx > 16) return null;
  return Math.round(sx);
}

function rangeFromInputType(inputType) {
  if (typeof inputType !== 'string') return 1;
  if (inputType.includes('uint8') || inputType.includes('int8')) return 255;
  return 1;
}

function precisionFromInputType(inputType) {
  return typeof inputType === 'string' && inputType.toLowerCase().includes('float16')
    ? 'fp16'
    : 'fp32';
}

function createProbeTensor(ort, inputType, layout, size, range) {
  const dims = layout === 'nhwc' ? [1, size, size, 3] : [1, 3, size, size];
  const count = dims.reduce((acc, v) => acc * v, 1);
  const type = String(inputType || 'float32').toLowerCase();
  if (type.includes('uint8')) {
    const data = new Uint8Array(count);
    data.fill(range === 255 ? 128 : 1);
    return new ort.Tensor('uint8', data, dims);
  }
  if (type.includes('int8')) {
    const data = new Int8Array(count);
    data.fill(0);
    return new ort.Tensor('int8', data, dims);
  }
  if (type.includes('float16')) {
    const data = new Uint16Array(count);
    return new ort.Tensor('float16', data, dims);
  }
  const data = new Float32Array(count);
  data.fill(range === 255 ? 128 : 0.5);
  return new ort.Tensor('float32', data, dims);
}

function getPrimaryOutput(results, outputName) {
  if (!results || typeof results !== 'object') return null;
  if (outputName && results[outputName]) return results[outputName];
  const first = Object.values(results)[0];
  return first || null;
}

function inferScaleFromProbeOutput(layout, inputSize, outDims) {
  if (!Array.isArray(outDims) || outDims.length !== 4) return null;
  const dims = normalizeDims(outDims);
  const outH = layout === 'nhwc' ? dims[1] : dims[2];
  const outW = layout === 'nhwc' ? dims[2] : dims[3];
  if (![outH, outW].every(Number.isFinite) || inputSize <= 0) return null;
  const sx = outW / inputSize;
  const sy = outH / inputSize;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx !== sy) return null;
  if (sx < 1 || sx > 16) return null;
  return Math.round(sx);
}

function inferMultipleFromReshapeError(rawError) {
  const raw = String(rawError || '');
  const match = raw.match(/requested shape:\{([^}]*)\}/i);
  if (!match) return null;
  const requested = match[1]
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter(Number.isFinite);
  const pow2 = requested.filter((d) => d > 1 && d <= 256 && (d & (d - 1)) === 0);
  if (!pow2.length) return null;
  return Math.max(...pow2);
}

/**
 * Detect a hard upper bound on input size by probing at increasing sizes.
 * Some ONNX exports (notably PyTorch traces of models with shape-dependent
 * conditionals — e.g. DAT-style window attention) bake in window counts as
 * Constants and only accept inputs near the trace size. The auto-detect
 * sweet-spot probe at 64 alone can't catch this, so we sweep a few common
 * tile sizes upward and report the largest size that still runs.
 *
 * Returns `null` if the model worked at every probed size (i.e. no upper
 * bound was found within the tested range).
 */
async function probeMaxInputSize(session, ort, baseProbeArgs, knownWorkingSize, report) {
  const candidates = [128, 256];
  let lastWorking = knownWorkingSize;
  let foundUpperBound = false;
  for (const size of candidates) {
    if (size <= lastWorking) continue;
    report?.(`testing maximum tile size at ${size}\u00d7${size}…`);
    const probe = await runProbe(session, ort, { ...baseProbeArgs, size });
    if (probe.ok) {
      lastWorking = size;
    } else {
      foundUpperBound = true;
      break;
    }
  }
  return foundUpperBound ? lastWorking : null;
}

async function runProbe(session, ort, { inputName, outputName, inputType, layout, size, range }) {
  const inputTensor = createProbeTensor(ort, inputType, layout, size, range);
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

export class CustomModelInspector {
  async inspectFile(file, { onProgress } = {}) {
    if (!(file instanceof File)) {
      throw new Error('Expected an ONNX file.');
    }
    const report = typeof onProgress === 'function' ? onProgress : null;
    const ort = globalThis.ort;
    if (!ort?.InferenceSession) {
      return {
        scale: 4,
        range: 1,
        layout: 'nchw',
        multipleOf: 1,
        maxTileSize: null,
        inputType: 'float32',
        precision: 'fp32',
        scaleSource: 'default',
        multipleOfSource: 'default',
        notes: ['ONNX Runtime not loaded yet; using defaults (4x, range 1).'],
      };
    }

    report?.('reading ONNX metadata and loading session…');
    const bytes = await file.arrayBuffer();
    // Probe on WebGPU first when available — fp16 models will only run there,
    // and fp32 models work fine on either EP, so WebGPU is the right default.
    // Fall back to WASM when WebGPU is unavailable or session creation fails.
    const hasWebGpu = !!(navigator.gpu && ort.env?.webgpu);
    let session = null;
    let probeBackend = null;
    if (hasWebGpu) {
      try {
        report?.('loading session on WebGPU…');
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: [{ name: 'webgpu', preferredLayout: 'NCHW' }],
          graphOptimizationLevel: 'all',
        });
        probeBackend = 'webgpu';
      } catch (err) {
        console.warn('[CustomModelInspector] WebGPU probe session failed, falling back to WASM:', err);
      }
    }
    if (!session) {
      report?.('loading session on CPU/WASM…');
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      probeBackend = 'wasm';
    }
    try {
      const inputName = session.inputNames?.[0];
      const outputName = session.outputNames?.[0];
      if (!inputName) {
        return {
          scale: 4,
          range: 1,
          layout: 'nchw',
          multipleOf: 1,
          maxTileSize: null,
          inputType: 'float32',
          precision: 'fp32',
          scaleSource: 'default',
          multipleOfSource: 'default',
          notes: ['Model has no detectable input tensor; using defaults.'],
        };
      }
      const inMeta = readMetaEntry(session.inputMetadata, inputName, 0);
      const outMeta = readMetaEntry(session.outputMetadata, outputName, 0);
      const inDims = normalizeDims(readMetaShape(inMeta));
      const outDims = normalizeDims(readMetaShape(outMeta));
      const layout = detectLayout(inDims);
      const inputType = inMeta?.type || 'float32';
      const range = rangeFromInputType(inputType);
      const precision = precisionFromInputType(inputType);
      const notes = [];
      if (precision === 'fp16' && probeBackend !== 'webgpu') {
        notes.push('This model is fp16 but probing fell back to CPU/WASM, which has limited fp16 op coverage. Probe results may be unreliable; the model itself will require WebGPU at run time.');
      }
      const layoutCandidates = layout === 'unknown'
        ? ['nchw', 'nhwc']
        : [layout, layout === 'nchw' ? 'nhwc' : 'nchw'];

      let chosenLayout = layout === 'nhwc' ? 'nhwc' : 'nchw';
      let probeScale = null;
      let probeWorked = false;
      for (const candidateLayout of layoutCandidates) {
        report?.(`testing ${candidateLayout.toUpperCase()} layout at 64\u00d764…`);
        const probe = await runProbe(session, ort, {
          inputName,
          outputName,
          inputType,
          layout: candidateLayout,
          size: 64,
          range,
        });
        if (!probe.ok) continue;
        probeWorked = true;
        chosenLayout = candidateLayout;
        probeScale = inferScaleFromProbeOutput(candidateLayout, 64, probe.outDims);
        break;
      }
      if (!probeWorked) {
        notes.push('Layout probe failed for both NCHW and NHWC; using defaults.');
      } else if (chosenLayout === 'nhwc') {
        notes.push('Detected NHWC layout from probe; this can run, but may be slower than NCHW.');
      }

      const staticScale = inferScaleFromStaticDims(inDims, outDims, chosenLayout);
      const scale = probeScale || staticScale || 4;
      const scaleSource = probeScale ? 'probe' : staticScale ? 'metadata' : 'default';

      let multipleOf = 1;
      let multipleOfSource = 'default';
      if (probeWorked) {
        report?.('checking window-size alignment at 60\u00d760…');
        const mismatchProbe = await runProbe(session, ort, {
          inputName,
          outputName,
          inputType,
          layout: chosenLayout,
          size: 60,
          range,
        });
        if (!mismatchProbe.ok) {
          const inferred = inferMultipleFromReshapeError(mismatchProbe.error?.message);
          if (Number.isFinite(inferred) && inferred > 1) {
            multipleOf = inferred;
            multipleOfSource = 'probe';
          }
        }
      }

      let maxTileSize = null;
      if (probeWorked) {
        maxTileSize = await probeMaxInputSize(
          session,
          ort,
          { inputName, outputName, inputType, layout: chosenLayout, range },
          64,
          report,
        );
        if (Number.isFinite(maxTileSize)) {
          // Some exports (e.g. DAT with window-count constants baked in) only
          // accept inputs in a narrow band around the trace size. To keep
          // every padded edge tile inside that band, force the alignment to
          // equal the discovered max — combined with a tile-size cap in the
          // engine, every inference then runs at exactly maxTileSize.
          if (maxTileSize > multipleOf) {
            multipleOf = maxTileSize;
            multipleOfSource = 'probe';
          }
          notes.push(
            `Model rejected inputs larger than ${maxTileSize}\u00d7${maxTileSize}; tile size will be capped at ${maxTileSize}.`,
          );
        }
      }

      return {
        scale,
        range,
        layout: chosenLayout,
        multipleOf,
        maxTileSize,
        inputType,
        precision,
        scaleSource,
        multipleOfSource,
        notes,
      };
    } finally {
      try { session.release?.(); } catch {}
    }
  }
}

export async function inspectCustomModelFile(file, opts) {
  const inspector = new CustomModelInspector();
  return inspector.inspectFile(file, opts);
}
