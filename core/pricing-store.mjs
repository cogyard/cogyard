// core/pricing-store.mjs — the SYNCED price table on disk.
//
// The active driver ships a built-in price table (the `pricing` seam), but a
// hand-written table goes stale the day a new model ships: an unknown model
// prices at null and its work silently reads as $0. So the table is kept fresh
// from the driver's own upstream feed (`pricing.sync()`), and the result lands
// HERE — $COGYARD_HOME/pricing.json — not back in the repo.
//
// Storage is engine-owned (the driver never touches the filesystem); the DATA is
// driver-owned (only the driver knows what its models cost and where to look).
//
// Keyed BY DRIVER, because a machine can run more than one over time and two
// drivers sharing one slot would take turns clobbering each other — the loser
// silently falling back to its seed table, which is the same invisible-wrong-cost
// failure this whole mechanism exists to kill:
//   {drivers: {<name>: {updated, source, versions: [{version, effective, source, models}]}}}
// `versions` is newest-first and append-only — same shape the seam already
// defines, so core/pricing.mjs can concatenate a driver's stored versions in
// front of its built-in ones and treat the result as one list. Rows keep the cost
// they were priced with; a new version only affects future pricing.
//
// The original single-driver shape ({driver, updated, source, versions}) is read
// as that one driver's entry, so an existing store keeps working untouched.

import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';

const PRICING_PATH = join(COGYARD_HOME, 'pricing.json');

// How many versions to keep. Rates change a few times a year, so this is a
// runaway guard, not a real limit — old versions are history for reading, never
// re-applied to a priced row.
const MAX_VERSIONS = 50;

// priceFor() runs per ledger row, so re-parsing the store on every call would
// mean thousands of reads in one reprice. Cache on mtime+size: a sync (or a
// hand-edit) invalidates it on the next call, with no restart.
let cache = { key: null, value: null };

function readPricingStore() {
  let key;
  try {
    const st = statSync(PRICING_PATH);
    key = `${st.mtimeMs}:${st.size}`;
  } catch { cache = { key: null, value: null }; return null; }
  if (cache.key === key) return cache.value;
  let value = null;
  try {
    const obj = JSON.parse(readFileSync(PRICING_PATH, 'utf8'));
    value = normalize(obj);
  } catch { /* torn or hand-mangled file → fall back to the built-in table */ }
  cache = { key, value };
  return value;
}

// Both shapes in, one shape out: {drivers: {<name>: {updated, source, versions}}}
function normalize(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.drivers && typeof obj.drivers === 'object') return obj;
  // Legacy single-driver store — one driver's entry, keyed by its own name.
  if (typeof obj.driver === 'string' && Array.isArray(obj.versions)) {
    return { drivers: { [obj.driver]: { updated: obj.updated, source: obj.source, versions: obj.versions } } };
  }
  return null;
}

function entryFor(driverName) {
  const store = readPricingStore();
  if (!store || !driverName) return null;
  const entry = store.drivers[driverName];
  return entry && Array.isArray(entry.versions) ? entry : null;
}

// Versions this driver may use, newest first. [] when there's no store, the
// store is unreadable, or it holds nothing for this driver.
function storedVersions(driverName) {
  const entry = entryFor(driverName);
  if (!entry) return [];
  return entry.versions.filter((v) => v && v.models && typeof v.models === 'object');
}

// Prepend a version for ONE driver and persist, leaving every other driver's
// entry untouched. Atomic (tmp + rename) so a crashed write can never leave a
// half-parsed table behind.
function appendPricingVersion(driverName, version, meta = {}) {
  const store = readPricingStore();
  const drivers = (store && store.drivers) || {};
  const existing = (drivers[driverName] && drivers[driverName].versions) || [];
  const next = {
    drivers: {
      ...drivers,
      [driverName]: {
        updated: new Date().toISOString(),
        source: meta.source || (drivers[driverName] && drivers[driverName].source) || null,
        versions: [version, ...existing].slice(0, MAX_VERSIONS),
      },
    },
  };
  mkdirSync(COGYARD_HOME, { recursive: true });
  const tmp = PRICING_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, PRICING_PATH);
  cache = { key: null, value: null };
  return next;
}

export { PRICING_PATH, readPricingStore, storedVersions, appendPricingVersion, entryFor as storedEntry };
