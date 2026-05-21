// Preload — runs in an isolated world with Node access, exposes a narrow
// IPC surface on the renderer's window via contextBridge. lib/backend.js
// in the renderer calls these directly; there is no monkey-patching of
// ORT-Web's surface.

const { contextBridge, ipcRenderer } = require('electron');

// AITOOLS_NATIVE=0 keeps the renderer purely on ORT-Web (WebGPU/WASM) by
// not exposing the bridge at all. lib/backend.js checks for the presence of
// `globalThis.__nativeOrt` as the single signal that native is available.
if (process.env.AITOOLS_NATIVE !== '0') {
  function subscribe(channel) {
    return (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    };
  }

  contextBridge.exposeInMainWorld('__nativeOrt', {
    // load(key, modelBytes: ArrayBuffer, { intent: 'gpu' | 'cpu' })
    //   -> { inputNames, outputNames, rung }
    //   `intent` directly drives the host's EP-ladder filtering — 'cpu'
    //   restricts to CPU-only rungs; 'gpu' uses the full platform ladder.
    //   `rung` is the EP name the worker settled on (e.g. 'coreml/MLProgram',
    //   'dml', 'cuda', 'cpu'); the renderer combines it with the 'native-'
    //   prefix to form a realizedBackend label.
    load:    (key, modelBytes, opts) => ipcRenderer.invoke('ort:load', key, modelBytes, opts),
    // run(key, wireFeeds: Record<string, {type, dims, data: ArrayBuffer}>)
    //   -> Record<string, {type, dims, data: ArrayBuffer}>
    run:     (key, wireFeeds)  => ipcRenderer.invoke('ort:run', key, wireFeeds),
    // release(key) -> void
    release: (key)             => ipcRenderer.invoke('ort:release', key),
    // onMainLog(({ level, message }) => void) -> unsubscribe
    // Main-process diagnostics (worker spawn/exit, FATAL errors, worker
    // stdio). On GUI launches main's stdout/stderr go to /dev/null, so
    // without this channel we have no visibility into what main is doing.
    onMainLog: subscribe('main-log'),
    // onModelEvent(({ type, key, rung, reason }) => void) -> unsubscribe
    // Mid-load status from the worker side:
    //   - rung-fallback:  an EP failed (load or runtime); falling through
    //   - rung-skipped:   an EP was preemptively skipped (e.g., blacklisted)
    // 'success' events are emitted by the engine layer, not here.
    onModelEvent: subscribe('model-event'),
  });
}
