// Source fetchers + same-origin static-tree crawl.
//
// Three independent streams feed the composer:
//   1. Electron framework zip   (from GitHub Releases, per platform)
//   2. ORT-Node tarball         (from npm registry, platform-agnostic)
//   3. Aitools static tree      (from this origin, via Resource Timing)
//      + optionally a few hand-picked model files.

import { getModelCache, isCustomModelUrl } from '../lib/fetch-progress.js';

let _versions = null;
export async function getVersions() {
  if (_versions) return _versions;
  const r = await fetch('desktop/versions.lock.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load desktop/versions.lock.json: HTTP ${r.status}`);
  _versions = await r.json();
  return _versions;
}

let _branding = null;
export async function getBranding() {
  if (_branding) return _branding;
  const r = await fetch('branding.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load branding.json: HTTP ${r.status}`);
  _branding = await r.json();
  return _branding;
}

let _manifest = null;
/**
 * Load the explicit list of files the desktop bundle should include. The
 * manifest at desktop/bundle-manifest.json is the source of truth — when
 * adding a new static file to the web app, add it there.
 *
 * Returns an array of repo-relative paths (no leading slash).
 */
export async function getBundleManifest() {
  if (_manifest) return _manifest;
  const r = await fetch('desktop/bundle-manifest.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load desktop/bundle-manifest.json: HTTP ${r.status}`);
  const parsed = await r.json();
  if (!Array.isArray(parsed?.files)) {
    throw new Error('desktop/bundle-manifest.json is malformed: expected { files: [...] }');
  }
  _manifest = parsed.files;
  return _manifest;
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
 */
export async function fetchRemoteWithProgress(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} failed: HTTP ${resp.status}`);
  const total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
  if (!resp.body) {
    const buf = await resp.arrayBuffer();
    onProgress?.(buf.byteLength, total || buf.byteLength);
    return buf;
  }
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
  // Stitch.
  const finalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(finalSize);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
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

/**
 * Pull a model's bytes — either from the same-origin /models/X.onnx path
 * (built-in) or from the Cache API (custom upload).
 */
export async function fetchModelBytes(url) {
  if (isCustomModelUrl(url)) {
    const cache = await getModelCache();
    if (!cache) throw new Error(`Cache API unavailable; can't fetch custom model ${url}`);
    const cached = await cache.match(url);
    if (!cached) throw new Error(`Custom model not found in cache: ${url}`);
    const ab = await cached.arrayBuffer();
    return new Uint8Array(ab);
  }
  // Built-in: fetch from same origin
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} failed: HTTP ${r.status}`);
  const ab = await r.arrayBuffer();
  return new Uint8Array(ab);
}
