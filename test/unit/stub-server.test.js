import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureStubServer, addStub, clearStubs, listStubs, stopStubServer, stubHost } from '../../server/stub-server.js';
import { registerTools } from '../../server/tools.js';

after(() => stopStubServer());

test('stub server: serve body/status/content-type con CORS, 404 su id ignoto', async () => {
  const port = await ensureStubServer();
  const id = addStub({ body: '{"items":[]}', status: 201, content_type: 'application/json' });

  const res = await fetch(`http://127.0.0.1:${port}/__stub__/${id}`);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { items: [] });

  const preflight = await fetch(`http://127.0.0.1:${port}/__stub__/${id}`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);

  const miss = await fetch(`http://127.0.0.1:${port}/__stub__/nope`);
  assert.equal(miss.status, 404);

  assert.equal(listStubs().length, 1);
  clearStubs();
  assert.equal(listStubs().length, 0);
});

test('network_rules action=stub: crea stub e regola redirect verso di esso', async () => {
  const sent = [];
  const handlers = new Map();
  registerTools({ tool: (n, _d, _s, h) => handlers.set(n, h) }, {
    isConnected: () => true, mode: 'p', port: 1,
    sendCommand: async (type, params) => { sent.push({ type, params }); return { rule_id: 9 }; },
  });
  const result = await handlers.get('network_rules')({ action: 'stub', url_filter: '||api.test/products*', body: '{"stub":true}' });
  const out = JSON.parse(result.content[0].text);
  assert.match(out.stub_url, new RegExp(`^http://${stubHost().replace(/\\./g, '\\.')}:\\d+/__stub__/s\\d+$`));
  const rule = sent.find((s) => s.type === 'network_rules');
  assert.equal(rule.params.action, 'redirect');
  assert.equal(rule.params.redirect_url, out.stub_url);
  // Lo stub risponde davvero
  const res = await fetch(out.stub_url.replace(stubHost(), '127.0.0.1'));
  assert.deepEqual(await res.json(), { stub: true });
});
