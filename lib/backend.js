// Unified session loader for inference engines. One entry point, two arms.
//
//   loadSession(bytes, intent, opts) -> { session, realizedBackend }
//
//   intent          'gpu' | 'cpu'                          — what the user wants
//   realizedBackend 'web-webgpu' | 'web-wasm'              — what actually ran
//                 | 'native-cpu' | 'native-coreml/...'     — (display only)
//                 | 'native-dml' | 'native-cuda' | ...
//
// Callers (the engines) shouldn't need to know whether we're running native
// (Electron + onnxruntime-node) or web (browser + ort-web). They pass intent
// in; they get a session-shaped object out plus a string label of what it's
// running on. No magic options-bag properties, no synthesised exceptions to
// drive control flow, no monkey-patching of ORT-Web's surface.

import { dispatchBackendEvent, shortenReason } from 'lib/backend-events';

// ───── Mode detection ──────────────────────────────────────────────────────
// `__nativeOrt` is installed by desktop/preload.cjs only when the renderer is
// running inside Electron *and* AITOOLS_NATIVE isn't explicitly disabled. Its
// presence is the entire signal — no `enabled` flag to interrogate.

export function isNativeMode() {
  return !!globalThis.__nativeOrt;
}

// ───── Auto-disable on worker crash ────────────────────────────────────────
// If the native worker crashes mid-session, we trip a one-way switch so the
// rest of this page's loads fall through to the web path. Same semantics as
// the old inject.js `tripAutoDisable`, just lifted here.

let nativeAutoDisabled = false;

function isWorkerCrash(err) {
  const m = err && err.message;
  return !!m && /worker crashed|worker not available|native ort unavailable/i.test(m);
}

// ───── Wire tensor codec ───────────────────────────────────────────────────
// Mirrors WIRE_DTYPES in ort-worker.cjs.

const WIRE_DTYPES = {
  float32: Float32Array, float16: Uint16Array,
  int32: Int32Array, int64: BigInt64Array, uint8: Uint8Array,
};

// ───── Public entry point ──────────────────────────────────────────────────

/**
 * Load a model and return a session-shaped object plus the realized backend.
 *
 * @param {Uint8Array|ArrayBuffer} modelBytes
 * @param {'gpu'|'cpu'} intent
 * @param {{
 *   profile?: boolean,
 *   preferredOutputLocation?: 'gpu-buffer' | 'cpu',
 *   graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all',
 * }} [opts]
 *   `preferredOutputLocation` is forwarded only on the web-webgpu path; it
 *   enables zero-readback output tensors for the upscaler's GPU fast path.
 *   Ignored on web-wasm and on native.
 *   `graphOptimizationLevel` defaults to 'all'. Callers may pass 'disabled'
 *   to prevent fp16 graphs from being fused into ops the WebGPU EP only
 *   registers for fp32 (e.g. com.microsoft.FusedConv).
 * @returns {Promise<{ session: object, realizedBackend: string }>}
 */
export async function loadSession(modelBytes, intent, opts = {}) {
  if (intent !== 'gpu' && intent !== 'cpu') {
    throw new Error(`loadSession: unknown intent ${JSON.stringify(intent)} (expected 'gpu' or 'cpu')`);
  }
  if (isNativeMode() && !nativeAutoDisabled) {
    try {
      return await loadNative(modelBytes, intent);
    } catch (e) {
      if (isWorkerCrash(e)) {
        nativeAutoDisabled = true;
        console.warn(`[backend] native ORT auto-disabled for this page session: ${e.message} Future loads use ORT-Web. Reload to retry native.`);
        // Fall through to web path so this load still has a chance.
      } else {
        throw e;
      }
    }
  }
  return loadWeb(modelBytes, intent, opts);
}

// ───── Native arm ──────────────────────────────────────────────────────────

let nativeSeq = 0;

async function loadNative(modelBytes, intent) {
  const transferable = toArrayBuffer(modelBytes);
  const key = `m${++nativeSeq}_${transferable.byteLength}`;
  // Host emits attempt/fallback/skipped events via the model-event channel
  // (forwarded to backend-events by desktop/inject.js). We don't synthesise
  // an attempt here — let the worker's actual rung outcomes speak.
  const meta = await globalThis.__nativeOrt.load(key, transferable, { intent });
  console.log(`[backend] native session ${key}: ${meta.inputNames.join(',')} -> ${meta.outputNames.join(',')} via ${meta.rung}`);
  return {
    session: makeNativeSession(key, meta),
    realizedBackend: `native-${meta.rung}`,
  };
}

function makeNativeSession(key, meta) {
  // ORT-Web sessions expose inputMetadata / outputMetadata as arrays of
  // {name, type, dimensions}; the engines self-correct from dims so a narrow
  // 'tensor(float)' placeholder is fine.
  const inputMetadata  = meta.inputNames.map(name => ({ name, type: 'tensor(float)', dimensions: [] }));
  const outputMetadata = meta.outputNames.map(name => ({ name, type: 'tensor(float)', dimensions: [] }));

  return {
    inputNames: meta.inputNames,
    outputNames: meta.outputNames,
    inputMetadata,
    outputMetadata,

    async run(feeds /*, runOptions */) {
      const wire = {};
      for (const [name, t] of Object.entries(feeds)) {
        const data = t.data;
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        wire[name] = { type: t.type, dims: t.dims, data: ab };
      }
      let raw;
      try {
        raw = await globalThis.__nativeOrt.run(key, wire);
      } catch (e) {
        if (isWorkerCrash(e)) {
          // Native is now dead for this page. The caller's current run still
          // fails (we can't reload mid-session-run), but subsequent loadSession
          // calls will fall through to the web path via nativeAutoDisabled.
          nativeAutoDisabled = true;
          console.warn(`[backend] native ORT auto-disabled mid-run: ${e.message}`);
        }
        throw e;
      }
      const out = {};
      for (const [name, t] of Object.entries(raw)) {
        const Arr = WIRE_DTYPES[t.type];
        if (!Arr) throw new Error(`[backend] unsupported output tensor type: ${t.type}`);
        const ortGlobal = globalThis.ort;
        const tensor = new ortGlobal.Tensor(t.type, new Arr(t.data), t.dims);
        if (typeof tensor.dispose !== 'function') tensor.dispose = () => {};
        out[name] = tensor;
      }
      return out;
    },

    async release() {
      try { await globalThis.__nativeOrt.release(key); } catch {}
    },
    startProfiling() {},
    endProfiling() {},
  };
}

// ───── Web arm ─────────────────────────────────────────────────────────────

async function loadWeb(modelBytes, intent, { profile = false, preferredOutputLocation, graphOptimizationLevel } = {}) {
  const ort = globalThis.ort;
  if (!ort) throw new Error('[backend] ort-web is not loaded — include vendor/onnxruntime-web/ort.all.min.js before using loadSession');

  ort.env.wasm.wasmPaths =
    globalThis.__ORT_WASM_PATHS__ ||
    new URL('vendor/onnxruntime-web/', document.baseURI).toString();
  ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

  // ort.env.webgpu.profilingMode is global; clear when not profiling so a
  // prior run can't leave it stuck on.
  if (ort.env.webgpu) {
    ort.env.webgpu.profilingMode = (profile && intent === 'gpu') ? 'default' : 'off';
  }

  const sessionOpts = {
    // 'all' enables every fusion/layout pass. Caller can override (e.g. fp16
    // models pass 'disabled' to prevent Conv+PRelu → com.microsoft.FusedConv,
    // which the WebGPU EP has only fp32 kernels for).
    graphOptimizationLevel: graphOptimizationLevel || 'all',
    ...(profile && { enableProfiling: true }),
  };

  if (intent === 'gpu') {
    sessionOpts.executionProviders = [{ name: 'webgpu', preferredLayout: 'NCHW' }];
    if (preferredOutputLocation) sessionOpts.preferredOutputLocation = preferredOutputLocation;
    dispatchBackendEvent({ kind: 'attempt', backend: 'web-webgpu' });
    try {
      const session = await ort.InferenceSession.create(modelBytes, sessionOpts);
      dispatchBackendEvent({ kind: 'success', backend: 'web-webgpu' });
      return { session, realizedBackend: 'web-webgpu' };
    } catch (e) {
      console.warn(`[backend] WebGPU failed, falling back to WASM. Reason:`, e);
      dispatchBackendEvent({ kind: 'fallback', backend: 'web-webgpu', reason: shortenReason(e) });
      // Strip WebGPU-only opts before retrying on WASM.
      delete sessionOpts.preferredOutputLocation;
    }
  }

  sessionOpts.executionProviders = ['wasm'];
  dispatchBackendEvent({ kind: 'attempt', backend: 'web-wasm' });
  const session = await ort.InferenceSession.create(modelBytes, sessionOpts);
  dispatchBackendEvent({ kind: 'success', backend: 'web-wasm' });
  return { session, realizedBackend: 'web-wasm' };
}

// ───── helpers ─────────────────────────────────────────────────────────────

function toArrayBuffer(modelBytes) {
  if (modelBytes instanceof ArrayBuffer) return modelBytes;
  if (modelBytes instanceof Uint8Array) {
    return modelBytes.buffer.slice(modelBytes.byteOffset, modelBytes.byteOffset + modelBytes.byteLength);
  }
  throw new Error(`[backend] modelBytes must be ArrayBuffer or Uint8Array, got ${typeof modelBytes}`);
}
