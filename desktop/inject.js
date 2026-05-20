// Runs in the renderer's main world (injected via webContents.executeJavaScript
// on every dom-ready). Patches ort.InferenceSession.create so that:
//
//   1. WebGPU EP requests throw immediately — the engine's existing
//      try-webgpu / catch -> wasm fallback then retries with WASM. By the
//      time the second attempt comes through us, the engine has set
//      activeBackend='wasm' and skipped GpuFrameExtractor/GpuTileRenderer
//      construction. The proxy session handles the actual inference.
//
//   2. Each session.run() ships its feed tensors' bytes to the main
//      process over IPC, awaits inference there, and rehydrates the
//      output tensors locally. Aitools' engine sees a normal
//      InferenceSession-shaped object and never knows.
//
// Custom-uploaded models (ArrayBuffer/Uint8Array sources) work the same as
// registry models — both reach create() as bytes, both ship over IPC once
// on load. The model-load IPC is a ~700 MB blip for TinySR; per-tile
// inference is a ~3 MB round-trip.

(function installNativeOrtPatch() {
  // Wire-tensor decode table. Mirrors WIRE_DTYPES in ort-worker.cjs —
  // both sides use the same {ort-dtype-string -> TypedArray ctor} mapping.
  const WIRE_DTYPES = {
    float32: Float32Array, float16: Uint16Array,
    int32: Int32Array, int64: BigInt64Array, uint8: Uint8Array,
  };

  const tryPatch = () => {
    const ort = globalThis.ort;
    const native = globalThis.__nativeOrt;
    if (!ort || !ort.InferenceSession || !ort.InferenceSession.create || !native) {
      return setTimeout(tryPatch, 25);
    }
    if (ort.InferenceSession.__nativePatched) return;

    // Surface main-process logs in DevTools — on GUI launches main's
    // stdio is /dev/null, so without this channel we're blind to spawn
    // failures, worker stderr, FATAL messages, etc.
    if (native.onMainLog) {
      native.onMainLog(({ level, message }) => {
        const fn = level === 'error' ? console.error
          : level === 'warn' ? console.warn : console.log;
        fn('%c[main]%c ' + message, 'background:#444;color:#fff;padding:0 4px;border-radius:2px', '');
      });
    }

    // Surface structured EP-fallback events to whichever <status-bar> is
    // currently visible. We dispatch a CustomEvent on `document` rather
    // than poking a specific instance — the status-bar component listens
    // for `aitools:status` and updates its own message. Aitools' own
    // pipeline still writes to status-bar.message directly during
    // upscale; that's fine, these EP events are brief transient notices
    // between aitools updates.
    if (native.onModelEvent) {
      const dispatchStatus = (msg) => {
        document.dispatchEvent(new CustomEvent('aitools:status', { detail: { message: msg, source: 'native-ep' } }));
        // Belt-and-suspenders: also log to console for debug visibility.
        console.log('%c[native EP]%c ' + msg, 'background:#264;color:#fff;padding:0 4px;border-radius:2px', '');
      };
      native.onModelEvent((ev) => {
        if (ev.type === 'rung-fallback') {
          const reason = ev.reason ? ` (${shortenReason(ev.reason)})` : '';
          dispatchStatus(`Native EP "${ev.rung}" failed${reason} — falling back…`);
        } else if (ev.type === 'rung-succeeded') {
          const phase = ev.phase === 'load' ? 'Loaded' : 'Now running';
          dispatchStatus(`${phase} on native EP: ${ev.rung}`);
        }
      });
    }

    function shortenReason(s) {
      // ORT error strings are often long and noisy. Pull the first useful
      // signal — usually a phrase like "Error in building plan" or
      // "Non-zero status code".
      const m = String(s).match(/Error in building plan|Non-zero status code returned|Failed to load|Could not create/i);
      return m ? m[0] : s.slice(0, 60);
    }

    if (!native.enabled) {
      console.log('[native-ort] disabled via AITOOLS_NATIVE=0 — using pure ORT-Web');
      ort.InferenceSession.__nativePatched = true; // mark so we don't retry
      return;
    }

    ort.InferenceSession.__nativePatched = true;
    const origCreate = ort.InferenceSession.create.bind(ort.InferenceSession);
    let modelSeq = 0;

    // After the first worker crash we stop trying native for the rest of
    // this page session. Subsequent InferenceSession.create calls fall
    // through to origCreate, so aitools gets a real WebGPU/WASM session
    // and any further upscale attempts work. The user can reload to
    // retry native, or set AITOOLS_NATIVE=0 to disable permanently.
    let autoDisabled = false;
    function isWorkerCrash(err) {
      const m = err && err.message;
      return !!m && /worker crashed|worker not available/i.test(m);
    }
    function tripAutoDisable(reason) {
      if (autoDisabled) return;
      autoDisabled = true;
      console.warn(`[native-ort] auto-disabled for this page session: ${reason}. Future models will use ORT-Web. Reload to retry native, or set AITOOLS_NATIVE=0 to bypass permanently.`);
    }

    ort.InferenceSession.create = async function patchedCreate(modelArg, opts = {}) {
      if (autoDisabled) return origCreate(modelArg, opts);

      const eps = opts.executionProviders || [];
      const wantsGpu = eps.some(ep =>
        (typeof ep === 'string' && ep === 'webgpu') ||
        (typeof ep === 'object' && ep && ep.name === 'webgpu'),
      );
      if (wantsGpu) {
        // Triggers UpscalerEngine.loadModel's webgpu -> wasm fallback,
        // which strips preferredOutputLocation and retries. We'll handle
        // the retry below.
        throw new Error('[native-ort] webgpu disabled; falling back to native EP');
      }

      // Convert all supported model-source shapes to a Uint8Array we can
      // send to the main process.
      let bytes = null;
      if (modelArg instanceof Uint8Array) {
        bytes = modelArg;
      } else if (modelArg instanceof ArrayBuffer) {
        bytes = new Uint8Array(modelArg);
      } else if (typeof modelArg === 'string') {
        const resp = await fetch(modelArg);
        if (!resp.ok) throw new Error(`failed to fetch model ${modelArg}: HTTP ${resp.status}`);
        bytes = new Uint8Array(await resp.arrayBuffer());
      } else {
        // Unrecognised shape — let the real ORT-Web handle it.
        return origCreate(modelArg, opts);
      }

      const key = `m${++modelSeq}_${bytes.length}`;
      // Slice creates an owned ArrayBuffer (structured-cloned across IPC).
      const transferable = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      let meta;
      try {
        meta = await native.load(key, transferable);
      } catch (e) {
        if (isWorkerCrash(e)) {
          tripAutoDisable(`worker crashed during load (${e.message})`);
          return origCreate(modelArg, opts);
        }
        throw e;
      }
      console.log(`[native-ort] session ${key}: ${meta.inputNames.join(',')} -> ${meta.outputNames.join(',')} via ${meta.rung}`);

      return makeProxySession(key, meta);
    };

    function makeProxySession(key, meta) {
      const inputMeta = meta.inputNames.map(name => ({
        name,
        type: 'tensor(float)',  // narrow assumption — aitools self-corrects from dims
        dimensions: [],
      }));
      const outputMeta = meta.outputNames.map(name => ({
        name,
        type: 'tensor(float)',
        dimensions: [],
      }));

      return {
        inputNames: meta.inputNames,
        outputNames: meta.outputNames,
        inputMetadata: inputMeta,
        outputMetadata: outputMeta,

        async run(feeds /*, runOptions */) {
          const wire = {};
          for (const [name, t] of Object.entries(feeds)) {
            // t is an ort.Tensor (cpu-backed). Its .data is a TypedArray
            // (Float32Array / Uint16Array for fp16 / etc.). Ship its
            // underlying ArrayBuffer slice.
            const data = t.data;
            const ab = data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            );
            wire[name] = { type: t.type, dims: t.dims, data: ab };
          }
          let raw;
          try {
            raw = await native.run(key, wire);
          } catch (e) {
            if (isWorkerCrash(e)) {
              // The crash already invalidated the worker-side session.
              // Auto-disable so subsequent CREATE calls go through
              // ORT-Web; this run still fails (we can't retry without
              // the original model bytes), but the next upscale attempt
              // will get a real WASM session and complete.
              tripAutoDisable(`worker crashed mid-run (${e.message})`);
            }
            throw e;
          }
          const out = {};
          for (const [name, t] of Object.entries(raw)) {
            const Arr = WIRE_DTYPES[t.type];
            if (!Arr) throw new Error(`[native-ort] unsupported output tensor type: ${t.type}`);
            const tensor = new ort.Tensor(t.type, new Arr(t.data), t.dims);
            // ORT-Web tensor objects have .dispose() that we no-op here —
            // GC handles the underlying TypedArray.
            if (typeof tensor.dispose !== 'function') tensor.dispose = () => {};
            out[name] = tensor;
          }
          return out;
        },

        async release() { try { await native.release(key); } catch {} },
        startProfiling() {},
        endProfiling() {},
      };
    }
  };

  tryPatch();
})();
