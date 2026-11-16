// core/driver-logo.mjs — a driver's logo, for the status line beside each
// claimed task (Plan and Tasks tabs).
//
// An agent's logo is its maker's trademark, so the PUBLIC cogyard repo ships
// none. A driver names where a public copy lives (adapter.liveState.logoSource)
// and onboarding the driver (`cogyard claude install`, or any driver's own
// installer) downloads it once into $COGYARD_HOME/drivers/<name>/. A driver
// may also bundle a file (adapter.liveState.logo) — the private repo does —
// which wins when present. With neither, the status line shows no logo.
//
// The portal serves the file from its own origin, so a downloaded SVG is
// refused if it could carry script, and is served under a no-script CSP.

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10 * 1000;

const logoDir = (name) => join(COGYARD_HOME, 'drivers', name);

// The downloaded copy for driver `name`, or null.
function installedLogo(name) {
  for (const f of ['logo.svg', 'logo.png']) {
    const p = join(logoDir(name), f);
    if (existsSync(p)) return p;
  }
  return null;
}

// The file the portal serves for this driver: its bundled logo if the driver
// ships one, else the copy onboarding downloaded, else null.
function logoFile(adapter) {
  const bundled = adapter?.liveState?.logo;
  if (bundled && existsSync(bundled)) return bundled;
  return adapter?.name ? installedLogo(adapter.name) : null;
}

// An SVG that could run script or pull in outside content is refused outright.
const UNSAFE_SVG = /<script|<foreignObject|\son[a-z]+\s*=|javascript:|<iframe|<object|<embed|xlink:href\s*=\s*["']?(?!#)|\shref\s*=\s*["']?(?!#)/i;

// Download the driver's public logo into $COGYARD_HOME/drivers/<name>/.
//   logoSource: { url, fill? }  — fill colours a one-colour mark that has none
// → { ok: true, path } | { ok: false, error }. Never throws; onboarding goes on
// without a logo when the network or the file is no good.
async function fetchDriverLogo(adapter, { fetchImpl = globalThis.fetch, dir } = {}) {
  const src = adapter?.liveState?.logoSource;
  if (!adapter?.name || !src?.url) return { ok: false, error: 'this driver names no logo source' };
  let res;
  try {
    res = await fetchImpl(src.url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (e) { return { ok: false, error: `download failed: ${e.message}` }; }
  if (!res.ok) return { ok: false, error: `download failed: HTTP ${res.status}` };
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
  const ext = type === 'image/svg+xml' ? 'svg' : type === 'image/png' ? 'png' : null;
  if (!ext) return { ok: false, error: `not an SVG or PNG (${type || 'no content type'})` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return { ok: false, error: `too large (${buf.length} bytes)` };
  let body = buf;
  if (ext === 'svg') {
    let svg = buf.toString('utf8');
    if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) return { ok: false, error: 'not an SVG document' };
    if (UNSAFE_SVG.test(svg)) return { ok: false, error: 'the SVG carries script or outside links — refused' };
    if (src.fill && /^#[0-9a-f]{3,8}$/i.test(src.fill) && !/<svg[^>]*\sfill=/i.test(svg)) {
      svg = svg.replace(/<svg(\s|>)/i, `<svg fill="${src.fill}"$1`);
    }
    body = Buffer.from(svg, 'utf8');
  }
  const out = dir || logoDir(adapter.name);
  try {
    mkdirSync(out, { recursive: true });
    const path = join(out, `logo.${ext}`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (e) { return { ok: false, error: `could not save: ${e.message}` }; }
}

export { logoFile, installedLogo, fetchDriverLogo, UNSAFE_SVG };
