/**
 * Sezione D dell'analisi: fascicolo di prova (redazione obbligatoria), guarda
 * come faccio (mai valori sensibili), secondo paio d'occhi (lettore di moduli).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactUrl, redactText, redactHar, redactHeaders, buildManifest, evidenceIndex, REDACTED } from '../../server/evidence.js';
import { MessageType } from '../../server/protocol.js';

test('redactUrl oscura token, chiavi e firme nella query, lascia il resto', () => {
  assert.equal(redactUrl('https://a.it/x?page=2&token=abc&sig=zzz'), `https://a.it/x?page=2&token=${encodeURIComponent(REDACTED)}&sig=${encodeURIComponent(REDACTED)}`);
  assert.equal(redactUrl('https://a.it/x?page=2'), 'https://a.it/x?page=2');
});

test('redactText oscura JWT, bearer, csrf e value di input password/hidden', () => {
  const t = redactText('csrf: "AbCdEf123456" Bearer aaaaaaaaaaaaaaaa eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c <input type="hidden" name="_token" value="tok12345"> plain text stays');
  assert.ok(!t.includes('AbCdEf123456') && !t.includes('aaaaaaaaaaaaaaaa') && !t.includes('eyJhbGciOiJIUzI1NiJ9') && !t.includes('tok12345'), t);
  assert.match(t, /plain text stays$/);
});

test('redactHar oscura cookie e header di autorizzazione, URL con token, corpi', () => {
  const har = { log: { entries: [{ request: { url: 'https://a.it/api?access_token=x', headers: [{ name: 'Cookie', value: 'sess=1' }, { name: 'Accept', value: '*/*' }], cookies: [{ name: 'sess', value: '1' }], queryString: [{ name: 'access_token', value: 'x' }] }, response: { headers: [{ name: 'Set-Cookie', value: 'a=b' }], cookies: [], content: { text: 'Bearer zzzzzzzzzzzz' } } }] } };
  const r = redactHar(har);
  const e = r.log.entries[0];
  assert.equal(e.request.headers[0].value, REDACTED);
  assert.equal(e.request.headers[1].value, '*/*');
  assert.equal(e.request.cookies[0].value, REDACTED);
  assert.equal(e.request.queryString[0].value, REDACTED);
  assert.match(e.request.url, /access_token=%5BREDACTED%5D/);
  assert.equal(e.response.headers[0].value, REDACTED);
  assert.match(e.response.content.text, /Bearer \[REDACTED\]/);
  assert.equal(har.log.entries[0].request.headers[0].value, 'sess=1', 'l\'originale non viene toccato');
  assert.deepEqual(redactHeaders({ authorization: 'x', 'content-type': 'text/html' }), { authorization: REDACTED, 'content-type': 'text/html' });
});

test('buildManifest calcola sha256 e dichiara redazione e limite del timestamp', () => {
  const m = buildManifest({ url: 'https://a.it', title: 'A', capturedAt: new Date('2026-09-02T10:00:00Z'), files: [{ name: 'page.txt', bytes: 'hello' }] });
  assert.equal(m.files[0].sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.match(m.timestamp_note, /not a certified timestamp/);
  assert.match(m.redaction, /cookies, authorization headers/);
  const idx = evidenceIndex(m);
  assert.match(idx, /^# Evidence — A\n/);
  assert.match(idx, /\| page\.txt \| 5 \| `2cf24dba/);
});

async function freshTools(env) {
  Object.assign(process.env, env);
  const { registerTools } = await import('../../server/tools.js?d' + Date.now() + Math.random());
  return registerTools;
}

test('session_record observe avvia l\'osservazione e stop scrive jsonl e procedura', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-obs-'));
  const registerTools = await freshTools({ CHROME_BRIDGE_RECORD_DIR: dir });
  const handlers = new Map(); const sent = [];
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, rest[rest.length - 1]) }, { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => {
    sent.push({ t, p });
    if (t === MessageType.OBSERVE && p.action === 'start') return { observing: 'renew', tabId: 5, url: 'https://reg.it/' };
    if (t === MessageType.OBSERVE && p.action === 'stop') return { stopped: 'renew', started_at: 1, final_url: 'https://reg.it/done', steps: [
      { command: 'navigate', params: { url: 'https://reg.it/' }, human: { label: 'Registrar' }, ts: 1 },
      { command: 'type_text', params: { selector: '#user', text: '{{user}}' }, human: { label: 'Username', placeholder: true }, ts: 2 },
      { command: 'type_text', params: { selector: '#pass', text: '{{pass}}' }, human: { label: 'Password', sensitive: true, placeholder: true }, ts: 3 },
      { command: 'click', params: { selector: 'button#login' }, human: { label: 'Log in' }, ts: 4 },
    ] };
    return {};
  } }, 'all');
  const start = await handlers.get('session_record')({ action: 'observe', name: 'renew', values: false });
  assert.match(start.content[0].text, /observing "renew" on tab 5/);
  assert.equal(sent[0].p.values, false);
  const stop = await handlers.get('session_record')({ action: 'stop' });
  const text = stop.content[0].text;
  assert.match(text, /observed 4 step\(s\)/);
  assert.match(text, /1 sensitive field\(s\) recorded as placeholders/);
  const jsonl = (await readFile(join(dir, 'renew.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(jsonl[2], { command: 'type_text', params: { selector: '#pass', text: '{{pass}}' } }, 'niente campo human, niente valore');
  const md = await readFile(join(dir, 'renew.md'), 'utf8');
  assert.match(md, /3\. \[HUMAN\] Enter Password in `#pass` — not recorded/);
  assert.match(md, /4\. Click «Log in» \(`button#login`\)/);
});

test('read_form stampa una riga per controllo e segnala obbligatori vuoti e invalidi', async () => {
  const registerTools = await freshTools({});
  const handlers = new Map();
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, rest[rest.length - 1]) }, { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async () => ({ url: 'https://pa.it/form', count: 3, empty_required: 1, invalid: 1, controls: [
    { label: 'Codice fiscale', selector: '#cf', type: 'text', value: 'RSSMRA80A01H501U', required: true, disabled: false, valid: true, validation: null, empty_required: false },
    { label: 'IBAN', selector: '#iban', type: 'text', value: '', required: true, disabled: false, valid: false, validation: 'Compila questo campo', empty_required: true },
    { label: 'Password', selector: '#pw', type: 'password', value: '[redacted]', required: false, disabled: false, valid: true, validation: null, empty_required: false },
  ] }) }, 'all');
  const res = await handlers.get('read_form')({});
  const t = res.content[0].text;
  assert.match(t, /^form controls=3 empty_required=1 invalid=1 url=https:\/\/pa\.it\/form\nCodice fiscale\ttext\tRSSMRA80A01H501U\t#cf\trequired\n/);
  assert.match(t, /IBAN\ttext\t\(empty\)\t#iban\tREQUIRED EMPTY\n/);
  assert.match(t, /Password\tpassword\t\[redacted\]\t#pw\n/);
  assert.match(t, /never a bare "all good"/);
});
