// Model byte cache (Cache API) + custom-model URL scheme. Shared by
// fetch-progress (reads) and sr-model-store (writes).

const MODEL_CACHE_NAME = 'aitools-models-v1';
export const CUSTOM_MODEL_URL_PREFIX = 'https://cache.aitools.local/custom-model/';

export async function getModelCache() {
  try { return await caches.open(MODEL_CACHE_NAME); }
  catch { return null; }
}

export function isCustomModelUrl(url) {
  return typeof url === 'string' && url.startsWith(CUSTOM_MODEL_URL_PREFIX);
}

export async function putModelBytes(url, bytes) {
  const cache = await getModelCache();
  if (!cache) throw new Error('Browser Cache API is unavailable; cannot store custom model.');
  await cache.put(url, new Response(bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
    },
  }));
}

export async function deleteModelBytes(url) {
  const cache = await getModelCache();
  return (await cache?.delete(url)) ?? false;
}
