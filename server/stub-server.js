/**
 * Mini server HTTP per il response stubbing di network_rules.
 *
 * declarativeNetRequest può bloccare/redirigere ma non sintetizzare body:
 * le richieste da stubbare vengono redirette qui, dove serviamo la risposta
 * registrata (CORS aperto). Porta effimera, avviato al primo stub.
 *
 * Nota mixed-content: da pagine HTTPS il browser blocca redirect verso
 * http:// non-trustworthy. 127.0.0.1 è trattato come sicuro; su ChromeOS
 * (host penguin.linux.test) gli stub valgono per pagine http/dev server.
 */

import { createServer } from 'node:http';
import { hostname } from 'node:os';

const stubs = new Map();
let server = null;
let port = null;
let seq = 0;

/** Host raggiungibile dal browser: override env, poi euristica Crostini. */
export function stubHost() {
  if (process.env.CHROME_BRIDGE_STUB_HOST) return process.env.CHROME_BRIDGE_STUB_HOST;
  return hostname() === 'penguin' ? 'penguin.linux.test' : '127.0.0.1';
}

export async function ensureStubServer() {
  if (server) return port;
  server = createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const id = (req.url || '').replace(/^\/__stub__\//, '').split('?')[0];
    const stub = stubs.get(id);
    if (!stub) {
      res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
      res.end('stub not found');
      return;
    }
    res.writeHead(stub.status, { ...cors, 'Content-Type': stub.content_type });
    res.end(stub.body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 0.0.0.0: su Crostini il browser host entra dall'interfaccia del container
    server.listen(0, '0.0.0.0', resolve);
  });
  server.unref();
  port = server.address().port;
  return port;
}

export function addStub({ body, status = 200, content_type = 'application/json' }) {
  const id = `s${++seq}`;
  stubs.set(id, { body, status, content_type });
  return id;
}

export function clearStubs() {
  stubs.clear();
}

export function listStubs() {
  return [...stubs.entries()].map(([id, s]) => ({ id, status: s.status, content_type: s.content_type, bytes: Buffer.byteLength(s.body) }));
}

export async function stopStubServer() {
  stubs.clear();
  if (server) {
    await new Promise((r) => server.close(r));
    server = null;
    port = null;
  }
}
