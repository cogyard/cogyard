#!/usr/bin/env node
// scripts/generate-version.mjs — the SINGLE source of the app's version + commit.
//
// Writes frontend/src/version.json from the ROOT package.json version + the short
// git HEAD. Run at build time (frontend pre-build/pre-start). BOTH consumers read
// this one artifact: the SPA imports it (build-stamped into the hashed bundle, so
// the footer is correct in the web portal AND the packaged desktop app, with no
// runtime /api/health dependency), and the API (server/routes/meta.mjs) reads it
// for /api/health. Never hand-edit the output — it's generated + gitignored.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const version = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

let commit = null;
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
catch { /* no git (e.g. a packaged/extracted tree) — commit stays null */ }

const out = join(ROOT, 'frontend', 'src', 'version.json');
writeFileSync(out, JSON.stringify({ version, commit }, null, 2) + '\n');
process.stdout.write(`generate-version: v${version} (${commit || 'no-git'}) → frontend/src/version.json\n`);
