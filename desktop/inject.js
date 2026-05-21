// Runs in the renderer's main world (injected via webContents.executeJavaScript
// on every dom-ready). Two responsibilities now:
//
//   1. Forward main-process diagnostic logs (`main-log` IPC) to DevTools so
//      users debugging GUI launches can see what main and the worker are
//      doing. On GUI launches main's stdio is /dev/null, so without this
//      channel we'd be blind to spawn failures, FATAL errors, etc.
//
//   2. Translate native-side rung events into the renderer's
//      `aitools:backend-event` channel so the status bar can surface
//      fallbacks and skips. The status bar speaks one canonical event
//      shape regardless of mode — this is the desktop-side bridge.
//
// Session loading lives in lib/backend.js. No monkey-patching of ORT-Web's
// surface from here.

(function installNativeOrtEventBridge() {
  // The presence of __nativeOrt is the entire "native available" signal.
  // desktop/preload.cjs only exposes it when AITOOLS_NATIVE!=='0'.
  const native = globalThis.__nativeOrt;
  if (!native) return;

  // Forward main-process logs to DevTools. Tag them so they're easy to spot
  // alongside renderer-originated logs.
  if (native.onMainLog) {
    native.onMainLog(({ level, message }) => {
      const fn = level === 'error' ? console.error
        : level === 'warn' ? console.warn : console.log;
      fn('%c[main]%c ' + message, 'background:#444;color:#fff;padding:0 4px;border-radius:2px', '');
    });
  }

  // Translate native rung events into aitools:backend-event so the
  // orchestrator's tracker (lib/backend-events) sees them. The realized
  // backend label uses the 'native-' prefix to distinguish from web EPs.
  if (native.onModelEvent) {
    const dispatch = (detail) => {
      document.dispatchEvent(new CustomEvent('aitools:backend-event', { detail }));
      console.log('%c[native EP]%c ' + JSON.stringify(detail), 'background:#264;color:#fff;padding:0 4px;border-radius:2px', '');
    };
    native.onModelEvent((ev) => {
      const realized = ev.rung ? `native-${ev.rung}` : 'native-unknown';
      if (ev.type === 'rung-fallback') {
        dispatch({ kind: 'fallback', backend: realized, reason: shortenReason(ev.reason) });
      } else if (ev.type === 'rung-skipped') {
        dispatch({ kind: 'skipped', backend: realized, reason: ev.reason });
      } else if (ev.type === 'rung-succeeded') {
        dispatch({ kind: 'success', backend: realized });
      }
    });
  }

  function shortenReason(s) {
    // Native ORT error strings are noisy; pull the first useful phrase if we
    // recognise one, else truncate.
    const m = String(s || '').match(/Error in building plan|Non-zero status code returned|Failed to load|Could not create/i);
    return m ? m[0] : String(s || '').slice(0, 60);
  }
})();
