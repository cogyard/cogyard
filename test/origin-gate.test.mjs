// test/origin-gate.test.mjs — requireSameOrigin, the gate every portal write
// passes through. It must let in every address the portal can be opened at on
// this machine, and nothing that only looks like one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireSameOrigin } from '../server/http.mjs';

const gate = (origin) => requireSameOrigin({ headers: origin == null ? {} : { origin } });

test('every local address the portal is opened at may write', () => {
  for (const o of [
    'http://localhost:7440', 'http://127.0.0.1:7440', 'http://localhost:4200',
    'http://cogyard', 'https://cogyard',
    'http://cogyard.localhost', 'http://cogyard.localhost:7440', 'https://cogyard.localhost',
  ]) assert.equal(gate(o), null, o);
});

test('a non-browser caller with no Origin header may write', () => {
  assert.equal(gate(undefined), null);
});

test('other sites, including look-alikes, are rejected', () => {
  for (const o of [
    'https://evil.example', 'http://localhost.evil.example', 'http://cogyard.evil',
    'http://evil.example/.localhost', 'http://cogyard.localhost.evil.example', 'null',
  ]) assert.equal(gate(o), 'cross-origin request rejected', o);
});
