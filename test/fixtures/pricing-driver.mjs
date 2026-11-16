// test/fixtures/pricing-driver.mjs — a stand-in agent driver for the pricing
// tests (task 113). Loaded via COGYARD_DRIVER=<path>, which core/drivers.mjs
// supports so a driver can live outside the repo.
//
// Its pricing.sync() is scripted by the test (see `script` below) instead of
// hitting the network: the engine's job is to decide whether the feed changed
// anything and to own the write, and that decision is what these tests lock.

const seed = {
  version: 'seed-1',
  effective: 'seed-1',
  source: 'built-in seed',
  models: {
    'model-a': { input: 10, output: 50 },
    'model-b': { input: 1, output: 5 },
  },
};

// The test mutates this between calls: {models} to succeed, {throws} to fail.
const script = { models: null, throws: null, calls: 0 };

export default {
  name: 'testdriver',
  detect() { return false }, // never auto-detected; only via COGYARD_DRIVER
  worktree: { detect() { return null }, branchPrefix: null },
  transcripts: {
    supported: false,
    root() { return null },
    list() { return [] },
    findBySession() { return [] },
    parseLine() { return null },
    firstHumanLabel() { return null },
    readTurns() { return { turns: [], truncated: false } },
  },
  pricing: {
    versions: [seed],
    aliases: { 'alias-of-a': 'model-a' },
    async sync() {
      script.calls += 1;
      if (script.throws) throw new Error(script.throws);
      return { models: script.models, source: 'test-feed' };
    },
  },
  sessions: { supported: false, list() { return [] }, listArchived() { return [] }, archive() { throw new Error('n/a') }, appRunning() { return false } },
};

export { seed, script };
