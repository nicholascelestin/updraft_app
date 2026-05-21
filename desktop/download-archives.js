// Thin wrappers around fflate for in-browser zip + .tar.gz handling.
//
// We lazy-import fflate so it only loads when the user actually clicks
// the download button — keeps page-load weight unchanged. The vendored
// copy lives in vendor/fflate/index.mjs so this works offline.
//
// The URL is relative (no leading slash) so it resolves against the app's
// mount point rather than the origin root. On a site served at a sub-path
// like /applications/aitools/v2/ a leading-slash path 404s.

let fflate = null;
async function getFflate() {
  if (fflate) return fflate;
  fflate = await import(new URL('vendor/fflate/index.mjs', document.baseURI).toString());
  return fflate;
}

/**
 * Unzip an ArrayBuffer into a map of path -> Uint8Array.
 * Uses fflate's async API so the work happens off the main thread when
 * Web Workers are available.
 */
export async function unzipBufferToFiles(buf) {
  const { unzip } = await getFflate();
  return new Promise((resolve, reject) => {
    unzip(new Uint8Array(buf), (err, files) => {
      if (err) reject(err); else resolve(files);
    });
  });
}

/** Gunzip an ArrayBuffer. */
export async function gunzipBuffer(buf) {
  const { gunzip } = await getFflate();
  return new Promise((resolve, reject) => {
    gunzip(new Uint8Array(buf), (err, data) => {
      if (err) reject(err); else resolve(data);
    });
  });
}

/**
 * Untar a Uint8Array into a map of path -> Uint8Array.
 * Supports the modest subset of tar features npm tarballs use:
 *   - ustar header (typeflag '0' = regular file, '5' = directory, 'x'/'g' = pax extended)
 *   - long-name extension via 'L'-typeflag GNU LongLink entries (rare in npm,
 *     but cheap to support — we read the next entry's name from this entry's
 *     payload)
 *   - prefix field concatenation (path > 100 chars)
 */
export function untarBufferToFiles(buf) {
  const files = {};
  let offset = 0;
  let nextNameOverride = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    let name = readField(header, 0, 100);
    const sizeStr = readField(header, 124, 12).replace(/[^0-7]/g, '');
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const typeflag = String.fromCharCode(header[156] || 48); // '0' default
    const prefix = readField(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (nextNameOverride) { name = nextNameOverride; nextNameOverride = null; }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const padded = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {
      // GNU long-name: next entry's name is the bytes of this payload.
      nextNameOverride = new TextDecoder().decode(
        buf.subarray(dataStart, dataEnd)
      ).replace(/\0+$/, '');
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      files[name] = buf.subarray(dataStart, dataEnd);
    }
    // typeflag '5' (dir), 'x'/'g' (pax), etc. are skipped.

    offset = padded;
  }
  return files;
}

/** Convenience: gunzip + untar. */
export async function untargzBufferToFiles(buf) {
  const tar = await gunzipBuffer(buf);
  return untarBufferToFiles(tar);
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}
function readField(buf, start, len) {
  let end = start;
  const max = start + len;
  while (end < max && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(start, end));
}

/**
 * Build a zip Blob from a map of path -> Uint8Array.
 *
 * @param {Record<string, Uint8Array>} files
 * @param {{
 *   storeOnlyExts?: string[],
 *   perFileAttrs?: Record<string, number>,   // path -> Unix st_mode (16-bit)
 *   onProgress?: (done: number, total: number, currentName: string) => void,
 * }} opts
 */
export async function zipFilesToBlob(files, opts = {}) {
  const { zip } = await getFflate();
  const storeRe = makeStoreRegex(opts.storeOnlyExts ?? DEFAULT_STORE_EXTS);
  const perFileAttrs = opts.perFileAttrs || {};

  // fflate's `attrs` is the EXTERNAL FILE ATTRIBUTES field (32 bits).
  // The high 16 bits hold Unix st_mode; the low 16 are DOS attrs.
  // BUT the zip reader only interprets the high bits as Unix mode when
  // the central directory's "version made by" host-system byte is 3
  // (Unix). fflate writes that byte from `os` — defaulting to 0 (DOS),
  // which makes Archive Utility / unzip silently fall back to DOS attrs
  // and strip exec bits + demote symlinks. Set os=3 whenever we're
  // emitting Unix modes.
  /** @type {Record<string, [Uint8Array, object] | Uint8Array>} */
  const input = {};
  for (const [name, data] of Object.entries(files)) {
    const mode = perFileAttrs[name];
    const level = storeRe.test(name) ? 0 : 6;
    if (mode) {
      input[name] = [data, { level, os: 3, attrs: (mode & 0xFFFF) << 16 }];
    } else if (level === 0) {
      input[name] = [data, { level }];
    } else {
      input[name] = data;
    }
  }

  return new Promise((resolve, reject) => {
    zip(input, { level: 6 }, (err, out) => {
      if (err) reject(err);
      else resolve(new Blob([out], { type: 'application/zip' }));
    });
  });
}

const DEFAULT_STORE_EXTS = ['.onnx', '.wasm', '.woff2', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.gz', '.tgz', '.zip', '.asar'];
function makeStoreRegex(exts) {
  const pat = exts.map(e => e.replace(/[.+]/g, '\\$&')).join('|');
  return new RegExp(`(?:${pat})$`, 'i');
}

// ─── Zip central-directory parser ────────────────────────────────────────
//
// fflate's high-level unzip API drops Unix mode bits and silently
// promotes symlinks to regular files. That breaks the Electron bundle in
// three ways:
//   1. Symlinks (lrwx…) inside frameworks (Versions/Current → A, etc.)
//      lose their link-ness and become files containing the link target
//      as text. macOS framework loader fails.
//   2. Exec bits (-rwxr-xr-x) on the main binary + helpers get dropped.
//      macOS refuses to launch a non-executable binary.
//   3. (Separately, we invalidate the bundle's code signature by
//      modifying Contents/Resources/app/, so the bundle has to be
//      stripped or the user has to override Gatekeeper.)
//
// This parser walks the End-of-Central-Directory + Central Directory
// records and returns { name -> unixMode } where unixMode is the high
// 16 bits of the entry's external file attributes (i.e. st_mode bits
// including file-type field). Pass these through to fflate.zip's `attrs`
// option to preserve everything.

const SIG_EOCD       = 0x06054b50; // "PK\005\006"
const SIG_EOCD64     = 0x06064b50; // "PK\006\006"
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CDH        = 0x02014b50; // "PK\001\002"

/**
 * Parse a zip's central directory and return a map of entry path to Unix
 * st_mode bits (16 bits, includes file-type field).
 *
 * Files with no Unix mode (e.g. zips authored on Windows-only tooling)
 * map to 0; the caller can substitute defaults.
 */
export function parseZipUnixModes(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // Find EOCD. It's near the end, ≤ 65557 bytes from end (16-bit comment).
  let eocd = -1;
  const minSearch = Math.max(0, u8.byteLength - 65557);
  for (let i = u8.byteLength - 22; i >= minSearch; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no End-of-Central-Directory record');

  let cdOff  = dv.getUint32(eocd + 16, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  // ZIP64 fallback (Electron zips don't trigger this, but defensive)
  if (cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
    const locOff = eocd - 20;
    if (locOff >= 0 && dv.getUint32(locOff, true) === SIG_EOCD64_LOC) {
      const eocd64 = Number(dv.getBigUint64(locOff + 8, true));
      if (dv.getUint32(eocd64, true) === SIG_EOCD64) {
        cdSize = Number(dv.getBigUint64(eocd64 + 40, true));
        cdOff  = Number(dv.getBigUint64(eocd64 + 48, true));
      }
    }
  }

  /** @type {Record<string, number>} */
  const modes = {};
  const decoder = new TextDecoder();
  let p = cdOff;
  const end = cdOff + cdSize;
  while (p + 46 <= end) {
    if (dv.getUint32(p, true) !== SIG_CDH) break;
    const nameLen    = dv.getUint16(p + 28, true);
    const extraLen   = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const extAttrs   = dv.getUint32(p + 38, true);
    const name = decoder.decode(u8.subarray(p + 46, p + 46 + nameLen));
    // Unix mode lives in the high 16 bits of the external attributes
    // (only when the creator-version's host system byte is Unix == 3,
    // which Electron's zip uses everywhere — but we don't bother
    // validating since the high bits are zero in the Windows case).
    modes[name] = (extAttrs >>> 16) & 0xFFFF;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return modes;
}

// Unix st_mode file-type constants (octal).
export const S_IFMT  = 0o170000;
export const S_IFLNK = 0o120000;  // symlink
export const S_IFREG = 0o100000;  // regular file
export const S_IFDIR = 0o040000;  // directory
export const S_IXUSR = 0o000100;  // exec bit, user
