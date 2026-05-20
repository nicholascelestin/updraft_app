// Isolated repro: load a model via onnxruntime-node and run a single
// known-shape tile. If this SIGTRAPs, the bug is in ORT-node + this
// model (we ruled out our IPC pipeline). If this works, the bug is in
// what we're sending from the renderer.
//
// Usage:
//   node debug-model.cjs <path-to-onnx> [tileSize] [ep]
//   node debug-model.cjs ../models/4x-UltraSharpV2.onnx 64 cpu
//   node debug-model.cjs ../models/tinysr_fused.onnx 128 coreml

const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');

async function main() {
  const modelPath = process.argv[2] || path.resolve(__dirname, '../models/4x-UltraSharpV2.onnx');
  const tile = parseInt(process.argv[3] || '64', 10);
  const epArg = (process.argv[4] || 'cpu').toLowerCase();

  console.log(`ORT-node version: ${ort.version || '(unknown)'}`);
  console.log(`Loading: ${modelPath}`);
  const stat = fs.statSync(modelPath);
  console.log(`  size: ${(stat.size / 1e6).toFixed(1)} MB`);

  const eps = epArg === 'coreml'
    ? [{ name: 'coreml', modelFormat: 'MLProgram', mlComputeUnits: 'CPUAndGPU' }, 'cpu']
    : epArg === 'cpu' ? ['cpu']
    : [epArg, 'cpu'];

  console.log(`  EPs: ${JSON.stringify(eps)}`);
  const t0 = Date.now();
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: eps });
  console.log(`  loaded in ${Date.now() - t0}ms`);
  console.log(`  inputs:  ${session.inputNames.join(', ')}`);
  console.log(`  outputs: ${session.outputNames.join(', ')}`);
  // Dump input metadata so we can see required dims/dtype.
  for (const name of session.inputNames) {
    const meta = session.inputMetadata?.[name] || session.inputMetadata?.find?.(m => m.name === name);
    console.log(`  input "${name}":`, meta);
  }

  const inputName = session.inputNames[0];
  // [B, 3, H, W] NCHW, fp32, values in [0,1] — match what aitools sends.
  const dims = [1, 3, tile, tile];
  const numel = dims.reduce((a, b) => a * b);
  const data = new Float32Array(numel);
  // Fill with a plausible gradient, not all zeros (some models choke on
  // zero inputs in normalization layers).
  for (let i = 0; i < numel; i++) data[i] = (i % 256) / 255.0;
  const tensor = new ort.Tensor('float32', data, dims);

  console.log(`Running tile ${dims.join('x')} ...`);
  const tInfer = Date.now();
  const outputs = await session.run({ [inputName]: tensor });
  console.log(`  ran in ${Date.now() - tInfer}ms`);
  for (const [k, v] of Object.entries(outputs)) {
    const a = v.data;
    let min = Infinity, max = -Infinity, sum = 0, nans = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (Number.isNaN(x)) { nans++; continue; }
      if (x < min) min = x;
      if (x > max) max = x;
      sum += x;
    }
    console.log(`  ${k}: dims=${v.dims} type=${v.type} min=${min.toFixed(3)} max=${max.toFixed(3)} mean=${(sum / a.length).toFixed(3)} nan=${nans}`);
  }
  await session.release();
  console.log('OK');
}

main().catch(e => {
  console.error('FAIL:', e?.stack || e?.message || e);
  process.exit(1);
});
