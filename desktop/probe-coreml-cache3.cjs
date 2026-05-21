// Probe 3: try the exact PascalCase provider-option keys the C++ side uses.
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
  const cacheDir = path.join(os.tmpdir(), 'aitools-coreml-cache-probe3');
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  console.log(`Model: ${modelPath}  (${(fs.statSync(modelPath).size/1e6).toFixed(1)} MB)`);
  console.log(`Cache dir: ${cacheDir}`);

  console.log('H — exact C++ PascalCase keys (ModelCacheDirectory):');
  await loadOnce(modelPath, 'H1', { executionProviders: [{ name: 'coreml', ModelCacheDirectory: cacheDir }, 'cpu'] });
  await loadOnce(modelPath, 'H2', { executionProviders: [{ name: 'coreml', ModelCacheDirectory: cacheDir }, 'cpu'] });

  console.log();
  console.log('Cache dir after H:');
  try {
    function walk(dir, indent = '  ') {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        console.log(`${indent}${name}  ${st.isDirectory() ? '(dir)' : `${st.size} B`}`);
        if (st.isDirectory()) walk(full, indent + '  ');
      }
    }
    walk(cacheDir);
  } catch (e) { console.log(`  (failed: ${e.message})`); }
}

main().catch(e => { console.error('FAIL:', e?.stack || e?.message || e); process.exit(1); });
