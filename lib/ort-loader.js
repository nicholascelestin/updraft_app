// Lazy loader for the ONNX Runtime Web global bundle (ort.all.min.js).
//
// ORT-Web is ~774 KB of parser-blocking JS that nothing needs until the user
// actually loads a model, so we keep it off the initial-load critical path and
// inject it on demand instead of via a <script> tag in index.html.
//
// ensureOrt() injects the classic (UMD) bundle exactly once and resolves with
// globalThis.ort. It's safe to call concurrently and repeatedly — every caller
// shares the same in-flight promise, and a settled load resolves immediately.
//
// The .wasm backends are still fetched lazily by ORT itself (via wasmPaths) on
// the first InferenceSession.create, so this loader only governs the JS glue.

let ortPromise = null;

function scriptUrl() {
  return (
    globalThis.__ORT_SCRIPT_URL__ ||
    new URL('vendor/onnxruntime-web/ort.all.min.js', document.baseURI).toString()
  );
}

/**
 * Ensure the ORT-Web global bundle is loaded.
 * @returns {Promise<object>} resolves with globalThis.ort
 */
export function ensureOrt() {
  if (globalThis.ort) return Promise.resolve(globalThis.ort);
  if (ortPromise) return ortPromise;

  ortPromise = new Promise((resolve, reject) => {
    const src = scriptUrl();
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      if (globalThis.ort) resolve(globalThis.ort);
      else reject(new Error(`[ort-loader] ${src} loaded but globalThis.ort is undefined`));
    };
    script.onerror = () => {
      // Drop the cached promise so a later call can retry (e.g. transient
      // network failure) rather than being stuck with a rejected singleton.
      ortPromise = null;
      reject(new Error(`[ort-loader] failed to load ${src}`));
    };
    document.head.appendChild(script);
  });

  return ortPromise;
}
