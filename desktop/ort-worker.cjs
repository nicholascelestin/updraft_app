// Child process that hosts onnxruntime-node sessions. Forked by main.cjs.
//
// Why a child process? Native ORT extensions (CoreML EP in particular)
// can SIGSEGV the host on certain transformer op patterns after a
// preceding compilation failure leaves their internal state corrupt.
// A JS-level uncaughtException handler can't catch signals from C++,
// so the host node process dies and Electron quits. Isolating ORT in
// a child means a SIGSEGV here only kills this process — the parent
// observes the death, rejects in-flight requests, and respawns us.
//
// Protocol (over Node IPC, serialize='advanced' so ArrayBuffers survive):
//   parent -> child:
//     { type: 'load', id, key, tmpPath, rungs: [{ name, config }] }
//     { type: 'run',  id, key, wireFeeds }
//     { type: 'release', id, key }
//   child -> parent:
//     { type: 'response', id, ok }     | success, ok = payload
//     { type: 'response', id, err }    | failure, err = string
//     { type: 'log', level, message }  | one-line status (no requestId)

const fs = require('fs');
const ort = require('onnxruntime-node');

const sessions = new Map(); // key -> { session, ep, tmpPath, rungs }

function log(level, message) {
  try { process.send({ type: 'log', level, message }); } catch {}
}

process.on('uncaughtException', (err) => {
  log('error', `uncaughtException: ${err?.stack || err?.message || String(err)}`);
  // Don't exit — let parent decide whether to respawn based on next signal.
});
process.on('unhandledRejection', (reason) => {
  log('error', `unhandledRejection: ${reason?.stack || reason?.message || String(reason)}`);
});

// Auto-die if the parent (Electron main) goes away. The IPC channel closes
// when the parent exits — gracefully or via SIGKILL / OS panic — at which
// point `disconnect` fires and we exit so the worker doesn't get orphaned
// by launchd/init and leak ~700 MB of model + ORT memory.
process.on('disconnect', () => {
  // Parent's gone. Release sessions and exit cleanly. No point logging —
  // there's no longer anyone listening.
  for (const entry of sessions.values()) {
    try { entry.session.release(); } catch {}
  }
  process.exit(0);
});

async function createSession(tmpPath, rungs) {
  let lastErr = null;
  for (const rung of rungs) {
    try {
      const session = await ort.InferenceSession.create(tmpPath, rung.config);
      return { session, ep: rung.name };
    } catch (e) {
      log('warn', `${rung.name} create failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error('All EP rungs failed');
}

// Wire-tensor decode table. Mirrors WIRE_DTYPES in inject.js — both sides
// use the same {ort-dtype-string -> TypedArray ctor} mapping.
const WIRE_DTYPES = {
  float32: Float32Array, float16: Uint16Array,
  int32: Int32Array, int64: BigInt64Array, uint8: Uint8Array,
};

function tensorFromWire(t) {
  const Arr = WIRE_DTYPES[t.type];
  if (!Arr) throw new Error(`Unsupported tensor type on wire: ${t.type}`);
  return new ort.Tensor(t.type, new Arr(t.data), t.dims);
}

function tensorToWire(t) {
  const ab = t.data.buffer.slice(t.data.byteOffset, t.data.byteOffset + t.data.byteLength);
  return { type: t.type, dims: t.dims, data: ab };
}

async function handleLoad({ key, tmpPath, rungs }) {
  if (sessions.has(key)) {
    const e = sessions.get(key);
    return { inputNames: e.session.inputNames, outputNames: e.session.outputNames, rung: e.ep };
  }
  const t0 = Date.now();
  const { session, ep } = await createSession(tmpPath, rungs);
  const dt = Date.now() - t0;
  sessions.set(key, { session, ep, tmpPath, rungs, firstRunDone: false });
  log('info', `loaded ${key} via ${ep} — session.create took ${dt}ms`);
  if (dt > 4000) {
    log('warn', `slow load — likely CoreML/EP graph compilation. Set AITOOLS_NATIVE_EP=cpu for cheaper startup at the cost of per-tile speed.`);
  }
  // Tell renderer which EP we settled on at load time. If first-run later
  // triggers a fallback, more rung-failed/rung-succeeded events follow.
  try { process.send({ type: 'rung-succeeded', key, rung: ep, phase: 'load' }); } catch {}
  return { inputNames: session.inputNames, outputNames: session.outputNames, rung: ep };
}

async function handleRun({ key, wireFeeds }) {
  const entry = sessions.get(key);
  if (!entry) throw new Error(`run: no session loaded for ${key}`);

  const tBuild = Date.now();
  const feeds = {};
  for (const [name, t] of Object.entries(wireFeeds)) feeds[name] = tensorFromWire(t);
  const buildMs = Date.now() - tBuild;

  while (true) {
    try {
      const tRun = Date.now();
      const outputs = await entry.session.run(feeds);
      const runMs = Date.now() - tRun;
      const tSerialize = Date.now();
      const result = {};
      for (const [name, t] of Object.entries(outputs)) result[name] = tensorToWire(t);
      const serializeMs = Date.now() - tSerialize;
      if (!entry.firstRunDone) {
        entry.firstRunDone = true;
        log('info', `first run for ${key}: build=${buildMs}ms run=${runMs}ms serialize=${serializeMs}ms (subsequent runs typically much faster as shader/kernel caches warm up)`);
      }
      return result;
    } catch (e) {
      const currentIdx = entry.rungs.findIndex(r => r.name === entry.ep);
      const remaining = entry.rungs.slice(currentIdx + 1);
      if (remaining.length === 0) {
        log('error', `${entry.ep} run failed, no more rungs to try`);
        throw e;
      }
      const failedRung = entry.ep;
      log('warn', `${failedRung} runtime error, trying remaining rungs [${remaining.map(r => r.name).join(', ')}]: ${e.message}`);
      // Tell main which rung blew up + why. Main persists a content-hash
      // blacklist entry for future loads AND forwards as a model-event
      // to the renderer for status-bar display.
      try {
        process.send({
          type: 'rung-failed',
          key,
          rung: failedRung,
          reason: String(e?.message || e || '').slice(0, 300),
        });
      } catch {}
      try { await entry.session.release(); } catch {}
      const { session, ep } = await createSession(entry.tmpPath, remaining);
      entry.session = session;
      entry.ep = ep;
      log('info', `now serving ${key} via ${ep}`);
      // The "we're running again" signal — multiple rung-failed events
      // may fire before the chain settles; rung-succeeded is the user's
      // cue that the upscale is proceeding on a working EP.
      try { process.send({ type: 'rung-succeeded', key, rung: ep }); } catch {}
    }
  }
}

async function handleRelease({ key }) {
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  try { await entry.session.release(); } catch {}
  try { fs.unlinkSync(entry.tmpPath); } catch {}
  return null;
}

process.on('message', async (msg) => {
  const { type, id } = msg || {};
  try {
    let ok;
    switch (type) {
      case 'load':    ok = await handleLoad(msg); break;
      case 'run':     ok = await handleRun(msg); break;
      case 'release': ok = await handleRelease(msg); break;
      case 'ping':    ok = { pong: true, sessions: sessions.size }; break;
      default: throw new Error(`unknown message type: ${type}`);
    }
    try { process.send({ type: 'response', id, ok }); } catch {}
  } catch (e) {
    const err = String(e?.message || e || 'unknown error').slice(0, 500);
    try { process.send({ type: 'response', id, err }); } catch {}
  }
});

log('info', 'worker ready');
