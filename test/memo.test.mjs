// Tests for memoize — the change-signal-keyed cache that backs the portal's
// git-derived views (core/memo.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoize, clearMemo } from '../core/memo.mjs';

test('reuses the cached value while the signal is unchanged', async () => {
  clearMemo();
  let computes = 0;
  const sig = () => Promise.resolve('s1');
  const run = () => memoize('t', 'k', sig, async () => { computes++; return computes; });
  assert.equal(await run(), 1);
  assert.equal(await run(), 1); // hit — compute not re-run
  assert.equal(await run(), 1);
  assert.equal(computes, 1);
});

test('recomputes when the signal changes', async () => {
  clearMemo();
  let signal = 'a';
  let computes = 0;
  const run = () => memoize('t', 'k', () => Promise.resolve(signal), async () => { computes++; return signal + computes; });
  assert.equal(await run(), 'a1');
  signal = 'b';
  assert.equal(await run(), 'b2'); // signal moved → recompute
  assert.equal(await run(), 'b2'); // stable again → hit
  assert.equal(computes, 2);
});

test('a null signal bypasses the cache entirely (transient error never poisons it)', async () => {
  clearMemo();
  let computes = 0;
  const run = (sig) => memoize('t', 'k', () => Promise.resolve(sig), async () => { computes++; return computes; });
  assert.equal(await run(null), 1); // not cached
  assert.equal(await run(null), 2); // runs again
  assert.equal(await run('ok'), 3); // now caches
  assert.equal(await run('ok'), 3); // hit
  assert.equal(computes, 3);
});

test('keys and namespaces are isolated', async () => {
  clearMemo();
  const v = (ns, k, val) => memoize(ns, k, () => Promise.resolve('s'), async () => val);
  assert.equal(await v('a', 'k1', 'A1'), 'A1');
  assert.equal(await v('a', 'k2', 'A2'), 'A2'); // different key, own slot
  assert.equal(await v('b', 'k1', 'B1'), 'B1'); // different namespace, own slot
  assert.equal(await v('a', 'k1', 'IGNORED'), 'A1'); // original still cached
});

test('signalFn runs on every call (so it can thread work into computeFn)', async () => {
  clearMemo();
  let signalCalls = 0;
  const run = () => memoize('t', 'k', () => { signalCalls++; return Promise.resolve('const'); }, async () => 'v');
  await run(); await run(); await run();
  assert.equal(signalCalls, 3); // even on hits
});

test('clearMemo(namespace) drops just that namespace', async () => {
  clearMemo();
  let computes = 0;
  const run = (ns) => memoize(ns, 'k', () => Promise.resolve('s'), async () => { computes++; return computes; });
  await run('a'); await run('b'); // computes = 2
  clearMemo('a');
  await run('a'); // recompute → 3
  await run('b'); // still cached → no recompute
  assert.equal(computes, 3);
});
