#!/usr/bin/env node
// cli/driver-logo.mjs — download the active driver's logo into
// $COGYARD_HOME/drivers/<name>/ if this machine has none (core/driver-logo.mjs).
//
// `cogyard claude install` downloads it as part of onboarding. A PLUGIN install
// runs no install step, so the SessionStart engine hook starts this script
// detached on each session start; it does nothing once the logo is there, and
// tries the network at most once every few hours when it can't get it.
// Always exits 0, prints nothing: nobody is watching.

import { statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { COGYARD_HOME } from '../core/paths.mjs';
import { adapter } from '../core/drivers.mjs';
import { logoFile, fetchDriverLogo } from '../core/driver-logo.mjs';

const RETRY_MS = 6 * 60 * 60 * 1000;

try {
  if (adapter.liveState?.logoSource && !logoFile(adapter)) {
    const dir = join(COGYARD_HOME, 'drivers', adapter.name);
    const marker = join(dir, '.last-attempt');
    let recent = false;
    try { recent = Date.now() - statSync(marker).mtimeMs < RETRY_MS; } catch {}
    if (!recent) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(marker, new Date().toISOString() + '\n');
      await fetchDriverLogo(adapter);
    }
  }
} catch { /* a missing logo only means the status line shows none */ }
process.exit(0);
