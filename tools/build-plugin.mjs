#!/usr/bin/env node
/**
 * Writes plugin/, the folder Claude Code installs (marketplace.json: source "./plugin").
 *
 * Why a folder of its own: with the plugin at the root of the repository every user got the
 * whole repository in the plugin cache, tests, docs, benchmarks and the Chrome Web Store
 * release tool (tools/cws-upload.mjs) included. plugin/ holds only what runs:
 *
 *   .claude-plugin/   manifest and icon            written by hand, here, not copied
 *   dist/             server and CLI bundled       tools/build-plugin-server.mjs
 *   skills/ commands/ hooks/ observe/ extension/   copies of the folders at the root
 *   LICENSE
 *
 * The folders at the root stay the source: npm, the Chrome Web Store workflows and
 * claude-observe's sync.py keep writing and reading them there. Run this after changing any
 * of them, and at every release; test/unit/plugin-dir.test.js fails when plugin/ is stale.
 *
 * Usage:
 *   node tools/build-plugin.mjs            rewrite plugin/ (the manifest is left alone)
 *   node tools/build-plugin.mjs --out DIR  write the generated part elsewhere (the drift test)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const COPIED = ['skills', 'commands', 'hooks', 'observe', 'extension'];
export const COPIED_FILES = ['LICENSE'];
// Produced by running the code, never part of the plugin.
const SKIP = new Set(['__pycache__', '.DS_Store', 'node_modules']);

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).sort()) {
    if (SKIP.has(name) || name.endsWith('.pyc')) continue;
    const src = join(from, name);
    const st = lstatSync(src);
    // The directory refuses links that point outside the plugin: copy files, never links.
    if (st.isSymbolicLink()) throw new Error(`${src} is a symbolic link: plugin/ takes only real files`);
    if (st.isDirectory()) copyTree(src, join(to, name));
    else copyFileSync(src, join(to, name));
  }
}

export function buildPlugin(out) {
  for (const dir of [...COPIED, ...COPIED_FILES, 'dist']) rmSync(join(out, dir), { recursive: true, force: true });
  for (const dir of COPIED) copyTree(join(ROOT, dir), join(out, dir));
  for (const f of COPIED_FILES) copyFileSync(join(ROOT, f), join(out, f));
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-plugin-server.mjs'), '--out', join(out, 'dist')], { stdio: 'inherit' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : join(ROOT, 'plugin');
  buildPlugin(out);
}
