// Copies the Material Icon Theme SVGs from the hoisted node_modules into
// public/assets so the Angular builder can ship them (it refuses asset inputs
// outside the workspace root). Runs via prebuild/prestart; output is gitignored.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'node_modules', 'vscode-material-icons', 'generated', 'icons');
const dest = join(here, '..', 'public', 'assets', 'material-icons');

if (!existsSync(src)) {
  console.error('vscode-material-icons not installed at ' + src);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('material icons → public/assets/material-icons');
