/**
 * Fetch a URL with streaming download progress and Cache API persistence.
 * Cached models are keyed by URL — change the filename to bust the cache.
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

  if (cache) {
    const cached = await cache.match(url);
    if (cached) {
      report?.(1, 'Loading model from cache\u2026');
      return cached.arrayBuffer();
    }
    if (isCustomModelUrl(url)) {
      throw new Error('Custom model not found in cache. Please re-upload the model file.');
    }
  }

  report?.(0, 'Downloading model\u2026');
  const resp = await fetch(url);
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
      report?.(frac, `Downloading model\u2026 ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    }
  }

  if (cache) {
    cache.put(url, respForCache).catch(() => {});
  }

  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf.buffer;
}
