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
//   4. Track a per-session CoreML blacklist keyed on model content-hash so
//      models that fail CoreML at runtime skip the expensive 4–10s graph
//      compile on subsequent loads *within the same launch*. Cleared on
//      every app open.
//   5. Keep worker sessions warm across renderer reloads by indexing the
//      worker's session map by content hash (not by the renderer's per-page
//      m1/m2 keys, which reset on reload). A reload that re-loads the same
//      model pays nothing — no fs.write, no IPC blob, no EP recompile.
//      Bounded by AITOOLS_NATIVE_MAX_SESSIONS (default 2) with LRU eviction.
//   6. Forward worker rung events (`rung-failed`, `rung-succeeded`) to the
//      renderer's status bar via the injected `notifyModelEvent` callback.
//
// Lifecycle (called by main.cjs):
//   const host = createOrtHost({ userDataDir, log, notifyModelEvent });
//   // ... renderer talks to host via ipcRenderer.invoke('ort:*', ...) ...
//   host.evictAll();   // on renderer navigation — clears key bindings only;
//                      // sessions stay loaded in the worker.
//   host.shutdown();   // on app before-quit — releases all sessions.

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

  // Bundled Node, shipped inside the .app/.exe by the desktop downloader.
  // Lets users without a system Node install still get native ORT. Takes
  // precedence over system Node so we get the version this build was
  // tested against (avoids surprises from a too-new or too-old system
  // Node binary).
  const bundledNode = path.join(
    __dirname, 'node',
    process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'),
  );
  try {
    if (fs.existsSync(bundledNode)) {
      const out = execSync(`"${bundledNode}" --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^v\d+/.test(out)) return bundledNode;
    }
  } catch {}

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
  // Windows: DirectML only. CUDA is intentionally not in the default ladder
  // because its setup is fragile (requires matching CUDA Toolkit + cuDNN
  // versions on the host), and a misconfigured CUDA EP loads but performs
  // poorly — masking itself as a working "cuda" rung. DML works on any
  // DX12-capable GPU (NVIDIA / AMD / Intel / integrated) with no external
  // install. Users with a verified CUDA setup can opt in via
  // AITOOLS_NATIVE_EP=cuda (the env var still works, see epLadder below).
  win32: [
    { name: 'dml', config: { executionProviders: ['dml', 'cpu'] } },
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

  // ───── Per-session CoreML blacklist ────────────────────────────────────
  //
  // CoreML can spend 4–10s compiling a partitioned graph and then fail at
  // the very first session.run() (DAT-family transformers do this — "Error
  // in building plan" on partition N). Within one app session we remember
  // those failed model content hashes and strip CoreML rungs from the ladder
  // for subsequent loads, so each failing model only pays the wasted compile
  // once per launch. Intentionally NOT persisted across launches — a clean
  // slate each app open avoids stale entries lingering after a model or ORT
  // upgrade changes the failure shape.
  const blacklist = new Set();

  // Best-effort cleanup of the persistence file used by older builds. Not
  // strictly necessary (we never read it), but leaves userData tidy.
  const legacyBlacklistFile = path.join(userDataDir, 'coreml-blacklist.json');
  try { fs.unlinkSync(legacyBlacklistFile); } catch {}

  // ───── Worker state ────────────────────────────────────────────────────
  let worker = null;
  let workerReady = false;
  let nextReqId = 1;
  const pending = new Map();          // id -> { resolve, reject }

  // The renderer assigns per-page-session keys (m1, m2, …) that reset on
  // every reload. We can't key the worker's session map by those — a reload
  // would lose the binding even though the model bytes are identical. Index
  // the worker's sessions by a composite cache key instead: content hash +
  // intent ('gpu' uses the full EP ladder; 'cpu' restricts to CPU-only).
  // Including intent means picking "CPU" in the backend selector doesn't
  // silently reuse a previously-compiled GPU session.
  // Net effect: reload-with-same-model-and-intent is free (no fs.write, no
  // session.create, no EP compile).
  const keyToCacheKey = new Map();    // rendererKey -> cacheKey
  const sessionsByKey = new Map();    // cacheKey -> { hash, modelPath, rungs, ep, inputNames, outputNames, lastUsed }

  function makeCacheKey(hash, intent) {
    // intent is 'gpu' or 'cpu'; we keep both in the key so a CPU-only load
    // doesn't reuse a previously-compiled GPU session for the same model.
    return `${hash}/${intent}`;
  }

  // Cap on simultaneous worker-side sessions. Each loaded SR model can be
  // 700+ MB of weights plus the EP's compiled artifacts. 2 covers the common
  // case (foreground model + previously-used one); raise via env var if you
  // routinely flip between more.
  const MAX_LIVE_SESSIONS = Math.max(1, parseInt(process.env.AITOOLS_NATIVE_MAX_SESSIONS || '2', 10));

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
        // A CoreML (or other accelerator) rung blew up — either while loading
        // (phase=create) or mid-run (phase=runtime). Remember its content
        // hash so other loads of the same model in this session skip that
        // rung. The blacklist is session-only (cleared on app restart), so
        // this only saves the wasted compile on repeats *within* a launch.
        // The worker sends hash explicitly — no parsing of the cacheKey.
        const hash = msg.hash;
        if (hash && msg.rung && msg.rung.startsWith('coreml') && !blacklist.has(hash)) {
          blacklist.add(hash);
          console.log(`[blacklist] +${hash} — CoreML failed (${msg.phase || 'runtime'}); future loads in this session will skip CoreML rungs for this model`);
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
        // The worker can swap rungs internally on a runtime failure (CoreML
        // tile blows up, next tile served by CPU). Keep our cached `ep` in
        // sync so the hot-path on the *next* load (e.g., after a brief
        // GPU→CPU→GPU flip) reports the rung that's actually serving, not
        // the one we originally compiled.
        const entry = sessionsByKey.get(msg.key);
        if (entry && msg.rung && entry.ep !== msg.rung) {
          console.log(`[ort-native] session ${msg.key} migrated ${entry.ep} → ${msg.rung}`);
          entry.ep = msg.rung;
        }
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
      // Worker is gone — every cached session went with it.
      sessionsByKey.clear();
      keyToCacheKey.clear();

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

  // Build a specific error message for the renderer when the worker is
  // unavailable, so DevTools shows what the user can do about it instead
  // of a generic "worker not available." All variants start with
  // "Native ORT unavailable:" — the renderer's isWorkerCrash matcher
  // keys on that prefix to fall back to ORT-Web for the run.
  function workerUnavailableReason() {
    if (!SYSTEM_NODE) {
      const win = process.platform === 'win32';
      const mac = process.platform === 'darwin';
      const installHint = win
        ? 'Install Node.js LTS from https://nodejs.org/ (the official MSI)'
        : mac
        ? 'Install Node via Homebrew (`brew install node`) or download from https://nodejs.org/'
        : 'Install Node via your package manager or from https://nodejs.org/';
      return `Native ORT unavailable: Node.js is not installed on this system. ${installHint}, then restart the app. (You can also set AITOOLS_NODE_PATH to point at a specific node binary.)`;
    }
    if (respawnGivenUp) {
      return `Native ORT unavailable: worker crashed ${consecutiveCrashes} times in a row; native acceleration disabled for this session. Set AITOOLS_NATIVE_EP=cpu to bypass GPU rungs, or AITOOLS_NATIVE=0 to skip native entirely.`;
    }
    return 'Native ORT unavailable: worker still spawning or has crashed.';
  }

  function ask(type, payload) {
    if (!worker || !workerReady) {
      return Promise.reject(new Error(workerUnavailableReason()));
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

  // Evict worker sessions past the cap, oldest-touched first. Each release
  // round-trips to the worker and frees the model + EP artifacts on the
  // worker side; the host's on-disk hash-keyed file stays around so a future
  // cold load is still cheaper than the original (skips fs.write).
  async function evictLruSessions() {
    while (sessionsByKey.size > MAX_LIVE_SESSIONS) {
      let oldestKey = null, oldestT = Infinity;
      for (const [k, ent] of sessionsByKey.entries()) {
        if (ent.lastUsed < oldestT) { oldestT = ent.lastUsed; oldestKey = k; }
      }
      if (!oldestKey) break;
      const ent = sessionsByKey.get(oldestKey);
      sessionsByKey.delete(oldestKey);
      // Any renderer keys still pointing at this cacheKey become dangling
      // — clear them so a later run() doesn't hit a phantom binding. In
      // practice this is rare: the renderer typically loads its
      // currently-selected model last, which is the LRU-newest.
      for (const [k, ck] of keyToCacheKey.entries()) {
        if (ck === oldestKey) keyToCacheKey.delete(k);
      }
      try { await ask('release', { key: oldestKey }); } catch {}
      console.log(`[lru] evicted ${oldestKey} (last used ${Math.round((Date.now() - ent.lastUsed) / 1000)}s ago; cap=${MAX_LIVE_SESSIONS})`);
    }
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

  handle('ort:load', async (_evt, rendererKey, modelBytes, loadOpts) => {
    if (!(modelBytes instanceof ArrayBuffer)) {
      throw new Error(`ort:load expected ArrayBuffer model bytes, got ${typeof modelBytes}`);
    }
    const hash = modelHash(modelBytes);
    const mb = (modelBytes.byteLength / 1e6).toFixed(1);
    // `intent` is the explicit signal the renderer's lib/backend.js sends:
    // 'gpu' (use full EP ladder) or 'cpu' (CPU-only). The cacheKey carries
    // it so a CPU-only load doesn't reuse a previously-compiled GPU session
    // for the same model bytes.
    const intent = loadOpts?.intent === 'cpu' ? 'cpu' : 'gpu';
    const cacheKey = makeCacheKey(hash, intent);

    // Hot path: same model + same intent already loaded in the worker
    // (possibly under a previous renderer key from before a reload). Skip
    // the fs.write, the IPC blob, and — most importantly — the CoreML/DML
    // compile.
    if (sessionsByKey.has(cacheKey)) {
      const ent = sessionsByKey.get(cacheKey);
      ent.lastUsed = Date.now();
      keyToCacheKey.set(rendererKey, cacheKey);
      console.log(`[ort-native] reuse session ${cacheKey} for ${rendererKey} (${mb} MB, no recompile)`);
      // Mirror the cold-load behavior: tell the renderer which EP is now
      // serving this key. The worker only emits rung-succeeded after a real
      // session.create — without this, hot-path loads would have no
      // realized-backend signal for the status bar.
      notifyModelEvent({ type: 'rung-succeeded', key: rendererKey, rung: ent.ep, phase: 'load' });
      return { inputNames: ent.inputNames, outputNames: ent.outputNames, rung: ent.ep };
    }

    // Cold path. Write the model to disk in main under a hash-keyed name,
    // then hand the path off to the worker. The giant 687 MB IPC blip stops
    // at main; the worker just reads from disk. (We don't pipe bytes across
    // the parent->child pipe — Node IPC's framing isn't great for buffers
    // that size.) The on-disk file is content-addressed (just hash, no
    // mode suffix) so the cpu/full variants share one copy on disk.
    const tmpPath = path.join(TMP_DIR, `${hash}.onnx`);
    let writeMs = 0;
    if (!fs.existsSync(tmpPath)) {
      const tWrite = Date.now();
      await fs.promises.writeFile(tmpPath, Buffer.from(modelBytes));
      writeMs = Date.now() - tWrite;
    }

    let rungs = epLadder();
    if (intent === 'cpu') {
      // User explicitly chose CPU in the backend selector — skip all GPU
      // rungs even if they're available. The renderer surfaces this via
      // the backend-event narrative, so no need for a model-event here.
      rungs = rungs.filter(r => r.name === 'cpu');
    }
    let skippedCoreml = false;
    if (blacklist.has(hash)) {
      const before = rungs.length;
      rungs = rungs.filter(r => !r.name.startsWith('coreml'));
      skippedCoreml = before > rungs.length;
    }
    const skipNote = skippedCoreml ? ' [skipping CoreML; hash blacklisted from prior failure this session]' : '';
    console.log(`[ort-native] handing ${cacheKey} (${mb} MB) to worker — fs.write took ${writeMs}ms${skipNote}`);
    // Surface the pre-emptive skip so the user knows why this model is on
    // CPU even though no rung "failed" this load — the failure was on
    // a prior load this session and we remembered it.
    if (skippedCoreml) {
      notifyModelEvent({
        type: 'rung-skipped',
        key: rendererKey,
        rung: 'coreml',
        reason: 'blacklisted from prior failure this session',
      });
    }
    try {
      const tLoad = Date.now();
      // Worker is keyed by the composite cacheKey, not by the renderer's
      // per-page key. This is also what comes back on rung-failed events,
      // so the host can correlate.
      const result = await ask('load', { key: cacheKey, hash, tmpPath, rungs });
      console.log(`[ort-native] worker.load total round-trip ${Date.now() - tLoad}ms`);
      sessionsByKey.set(cacheKey, {
        hash,
        modelPath: tmpPath,
        rungs,
        ep: result.rung,
        inputNames: result.inputNames,
        outputNames: result.outputNames,
        lastUsed: Date.now(),
      });
      keyToCacheKey.set(rendererKey, cacheKey);
      await evictLruSessions();
      return result;
    } catch (e) {
      // Cold-load failed — drop the file IFF no other cached entry still
      // references it. (A different-mode load of the same model may have
      // succeeded earlier and is still using this file.)
      const stillReferenced = Array.from(sessionsByKey.values()).some(s => s.modelPath === tmpPath);
      if (!stillReferenced) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      throw e;
    }
  });

  // First-tile latency is logged by the worker (build/run/serialize split);
  // no need to re-time end-to-end here.
  handle('ort:run', async (_evt, rendererKey, wireFeeds) => {
    const cacheKey = keyToCacheKey.get(rendererKey);
    if (!cacheKey || !sessionsByKey.has(cacheKey)) {
      throw new Error(`ort:run: no session for ${rendererKey} (worker restarted or session evicted?)`);
    }
    sessionsByKey.get(cacheKey).lastUsed = Date.now();
    return ask('run', { key: cacheKey, wireFeeds });
  });

  handle('ort:release', async (_evt, rendererKey) => {
    // Unbind the renderer's per-page key but KEEP the worker session warm.
    // A subsequent load (post-reload, or another upscale of the same model
    // in this page) will reuse it. Real release happens via LRU eviction
    // or shutdown.
    keyToCacheKey.delete(rendererKey);
  });

  // Boot the worker.
  spawnWorker();

  // ───── Lifecycle hooks for main ──────────────────────────────────────

  function evictAll() {
    // Renderer is navigating away (page reload). The new page issues fresh
    // m1, m2, … keys from scratch — clear the binding map. Worker sessions
    // stay warm so the next load with the same model+mode is free (the
    // headline reason for this whole indirection).
    if (keyToCacheKey.size === 0) return;
    console.log(`[reload] clearing ${keyToCacheKey.size} renderer-key binding(s); ${sessionsByKey.size} session(s) staying warm`);
    keyToCacheKey.clear();
  }

  function shutdown() {
    console.log(`[ort-host] shutdown — releasing ${sessionsByKey.size} cached session(s)`);
    for (const ent of sessionsByKey.values()) {
      try { fs.unlinkSync(ent.modelPath); } catch {}
    }
    sessionsByKey.clear();
    keyToCacheKey.clear();
    // Kill the worker eagerly; we don't need a graceful release on quit.
    try { worker && worker.kill('SIGTERM'); } catch {}
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  }

  return { evictAll, shutdown };
}

module.exports = { createOrtHost };
