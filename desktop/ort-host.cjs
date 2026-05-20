// Native ORT host — owns the inference-extension domain inside the
// Electron host process. Responsibilities:
//
//   1. Spawn and supervise a system-Node child process (`ort-worker.cjs`)
//      that hosts onnxruntime-node. (Required because ORT-Node SIGTRAPs
//      when loaded inside Electron's binary — see README §"Why a separate
//      Node?".)
//   2. Register and serve the `ort:load` / `ort:run` / `ort:release` IPC
//      channels the renderer uses (via preload's `__nativeOrt`).
//   3. Manage the per-platform EP fallback ladder.
//   4. Persist a CoreML blacklist keyed on model content-hash so models
//      known to fail CoreML at runtime skip the expensive 4–10s graph
//      compile on subsequent loads.
//   5. Forward worker rung events (`rung-failed`, `rung-succeeded`) to the
//      renderer's status bar via the injected `notifyModelEvent` callback.
//
// Lifecycle (called by main.cjs):
//   const host = createOrtHost({ userDataDir, log, notifyModelEvent });
//   // ... renderer talks to host via ipcRenderer.invoke('ort:*', ...) ...
//   host.evictAll();   // on renderer navigation (reload)
//   host.shutdown();   // on app before-quit

const { ipcMain } = require('electron');
const { fork, execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DIR = path.join(os.tmpdir(), 'aitools-desktop');
fs.mkdirSync(TMP_DIR, { recursive: true });

// Override switch for debugging: AITOOLS_NATIVE_EP=cpu npm run app
const FORCED_EP = (process.env.AITOOLS_NATIVE_EP || '').toLowerCase() || null;

// ───── helpers ───────────────────────────────────────────────────────────

function trim(str, max = 2000) {
  const s = String(str);
  return s.length > max ? s.slice(0, max) + `…(truncated, ${s.length - max} more chars)` : s;
}
function fmtErr(e) {
  if (!e) return '(null)';
  if (e.stack) return trim(e.stack);
  return trim(e.message || String(e));
}

// ───── System Node detection ─────────────────────────────────────────────
//
// The ORT worker MUST run under plain Node, not Electron-as-Node.
//
// Why: onnxruntime-node's native binary SIGTRAPs at `session.run()` time
// when loaded inside Electron's binary (even with ELECTRON_RUN_AS_NODE=1).
// Reproduced with: CPU EP, UltraSharp V2 (a DAT model), known-good 256x256
// input — works under system node, dies under electron. Suspected cause is
// some interaction between ORT's native code and Electron's mach-exception
// / signal-handler / V8 isolate setup (Electron's binary has
// allow-jit/disable-library-validation entitlements, so it's not a plain
// hardened-runtime block — something subtler).

function findSystemNode() {
  // Honour explicit override first.
  if (process.env.AITOOLS_NODE_PATH) return process.env.AITOOLS_NODE_PATH;

  // `node` via PATH first — works when launched from a shell (e.g. `npm
  // run app` from a Terminal where nvm/fnm have set up PATH). DOES NOT
  // work for GUI launches (Finder, Spotlight, `open Electron.app`) which
  // inherit launchd's minimal PATH (usually /usr/bin:/bin:...).
  const candidates = ['node'];

  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  } else if (process.platform === 'linux') {
    candidates.push('/usr/local/bin/node', '/usr/bin/node', '/snap/bin/node');
  } else if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const lad = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      `${pf}\\nodejs\\node.exe`,
      lad && `${lad}\\Programs\\nodejs\\node.exe`,
    );
  }

  // Version-manager fallbacks: nvm / fnm / volta. None of these put Node
  // on the GUI launch PATH, so we enumerate their install dirs ourselves.
  // Each entry is [versions-root, ...trailing-segments-to-the-node-binary].
  // Newest version first within each root.
  const home = os.homedir();
  const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
  const versionManagerRoots = [
    [path.join(home, '.nvm', 'versions', 'node'),                                          'bin', nodeBin],
    [path.join(home, '.local', 'share', 'fnm', 'node-versions'),                           'installation', 'bin', nodeBin],
    [process.env.FNM_DIR && path.join(process.env.FNM_DIR, 'node-versions'),               'installation', 'bin', nodeBin],
    [process.env.APPDATA && path.join(process.env.APPDATA, 'fnm', 'node-versions'),        'installation', 'bin', nodeBin],
    [path.join(home, '.volta', 'tools', 'image', 'node'),                                  'bin', nodeBin],
  ];
  for (const [root, ...tail] of versionManagerRoots) {
    if (!root) continue;
    try {
      if (!fs.existsSync(root)) continue;
      for (const v of fs.readdirSync(root).filter(v => /^v?\d/.test(v)).sort().reverse()) {
        candidates.push(path.join(root, v, ...tail));
      }
    } catch {}
  }

  for (const c of candidates.filter(Boolean)) {
    try {
      // execSync goes through the platform shell (sh on POSIX, cmd.exe on
      // Windows). Quoting `c` handles paths with spaces on Windows.
      const out = execSync(`"${c}" --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^v\d+/.test(out)) return c;
    } catch {}
  }
  return null;
}

// ───── EP ladder ─────────────────────────────────────────────────────────
// JSON-serialisable so per-model rungs pass over Node IPC unchanged. The
// worker walks this on runtime failures.

const CPU_RUNG = { name: 'cpu', config: { executionProviders: ['cpu'] } };
const EP_LADDERS = {
  darwin: [
    { name: 'coreml/MLProgram',     config: { executionProviders: [{ name: 'coreml', modelFormat: 'MLProgram', mlComputeUnits: 'CPUAndGPU' }, 'cpu'] } },
    { name: 'coreml/NeuralNetwork', config: { executionProviders: [{ name: 'coreml' }, 'cpu'] } },
    CPU_RUNG,
  ],
  win32: [
    { name: 'cuda', config: { executionProviders: ['cuda', 'cpu'] } },
    { name: 'dml',  config: { executionProviders: ['dml',  'cpu'] } },
    CPU_RUNG,
  ],
  linux: [
    { name: 'cuda', config: { executionProviders: ['cuda', 'cpu'] } },
    { name: 'rocm', config: { executionProviders: ['rocm', 'cpu'] } },
    CPU_RUNG,
  ],
};

function epLadder() {
  if (FORCED_EP) return [{ name: FORCED_EP, config: { executionProviders: [FORCED_EP] } }];
  return EP_LADDERS[process.platform] || [CPU_RUNG];
}

// ───── Model content hash (for CoreML blacklist key) ─────────────────────

function modelHash(bytes) {
  // 4 KB from the start, 4 KB from the end, plus the total length —
  // collision-resistant enough for a per-user blacklist while staying
  // cheap (~ms even for huge models).
  const view = new Uint8Array(bytes);
  const h = crypto.createHash('sha256');
  h.update(view.subarray(0, Math.min(4096, view.length)));
  if (view.length > 4096) {
    h.update(view.subarray(view.length - 4096, view.length));
  }
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(view.length));
  h.update(lenBuf);
  return h.digest('hex').slice(0, 16);
}

// ───── Host factory ──────────────────────────────────────────────────────

/**
 * Create the native ORT host. Spawns the worker, registers IPC handlers,
 * and returns the lifecycle hooks main.cjs needs.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 *   Electron's `app.getPath('userData')` — used for the persistent
 *   CoreML blacklist file.
 * @param {(level: string, message: string) => void} opts.log
 *   Buffered writer to the renderer's `main-log` channel. Used for
 *   worker spawn / exit / FATAL notices that the user needs to see in
 *   DevTools on GUI launches.
 * @param {(payload: object) => void} opts.notifyModelEvent
 *   Best-effort writer to the renderer's `model-event` channel. Used
 *   for rung-fallback / rung-succeeded status notices.
 * @returns {{ evictAll: () => void, shutdown: () => void }}
 */
function createOrtHost({ userDataDir, log, notifyModelEvent }) {
  const SYSTEM_NODE = findSystemNode();

  // ───── Persistent CoreML blacklist ─────────────────────────────────────
  //
  // CoreML can spend 4–10s compiling a partitioned graph and then fail at
  // the very first session.run() (DAT-family transformers do this — "Error
  // in building plan" on partition N). Without memory across reloads we'd
  // re-pay that compile every time. We persist failed model content hashes
  // and strip CoreML rungs from the ladder for those models on subsequent
  // loads. Deleting the JSON resets the blacklist.
  const blacklistFile = path.join(userDataDir, 'coreml-blacklist.json');
  let blacklist = new Set();

  try {
    const raw = fs.readFileSync(blacklistFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) blacklist = new Set(parsed);
  } catch {
    blacklist = new Set();
  }
  if (blacklist.size) {
    console.log(`[blacklist] loaded ${blacklist.size} CoreML-incompatible model hash(es) from ${blacklistFile}`);
  }

  function saveBlacklist() {
    try {
      fs.mkdirSync(path.dirname(blacklistFile), { recursive: true });
      fs.writeFileSync(blacklistFile, JSON.stringify(Array.from(blacklist), null, 2), 'utf8');
    } catch (e) {
      console.warn(`[blacklist] save failed: ${fmtErr(e)}`);
    }
  }

  // ───── Worker state ────────────────────────────────────────────────────
  let worker = null;
  let workerReady = false;
  let nextReqId = 1;
  const pending = new Map();          // id -> { resolve, reject }
  const knownSessions = new Map();    // key -> { tmpPath, rungs, hash }

  // Respawn rate limiting. Workers that survive >CRASH_RESET_AFTER_MS reset
  // the streak; consecutive short-lived exits indicate a fundamental startup
  // error (missing native dep, arch mismatch). Give up after a few in a row
  // and let the renderer fall through to ORT-Web.
  let lastSpawnAt = 0;
  let consecutiveCrashes = 0;
  const MAX_CONSECUTIVE_CRASHES = 3;
  const CRASH_RESET_AFTER_MS = 30000;
  let respawnGivenUp = false;

  function spawnWorker() {
    if (respawnGivenUp) return;
    if (worker) {
      try { worker.removeAllListeners(); } catch {}
      try { worker.kill(); } catch {}
    }
    lastSpawnAt = Date.now();
    if (!SYSTEM_NODE) {
      const msg = '[FATAL] No system `node` binary found. Native ORT inference disabled.\n'
        + '        Tried: PATH lookup + ' + (process.platform === 'darwin'
          ? '/opt/homebrew/bin/node, /usr/local/bin/node, /usr/bin/node, '
          : process.platform === 'linux' ? '/usr/local/bin/node, /usr/bin/node, /snap/bin/node, '
          : 'C:\\Program Files\\nodejs\\node.exe, ')
        + 'plus ~/.nvm, ~/.local/share/fnm, ~/.volta.\n'
        + '        On GUI launches (double-click .app), shell-installed Node (nvm/fnm) is NOT visible.\n'
        + '        Fix: install Node via Homebrew (`brew install node`) or set AITOOLS_NODE_PATH.\n'
        + '        Aitools will run in WebGPU/WASM mode only — no native acceleration.';
      console.error(msg);
      log('error', msg);
      return;
    }
    worker = fork(path.join(__dirname, 'ort-worker.cjs'), [], {
      execPath: SYSTEM_NODE,
      // 'advanced' serializer is required for ArrayBuffer / TypedArray
      // values to survive parent<->child IPC.
      serialization: 'advanced',
      // Capture stdio so we can forward worker output to the renderer
      // (without this, on GUI launches the worker's stderr — including
      // any preflight failure that exits with code 1 — vanishes into
      // /dev/null and the renderer just sees "worker crashed").
      silent: true,
      env: { ...process.env },
    });
    workerReady = true;
    const msg = `[worker] forked pid=${worker.pid} via ${SYSTEM_NODE}`;
    console.log(msg);
    log('info', msg);

    // Forward worker stdio to renderer with a tag. Lots of output goes
    // here (ORT can be chatty), so we don't echo to main's stdout twice.
    worker.stdout?.on('data', (buf) => {
      log('info', `[worker:stdout] ${buf.toString().trimEnd()}`);
    });
    worker.stderr?.on('data', (buf) => {
      // ORT emits some informational warnings to stderr; tag as warn not error.
      log('warn', `[worker:stderr] ${buf.toString().trimEnd()}`);
    });

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'log') {
        const tag = `[worker:${msg.level || 'info'}]`;
        const m = msg.message || '';
        if (msg.level === 'error') console.error(`${tag} ${m}`);
        else if (msg.level === 'warn') console.warn(`${tag} ${m}`);
        else console.log(`${tag} ${m}`);
        return;
      }
      if (msg.type === 'rung-failed') {
        // A CoreML (or other accelerator) rung blew up at runtime for a
        // known session — record its content hash so future loads skip
        // that rung entirely. Saves ~4-10s of wasted graph-compilation
        // per page reload for diffusion / DAT-family models.
        const entry = knownSessions.get(msg.key);
        if (entry && msg.rung && msg.rung.startsWith('coreml') && !blacklist.has(entry.hash)) {
          blacklist.add(entry.hash);
          saveBlacklist();
          console.log(`[blacklist] +${entry.hash} (${msg.key}) — CoreML failed at runtime; future loads will skip CoreML rungs for this model`);
        }
        // Surface to the user's status bar so they can see "this model is
        // having to fall back" rather than just observing wall-clock pauses.
        notifyModelEvent({
          type: 'rung-fallback',
          key: msg.key,
          rung: msg.rung,
          reason: msg.reason || null,
        });
        return;
      }
      if (msg.type === 'rung-succeeded') {
        notifyModelEvent({
          type: 'rung-succeeded',
          key: msg.key,
          rung: msg.rung,
        });
        return;
      }
      if (msg.type === 'response') {
        const slot = pending.get(msg.id);
        if (!slot) return;
        pending.delete(msg.id);
        if (msg.err) slot.reject(new Error(msg.err));
        else slot.resolve(msg.ok);
      }
    });

    worker.on('exit', (code, signal) => {
      workerReady = false;
      const aliveMs = Date.now() - lastSpawnAt;
      const exitMsg = `[worker] exited code=${code} signal=${signal || '(none)'} after ${aliveMs}ms alive — ${pending.size} pending request(s) will be rejected`;
      console.error(exitMsg);
      log('error', exitMsg);

      // Reject all in-flight requests so the renderer surfaces the failure.
      const err = new Error(`ORT worker crashed (signal=${signal || 'none'}, code=${code}). This model hits a native EP bug in onnxruntime-node. Native will auto-disable for this page session; reload or retry the upscale to use ORT-Web instead. Permanent bypass: AITOOLS_NATIVE=0 npm run app.`);
      for (const { reject } of pending.values()) {
        try { reject(err); } catch {}
      }
      pending.clear();
      knownSessions.clear();

      if (aliveMs > CRASH_RESET_AFTER_MS) consecutiveCrashes = 0;
      consecutiveCrashes++;
      if (consecutiveCrashes > MAX_CONSECUTIVE_CRASHES) {
        respawnGivenUp = true;
        const giveUpMsg = `[worker] ${consecutiveCrashes} crashes in quick succession — abandoning respawn. Native inference disabled for this session. Reload the page to retry, or set AITOOLS_NATIVE=0 to silence.`;
        console.error(giveUpMsg);
        log('error', giveUpMsg);
        return;
      }

      // Back-off scales with how immediately the worker died — short-lived
      // workers get longer delays so we don't spin if it's an instant fail.
      const delay = aliveMs < 1000 ? 2000 : 200;
      setTimeout(spawnWorker, delay);
    });

    worker.on('error', (err) => {
      console.error(`[worker] ipc error: ${fmtErr(err)}`);
    });
  }

  function ask(type, payload) {
    if (!worker || !workerReady) {
      return Promise.reject(new Error('ORT worker not available (still spawning or crashed)'));
    }
    const id = nextReqId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.send({ type, id, ...payload }, (err) => {
          if (err) {
            pending.delete(id);
            reject(err);
          }
        });
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  // ───── IPC handlers (forward to worker) ──────────────────────────────

  function handle(channel, fn) {
    ipcMain.handle(channel, async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        console.error(`[${channel}] handler error: ${fmtErr(e)}`);
        throw new Error(trim(e?.message || String(e), 500));
      }
    });
  }

  handle('ort:load', async (_evt, key, modelBytes) => {
    if (knownSessions.has(key)) {
      // Already loaded in the worker — re-issue the load command (it's
      // idempotent worker-side) so the renderer gets the same metadata.
      const { tmpPath, rungs } = knownSessions.get(key);
      return ask('load', { key, tmpPath, rungs });
    }
    if (!(modelBytes instanceof ArrayBuffer)) {
      throw new Error(`ort:load expected ArrayBuffer model bytes, got ${typeof modelBytes}`);
    }
    // Write the model to disk in main, then hand the path off to the worker.
    // This means the giant 687 MB IPC blip stops at main; the worker just
    // reads from disk. (We don't pipe bytes across the parent->child pipe
    // because Node IPC's framing isn't great for buffers that size.)
    const tmpPath = path.join(TMP_DIR, `${key}.onnx`);
    const mb = (modelBytes.byteLength / 1e6).toFixed(1);
    const hash = modelHash(modelBytes);
    const tWrite = Date.now();
    await fs.promises.writeFile(tmpPath, Buffer.from(modelBytes));
    const writeMs = Date.now() - tWrite;
    let rungs = epLadder();
    let skippedCoreml = false;
    if (blacklist.has(hash)) {
      const before = rungs.length;
      rungs = rungs.filter(r => !r.name.startsWith('coreml'));
      skippedCoreml = before > rungs.length;
    }
    knownSessions.set(key, { tmpPath, rungs, hash });
    const skipNote = skippedCoreml ? ' [skipping CoreML; hash blacklisted from prior runtime failure]' : '';
    console.log(`[ort-native] handing ${key} (${mb} MB) to worker — fs.write took ${writeMs}ms${skipNote}`);
    try {
      const tLoad = Date.now();
      const result = await ask('load', { key, tmpPath, rungs });
      console.log(`[ort-native] worker.load total round-trip ${Date.now() - tLoad}ms`);
      return result;
    } catch (e) {
      knownSessions.delete(key);
      try { fs.unlinkSync(tmpPath); } catch {}
      throw e;
    }
  });

  // First-tile latency is logged by the worker (build/run/serialize split);
  // no need to re-time end-to-end here.
  handle('ort:run', async (_evt, key, wireFeeds) => {
    if (!knownSessions.has(key)) {
      throw new Error(`ort:run: no session loaded for ${key} (was the worker restarted?)`);
    }
    return ask('run', { key, wireFeeds });
  });

  handle('ort:release', async (_evt, key) => {
    if (!knownSessions.has(key)) return;
    const { tmpPath } = knownSessions.get(key);
    knownSessions.delete(key);
    try { await ask('release', { key }); } catch {}
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  // Boot the worker.
  spawnWorker();

  // ───── Lifecycle hooks for main ──────────────────────────────────────

  function evictAll() {
    if (knownSessions.size === 0) return;
    console.log(`[reload] evicting ${knownSessions.size} session(s) before navigation`);
    for (const [key, { tmpPath }] of knownSessions.entries()) {
      ask('release', { key }).catch(() => {});
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    knownSessions.clear();
  }

  function shutdown() {
    console.log(`[ort-host] shutdown — ${knownSessions.size} session(s) loaded`);
    for (const { tmpPath } of knownSessions.values()) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    knownSessions.clear();
    // Kill the worker eagerly; we don't need a graceful release on quit.
    try { worker && worker.kill('SIGTERM'); } catch {}
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  }

  return { evictAll, shutdown };
}

module.exports = { createOrtHost };
