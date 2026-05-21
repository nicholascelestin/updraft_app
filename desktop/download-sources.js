// Source fetchers + same-origin static-tree crawl.
//
// Three independent streams feed the composer:
//   1. Electron framework zip   (from GitHub Releases, per platform)
//   2. ORT-Node tarball         (from npm registry, platform-agnostic)
//   3. Aitools static tree      (from this origin, via Resource Timing)
//      + optionally a few hand-picked model files.

import { fetchWithProgress } from '../lib/fetch-progress.js';

const _jsonCache = new Map();
async function fetchJsonOnce(url) {
  if (_jsonCache.has(url)) return _jsonCache.get(url);
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load ${url}: HTTP ${r.status}`);
  const json = await r.json();
  _jsonCache.set(url, json);
  return json;
}

export const getVersions = () => fetchJsonOnce('desktop/versions.lock.json');
export const getBranding = () => fetchJsonOnce('branding.json');

// desktop/bundle-manifest.json is the source of truth for files bundled into
// the desktop build — add new static assets there.
export async function getBundleManifest() {
  const parsed = await fetchJsonOnce('desktop/bundle-manifest.json');
  if (!Array.isArray(parsed?.files)) {
    throw new Error('desktop/bundle-manifest.json is malformed: expected { files: [...] }');
  }
  return parsed.files;
}

/**
 * Fetch a list of same-origin paths into a map of (path-without-leading-slash) -> Uint8Array.
 *
 * onProgress(i, total, currentPath) fires after each fetch.
 */
export async function fetchStaticBundle(paths, onProgress) {
  /** @type {Record<string, Uint8Array>} */
  const out = {};
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    try {
      const r = await fetch(p);
      if (!r.ok) {
        console.warn(`[desktop-download] skipping ${p}: HTTP ${r.status}`);
      } else {
        const ab = await r.arrayBuffer();
        out[p.replace(/^\//, '')] = new Uint8Array(ab);
      }
    } catch (e) {
      console.warn(`[desktop-download] skipping ${p}: ${e?.message || e}`);
    }
    onProgress?.(i + 1, paths.length, p);
  }
  return out;
}

/**
 * Stream-fetch a remote URL into an ArrayBuffer with progress reports.
 * `total` is the response's Content-Length (may be 0 if absent).
 *
 * Cached in `aitools-build-deps-v1` (separate from the model cache so it
 * can be invalidated independently). The cache key is the full URL —
 * since Electron / ORT / Node URLs all bake the version in, bumping a
 * version in versions.lock.json naturally bypasses old cache entries
 * without us having to invalidate explicitly.
 */
const BUILD_CACHE_NAME = 'aitools-build-deps-v1';

async function getBuildCache() {
  try { return await caches.open(BUILD_CACHE_NAME); }
  catch { return null; }
}

export async function fetchRemoteWithProgress(url, onProgress) {
  const cache = await getBuildCache();

  if (cache) {
    const cached = await cache.match(url);
    if (cached) {
      const total = parseInt(cached.headers.get('content-length') || '0', 10) || 0;
      const buf = await cached.arrayBuffer();
      // Jump the progress bar straight to full so the UI doesn't sit at
      // 0% on a cache hit. Real value beats Content-Length absence.
      onProgress?.(buf.byteLength, total || buf.byteLength);
      return buf;
    }
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} failed: HTTP ${resp.status}`);
  const respForCache = resp.clone();
  const total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;

  let buf;
  if (!resp.body) {
    buf = await resp.arrayBuffer();
    onProgress?.(buf.byteLength, total || buf.byteLength);
  } else {
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total);
    }
    const finalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
    const out = new Uint8Array(finalSize);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    buf = out.buffer;
  }

  // Fire-and-forget cache write. Best-effort: a 250 MB Electron zip can
  // exceed the browser's per-origin quota on some platforms; on failure
  // we just lose the optimisation for next time, never the download.
  if (cache) cache.put(url, respForCache).catch(() => {});

  return buf;
}

/**
 * Expand {version}, {os}, {arch} placeholders in a URL template.
 * Swap the URL pattern in versions.lock.json to repoint to a different
 * mirror without touching code.
 */
function expandUrl(tpl, { name, version, os, arch }) {
  return String(tpl)
    .replaceAll('{name}', name || '')
    .replaceAll('{version}', version)
    .replaceAll('{os}', os || '')
    .replaceAll('{arch}', arch || '');
}

export async function fetchElectronBase(target, onProgress) {
  const v = await getVersions();
  if (!v.electronUrl) throw new Error('versions.lock.json missing `electronUrl` template');
  const url = expandUrl(v.electronUrl, { version: v.electron, os: target.os, arch: target.arch });
  return fetchRemoteWithProgress(url, onProgress);
}

/**
 * Fetch a generic npm package tarball. Used for both onnxruntime-node and
 * its runtime dependency `onnxruntime-common` — the npm registry serves
 * both at /{name}/-/{name}-{version}.tgz, so one helper covers both.
 */
export async function fetchNpmTarball(name, version, onProgress) {
  const v = await getVersions();
  const tpl = v.npmTarballUrl || v.ortNodeUrl;  // ortNodeUrl is legacy fallback
  if (!tpl) throw new Error('versions.lock.json missing `npmTarballUrl` template');
  const url = expandUrl(tpl, { name, version });
  return fetchRemoteWithProgress(url, onProgress);
}

// Node.js binary archive — bundled with the desktop build so users don't
// need a system Node install. The worker must run under plain Node (not
// Electron-as-Node) because onnxruntime-node SIGTRAPs inside Electron's V8.
const NODE_OS = { win32: 'win', darwin: 'darwin', linux: 'linux' };
const NODE_EXT = { win32: 'zip', darwin: 'tar.gz', linux: 'tar.gz' };

export async function fetchNodeBinary(target, onProgress) {
  const v = await getVersions();
  if (!v.nodeUrl || !v.node) throw new Error('versions.lock.json missing `node` / `nodeUrl`');
  const nodeos = NODE_OS[target.os];
  const ext    = NODE_EXT[target.os];
  if (!nodeos || !ext) throw new Error(`No Node bundle for platform ${target.os}`);
  const url = v.nodeUrl
    .replaceAll('{version}', v.node)
    .replaceAll('{nodeos}',  nodeos)
    .replaceAll('{arch}',    target.arch)
    .replaceAll('{ext}',     ext);
  return fetchRemoteWithProgress(url, onProgress);
}

/**
 * Pull a model's bytes — built-in (same-origin URL) or custom (Cache API).
 *
 * Delegates to fetchWithProgress so both kinds reuse the shared model
 * cache (aitools-models-v1). If the user has already loaded a model in
 * the web app, the downloader gets a cache hit and skips the re-fetch.
 * Custom models flow through the same cache-or-throw path the engine uses.
 */
export async function fetchModelBytes(url) {
  const ab = await fetchWithProgress(url);
  return new Uint8Array(ab);
}
