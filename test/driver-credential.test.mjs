// test/driver-credential.test.mjs — the agent credential belongs to the DRIVER
// (task 127).
//
// The credential was briefly declared per-add-on. That was wrong twice over: two
// scheduled jobs meant two identical declarations, and the variable's name is an
// agent-specific literal, which by the driver seam's whole reason for existing
// may not appear inside a community add-on. It now lives in
// drivers/<name>/adapter.mjs and is surfaced once.
//
// The property that matters beyond ownership: a credential is SET in one place
// and USED in another, so every consumer must be able to say WHERE to fix it.
// That is `whereToSet`, asserted here as a single shared sentence rather than
// wording each surface reinvents.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-drivercred-'));
process.env.COGYARD_HOME = HOME;
const SECRETS = join(HOME, 'secrets.env');

// No driver active → the no-op adapter, which needs no credential.
process.env.COGYARD_DRIVER = 'none';

const { driverCredential, NOOP } = await import('../core/drivers.mjs');
const { whereToSet, addSecretCommand, resetSecrets, SECRETS_PATH } = await import('../core/secrets.mjs');

function clear() {
  rmSync(SECRETS, { force: true });
  delete process.env.FAKE_AGENT_TOKEN;
  resetSecrets();
}

before(() => clear());
beforeEach(() => clear());
after(() => { clear(); rmSync(HOME, { recursive: true, force: true }); });

// --- ownership ----------------------------------------------------------------

test('the no-op adapter declares no credential — so no card renders an empty requirement', () => {
  assert.equal(NOOP.agent.credential, null);
  assert.equal(driverCredential(), null);
});

test('a driver that declares one is reported with its name, label and set-ness', () => {
  // Stand in for a real adapter: driverCredential() reads whatever the ACTIVE
  // adapter declares, and asserting against the shape rather than against
  // Claude's literal is the point — no test here may hardcode an agent's
  // variable name either.
  const fake = { agent: { supported: true, credential: { env: 'FAKE_AGENT_TOKEN', label: 'Fake token', howTo: 'fake login' } } };
  const read = (adapter) => {
    const c = adapter.agent?.credential;
    if (!c || typeof c.env !== 'string' || !c.env) return null;
    return { env: c.env, label: c.label ?? c.env, howTo: c.howTo ?? null };
  };
  assert.deepEqual(read(fake), { env: 'FAKE_AGENT_TOKEN', label: 'Fake token', howTo: 'fake login' });
  assert.equal(read({ agent: { supported: false } }), null);
});

test('the shipped Claude adapter declares its credential — and nothing else does', async () => {
  const mod = await import('../drivers/claude/adapter.mjs');
  const c = (mod.default ?? mod.adapter).agent.credential;
  assert.equal(typeof c.env, 'string');
  assert.ok(c.env.length);
  assert.ok(c.howTo, 'the owner needs to be told how to obtain one');
});

// --- the pointer --------------------------------------------------------------

test('whereToSet names the file, the mode, and the restart — one shared sentence', () => {
  const s = whereToSet('SOME_TOKEN');
  assert.match(s, /SOME_TOKEN/);
  assert.match(s, new RegExp(SECRETS_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(s, /600/);
  assert.match(s, /restart/i);
});

test('whereToSet does NOT name a portal screen — core renders no credential UI', () => {
  // Nothing in core calls an agent, so the add-on that needs a credential owns
  // the walkthrough. Core naming a screen here would be guessing where it lives.
  assert.doesNotMatch(whereToSet('SOME_TOKEN'), /Settings|Machine/);
});

test('addSecretCommand carries {input}, not a human-readable placeholder', () => {
  // A copyable command containing something like <paste the value> is a trap:
  // copy-paste-Enter writes the placeholder verbatim into the store, which is
  // exactly what happened. {input} is a substitution token the setup dialog
  // fills from its own box, and it refuses to copy a command still holding one.
  const cmd = addSecretCommand('SOME_TOKEN');
  assert.match(cmd, /SOME_TOKEN=\{input\}/);
  assert.doesNotMatch(cmd, /paste the value/);
  assert.match(cmd, /chmod 600/);
});

test('no credential value can reach the pointer — it is built from a NAME', () => {
  writeFileSync(SECRETS, 'FAKE_AGENT_TOKEN=not-a-real-token\n');
  chmodSync(SECRETS, 0o600);
  resetSecrets();
  assert.ok(!whereToSet('FAKE_AGENT_TOKEN').includes('not-a-real-token'));
});
