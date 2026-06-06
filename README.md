# Updraft

Browser-based AI image tools that run entirely on your machine. Two
features today: a super-resolution **Upscaler** and **Background Removal**.
Models run client-side via [ONNX Runtime Web](https://onnxruntime.ai/);
images never leave the page.

## Run it

```sh
npm start        # serves the static site on :8081
```

No build step. It's a static site of ES modules and Web Components, wired
through an import map in `index.html`. Open it, pick a feature, drop an image.

## How it works

**Upscaler.** Drop an image, optionally crop, select a model, hit Upscale, click to compare, download.

The work is a tiled pipeline (`features/upscaler/upscale-pipeline.js`):

- The image is cut into overlapping tiles so big images fit in VRAM. Each
  tile is run through the model; tiles are feathered back together to hide
  seams (`engine/tiling.js`, `engine/upscaler-engine.js`).
- The pipeline is a list of optional **steps** over a shared context: base
  upscale, a second model for side-by-side comparison, an all-image blend
  pass, and face detect → per-face enhance. Each step declares
  `shouldRun(ctx)`, so disabled passes cost nothing.
- Models come from a registry of built-in ONNX files
  (`model-registry.js`), plus your own: upload an `.onnx`, it's inspected
  for I/O shape, scale, and precision (`inspect-onnx.js`), then cached in
  the browser Cache API and treated like any built-in.

**Background removal** is simpler: one segmentation model produces an alpha
mask that's composited over transparency (`features/bg-removal/`).

## Backends

Engines ask `lib/backend.js` for a session with an *intent* — `gpu` or
`cpu` — and get back a session plus a label of what actually ran. The web
path uses ORT-Web's WebGPU EP, falling back to WASM. Fallbacks and the
realized backend surface in the status bar (`lib/backend-events.js`).

## Desktop (optional, faster)

An Electron wrapper in `desktop/` routes inference through
`onnxruntime-node` with native execution providers — CoreML on macOS, CUDA
on NVIDIA, DirectML on Windows — for a 3–10× speedup. The renderer is
unchanged: `lib/backend.js` dispatches to native only when Electron's
preload exposes `window.__nativeOrt`. See [`desktop/README.md`](./desktop/README.md).

## Layout

```
index.html              # entry: import map + feature switcher
features/upscaler/       # pipeline, tiling/inference engines, UI
features/bg-removal/     # segmentation engine + UI
components/              # shared Web Components (cropper, sliders, status)
lib/                     # backend dispatch, model cache, ORT loader, canvas utils
desktop/                 # Electron native-acceleration wrapper
vendor/                  # ORT-Web, PicoCSS, Font Awesome (no package manager)
```
