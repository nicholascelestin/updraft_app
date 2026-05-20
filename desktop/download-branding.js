// Aitools-branding overrides for the packaged desktop app.
//
// Two responsibilities, both invoked from download-compose.js when the
// target is macOS:
//
//   1. patchMacInfoPlist  — flip the CFBundleName / CFBundleDisplayName /
//      CFBundleIdentifier fields in Electron.app/Contents/Info.plist so
//      Finder / the Dock / About-window show "Updraft" instead of
//      "Electron". The on-disk folder stays Electron.app (renaming it
//      would invalidate the binary's linker-signed ad-hoc signature
//      since CFBundleExecutable still points at MacOS/Electron — and
//      Finder honors CFBundleDisplayName for the visible label
//      regardless of the folder name).
//
//   2. renderSvgToIcns  — render aitools' favicon.svg at the canonical
//      Apple ICNS sizes via OffscreenCanvas, pack them into a valid
//      `.icns` container. We swap the bytes of
//      Electron.app/Contents/Resources/electron.icns rather than
//      renaming the file (CFBundleIconFile still references
//      "electron.icns"; we change the bytes, not the reference).
//
// Linux/Windows branding (desktop entry + PE-embedded icons) is out of
// scope for now — the focus here is the visible Finder/Dock chrome on
// macOS which is what the user sees on launch.

/**
 * Replace the value of a <key>K</key><string>V</string> pair in a plist
 * XML document. Uses regex text substitution because (a) it avoids
 * round-tripping through DOMParser which drops the XML declaration and
 * DOCTYPE, and (b) the Info.plist structure is stable enough that a
 * targeted regex is reliable. If the key isn't present the plist is
 * returned unchanged — Info.plists for Electron variants don't have
 * all fields, and silent no-op is preferable to throwing here.
 *
 * @param {string} text   Full plist XML as a string
 * @param {string} key    plist key to update
 * @param {string} value  new string value (XML-escaped automatically)
 * @returns {string} updated plist text
 */
function setPlistStringKey(text, key, value) {
  const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(<key>${escKey}</key>\\s*<string>)([^<]*)(</string>)`);
  const escVal = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return text.replace(re, (_m, before, _old, after) => before + escVal + after);
}

/**
 * Patch the relevant CFBundle* fields in a macOS Info.plist file.
 *
 * @param {Uint8Array} plistBytes
 * @param {{ name: string, displayName: string, identifier: string }} updates
 * @returns {Uint8Array}
 */
export function patchMacInfoPlist(plistBytes, updates) {
  let text = new TextDecoder().decode(plistBytes);
  text = setPlistStringKey(text, 'CFBundleName',        updates.name);
  text = setPlistStringKey(text, 'CFBundleDisplayName', updates.displayName);
  text = setPlistStringKey(text, 'CFBundleIdentifier',  updates.identifier);
  return new TextEncoder().encode(text);
}

// ─── SVG → ICNS pipeline ─────────────────────────────────────────────────
//
// Apple ICNS format: 8-byte file header ("icns" magic + total length BE)
// followed by entries. Each entry: 4-byte type code + 4-byte length BE
// (including the 8-byte header) + payload. The payload for modern Macs
// is just a PNG of the right pixel dimensions.
//
// Type codes for PNG-payload icons (we use these, ignoring legacy
// uncompressed RGBA formats):
//   ic04  16x16        ic07  128x128       ic10  1024x1024 (also 512@2x)
//   ic05  32x32        ic08  256x256       ic11  32x32 (16@2x)
//   ic07  128x128      ic09  512x512       ic12  64x64 (32@2x)
//                                          ic13  256x256 (128@2x)
//                                          ic14  512x512 (256@2x)
//
// Finder/Dock pick whichever size best matches the display, so we
// generate a reasonable spread.

const ICNS_TYPES = [
  { type: 'ic04', size: 16 },
  { type: 'ic05', size: 32 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
  { type: 'ic11', size: 32 },     // 16@2x
  { type: 'ic12', size: 64 },     // 32@2x
  { type: 'ic13', size: 256 },    // 128@2x
  { type: 'ic14', size: 512 },    // 256@2x
];

async function renderSvgToPng(svgText, size) {
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload  = () => resolve(i);
      i.onerror = (e) => reject(new Error(`SVG load failed: ${e.message || e.type || e}`));
      i.src = url;
    });
    const canvas = ('OffscreenCanvas' in globalThis)
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size, size);
    // OffscreenCanvas.convertToBlob vs HTMLCanvasElement.toBlob — different
    // APIs, same result.
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise(r => canvas.toBlob(r, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

function writeUint32BE(buf, off, v) {
  buf[off]     = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>>  8) & 0xff;
  buf[off + 3] =  v         & 0xff;
}

/**
 * Render `svgText` at all the standard Apple icon sizes and pack into an
 * ICNS container. Suitable to drop into the bundle at
 * Contents/Resources/electron.icns.
 *
 * @param {string} svgText  The SVG source as text
 * @returns {Promise<Uint8Array>}
 */
export async function renderSvgToIcns(svgText) {
  // Render all sizes (parallel — Canvas decode is cheap, the SVG is small).
  const pngs = await Promise.all(
    ICNS_TYPES.map(async ({ type, size }) => ({
      type, png: await renderSvgToPng(svgText, size),
    })),
  );

  // Assemble. Compute total size first so we can write the file-level
  // length header up front.
  let total = 8; // "icns" + total-size header
  for (const { png } of pngs) total += 8 + png.length;

  const out = new Uint8Array(total);
  // File header
  out.set([0x69, 0x63, 0x6e, 0x73], 0);            // "icns"
  writeUint32BE(out, 4, total);

  let off = 8;
  for (const { type, png } of pngs) {
    const chunkLen = 8 + png.length;
    out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], off);
    writeUint32BE(out, off + 4, chunkLen);
    out.set(png, off + 8);
    off += chunkLen;
  }
  return out;
}
