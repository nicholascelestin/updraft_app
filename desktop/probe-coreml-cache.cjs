// One-off probe: does the ORT-node 1.26 binding actually honor CoreML
// provider options beyond `coreMlFlags`? In particular `modelCacheDirectory`.
//
// Method: load the same model three times in this single process. We
// can't probe cross-process cache persistence without restarting, but if
// modelCacheDirectory is honored, ORT will reuse the compiled .mlmodelc
// from the cache dir on subsequent loads (even within one process they
// see a dramatic speedup vs. first load). And the dir will contain files.
//
// Usage: node probe-coreml-cache.cjs ../models/4x-UltraSharpV2.onnx
const fs = require('fs');
const os = require('os');
const path = require('path');
const ort = require('onnxruntime-node');

async function loadOnce(modelPath, label, opts) {
  const t0 = Date.now();
  const s = await ort.InferenceSession.create(modelPath, opts);
  const dt = Date.now() - t0;
  console.log(`  [${label}] load = ${dt}ms`);
  await s.release();
  return dt;
}

async function main() {
  const modelPath = process.argv[2] || path.resolve(__dirname, '../models/4x-UltraSharpV2.onnx');
  const cacheDir = path.join(os.tmpdir(), 'aitools-coreml-cache-probe');
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  console.log(`Model: ${modelPath}`);
  console.log(`Cache dir: ${cacheDir}`);
  console.log(`ORT version: ${ort.version || '(unknown)'}`);
  console.log();

  // Variant A: no cache dir, default config — establishes baseline.
  console.log('Variant A — coreml default (no cache):');
  await loadOnce(modelPath, 'A1', { executionProviders: [{ name: 'coreml' }, 'cpu'] });
  await loadOnce(modelPath, 'A2', { executionProviders: [{ name: 'coreml' }, 'cpu'] });

  // Variant B: with modelCacheDirectory set.
  console.log('Variant B — coreml + modelCacheDirectory:');
  await loadOnce(modelPath, 'B1', { executionProviders: [{ name: 'coreml', modelCacheDirectory: cacheDir }, 'cpu'] });
  await loadOnce(modelPath, 'B2', { executionProviders: [{ name: 'coreml', modelCacheDirectory: cacheDir }, 'cpu'] });

  // Variant C: with coreMlFlags only (known-honored).
  console.log('Variant C — coreMlFlags=0x030 (MLProgram + CPU+GPU):');
  await loadOnce(modelPath, 'C1', { executionProviders: [{ name: 'coreml', coreMlFlags: 0x030 }, 'cpu'] });
  await loadOnce(modelPath, 'C2', { executionProviders: [{ name: 'coreml', coreMlFlags: 0x030 }, 'cpu'] });

  // Variant D: B + C combined.
  console.log('Variant D — coreMlFlags=0x030 + modelCacheDirectory:');
  await loadOnce(modelPath, 'D1', { executionProviders: [{ name: 'coreml', coreMlFlags: 0x030, modelCacheDirectory: cacheDir }, 'cpu'] });
  await loadOnce(modelPath, 'D2', { executionProviders: [{ name: 'coreml', coreMlFlags: 0x030, modelCacheDirectory: cacheDir }, 'cpu'] });

  console.log();
  console.log(`Cache dir contents after probe:`);
  try {
    for (const name of fs.readdirSync(cacheDir)) {
      const st = fs.statSync(path.join(cacheDir, name));
      console.log(`  ${name}  ${st.isDirectory() ? '(dir)' : `${st.size} B`}`);
    }
  } catch (e) {
    console.log(`  (failed: ${e.message})`);
  }
}

main().catch(e => { console.error('FAIL:', e?.stack || e?.message || e); process.exit(1); });
