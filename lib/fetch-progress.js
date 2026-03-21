/**
 * Fetch a URL with streaming download progress.
 * @param {string} url
 * @param {(frac: number, message: string) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchWithProgress(url, onProgress) {
  onProgress?.(0, 'Downloading model\u2026');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Model download failed: HTTP ${resp.status}`);

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
      onProgress?.(frac, `Downloading model\u2026 ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    }
  }

  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf.buffer;
}
