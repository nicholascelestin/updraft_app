#!/usr/bin/env bash
# Mirror CDN dependencies into vendor/ for fully-offline operation.
#
# Run this once after cloning, and again whenever you bump versions.
# The downloaded files are committed to the repo — at ~82 MB this is
# reasonable for the value they add (no third-party CDN dependency at
# runtime, and a packaged desktop app can run with no network).
#
# To bump a version: edit the constants below, re-run, commit.

set -euo pipefail
cd "$(dirname "$0")/.."

# ─────── Pinned versions ───────
PICOCSS_VER="2"            # https://github.com/picocss/pico
FA_VER="6.5.2"             # https://cdnjs.com/libraries/font-awesome
IDIOMORPH_VER="0.3.0"      # https://github.com/bigskysoftware/idiomorph
ORT_WEB_VER="1.24.3"       # https://github.com/microsoft/onnxruntime
FFLATE_VER="0.8.2"         # https://github.com/101arrowz/fflate

# ─────── Layout ───────
mkdir -p \
  vendor/picocss \
  vendor/font-awesome/css \
  vendor/font-awesome/webfonts \
  vendor/idiomorph \
  vendor/onnxruntime-web \
  vendor/fflate

# ─────── Downloads (parallel) ───────
echo "Fetching $(tput bold)CSS frameworks and JS libs$(tput sgr0)..."
(
  curl -sSfL -o vendor/picocss/pico.min.css \
    "https://cdn.jsdelivr.net/npm/@picocss/pico@${PICOCSS_VER}/css/pico.min.css" &
  curl -sSfL -o vendor/font-awesome/css/all.min.css \
    "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/${FA_VER}/css/all.min.css" &
  curl -sSfL -o vendor/idiomorph/idiomorph.min.js \
    "https://cdn.jsdelivr.net/npm/idiomorph@${IDIOMORPH_VER}/dist/idiomorph.min.js" &
  curl -sSfL -o vendor/onnxruntime-web/ort.all.min.js \
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VER}/dist/ort.all.min.js" &
  # NB: esm/browser.js, not esm/index.mjs — the latter imports Node's
  # 'module' builtin and won't load in a browser.
  curl -sSfL -o vendor/fflate/index.mjs \
    "https://cdn.jsdelivr.net/npm/fflate@${FFLATE_VER}/esm/browser.js" &
  wait
)

echo "Fetching $(tput bold)Font Awesome webfonts$(tput sgr0)..."
(
  for f in fa-solid-900 fa-regular-400 fa-brands-400 fa-v4compatibility; do
    for ext in woff2 ttf; do
      curl -sSfL -o "vendor/font-awesome/webfonts/${f}.${ext}" \
        "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/${FA_VER}/webfonts/${f}.${ext}" &
    done
  done
  wait
)

echo "Fetching $(tput bold)ORT-Web WASM blobs + loader shims$(tput sgr0)..."
# Each WASM target has a sibling .mjs loader that the main ort.all bundle
# dynamically imports (not optional — ORT 1.24+ requires both .wasm and
# .mjs to be reachable at wasmPaths). Variants:
#   .jsep         — WebGPU EP via JSEP (the main path for accelerated inference)
#   (plain)       — CPU fallback (used when WebGPU is unavailable)
#   .asyncify     — emscripten asyncify variant (older concurrency)
#   .jspi         — JSPI variant (newer concurrency, Chrome 123+)
# We mirror all four so any browser the desktop app's renderer ships
# with can load the right one offline.
(
  for v in '' '.jsep' '.asyncify' '.jspi'; do
    for ext in wasm mjs; do
      f="ort-wasm-simd-threaded${v}.${ext}"
      curl -sSfL -o "vendor/onnxruntime-web/${f}" \
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VER}/dist/${f}" &
    done
  done
  wait
)

echo "Done."
echo
du -sh vendor/*
echo
echo "Total: $(du -sh vendor | cut -f1)"
