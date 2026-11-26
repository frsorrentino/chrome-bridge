#!/usr/bin/env node
/**
 * Builds plugin/dist/: the MCP server and the CLI bundled with their dependencies, so the
 * Claude Code plugin runs `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js` instead of
 * downloading chrome-bridge-mcp from npm with npx.
 *
 * Why a bundle and not a copy of node_modules: the server needs 292 source files at
 * runtime, and the plugin directory accepts at most 512 files in all (the repository
 * already has 327). The output is not minified, so it stays readable, and it is cut
 * into chunks under 256 KiB, the largest file the plugin directory reads.
 *
 * Usage:
 *   node tools/build-plugin-server.mjs            write plugin/dist/ (tools/build-plugin.mjs calls it)
 *   node tools/build-plugin-server.mjs --out DIR  write elsewhere (the drift test)
 *
 * The npm package keeps shipping server/ as it is: plugin/dist/ is for the plugin only.
 */
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE = 256 * 1024;   // the directory limit
const BUCKET = 200 * 1024;     // what a vendor chunk is filled to, with margin for the wrapper code
// Optional at runtime: tools.js imports it in a try/catch and works without it (perf traces).
const OPTIONAL = ['@paulirish/trace_engine'];

const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 ? process.argv[argOut + 1] : join(ROOT, 'plugin', 'dist');

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** "…/node_modules/@scope/name/lib/x.js" → "@scope/name" */
function packageOf(id) {
  const parts = id.split(sep).join('/').split('/node_modules/');
  if (parts.length < 2) return null;
  const rest = parts[parts.length - 1].split('/');
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

// Chunks are filled per group (one per npm package, one for server/) in a topological order
// of the module graph, with every import cycle kept whole in one chunk: a module only imports
// modules of its own chunk or of earlier ones, so no two chunks import each other and the
// evaluation order stays the one of the unbundled code. Same inputs, same chunks.
const ENTRIES = { index: 'server/index.js', cli: 'server/cli.js', observe: 'server/observe.js' };
const assignment = new Map();   // module id → chunk name
// The commonjs plugin puts virtual modules ("\0…/x.js?commonjs-proxy") between a CommonJS file
// and what it requires: they belong to the group of the file they wrap, or the cycles through
// them stay invisible and end up split across two chunks.
const fileOf = (id) => id.replace(/^\0/, '').split('?')[0];
const groupOf = (id) => packageOf(fileOf(id)) ?? (fileOf(id).startsWith(join(ROOT, 'server') + sep) ? 'server' : null);

// Modules the plugin replaces with a stub of its own (tools/plugin-stubs/): server/lighthouse.js
// fetches the Lighthouse CLI from npm and runs it, which the plugin must not ship. Its stub
// keeps the same exports; the reason is in the stub.
const STUBS = { [join(ROOT, 'server', 'lighthouse.js')]: join(ROOT, 'tools', 'plugin-stubs', 'lighthouse.js') };
function pluginStubs() {
  return {
    name: 'plugin-stubs',
    async resolveId(source, importer, opts) {
      if (!importer || !source.startsWith('.')) return null;
      const r = await this.resolve(source, importer, { ...opts, skipSelf: true });
      return r && STUBS[r.id] ? STUBS[r.id] : null;
    },
  };
}

function planChunks() {
  return {
    name: 'plan-chunks',
    buildEnd() {
      const ids = [...this.getModuleIds()].filter((id) => !this.getModuleInfo(id).isExternal);
      const info = new Map(ids.map((id) => [id, this.getModuleInfo(id)]));
      const entryIds = new Set(Object.values(ENTRIES).map((e) => join(ROOT, e)));
      // Tarjan: strongly connected components, emitted dependencies first.
      let index = 0;
      const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
      const deps = (id) => [...info.get(id).importedIds].filter((d) => info.has(d) && groupOf(d) === groupOf(id));
      const visit = (v) => {
        idx.set(v, index); low.set(v, index); index += 1; stack.push(v); onStack.add(v);
        for (const w of deps(v)) {
          if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
          else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
        }
        if (low.get(v) === idx.get(v)) {
          const scc = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
          sccs.push(scc);
        }
      };
      // Sorted by the path inside the repository with "/": absolute Windows paths ("D:\…") sort in
      // another order than POSIX ones, and the chunks came out different on the two systems.
      const key = (id) => id.split(ROOT).join('').split('\\').join('/');
      const byKey = [...ids].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
      for (const id of byKey) if (!idx.has(id) && groupOf(id)) visit(id);
      const fill = new Map();   // group → { n, size }
      for (const scc of sccs) {
        const group = groupOf(scc[0]);
        if (scc.some((id) => entryIds.has(id))) continue;   // entries stay in their own files
        // The size of the file on disk, not of info.code: the commonjs plugin writes absolute import
        // paths into the transformed code, so its length changed with the checkout folder and the
        // chunks with it (CI, Windows). Virtual modules count 0.
        const size = scc.reduce((s, id) => s + (id.startsWith('\0') ? 0 : statSync(fileOf(id)).size), 0);
        const b = fill.get(group) ?? { n: 1, size: 0 };
        if (b.size > 0 && b.size + size > BUCKET) { b.n += 1; b.size = 0; }
        b.size += size;
        fill.set(group, b);
        const name = group === 'server' ? `server-${b.n}` : `vendor-${group.replace('@', '').replace('/', '-')}-${b.n}`;
        for (const id of scc) assignment.set(id, name);
      }
    },
  };
}
const manualChunks = (id) => assignment.get(id);

const bundle = await rollup({
  // observe.js is an entry of its own: it starts itself again as `node <its file> --write`
  // (server/observe.js, SELF), so its code must live in a file named after it.
  // Absolute: relative inputs resolve against the current folder, not against this repository.
  input: Object.fromEntries(Object.entries(ENTRIES).map(([k, v]) => [k, join(ROOT, v)])),
  external: (id) => builtins.has(id) || OPTIONAL.some((p) => id === p || id.startsWith(`${p}/`)),
  plugins: [pluginStubs(), nodeResolve({ preferBuiltins: true, exportConditions: ['node'] }), commonjs(), json(), planChunks()],
  onwarn(w, warn) {
    // zod's /* @__PURE__ */ comments in positions rollup drops: harmless, only tree-shaking hints
    if (['CIRCULAR_DEPENDENCY', 'THIS_IS_UNDEFINED', 'INVALID_ANNOTATION'].includes(w.code)) return;
    warn(w);
  },
});

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { output } = await bundle.write({
  dir: OUT,
  format: 'es',
  entryFileNames: '[name].js',
  chunkFileNames: '[name].js',
  manualChunks,
  generatedCode: 'es2015',
  // rollup keeps the entry's own hashbang on the first line, ahead of this banner
  banner: '// Generated by tools/build-plugin-server.mjs from server/ and node_modules/: do not edit, rebuild.',
});
await bundle.close();

// Licenses of everything bundled: MIT, ISC and BSD ask for the notice to travel with the code.
const packages = new Map();
for (const chunk of output) {
  if (chunk.type !== 'chunk') continue;
  for (const raw of Object.keys(chunk.modules)) {
    if (raw.startsWith('\0')) continue;   // commonjs helpers and proxies, not files
    const id = raw.split('?')[0];
    const pkg = packageOf(id);
    if (!pkg || packages.has(pkg)) continue;
    const base = id.split(sep).join('/').slice(0, id.split(sep).join('/').lastIndexOf(`/node_modules/${pkg}/`)) + `/node_modules/${pkg}`;
    const meta = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    const lic = readdirSync(base).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    packages.set(pkg, { version: meta.version, license: meta.license, text: lic ? readFileSync(join(base, lic), 'utf8').trim() : '' });
  }
}
const notices = [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))
  .map(([name, p]) => `## ${name} ${p.version} (${p.license})\n\n${p.text || 'No license file in the package.'}\n`);
writeFileSync(join(OUT, 'THIRD_PARTY_LICENSES.md'),
  `# Third-party licenses\n\nCode bundled into plugin/dist/ by tools/build-plugin-server.mjs.\n\n${notices.join('\n')}`);

const files = readdirSync(OUT).map((f) => ({ f, size: statSync(join(OUT, f)).size }));
const big = files.filter((x) => x.size >= MAX_FILE);
if (big.length) {
  console.error(`Over 256 KiB: ${big.map((x) => `${x.f} ${x.size}`).join(', ')}`);
  process.exit(1);
}
const total = files.reduce((s, x) => s + x.size, 0);
console.log(`${relative(process.cwd(), OUT) || '.'}: ${files.length} files, ${(total / 1024).toFixed(0)} KiB, largest ${Math.max(...files.map((x) => x.size))} bytes`);
if (!existsSync(join(OUT, 'index.js'))) process.exit(1);
