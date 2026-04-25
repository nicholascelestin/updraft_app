function normalizeDims(dims) {
  if (!Array.isArray(dims)) return [];
  return dims.map((d) => (typeof d === 'number' ? d : Number.NaN));
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
        inputType: 'float32',
        scaleSource: 'default',
        multipleOfSource: 'default',
        notes: ['ONNX Runtime not loaded yet; using defaults (4x, range 1).'],
      };
    }

    report?.('Reading ONNX metadata…');
    const bytes = await file.arrayBuffer();
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    try {
      const inputName = session.inputNames?.[0];
      const outputName = session.outputNames?.[0];
      if (!inputName) {
        return {
          scale: 4,
          range: 1,
          layout: 'nchw',
          multipleOf: 1,
          inputType: 'float32',
          scaleSource: 'default',
          multipleOfSource: 'default',
          notes: ['Model has no detectable input tensor; using defaults.'],
        };
      }
      const inMeta = inputName ? session.inputMetadata?.[inputName] : null;
      const outMeta = outputName ? session.outputMetadata?.[outputName] : null;
      const inDims = normalizeDims(inMeta?.dimensions);
      const outDims = normalizeDims(outMeta?.dimensions);
      const layout = detectLayout(inDims);
      const inputType = inMeta?.type || 'float32';
      const range = rangeFromInputType(inputType);
      const notes = [];
      const layoutCandidates = layout === 'unknown'
        ? ['nchw', 'nhwc']
        : [layout, layout === 'nchw' ? 'nhwc' : 'nchw'];

      let chosenLayout = layout === 'nhwc' ? 'nhwc' : 'nchw';
      let probeScale = null;
      let probeWorked = false;
      for (const candidateLayout of layoutCandidates) {
        report?.(`Probing ${candidateLayout.toUpperCase()} layout…`);
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

      report?.('Probing window multiple constraint…');
      let multipleOf = 1;
      let multipleOfSource = 'default';
      if (probeWorked) {
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

      return {
        scale,
        range,
        layout: chosenLayout,
        multipleOf,
        inputType,
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
