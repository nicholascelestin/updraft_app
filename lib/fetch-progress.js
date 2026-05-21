/**
 * Fetch a URL with streaming download progress and Cache API persistence.
 *
 * Built-in models use relative URLs (e.g. `models/foo.onnx`). In the web
 * app those resolve against the deploy origin and just work. In the
 * desktop app they resolve against `http://127.0.0.1:<random>/`, where
 * the file is only present if the user bundled it at download time. When
 * the local fetch 404s and `branding.json` defines a `remoteOrigin`, we
 * re-fetch from there — turning the local bundle into a preload
 * optimization rather than a hard gate.
 *
 * Cache keys are normalised against `remoteOrigin` (when configured) so
 * the Cache API entry survives across desktop launches even though the
 * localhost port is ephemeral.
 *
 * @param {string} url
 * @param {(frac: number, message: string) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */

const MODEL_CACHE_NAME = 'aitools-models-v1';
export const CUSTOM_MODEL_URL_PREFIX = 'https://cache.aitools.local/custom-model/';
const LEGACY_CUSTOM_MODEL_URL_PREFIX = 'aitools-custom-model://';

export async function getModelCache() {
  try { return await caches.open(MODEL_CACHE_NAME); }
  catch { return null; }
}

export function isCustomModelUrl(url) {
  return typeof url === 'string' && (
    url.startsWith(CUSTOM_MODEL_URL_PREFIX) ||
    url.startsWith(LEGACY_CUSTOM_MODEL_URL_PREFIX)
  );
}

function isRelativeHttpUrl(url) {
  return typeof url === 'string' && !/^https?:\/\//i.test(url) && !isCustomModelUrl(url);
}

let _remoteOriginPromise = null;
function getRemoteOrigin() {
  if (_remoteOriginPromise) return _remoteOriginPromise;
  _remoteOriginPromise = fetch('branding.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => b?.remoteOrigin || null)
    .catch(() => null);
  return _remoteOriginPromise;
}

// A cache key that doesn't depend on the (possibly ephemeral) origin we
// fetched from. In desktop mode the localhost port changes each launch,
// so caching under that URL would mean a fresh download every run.
async function stableCacheKey(url) {
  if (!isRelativeHttpUrl(url)) return url;
  const remoteOrigin = await getRemoteOrigin();
  return remoteOrigin ? new URL(url, remoteOrigin).toString() : url;
}

export async function fetchWithProgress(url, onProgress) {
  if (onProgress != null && typeof onProgress !== 'function') {
    console.warn('[fetchWithProgress] Ignoring non-function onProgress callback.', {
      type: typeof onProgress,
      value: onProgress,
      url,
    });
  }
  const report = typeof onProgress === 'function' ? onProgress : null;
  const cache = await getModelCache();
  const cacheKey = await stableCacheKey(url);

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      report?.(1, 'Loading model from cache…');
      return cached.arrayBuffer();
    }
    if (isCustomModelUrl(url)) {
      throw new Error('Custom model not found in cache. Please re-upload the model file.');
    }
  }

  report?.(0, 'Downloading model…');
  let resp = await fetch(url);
  if (!resp.ok && resp.status === 404 && isRelativeHttpUrl(url)) {
    const remoteOrigin = await getRemoteOrigin();
    if (remoteOrigin) {
      const remoteUrl = new URL(url, remoteOrigin).toString();
      report?.(0, 'Model not in local bundle, fetching from server…');
      resp = await fetch(remoteUrl);
    }
  }
  if (!resp.ok) throw new Error(`Model download failed: HTTP ${resp.status}`);

  const respForCache = resp.clone();

  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total) {
      const frac = loaded / total;
      report?.(frac, `Downloading model… ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    }
  }

  if (cache) {
    cache.put(cacheKey, respForCache).catch(() => {});
  }

  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf.buffer;
}
