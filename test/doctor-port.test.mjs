// test/doctor-port.test.mjs — `cogyard doctor`'s serve-port check must see a
// portal that is already listening. The portal binds every address
// (server.listen(PORT)); the probe used to bind only 127.0.0.1, which macOS
// allows beside a wildcard listener, so a busy port was reported free.
//
// Runs with a throwaway HOME, $COGYARD_HOME and $CLAUDE_CONFIG_DIR so nothing
// on this machine is read or written.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const COGYARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'cogyard.mjs');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-doctor-port-')));
after(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, 'home');
mkdirSync(home);

// Async spawn: the listener lives in this process, so a blocking spawnSync
// would stop it from accepting while doctor probes.
function doctor(port) {
  return new Promise((resolve) => {
    const child = spawn('node', [COGYARD, 'doctor'], {
      cwd: root,
      env: { ...process.env, HOME: home, COGYARD_HOME: join(home, '.cogyard'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PORT: String(port) },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
  });
}

function listenLikeThePortal() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => resolve(srv));
  });
}

test('a port the portal is listening on is reported in use', async () => {
  const srv = await listenLikeThePortal();
  const { port } = srv.address();
  try {
    const out = await doctor(port);
    assert.match(out, new RegExp(`port ${port} is in use`));
  } finally {
    srv.close();
  }
});

test('a port nothing listens on is reported free', async () => {
  const srv = await listenLikeThePortal();
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  const out = await doctor(port);
  assert.match(out, new RegExp(`port ${port} free`));
});
