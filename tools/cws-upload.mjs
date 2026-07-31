#!/usr/bin/env node
/**
 * Carica e pubblica lo zip dell'estensione sul Chrome Web Store via API.
 *
 * Esiste per togliere di mezzo il TOTP: la dev console non è automatizzabile
 * (la gallery non è scriptabile da un'estensione, e via CDP serve comunque il
 * login Google completo), mentre l'API vuole solo un refresh token revocabile.
 *
 * Credenziali in ~/.config/chrome-bridge/cws.json (chmod 600), MAI nel repo:
 *   { "client_id": "...", "client_secret": "...", "refresh_token": "...", "item_id": "..." }
 * Sovrascrivibili da CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN / CWS_ITEM_ID.
 *
 * Uso:
 *   node tools/cws-upload.mjs dist/chrome-bridge-extension-1.11.0.zip           # carica come bozza
 *   node tools/cws-upload.mjs dist/....zip --publish                            # carica e pubblica
 *   node tools/cws-upload.mjs --status                                         # stato della bozza sullo store
 *   node tools/cws-upload.mjs --auth [porta]                                    # URL di consenso + cattura del codice sul loopback
 *   node tools/cws-upload.mjs --exchange <code> [--redirect <uri>]              # code → refresh token
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CONFIG = join(homedir(), '.config', 'chrome-bridge', 'cws.json');
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
// Google ha dismesso il redirect fuori banda (urn:ietf:wg:oauth:2.0:oob): un
// client nuovo che lo usa riceve "Errore 400: invalid_request". Per i client
// desktop la strada supportata è il loopback su una porta qualsiasi, che qui
// viene aperta al volo e chiusa appena arriva il codice.
function buildAuthUrl(clientId, redirectUri) {
  return 'https://accounts.google.com/o/oauth2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
}

// Attende un solo codice sul loopback e poi chiude: nessun server che resta su.
function waitForCode(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>${code ? 'Autorizzato. Puoi chiudere questa scheda.' : 'Errore: ' + (err || 'nessun codice')}</h2>`);
      server.close();
      if (code) resolve(code); else reject(new Error(err || 'nessun codice nella risposta'));
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
    setTimeout(() => { server.close(); reject(new Error('nessuna autorizzazione entro 5 minuti')); }, 300000);
  });
}

export async function loadConfig(env = process.env) {
  let file = {};
  try { file = JSON.parse(await readFile(CONFIG, 'utf8')); } catch { /* prima esecuzione */ }
  return {
    client_id: env.CWS_CLIENT_ID || file.client_id,
    client_secret: env.CWS_CLIENT_SECRET || file.client_secret,
    refresh_token: env.CWS_REFRESH_TOKEN || file.refresh_token,
    item_id: env.CWS_ITEM_ID || file.item_id,
  };
}

export function requireFields(cfg, fields) {
  const missing = fields.filter((f) => !cfg[f]);
  if (missing.length) {
    throw new Error(`Manca ${missing.join(', ')} — mettili in ${CONFIG} o nelle variabili CWS_*`);
  }
}

/**
 * Il Web Store risponde 200 anche quando il caricamento è fallito: l'esito vero
 * è in uploadState, e itemError porta il motivo. Trattare 200 come successo è
 * il modo di credere di aver pubblicato senza averlo fatto.
 */
export function interpretUpload(body) {
  const state = body?.uploadState;
  if (state === 'SUCCESS') return { ok: true, state };
  const reasons = (body?.itemError || []).map((e) => e.error_detail || e.errorDetail || JSON.stringify(e));
  return { ok: false, state: state ?? 'UNKNOWN', reasons };
}

export function interpretPublish(body) {
  const status = body?.status || [];
  const ok = status.includes('OK') || status.includes('PUBLISHED_WITH_FRICTION_WARNING');
  return { ok, status, detail: body?.statusDetail || [] };
}

async function exchange(cfg, code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id, client_secret: cfg.client_secret,
      code, grant_type: 'authorization_code', redirect_uri: redirectUri,
    }),
  });
  const body = await res.json();
  if (!body.refresh_token) throw new Error(`Nessun refresh_token: ${JSON.stringify(body)}`);
  return body.refresh_token;
}

async function saveRefreshToken(cfg, refresh_token) {
  await mkdir(dirname(CONFIG), { recursive: true });
  await writeFile(CONFIG, JSON.stringify({ ...cfg, refresh_token }, null, 2), { mode: 0o600 });
  console.log(`refresh_token salvato in ${CONFIG} (chmod 600)`);
}

async function accessToken(cfg) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    // invalid_grant qui significa quasi sempre consent screen in "Testing":
    // in quello stato Google scade i refresh token dopo 7 giorni.
    throw new Error(`Token refresh fallito (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = await loadConfig();

  if (argv.includes('--auth')) {
    requireFields(cfg, ['client_id', 'client_secret']);
    const portArg = argv[argv.indexOf('--auth') + 1];
    const port = Number(portArg) > 0 ? Number(portArg) : 8899;
    const redirect = `http://localhost:${port}`;
    console.log(buildAuthUrl(cfg.client_id, redirect));
    console.error(`in attesa del codice su ${redirect} …`);

    const code = await waitForCode(port);
    const token = await exchange(cfg, code, redirect);
    await saveRefreshToken(cfg, token);
    return;
  }

  const exIdx = argv.indexOf('--exchange');
  if (exIdx !== -1) {
    requireFields(cfg, ['client_id', 'client_secret']);
    const code = argv[exIdx + 1];
    if (!code) throw new Error('Uso: --exchange <codice> [--redirect <uri>]');
    const rIdx = argv.indexOf('--redirect');
    const redirect = rIdx !== -1 ? argv[rIdx + 1] : 'http://localhost:8899';
    await saveRefreshToken(cfg, await exchange(cfg, code, redirect));
    return;
  }

  if (argv.includes('--publish-only')) {
    // Serve a distinguere due stati che l'API confonde in un solo messaggio di
    // errore: "in revisione" (non si può fare nulla, si aspetta) e "pronta da
    // pubblicare" (la revisione è passata e manca solo questa chiamata).
    requireFields(cfg, ['client_id', 'client_secret', 'refresh_token', 'item_id']);
    const token = await accessToken(cfg);
    const res = await fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${cfg.item_id}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2', 'Content-Length': '0' },
    });
    const body = await res.json();
    console.log(JSON.stringify({ http: res.status, ...body }, null, 2));
    return;
  }

  if (argv.includes('--status')) {
    requireFields(cfg, ['client_id', 'client_secret', 'refresh_token', 'item_id']);
    const token = await accessToken(cfg);
    const res = await fetch(
      `https://www.googleapis.com/chromewebstore/v1.1/items/${cfg.item_id}?projection=DRAFT`,
      { headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' } },
    );
    const body = await res.json();
    // uploadState dice se la bozza esiste e in che stato è; crxVersion dice quale
    // versione è nel cassetto, che è l'unico modo di distinguere "in revisione"
    // da "mai caricata" senza guardare la vetrina.
    console.log(JSON.stringify({ http: res.status, ...body }, null, 2));
    return;
  }

  const zip = argv.find((a) => a.endsWith('.zip'));
  if (!zip) throw new Error('Indica lo zip da caricare, o usa --auth / --exchange');
  requireFields(cfg, ['client_id', 'client_secret', 'refresh_token', 'item_id']);

  const size = (await stat(zip)).size;
  const token = await accessToken(cfg);

  const up = await fetch(`https://www.googleapis.com/upload/chromewebstore/v1.1/items/${cfg.item_id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' },
    body: await readFile(zip),
  });
  const upBody = await up.json();
  const upRes = interpretUpload(upBody);
  console.log(`upload ${zip} (${size} B): ${upRes.ok ? 'SUCCESS' : `FALLITO [${upRes.state}] ${upRes.reasons.join(' | ')}`}`);
  if (!upRes.ok) process.exit(1);

  if (!argv.includes('--publish')) {
    console.log('bozza caricata; ripassa con --publish per mandarla in review');
    return;
  }

  const pub = await fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${cfg.item_id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2', 'Content-Length': '0' },
  });
  const pubRes = interpretPublish(await pub.json());
  console.log(`publish: ${pubRes.ok ? 'OK' : 'FALLITO'} ${pubRes.status.join(',')} ${pubRes.detail.join(' | ')}`);
  if (!pubRes.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
