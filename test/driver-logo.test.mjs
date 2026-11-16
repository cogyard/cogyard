// test/driver-logo.test.mjs — a driver's logo is downloaded at onboarding from
// the public copy the driver names, and the portal serves the bundled file
// first, else that download. The network is a stub; $COGYARD_HOME is a
// throwaway folder set before core is imported.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-logo-')));
process.env.COGYARD_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { fetchDriverLogo, logoFile, installedLogo } = await import('../core/driver-logo.mjs');

const MARK = '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>X</title><path d="M0 0h24v24H0z"/></svg>';
const reply = (body, type = 'image/svg+xml', status = 200) => async () => new Response(body, { status, headers: { 'content-type': type } });
const driver = (name, extra = {}) => ({ name, liveState: { supported: true, logo: null, logoSource: { url: 'https://example.test/x.svg', fill: '#D97757' }, ...extra } });

test('a good SVG is saved under $COGYARD_HOME/drivers/<name>/, coloured with the declared fill', async () => {
  const r = await fetchDriverLogo(driver('alpha'), { fetchImpl: reply(MARK) });
  assert.equal(r.ok, true);
  assert.equal(r.path, join(ROOT, 'home', 'drivers', 'alpha', 'logo.svg'));
  assert.match(readFileSync(r.path, 'utf8'), /^<svg fill="#D97757" role="img"/);
  assert.equal(installedLogo('alpha'), r.path);
});

test('an SVG that could run script or pull in outside content is refused', async () => {
  for (const bad of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><path d="M0 0"/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
  ]) {
    const r = await fetchDriverLogo(driver('beta'), { fetchImpl: reply(bad) });
    assert.equal(r.ok, false, bad);
  }
  assert.equal(installedLogo('beta'), null);
});

test('wrong type, too large, HTTP error, no source: refused with a reason, never thrown', async () => {
  assert.match((await fetchDriverLogo(driver('g'), { fetchImpl: reply('<html></html>', 'text/html') })).error, /not an SVG or PNG/);
  assert.match((await fetchDriverLogo(driver('g'), { fetchImpl: reply('<svg>' + 'x'.repeat(300 * 1024) + '</svg>') })).error, /too large/);
  assert.match((await fetchDriverLogo(driver('g'), { fetchImpl: reply('nope', 'text/plain', 404) })).error, /HTTP 404/);
  assert.match((await fetchDriverLogo(driver('g'), { fetchImpl: async () => { throw new Error('offline'); } })).error, /offline/);
  assert.match((await fetchDriverLogo({ name: 'g', liveState: {} })).error, /names no logo source/);
});

test('the portal serves the bundled logo first, else the downloaded one, else nothing', async () => {
  const bundled = join(ROOT, 'bundled.svg');
  writeFileSync(bundled, MARK);
  await fetchDriverLogo(driver('delta'), { fetchImpl: reply(MARK) });
  assert.equal(logoFile(driver('delta', { logo: bundled })), bundled);
  assert.equal(logoFile(driver('delta', { logo: join(ROOT, 'missing.svg') })), installedLogo('delta'));
  assert.equal(logoFile(driver('nobody')), null);
});
