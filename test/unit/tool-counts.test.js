/**
 * Fonte di verità unica per il conteggio dei tool.
 *
 * Il numero era divergente in cinque punti del repo (59 in server.json /
 * manifest / listing / docs, 56 in package.json, 30 esposti dal Dockerfile ai
 * registry MCP): ogni documento lo ripeteva a mano. Qui si misura una volta dal
 * codice e si confronta con i testi pubblicati.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure } from '../../tools/measure-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const ALL = measure('all').totals.n_tools;
const CORE = measure('core').totals.n_tools;

test('il conteggio misurato è quello dichiarato nei metadati', () => {
  assert.equal(ALL, 59, 'se il numero di tool cambia, aggiorna i documenti sotto');
  assert.equal(CORE, 30);

  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.description, new RegExp(`${ALL} tools`), `package.json: "${pkg.description}"`);

  const srv = JSON.parse(read('server.json'));
  assert.match(srv.description, new RegExp(String(ALL)), `server.json: "${srv.description}"`);

  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.match(manifest.description, new RegExp(String(ALL)), `manifest: "${manifest.description}"`);
});

test('README e listing non citano un conteggio diverso da quello misurato', () => {
  for (const file of ['README.md', 'docs/index.md', 'docs/store/listing.md']) {
    const text = read(file);
    // Qualunque "<numero> tools" nel testo deve essere il conteggio reale
    // (totale) o quello del set core.
    for (const m of text.matchAll(/(\d{2,3})\s+(?:token-efficient\s+)?(?:specialized\s+)?(?:web-dev\s+)?tools?\b/gi)) {
      const n = Number(m[1]);
      assert.ok(
        n === ALL || n === CORE,
        `${file}: cita "${m[0]}" ma i tool misurati sono ${ALL} (core ${CORE})`,
      );
    }
  }
});

test('il Dockerfile espone tutti i tool ai registry, non solo il core', () => {
  const dockerfile = read('Dockerfile');
  // I registry MCP (Glama, registry ufficiale) enumerano via tools/list: col
  // default caps=core pubblicavano 30 tool contro i 59 del claim.
  assert.match(
    dockerfile,
    /--caps["\s,]+all|CHROME_BRIDGE_CAPS[= ]+["']?all/,
    'il container deve avviarsi con tutte le capability attive',
  );
});

test('install.sh registra il server con le capability esplicite', () => {
  const sh = read('install.sh');
  assert.match(
    sh,
    /CHROME_BRIDGE_CAPS|--caps/,
    'senza caps espliciti l\'utente ottiene 30 tool su 59 mentre i doc ne promettono 59',
  );
});
