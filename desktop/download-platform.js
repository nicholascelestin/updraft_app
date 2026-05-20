// Pure platform detection + per-platform constants. No I/O.
//
// `target.appRoot` is where the packaged app's code lives inside the
// Electron framework's zip layout. `target.exeRel` identifies the
// executable for documentation purposes (we don't modify its bits).

/** @typedef {{
 *   id: string,
 *   os: 'darwin'|'linux'|'win32',
 *   arch: 'x64'|'arm64',
 *   label: string,
 *   appRoot: string,
 *   exeRel: string,
 *   downloadName: string,
 * }} PlatformTarget */

/** @type {PlatformTarget[]} */
export const PLATFORM_TARGETS = [
  {
    id: 'darwin-arm64', os: 'darwin', arch: 'arm64',
    label: 'macOS (Apple Silicon)',
    appRoot: 'Electron.app/Contents/Resources/app/',
    exeRel:  'Electron.app/Contents/MacOS/Electron',
    downloadName: 'aitools-desktop-darwin-arm64.zip',
  },
  {
    id: 'darwin-x64', os: 'darwin', arch: 'x64',
    label: 'macOS (Intel)',
    appRoot: 'Electron.app/Contents/Resources/app/',
    exeRel:  'Electron.app/Contents/MacOS/Electron',
    downloadName: 'aitools-desktop-darwin-x64.zip',
  },
  {
    id: 'linux-x64', os: 'linux', arch: 'x64',
    label: 'Linux (x64)',
    appRoot: 'resources/app/',
    exeRel:  'electron',
    downloadName: 'aitools-desktop-linux-x64.zip',
  },
  {
    id: 'linux-arm64', os: 'linux', arch: 'arm64',
    label: 'Linux (ARM64)',
    appRoot: 'resources/app/',
    exeRel:  'electron',
    downloadName: 'aitools-desktop-linux-arm64.zip',
  },
  {
    id: 'win32-x64', os: 'win32', arch: 'x64',
    label: 'Windows (x64)',
    appRoot: 'resources/app/',
    exeRel:  'electron.exe',
    downloadName: 'aitools-desktop-win32-x64.zip',
  },
  {
    id: 'win32-arm64', os: 'win32', arch: 'arm64',
    label: 'Windows (ARM64)',
    appRoot: 'resources/app/',
    exeRel:  'electron.exe',
    downloadName: 'aitools-desktop-win32-arm64.zip',
  },
];

export function targetById(id) {
  return PLATFORM_TARGETS.find(t => t.id === id) || null;
}

/**
 * Best-effort detection from the browser. Uses the User-Agent Client Hints
 * API where available (Chromium-derived browsers, including Electron's
 * renderer), and falls back to a UA-string heuristic for Firefox / Safari.
 * Returns null if no confident guess.
 */
export async function detectPlatform() {
  const data = navigator.userAgentData;
  if (data?.getHighEntropyValues) {
    try {
      const hi = await data.getHighEntropyValues(['platform', 'architecture', 'bitness']);
      const os = mapOs(hi.platform || data.platform || '');
      const arch = mapArch(hi.architecture || '', hi.bitness || '');
      if (os && arch) {
        const t = targetById(`${os}-${arch}`);
        if (t) return t;
      }
    } catch { /* fall through */ }
  }
  return parseUserAgent(navigator.userAgent || '');
}

function mapOs(p) {
  const s = String(p).toLowerCase();
  if (s.includes('mac')) return 'darwin';
  if (s.includes('win')) return 'win32';
  if (s.includes('linux')) return 'linux';
  return null;
}

function mapArch(arch, bitness) {
  const a = String(arch).toLowerCase();
  if (a === 'arm' || a === 'arm64' || a === 'aarch64') return 'arm64';
  if (a === 'x86' && String(bitness) === '64') return 'x64';
  if (a === 'x64' || a === 'x86_64') return 'x64';
  return null;
}

function parseUserAgent(ua) {
  const s = ua.toLowerCase();
  let os = null;
  if (/macintosh|mac os x/.test(s)) os = 'darwin';
  else if (/windows/.test(s)) os = 'win32';
  else if (/linux/.test(s)) os = 'linux';
  if (!os) return null;

  // Apple Silicon caveat: Safari on Apple Silicon still reports "Intel Mac OS X"
  // in the legacy UA for compat. We can't reliably tell from UA alone; default
  // to arm64 on recent Safari (>= 15), x64 otherwise. The override dropdown
  // exists for the cases this gets wrong.
  let arch = 'x64';
  if (/aarch64|arm64/.test(s)) arch = 'arm64';
  else if (os === 'darwin' && /version\/(1[5-9]|2[0-9])/.test(s)) arch = 'arm64';

  return targetById(`${os}-${arch}`);
}
