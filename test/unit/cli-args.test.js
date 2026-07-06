import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../../server/cli.js';

test('comando + flag con coercion di tipi', () => {
  const { command, params } = parseCliArgs(['click', '--selector', '#btn', '--tab-id', '42', '--force']);
  assert.equal(command, 'click');
  assert.equal(params.selector, '#btn');
  assert.equal(params.tab_id, 42);        // kebab → snake, numero
  assert.equal(params.force, true);       // flag senza valore → true
});

test('boolean espliciti e negativi', () => {
  const { params } = parseCliArgs(['get_interactives', '--visible-only', 'false', '--limit', '10']);
  assert.equal(params.visible_only, false);
  assert.equal(params.limit, 10);
});

test('--json merge di parametri complessi', () => {
  const { params } = parseCliArgs(['fill_form', '--json', '{"fields":[{"selector":"#q","value":"x"}]}', '--tab-id', '7']);
  assert.deepEqual(params.fields, [{ selector: '#q', value: 'x' }]);
  assert.equal(params.tab_id, 7);
});

test('opzioni CLI (out, format) separate dai params', () => {
  const { command, params, opts } = parseCliArgs(['screenshot', '--tab-id', '5', '--out', '/tmp/s.png']);
  assert.equal(command, 'screenshot');
  assert.equal(opts.out, '/tmp/s.png');
  assert.equal(params.out, undefined);
  const r = parseCliArgs(['read_console', '--format', 'json']);
  assert.equal(r.opts.format, 'json');
  assert.equal(r.params.format, undefined);
});

test('alias comandi comuni', () => {
  assert.equal(parseCliArgs(['tabs']).command, 'get_tabs');
  assert.equal(parseCliArgs(['js', '--code', '1+1']).command, 'execute_js');
});

test('comando sconosciuto → errore', () => {
  assert.throws(() => parseCliArgs(['non_esiste']), /Unknown command/);
});

test('valore stringa che sembra selettore resta stringa', () => {
  const { params } = parseCliArgs(['query_dom', '--selector', '.item-2']);
  assert.equal(params.selector, '.item-2');
});
