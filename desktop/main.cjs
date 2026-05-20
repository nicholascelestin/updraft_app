// Electron shell. Three responsibilities — only:
//   1. Serve the parent aitools/ directory over HTTP on a random localhost
//      port (the renderer loads the unchanged static site from there).
//   2. Create the BrowserWindow, inject `inject.js` on dom-ready, and forward
//      main-process diagnostic events to the renderer's DevTools console.
//   3. Bootstrap and tear down the ORT host (see ort-host.cjs for the
//      inference-extension domain).
//
// The aitools source tree is not touched — this wrapper sits in
// aitools/desktop/ and points at '..' for content.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { createOrtHost } = require('./ort-host.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEBUG_DEVTOOLS = process.env.AITOOLS_DEVTOOLS === '1';

let httpServer = null;
let ortHost = null;

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

// ───── Global crash guards ───────────────────────────────────────────────

process.on('uncaughtException', (err, origin) => {
  console.error(`\n[FATAL] uncaughtException (${origin}):\n${fmtErr(err)}\n`);
});

process.on('unhandledRejection', (reason) => {
  console.error(`\n[FATAL] unhandledRejection:\n${fmtErr(reason)}\n`);
});

// ───── Renderer log fan-out ──────────────────────────────────────────────
//
// On GUI launches (Finder, Spotlight, `open`), main's stdout/stderr go to
// /dev/null or unified logging — invisible to the user. The renderer's
// DevTools console is the only diagnostic channel they'll see, so we push
// worker spawn / exit / FATAL events to it via the `main-log` channel.
//
// `model-event` is a separate channel for user-facing rung-fallback /
// rung-succeeded notices that surface in aitools' <status-bar>.

let mainWindow = null;
const earlyLogBuffer = [];

function sendToRenderer(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
      return true;
    }
  } catch {}
  return false;
}
function notifyRenderer(level, message) {
  const payload = { level, message };
  // Buffer log entries that fire before the window is ready — typically the
  // FATAL findSystemNode message during startup. Model events before
  // window-ready are uninteresting and dropped.
  if (!sendToRenderer('main-log', payload)) earlyLogBuffer.push(payload);
}
function flushEarlyLogs() {
  while (earlyLogBuffer.length) sendToRenderer('main-log', earlyLogBuffer.shift());
}
function notifyModelEvent(payload) { sendToRenderer('model-event', payload); }

// ───── Static HTTP server ────────────────────────────────────────────────

const MIME = {
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm':  'text/html',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function serveStatic() {
  return new Promise((resolve, reject) => {
    httpServer = http.createServer((req, res) => {
      let urlPath;
      try {
        urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      } catch {
        res.writeHead(400); res.end(); return;
      }
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

      const filePath = path.resolve(ROOT, '.' + urlPath);
      if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
        res.writeHead(403); res.end(); return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          if (err.code === 'EISDIR') {
            return fs.readFile(path.join(filePath, 'index.html'), (e2, d2) => {
              if (e2) { res.writeHead(404); res.end(); return; }
              res.writeHead(200, { 'content-type': 'text/html' });
              res.end(d2);
            });
          }
          res.writeHead(404); res.end(); return;
        }
        res.writeHead(200, {
          'content-type': mimeFor(filePath),
          'cache-control': 'no-store',
        });
        res.end(data);
      });
    });
    httpServer.on('error', (err) => {
      console.error(`[http] server error: ${fmtErr(err)}`);
      reject(err);
    });
    httpServer.on('clientError', (err, socket) => {
      console.warn(`[http] client error: ${trim(err.message || err, 200)}`);
      try { socket.destroy(); } catch {}
    });
    httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port));
  });
}

// ───── Bootstrap ─────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  let port;
  try {
    port = await serveStatic();
  } catch (e) {
    console.error(`[FATAL] failed to start static server: ${fmtErr(e)}`);
    app.exit(1);
    return;
  }
  console.log(`[aitools-desktop] serving ${ROOT} on http://127.0.0.1:${port}`);

  // ORT host registers `ort:*` IPC handlers and supervises the worker.
  ortHost = createOrtHost({
    userDataDir: app.getPath('userData'),
    log: notifyRenderer,
    notifyModelEvent,
  });

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = win;

  if (DEBUG_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  // Replay any logs that happened before the window was ready (e.g. the
  // FATAL message from findSystemNode failing during startup).
  win.webContents.on('did-finish-load', flushEarlyLogs);

  const injectSrc = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');

  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(injectSrc).catch(err => {
      console.warn(`[inject] failed: ${fmtErr(err)}`);
    });
  });

  win.webContents.on('render-process-gone', (_evt, details) => {
    console.error(`[renderer] gone — reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason === 'oom') {
      console.error('[renderer] out of memory — tile/accumulator buffers + model bytes can blow past Chromium per-renderer limits. Try a smaller image or fewer simultaneous models.');
    }
  });
  win.webContents.on('unresponsive', () => {
    console.warn('[renderer] unresponsive (probably synchronous work blocking the event loop — long inference + readback can do this)');
  });
  win.webContents.on('responsive', () => {
    console.log('[renderer] responsive again');
  });
  win.on('closed', () => {
    console.log('[window] closed');
  });

  // Session eviction on renderer reload — the inject script's per-session
  // counter resets on every reload, so model keys (m1, m2, …) get reused
  // across reloads. Evict everything in the host when the renderer navigates.
  win.webContents.on('did-start-navigation', (_evt, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    ortHost.evictAll();
  });

  try {
    await win.loadURL(`http://127.0.0.1:${port}/`);
  } catch (e) {
    console.error(`[FATAL] loadURL failed: ${fmtErr(e)}`);
  }
});

app.on('child-process-gone', (_evt, details) => {
  console.error(`[child-process] ${details.type} gone — reason=${details.reason} exitCode=${details.exitCode} name=${details.name || ''}`);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  if (ortHost) ortHost.shutdown();
  try {
    httpServer && httpServer.close();
    if (httpServer && typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
  } catch {}
});
