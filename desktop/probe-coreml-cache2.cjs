// Probe 2: try sessionOptions.extra to set CoreML cache directory via
// the session-config-string backchannel. Use a model big enough to make
// CoreML compile time visible (UltraSharpV2 ≈ 50 MB, default-CoreML works).
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
  const cacheDir = path.join(os.tmpdir(), 'aitools-coreml-cache-probe2');
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  console.log(`Model: ${modelPath}  (${(fs.statSync(modelPath).size/1e6).toFixed(1)} MB)`);
  console.log(`Cache dir: ${cacheDir}`);

  // Variant A — baseline CoreML default.
  console.log('A — coreml default (no cache):');
  await loadOnce(modelPath, 'A1', { executionProviders: [{ name: 'coreml' }, 'cpu'] });
  await loadOnce(modelPath, 'A2', { executionProviders: [{ name: 'coreml' }, 'cpu'] });

  // Variant E — try sessionOptions.extra route.
  console.log('E — coreml + sessionOptions.extra[ep.coreml.modelCacheDirectory]:');
  await loadOnce(modelPath, 'E1', {
    executionProviders: [{ name: 'coreml' }, 'cpu'],
    extra: { 'ep.coreml.modelCacheDirectory': cacheDir },
  });
  await loadOnce(modelPath, 'E2', {
    executionProviders: [{ name: 'coreml' }, 'cpu'],
    extra: { 'ep.coreml.modelCacheDirectory': cacheDir },
  });

  // Variant F — try snake_case.
  console.log('F — coreml + sessionOptions.extra[ep.coreml.model_cache_directory]:');
  await loadOnce(modelPath, 'F1', {
    executionProviders: [{ name: 'coreml' }, 'cpu'],
    extra: { 'ep.coreml.model_cache_directory': cacheDir },
  });
  await loadOnce(modelPath, 'F2', {
    executionProviders: [{ name: 'coreml' }, 'cpu'],
    extra: { 'ep.coreml.model_cache_directory': cacheDir },
  });

  // Variant G — try `optimizedModelFilePath` (the cross-EP fallback we're
  // counting on for non-CoreML platforms). Time both phases.
  const optPath = path.join(os.tmpdir(), 'aitools-opt-probe.onnx');
  try { fs.unlinkSync(optPath); } catch {}
  console.log('G — coreml + optimizedModelFilePath (write):');
  await loadOnce(modelPath, 'G1', {
    executionProviders: [{ name: 'coreml' }, 'cpu'],
    optimizedModelFilePath: optPath,
  });
  console.log(`     optimized file exists? ${fs.existsSync(optPath)} size=${fs.existsSync(optPath) ? fs.statSync(optPath).size : 0}`);
  console.log('G — load FROM the optimized file (graphOptimizationLevel=disabled):');
  if (fs.existsSync(optPath)) {
    await loadOnce(optPath, 'G2', {
      executionProviders: [{ name: 'coreml' }, 'cpu'],
      graphOptimizationLevel: 'disabled',
    });
  }

  console.log();
  console.log(`Cache dir contents (any non-empty means cache works):`);
  function walk(dir, indent = '  ') {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      console.log(`${indent}${name}  ${st.isDirectory() ? '(dir)' : `${st.size} B`}`);
      if (st.isDirectory()) walk(full, indent + '  ');
    }
  }
  try { walk(cacheDir); } catch (e) { console.log(`  (failed: ${e.message})`); }
}

main().catch(e => { console.error('FAIL:', e?.stack || e?.message || e); process.exit(1); });
