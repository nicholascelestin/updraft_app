/**
 * Unified channel for inference-backend narrative events. Both the web-mode
 * engine (when it tries WebGPU then falls back to WASM) and the native
 * desktop bridge (when its EP ladder tries CoreML/CUDA/DML then falls back
 * to CPU) emit events on `document` with the same shape:
 *
 *   document.dispatchEvent(new CustomEvent('aitools:backend-event', {
 *     detail: {
 *       kind:    'attempt' | 'success' | 'fallback' | 'skipped',
 *       backend: string,           // canonical EP name
 *       reason?: string,           // short failure or skip reason
 *     }
 *   }));
 *
 * `trackBackendEvents()` lets a feature orchestrator subscribe for the
 * duration of one run, then ask for a summary on completion.
 */

const CHANNEL = 'aitools:backend-event';

export function dispatchBackendEvent(detail) {
  document.dispatchEvent(new CustomEvent(CHANNEL, { detail }));
}

export function trackBackendEvents(onEvent) {
  const events = [];
  const handler = (e) => {
    events.push(e.detail);
    onEvent?.(e.detail);
  };
  document.addEventListener(CHANNEL, handler);
  return {
    stop() { document.removeEventListener(CHANNEL, handler); },
    events: () => events.slice(),
    summary() {
      let activeBackend = null;
      let hadFallback = false;
      let hadSkip = false;
      const lines = [];
      for (const e of events) {
        if (e.kind === 'success') {
          activeBackend = e.backend || activeBackend;
        } else if (e.kind === 'fallback') {
          hadFallback = true;
          const friendly = friendlyBackend(e.backend);
          lines.push(e.reason ? `Failed on ${friendly}: ${e.reason}` : `Failed on ${friendly}`);
        } else if (e.kind === 'skipped') {
          hadSkip = true;
          const friendly = friendlyBackend(e.backend);
          lines.push(e.reason ? `Skipped ${friendly} (${e.reason})` : `Skipped ${friendly}`);
        }
      }
      return { activeBackend, hadFallback, hadSkip, lines };
    },
  };
}

/**
 * Trim a runtime error message down to the first useful signal phrase, or
 * the first 120 chars if no known phrase matches. ORT/native errors tend
 * to be long and noisy; the tooltip wants something compact.
 */
export function shortenReason(e) {
  const s = String(e?.message || e || '');
  const m = s.match(/Error in building plan|Non-zero status code returned|Failed to load|Could not create|cannot be reshaped|Unexpected input data type|kernel.*not.*found/i);
  if (m) return m[0];
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

/**
 * True if the realized backend label denotes a GPU-class execution provider.
 *
 * 'web-webgpu' counts; everything 'native-*' except 'native-cpu' counts
 * (coreml / dml / cuda / rocm all run on the GPU or neural accelerator).
 * 'web-wasm' and 'native-cpu' are CPU.
 *
 * Used by status-bar logic to detect intent/reality mismatches like
 * "user asked for GPU but a warm CPU session is what's actually serving".
 */
export function realizedIsGpu(backend) {
  if (!backend) return false;
  if (backend === 'web-wasm' || backend === 'native-cpu') return false;
  return true;
}

/**
 * Map a realized backend identifier to a user-facing label.
 *
 * The canonical shape produced by lib/backend.js is two-part: a mode prefix
 * (`web-` or `native-`) plus the concrete EP. We unpack both — the prefix
 * tells the user whether they're on the browser stack or the native one,
 * which materially affects perf and error shape.
 *
 *   'web-webgpu'              → 'WebGPU'
 *   'web-wasm'                → 'CPU (WASM)'
 *   'native-cpu'              → 'CPU (native)'
 *   'native-cuda'             → 'CUDA'
 *   'native-rocm'             → 'ROCm'
 *   'native-dml'              → 'DirectML'
 *   'native-coreml/MLProgram' → 'CoreML (MLProgram)'
 *
 * Legacy values from before the refactor are also accepted so a half-migrated
 * caller doesn't render "unknown".
 */
export function friendlyBackend(b) {
  if (!b) return 'unknown';

  // New-style two-part labels.
  if (b === 'web-webgpu') return 'WebGPU';
  if (b === 'web-wasm')   return 'CPU (WASM)';
  if (b.startsWith('native-')) {
    const ep = b.slice('native-'.length);
    if (ep === 'cpu')  return 'CPU (native)';
    if (ep === 'cuda') return 'CUDA';
    if (ep === 'rocm') return 'ROCm';
    if (ep === 'dml')  return 'DirectML';
    if (ep.startsWith('coreml')) {
      const variant = ep.includes('/') ? ep.split('/')[1] : null;
      return variant ? `CoreML (${variant})` : 'CoreML';
    }
    return ep;
  }

  // Legacy single-token forms (kept for any not-yet-migrated callers).
  if (b === 'webgpu')              return 'WebGPU';
  if (b === 'wasm' || b === 'cpu') return 'CPU';
  if (b === 'cuda')                return 'CUDA';
  if (b === 'dml')                 return 'DirectML';
  if (b.startsWith('coreml')) {
    const variant = b.includes('/') ? b.split('/')[1] : null;
    return variant ? `CoreML (${variant})` : 'CoreML';
  }
  return b;
}
