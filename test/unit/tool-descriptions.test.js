/**
 * L'audit di Glama ha dato 2.4/5 su `read_page`, `get_performance`, `modify_dom`
 * e `web_vitals` con una motivazione precisa: la descrizione non dice cosa fa il
 * tool al mondo né quanto costa. `read_page` era "Read the content of a Chrome
 * tab page" — 37 caratteri, mentre le istruzioni del server avvertono che
 * read_page su una tabella grande costa decine di migliaia di token. Quella
 * guida l'agente la legge una volta all'inizio; la descrizione la rilegge nel
 * momento in cui sceglie.
 *
 * Il pavimento qui non misura la qualità della prosa — misura che qualcuno ci
 * abbia pensato. Un tool con parametri e nessuna spiegazione è un tool che verrà
 * chiamato a caso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';

function describeAll() {
  const out = [];
  registerTools(
    { tool: (name, desc, schema) => out.push({ name, desc: desc ?? '', schema: schema ?? {} }) },
    { isConnected: () => false, mode: 'primary', host: '127.0.0.1', port: 8765, sendCommand: async () => ({}) },
    'all',
  );
  return out;
}

const TOOLS = describeAll();
const FLOOR = 60;

test('nessuna descrizione sta sotto il pavimento minimo', () => {
  const short = TOOLS.filter((t) => t.desc.length < FLOOR).map((t) => `${t.name} (${t.desc.length}: "${t.desc}")`);
  assert.deepEqual(short, [], `descrizioni sotto ${FLOOR} caratteri`);
});

test('i tool che scrivono dichiarano in prosa cosa toccano', () => {
  // Non basta l'annotation: destructiveHint dice "distrugge", non "cosa".
  const cases = [
    ['modify_dom', /revert|reload|persist|until/i],
    ['tab_action', /close|closes/i],
    ['inject_css', /remove|until|reload|persist/i],
    ['set_storage', /cookie/i],
    ['get_storage', /cookie/i],
  ];
  for (const [name, pattern] of cases) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, `tool "${name}" non registrato`);
    assert.match(t.desc, pattern, `${name}: la descrizione non dice cosa cambia o su cosa agisce`);
  }
});

test('i tool costosi in token avvertono del costo', () => {
  for (const name of ['read_page', 'full_page_screenshot']) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, `tool "${name}" non registrato`);
    assert.match(
      t.desc,
      /token|cost|expensive|cheaper|instead|prefer/i,
      `${name}: nessun avviso sul costo, e l'agente non ha modo di saperlo prima`,
    );
  }
});
