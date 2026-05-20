// Preload — runs in an isolated world with Node access, exposes a narrow
// IPC surface on the renderer's window via contextBridge. The actual
// monkey-patch of ort.InferenceSession.create happens in inject.js, which
// runs in the renderer's main world.

const { contextBridge, ipcRenderer } = require('electron');

// AITOOLS_NATIVE=0 disables native runtime entirely for this session;
// the inject script bails out without installing the patch, and aitools
// gets vanilla ORT-Web (WebGPU/WASM) like a plain browser.
const NATIVE_ENABLED = process.env.AITOOLS_NATIVE !== '0';

function subscribe(channel) {
  return (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('__nativeOrt', {
  enabled: NATIVE_ENABLED,
  // load(key, modelBytes: ArrayBuffer) -> { inputNames, outputNames, rung }
  //   `rung` is the EP-ladder rung name (e.g. 'coreml/MLProgram', 'cpu')
  //   that the worker settled on. Not equivalent to ort.js's `backend`
  //   ('wasm'/'webgpu') — this is desktop-coined vocabulary.
  load:    (key, modelBytes) => ipcRenderer.invoke('ort:load', key, modelBytes),
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
  // Structured user-facing events for the upscaler status bar:
  //   - rung-succeeded:  the EP that actually started running (after any fallbacks)
  //   - rung-fallback:   an EP errored mid-run; we're moving to the next ladder rung
  onModelEvent: subscribe('model-event'),
});
