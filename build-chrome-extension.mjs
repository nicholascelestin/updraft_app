import { mkdir, cp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UPSCALER_MODELS } from './features/upscaler/model-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = __dirname;
const extRoot = path.join(repoRoot, 'chrome-extension');

const generatedDirs = [
  path.join(extRoot, 'src'),
  path.join(extRoot, 'models'),
  path.join(extRoot, 'vendor', 'onnxruntime'),
];

const copyPairs = [
  // Shared upscaler runtime code.
  ['features/upscaler/upscaler-engine.js', 'chrome-extension/src/upscaler-engine.js'],
  ['features/upscaler/gpu-tile-renderer.js', 'chrome-extension/src/gpu-tile-renderer.js'],
  ['features/upscaler/gpu-frame-extractor.js', 'chrome-extension/src/gpu-frame-extractor.js'],
  ['features/upscaler/tiling.js', 'chrome-extension/src/tiling.js'],
  ['features/upscaler/model-registry.js', 'chrome-extension/src/model-registry.js'],
  ['lib/fetch-progress.js', 'chrome-extension/src/fetch-progress.js'],

  // ONNX weights — derived from UPSCALER_MODELS (same paths as model `url` fields).
  ...UPSCALER_MODELS.map(m => [m.url, path.join('chrome-extension', m.url)]),
];

const ortFiles = [
  'ort.all.min.js',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

async function mustExist(absPath) {
  try {
    await stat(absPath);
  } catch {
    throw new Error(`Missing required file: ${path.relative(repoRoot, absPath)}`);
  }
}

async function copyFileRel(fromRel, toRel) {
  const fromAbs = path.join(repoRoot, fromRel);
  const toAbs = path.join(repoRoot, toRel);
  await mustExist(fromAbs);
  await mkdir(path.dirname(toAbs), { recursive: true });
  await cp(fromAbs, toAbs, { force: true });
  console.log(`copied ${fromRel} -> ${toRel}`);
}

async function main() {
  await mustExist(extRoot);

  for (const dir of generatedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const dir of generatedDirs) {
    await mkdir(dir, { recursive: true });
  }

  for (const [fromRel, toRel] of copyPairs) {
    await copyFileRel(fromRel, toRel);
  }

  for (const file of ortFiles) {
    await copyFileRel(
      path.join('node_modules', 'onnxruntime-web', 'dist', file),
      path.join('chrome-extension', 'vendor', 'onnxruntime', file)
    );
  }

  console.log('chrome-extension build complete.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
