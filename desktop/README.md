# aitools-desktop

Desktop wrapper that runs aitools' static site locally and routes ONNX
inference through `onnxruntime-node` with native execution providers
(CoreML on macOS, CUDA on NVIDIA, DirectML on Windows GPUs, CPU fallback).

Built on Electron, but `desktop/` rather than `electron/` because (a)
this is also where the in-browser desktop-app packager lives (so users
can produce a downloadable build of aitools from the web app), and (b)
Electron doesn't extend to mobile platforms — the dir name reflects its
scope honestly.

The aitools tree (`..`) is **not modified** — this directory is fully
separable. The wrapper:

1. Serves `../` over HTTP on a random localhost port.
2. Opens a `BrowserWindow` against it.
3. Injects a small monkey-patch into the renderer that intercepts
   `ort.InferenceSession.create` so per-tile `session.run(...)` calls
   IPC into the Node main process, where native ORT does the work.

The aitools renderer thinks it's loading from a normal HTTP origin and
calling ORT-Web. The fact that inference is happening in Node is invisible
to every line of code under `../features/`, `../components/`, `../lib/`.

## Requirements

- **Node.js on `PATH`.** The ORT worker has to be forked under plain
  Node, not under Electron's binary — see [Why a separate Node?](#why-a-separate-node)
  below. If `which node` prints a path, you're set. Set `AITOOLS_NODE_PATH`
  to override.
- macOS / Linux / Windows.

## Use it (dev workflow)

```sh
cd desktop
npm install      # one-time
npm run app
```

Cmd+R inside the window reloads the renderer like a browser. Only main.cjs
or preload.cjs changes need `npm run app` to restart.

## Use it (downloadable build from the web app)

The aitools header has a **"Desktop"** link that opens a modal. The modal:
1. Detects platform (with an override dropdown for cross-building).
2. Lists every model in the registry + custom uploads with checkboxes —
   tiny built-ins (<10 MB) pre-checked, the rest opt-in.
3. On Download, fetches the Electron framework (from
   `cdn.npmmirror.com/binaries/electron/`), the `onnxruntime-node` tarball
   (from `registry.npmjs.org`), and the current aitools static tree (from
   the same origin via Resource Timing crawl), then composes a single zip.

Versions of the binary deps are pinned in [`versions.lock.json`](./versions.lock.json).
URL templates live in the same file — swap the CDN by editing the
`electronUrl` / `ortNodeUrl` fields, no code change.

### macOS install (one-time `xattr` step)

The downloaded `.zip` extracts via Finder's Archive Utility, which
propagates the browser's quarantine xattr to extracted contents. Gatekeeper
sees Electron's linker-signed ad-hoc binary inside a bundle whose
`_CodeSignature/` we had to strip (because we modify
`Contents/Resources/app/`) and reports the laconic "Electron is damaged
and can't be opened" error.

The one-line fix the install hint in the modal already shows:

```sh
xattr -cr Electron.app && open Electron.app
```

That strips quarantine. macOS then doesn't try to verify the
signature, and the bundle launches. Subsequent launches double-click
normally; macOS records the override.

The "proper" fix is a full ad-hoc re-sign of the bundle (recompute
`CodeResources` plist, rewrite the binary's `LC_CODE_SIGNATURE` blob with a
fresh `CodeDirectory`). That's ~300 LOC of careful pure-JS work or
~1.5–3 MB of WASM (compiling the Rust `apple-codesign` crate). Tracked as
a future improvement; not blocking for a self-hosted dev tool.

## What's accelerated

Every model the aitools registry loads, plus custom-uploaded ones. The
first call to a model ships its bytes over IPC once (~1–3 s for the 687 MB
TinySR fp16 ONNX). After that, per-tile inference is a ~3 MB IPC
round-trip — negligible against compute time.

Expect 3–8× speedup over ORT-Web's WebGPU EP on Apple Silicon (CoreML),
3–10× on NVIDIA (CUDA), 2–4× on Windows GPUs (DirectML).

## EP ladder

On `ort:load`, the loader tries a platform-specific sequence and walks
down on either create-time or runtime failure:

- **macOS**: `coreml/MLProgram (CPUAndGPU)` → `coreml/NeuralNetwork` → `cpu`
- **Windows**: `cuda` → `dml` → `cpu`
- **Linux**: `cuda` → `rocm` → `cpu`

CoreML can fail at `session.run()` time (not create time) with
*"Error in building plan"* on certain transformer op patterns — that's
why each rung is paired with `'cpu'` in the same `executionProviders`
array (lets ORT partition unsupported ops to CPU within one session),
and why an *unhandled* runtime error triggers a recreate against the
next rung.

Override the ladder, pick a Node binary, or bypass native entirely:

```sh
AITOOLS_NATIVE=0     npm run app   # disable native runtime; pure ORT-Web
AITOOLS_NATIVE_EP=cpu npm run app   # native enabled, force CPU EP only
AITOOLS_NATIVE_EP=coreml npm run app # native enabled, force CoreML only
AITOOLS_NODE_PATH=/path/to/node npm run app  # override Node detection
AITOOLS_DEVTOOLS=1   npm run app   # auto-open DevTools on launch
```

## When native doesn't work for a model

Some models trip native EP bugs (DAT-family transformers and similar
shifted-window architectures are known offenders even on the CPU EP).
The recovery flow:

1. Worker crashes mid-tile → renderer surfaces a clear error.
2. The inject script *auto-disables* native runtime for the rest of the
   page session. Subsequent `InferenceSession.create` calls fall through
   to vanilla ORT-Web (WebGPU/WASM).
3. Retry the upscale — it'll use ORT-Web from now on.

To skip native from the start (e.g. you know you're using a DAT model):

```sh
AITOOLS_NATIVE=0 npm run app
```

Aitools then behaves exactly like a plain browser load.

## Why a separate Node?

`onnxruntime-node`'s native binary SIGTRAPs at `session.run()` time
when loaded inside Electron's binary, even with `ELECTRON_RUN_AS_NODE=1`.

Reproducer (with this directory installed): same model, same input,
same CPU EP — works under plain Node, crashes under Electron.

```sh
# Crashes:
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron debug-model.cjs \
    ../models/4x-UltraSharpV2.onnx 256 cpu
# Works:
node debug-model.cjs ../models/4x-UltraSharpV2.onnx 256 cpu
```

Electron's binary has `allow-jit` and `disable-library-validation`
entitlements, so it's not a plain hardened-runtime block. The actual
cause is some interaction between ORT's native code and Electron's
mach-exception handlers / V8 isolate setup — bypassed entirely by
just using plain Node.

So: main spawns `ort-worker.cjs` via `fork(execPath: <system node>)`,
the worker hosts onnxruntime-node, and main proxies IPC between the
renderer and the worker. The aitools renderer is unchanged.

## Persistent CoreML blacklist

CoreML's MLProgram and NeuralNetwork formats spend 4–10s compiling a
partitioned graph eagerly during `session.create`, and DAT-family
transformers reliably fail at `session.run` time afterwards ("Error in
building plan"). Without memory across reloads, we'd re-pay that
8–10s of wasted compile every page reload.

So: when a CoreML rung errors at runtime, main records the model's
content-hash in:

```
<userData>/coreml-blacklist.json
```

`<userData>` resolves per-platform via Electron's `app.getPath('userData')`:

- macOS: `~/Library/Application Support/Electron/coreml-blacklist.json`
- Linux: `~/.config/Electron/coreml-blacklist.json`
- Windows: `%APPDATA%\Electron\coreml-blacklist.json`

On the next load of the same model bytes, the EP ladder is pre-filtered
to skip CoreML rungs entirely — straight to CPU. Look for
`[skipping CoreML; hash blacklisted from prior runtime failure]` in the
terminal.

To re-enable CoreML for previously-failed models (e.g. after an OS
upgrade or a new ORT version that might support them), delete the file.
The hash is computed from a small slice of the model bytes (first 4 KB
+ last 4 KB + total length), so identical models on the same machine
share a blacklist entry.

## Crash isolation

Even with the right Node binary, native EPs (CoreML especially) can
still SIGSEGV on certain transformer op patterns. The worker dies, but
main and renderer survive: main rejects all in-flight requests with a
clear error and respawns the worker. Aitools' EnginePool reloads its
model on the next upscale click, so this is usually invisible.

The worker also auto-exits if Electron dies hard (Force Quit, SIGKILL,
OS panic): the IPC channel closes, `process.on('disconnect')` fires,
the worker releases sessions and exits. No orphaned `node` processes
holding gigabytes of model weights.

## Cross-platform

The wrapper is platform-agnostic in its design and confirmed to work
where `onnxruntime-node` ships native binaries:

| Platform        | Status    | Native EPs available             |
|-----------------|-----------|----------------------------------|
| macOS arm64     | confirmed | CoreML + CPU                     |
| macOS x64       | should work (untested) | CoreML + CPU        |
| Linux x64       | should work (untested) | CUDA / ROCm / CPU   |
| Linux arm64     | should work (untested) | CPU (+ CUDA on Jetson) |
| Windows x64     | should work (untested) | CUDA / DirectML / CPU |
| Windows arm64   | should work (untested) | DirectML / CPU      |

Per-platform fallbacks are in place for Node detection (`node` on PATH,
plus typical install locations on each OS) and EP ladder selection (CUDA
preferred on Linux, DirectML on Windows, CoreML on macOS). Set
`AITOOLS_NODE_PATH` if `node` isn't on PATH in your launch context.

For end-user distribution rather than dev launch, you'd want to bundle
a Node binary (e.g. via `pkg`, `nexe`, or embedding) so users don't
need to install Node themselves — out of scope here.

You'll see worker death in the terminal as:

```
[worker] exited code=null signal=SIGSEGV — N pending request(s) will be rejected
[worker] forked pid=<new>
```

If you see repeated SIGSEGVs on the same model, try `AITOOLS_NATIVE_EP=cpu`
to skip CoreML entirely for that session.

## Diagnostics

The main process logs (in the terminal where you ran `npm run app`) cover:

- `[ort-native] loaded m1_... via <ep>` — which rung handled each model.
- `[ort-native] <ep> runtime error, falling to <next>` — fallback chain.
- `[renderer] gone — reason=...` — if the page process dies (crash, OOM,
  GPU process loss). Most useful failure signal.
- `[renderer] unresponsive / responsive` — long synchronous work in the
  page (usually long inference + readback).
- `[child-process] <type> gone` — GPU / utility / pepper subprocess
  crashes, separate from the main renderer.
- `[reload] evicting N session(s)` — Cmd+R nuked cached sessions so the
  next load doesn't return stale data under a recycled key.
- `[FATAL] uncaughtException / unhandledRejection` — caught by global
  guards instead of crashing the main process. Look here first.

## Tearing it out

`rm -rf desktop/` — aitools is byte-identical to its web-only form.

## How it stays out of aitools' way

- The renderer loads `../` over HTTP, same as `serve` would.
- `desktop/preload.cjs` exposes `window.__nativeOrt` (IPC surface) via
  `contextBridge`. Aitools never touches this.
- `desktop/inject.js` is injected on `dom-ready` and monkey-patches
  `ort.InferenceSession.create`:
  - WebGPU EP requests throw immediately, which triggers
    `UpscalerEngine.loadModel`'s existing `try webgpu / catch -> wasm`
    fallback. Because `activeBackend` is then `'wasm'`, the engine never
    constructs `GpuFrameExtractor` or `GpuTileRenderer` — the existing CPU
    readback code path runs unchanged.
  - The subsequent WASM-EP create call gets intercepted instead. The
    patch ships the model bytes to the main process, returns a proxy
    session whose `.run(feeds)` IPCs each per-tile inference to native.

No files under `../` change. The aitools tests, the web build, the `serve`
workflow — all unaffected.
