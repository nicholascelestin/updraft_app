// Per-platform layout: take the Electron framework zip, the ORT-Node
// tarball, the aitools static bundle, and any selected model bytes, and
// emit a single zip the user can download and run.
//
// All path logic is centralised here. Inputs are platform-agnostic; this
// module is the only one that knows what goes where.

import {
  unzipBufferToFiles, untargzBufferToFiles, zipFilesToBlob,
  parseZipUnixModes, S_IFLNK, S_IFREG, S_IXUSR,
} from './download-archives.js';
import { getVersions, getBranding } from './download-sources.js';
import { patchMacInfoPlist, renderSvgToIcns } from './download-branding.js';

/** @typedef {import('./download-platform.js').PlatformTarget} PlatformTarget */

/**
 * @param {{
 *   target: PlatformTarget,
 *   electronZipBuf: ArrayBuffer,
 *   ortTgzBuf: ArrayBuffer,
 *   ortCommonTgzBuf: ArrayBuffer,
 *   nodeArchiveBuf?: ArrayBuffer,           // bundled Node binary archive (.zip on win, .tar.gz else)
 *   staticFiles: Record<string, Uint8Array>,
 *   selectedModels: Array<{ outPath: string, bytes: Uint8Array }>,
 *   onProgress?: (stage: string, done?: number, total?: number) => void,
 * }} args
 * @returns {Promise<Blob>}
 */
export async function composeDesktopZip({
  target, electronZipBuf, ortTgzBuf, ortCommonTgzBuf, nodeArchiveBuf, staticFiles, selectedModels, onProgress,
}) {
  onProgress?.('Unpacking Electron framework');
  /** @type {Record<string, Uint8Array>} */
  const electronFiles = await unzipBufferToFiles(electronZipBuf);
  // fflate's unzip drops Unix mode bits and silently demotes symlinks to
  // regular files. Recover them from the central directory so we can
  // pass them through to the output zip — without this, the Electron
  // binary loses its exec bit and the framework symlinks get baked into
  // regular files, both of which produce "Electron can't be opened."
  const electronModes = parseZipUnixModes(electronZipBuf);

  onProgress?.('Unpacking ORT-Node runtime');
  /** @type {Record<string, Uint8Array>} */
  const ortFiles = await untargzBufferToFiles(ortTgzBuf);
  // ORT-Node's runtime dependency. Without onnxruntime-common at
  // app/node_modules/onnxruntime-common/, `require('onnxruntime-node')`
  // throws MODULE_NOT_FOUND on first load and the worker dies.
  /** @type {Record<string, Uint8Array>} */
  const ortCommonFiles = ortCommonTgzBuf ? await untargzBufferToFiles(ortCommonTgzBuf) : {};

  // Bundled Node.js binary — extract just the binary, discard everything
  // else (npm, lib, share, headers — ~70% of the archive). Placed at a
  // known relative path that ort-host.cjs checks before searching system
  // PATHs. See findSystemNode() there.
  /** @type {Uint8Array | null} */
  let nodeBinaryBytes = null;
  if (nodeArchiveBuf) {
    onProgress?.('Unpacking Node.js runtime');
    if (target.os === 'win32') {
      const files = await unzipBufferToFiles(nodeArchiveBuf);
      const key = Object.keys(files).find(p => /\/node\.exe$/.test(p));
      if (key) nodeBinaryBytes = files[key];
    } else {
      const files = await untargzBufferToFiles(nodeArchiveBuf);
      const key = Object.keys(files).find(p => /\/bin\/node$/.test(p));
      if (key) nodeBinaryBytes = files[key];
    }
    if (!nodeBinaryBytes) {
      console.warn('[desktop] Node binary not found in archive — bundled Node will be missing from the build, users will need system Node.');
    }
  }

  // For macOS targets, render the Updraft icon from aitools' favicon.svg
  // into a multi-size ICNS and patch Info.plist's CFBundle* fields so
  // Finder/Dock/About-window show "Updraft" with the right glyph instead
  // of "Electron" with the default icon.
  let icnsBytes = null;
  if (target.os === 'darwin') {
    onProgress?.('Rendering app icon');
    const svgText = new TextDecoder().decode(staticFiles['assets/favicon.svg']);
    try {
      icnsBytes = await renderSvgToIcns(svgText);
    } catch (e) {
      console.warn('[desktop] icon render failed, keeping default electron.icns:', e?.message || e);
    }
  }

  onProgress?.('Composing app layout');
  const versions = await getVersions();
  const branding = await getBranding();
  const layout = composeLayout({
    target, electronFiles, electronModes, ortFiles, ortCommonFiles,
    nodeBinaryBytes, staticFiles, selectedModels, versions, branding, icnsBytes,
  });

  onProgress?.('Generating final zip');
  return await zipFilesToBlob(layout.files, { perFileAttrs: layout.attrs });
}

/**
 * Produce the final file tree + per-file Unix mode attributes.
 *
 * Returns { files, attrs } where:
 *   files: Record<string, Uint8Array>  -- path -> content
 *   attrs: Record<string, number>      -- path -> Unix st_mode (16 bits)
 *                                          for entries that need explicit
 *                                          modes (symlinks, executables).
 */
function composeLayout({
  target, electronFiles, electronModes, ortFiles, ortCommonFiles, nodeBinaryBytes, staticFiles, selectedModels, versions, branding, icnsBytes,
}) {
  /** @type {Record<string, Uint8Array>} */
  const out = Object.create(null);
  /** @type {Record<string, number>} */
  const attrs = Object.create(null);

  const appRootIn = target.appRoot; // 'Electron.app/Contents/Resources/app/' on darwin
  const isMac = target.os === 'darwin';

  // Rename Electron.app/ → <branding.name>.app/ on macOS so Finder shows
  // the branded folder name straight out of the zip (before Launch
  // Services has had a chance to read CFBundleDisplayName from Info.plist).
  // `rename(p)` maps input paths (from the upstream Electron zip) to
  // output paths (the composed zip we hand the user).
  const macBundleRename = isMac ? { from: 'Electron.app/', to: `${branding.name}.app/` } : null;
  const rename = (p) => macBundleRename && p.startsWith(macBundleRename.from)
    ? macBundleRename.to + p.slice(macBundleRename.from.length)
    : p;
  const appRoot = rename(appRootIn);

  // Paths we MATCH against electronFiles keys must use the original prefix;
  // paths we EMIT use the renamed prefix (already baked into appRoot).
  const macBundlePrefixIn   = isMac ? appRootIn.slice(0, appRootIn.lastIndexOf('Resources/')) : null;
  const macOuterSigPrefixIn = macBundlePrefixIn ? `${macBundlePrefixIn}_CodeSignature/` : null;
  const macInfoPlistPathIn  = macBundlePrefixIn ? `${macBundlePrefixIn}Info.plist` : null;
  const macIcnsPathIn       = macBundlePrefixIn ? `${macBundlePrefixIn}Resources/electron.icns` : null;

  // ── 1. Carry the Electron framework files through ───────────────────────
  //    - Drop `default_app.asar` so Electron picks up our app/ instead.
  //    - Drop the OUTER bundle's _CodeSignature/ on macOS so the bundle is
  //      "unsigned" (not "broken-signed"). The latter triggers macOS's
  //      laconic "Electron can't be opened" error with no override; the
  //      former gives the standard "from an unidentified developer" dialog
  //      that the user can bypass via right-click → Open.
  //    - Replace the Electron Info.plist with our Updraft-branded variant
  //      (patched in-place — only CFBundle{Name,DisplayName,Identifier}).
  //    - Replace electron.icns with the Updraft icon rendered from
  //      favicon.svg. We keep the FILE name as electron.icns because
  //      CFBundleIconFile still references it; only the bytes change.
  //    - Preserve Unix modes parsed from the original zip's central
  //      directory — needed for symlinks and exec bits.
  for (const [path, data] of Object.entries(electronFiles)) {
    if (path.endsWith('default_app.asar')) continue;
    if (data.length === 0 && path.endsWith('/')) continue;  // directory entry
    if (macOuterSigPrefixIn && path.startsWith(macOuterSigPrefixIn)) continue;

    let bytes = data;
    if (isMac && path === macInfoPlistPathIn) {
      bytes = patchMacInfoPlist(data, branding);
    } else if (isMac && path === macIcnsPathIn && icnsBytes) {
      bytes = icnsBytes;
    }

    const outPath = rename(path);
    out[outPath] = bytes;
    const mode = electronModes[path];
    if (mode) attrs[outPath] = mode;
  }

  // ── 2. Synthesize package.json at the app root ──────────────────────────
  const pkgJson = {
    name: 'aitools-desktop',
    version: versions.electron,
    private: true,
    main: 'desktop/main.cjs',
    description: 'Aitools desktop build — packaged by the in-browser desktop downloader.',
  };
  out[appRoot + 'package.json'] = new TextEncoder().encode(JSON.stringify(pkgJson, null, 2) + '\n');

  // ── 3. Drop the aitools static tree at appRoot/<original path> ──────────
  for (const [path, data] of Object.entries(staticFiles)) {
    out[appRoot + path] = data;
  }

  // ── 4. ORT-Node native module: copy only the platform's binary subset ──
  //    npm tarballs put files under 'package/'. We strip that prefix and
  //    drop everything under appRoot/node_modules/onnxruntime-node/.
  //    Other platforms' bin/ subdirs are dropped to save ~150 MB.
  //    For non-Windows, the native binding (.node) + the bundled libonnx
  //    .dylib / .so need their exec bit preserved.
  const platBinPrefix = `package/bin/napi-v6/${target.os}/${target.arch}/`;
  const ortDestRoot = appRoot + 'node_modules/onnxruntime-node/';
  for (const [path, data] of Object.entries(ortFiles)) {
    if (!path.startsWith('package/')) continue;
    const rel = path.slice('package/'.length);
    if (rel.startsWith('bin/') && !path.startsWith(platBinPrefix)) continue;

    const destPath = ortDestRoot + rel;
    out[destPath] = data;
    // Mark .node / .dylib / .so / .dll as executable on Unix-y platforms.
    if (target.os !== 'win32' && /\.(node|dylib|so(?:\.\d+)*)$/.test(rel)) {
      attrs[destPath] = S_IFREG | 0o755;
    }
  }

  // ── 4b. onnxruntime-common: ORT-Node's runtime require dependency ──────
  //    Pure JS, no platform-specific bits — just copy everything under
  //    package/ to appRoot/node_modules/onnxruntime-common/.
  const ortCommonDestRoot = appRoot + 'node_modules/onnxruntime-common/';
  for (const [path, data] of Object.entries(ortCommonFiles)) {
    if (!path.startsWith('package/')) continue;
    const rel = path.slice('package/'.length);
    out[ortCommonDestRoot + rel] = data;
  }

  // ── 4c. Bundled Node.js binary ────────────────────────────────────────
  //    Placed at appRoot/desktop/node/node.exe (Windows) or
  //    appRoot/desktop/node/bin/node (Unix). ort-host.cjs's findSystemNode
  //    checks this path before searching system PATHs, so the desktop app
  //    works even on machines without Node installed.
  if (nodeBinaryBytes) {
    const nodeRelPath = target.os === 'win32' ? 'desktop/node/node.exe' : 'desktop/node/bin/node';
    const nodeDest = appRoot + nodeRelPath;
    out[nodeDest] = nodeBinaryBytes;
    if (target.os !== 'win32') {
      attrs[nodeDest] = S_IFREG | 0o755;
    }
  }

  // ── 5. Models the user selected (built-in or custom) ────────────────────
  for (const m of selectedModels) {
    out[appRoot + m.outPath] = m.bytes;
  }

  return { files: out, attrs };
}
