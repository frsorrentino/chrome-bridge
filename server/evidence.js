/**
 * Fascicolo di prova: una pagina catturata come la vede QUESTO utente
 * (loggato, IP suo, niente cloaking anti-bot), con hash e orario, pronta per
 * l'avvocato, la PEC o una issue. La redazione di cookie, token e campi
 * sensibili non è un'opzione: l'HAR e il DOM contengono la sessione dell'utente.
 */
import { createHash } from 'node:crypto';

const SENSITIVE_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf-token|x-xsrf-token|x-api-key|x-auth-token|x-access-token|x-session-token)$/i;
const SENSITIVE_QUERY = /^(token|access_token|auth|key|api_key|apikey|sig|signature|session|sessionid|sid|code|password|passwd|pwd|secret|otp)$/i;
const SENSITIVE_TEXT = [
  // [regex, sostituzione]: chiave: valore in JSON/JS inline, value= dei campi sensibili, bearer, JWT
  [/((?:csrf|xsrf|nonce|api[_-]?key|access[_-]?token|auth[_-]?token|session[_-]?id|secret|password|passwd|bearer)["']?\s*[:=]\s*["'])([^"'\s]{4,})(["'])/gi, `$1${'[REDACTED]'}$3`],
  [/(<input[^>]*(?:type=["']?(?:password|hidden)["']?|name=["']?[^"'>]*(?:token|nonce|csrf|secret|password)[^"'>]*["']?)[^>]*value=["'])([^"']{2,})(["'])/gi, `$1${'[REDACTED]'}$3`],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, `$1${'[REDACTED]'}`],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED]'],
];

export const REDACTED = '[REDACTED]';

export function redactUrl(url) {
  try {
    const u = new URL(url);
    let touched = false;
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_QUERY.test(k)) { u.searchParams.set(k, REDACTED); touched = true; }
    return touched ? u.toString() : url;
  } catch { return url; }
}

export function redactText(text) {
  let out = String(text ?? '');
  for (const [re, rep] of SENSITIVE_TEXT) out = out.replace(re, rep);
  return out;
}

/** HAR 1.2: header sensibili, cookie e query string oscurati; i corpi passano da redactText. */
export function redactHar(har) {
  const clone = JSON.parse(JSON.stringify(har));
  const scrub = (headers = []) => headers.map((h) => (SENSITIVE_HEADERS.test(h.name) ? { ...h, value: REDACTED } : h));
  for (const e of clone.log?.entries ?? []) {
    if (e.request) {
      e.request.url = redactUrl(e.request.url);
      e.request.headers = scrub(e.request.headers);
      e.request.cookies = (e.request.cookies ?? []).map((c) => ({ ...c, value: REDACTED }));
      e.request.queryString = (e.request.queryString ?? []).map((q) => (SENSITIVE_QUERY.test(q.name) ? { ...q, value: REDACTED } : q));
      if (e.request.postData?.text) e.request.postData.text = redactText(e.request.postData.text);
    }
    if (e.response) {
      e.response.headers = scrub(e.response.headers);
      e.response.cookies = (e.response.cookies ?? []).map((c) => ({ ...c, value: REDACTED }));
      if (e.response.content?.text) e.response.content.text = redactText(e.response.content.text);
    }
  }
  return clone;
}

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE_HEADERS.test(k) ? REDACTED : v;
  return out;
}

export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

/** @param {Array<{name:string, bytes:Buffer|string, note?:string}>} files */
export function buildManifest({ url, title, capturedAt = new Date(), files, redaction = true, extra = {} }) {
  return {
    schema: 'chrome-bridge-evidence/1',
    url, title: title ?? null,
    captured_at: capturedAt.toISOString(),
    captured_by: 'chrome-bridge (the user\'s own Chrome profile, logged-in session, real user agent)',
    redaction: redaction ? 'cookies, authorization headers, tokens in query strings, JWTs, password/hidden field values, bearer tokens replaced with [REDACTED] before hashing' : 'none',
    timestamp_note: 'local clock of the capturing machine; not a certified timestamp — for legal value have the manifest hash time-stamped by a TSA or sent via PEC',
    files: files.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.bytes), sha256: sha256(f.bytes), ...(f.note ? { note: f.note } : {}) })),
    ...extra,
  };
}

export function evidenceIndex(manifest) {
  const rows = manifest.files.map((f) => `| ${f.name} | ${f.bytes} | \`${f.sha256}\` |${f.note ? ` ${f.note}` : ''}`);
  return [
    `# Evidence — ${manifest.title || manifest.url}`, '',
    `- URL: ${manifest.url}`, `- Captured: ${manifest.captured_at}`, `- By: ${manifest.captured_by}`,
    `- Redaction: ${manifest.redaction}`, `- Timestamp: ${manifest.timestamp_note}`, '',
    '| File | Bytes | SHA-256 |', '|---|---:|---|', ...rows, '',
    'Verify: `sha256sum <file>` must match the column above; `manifest.json` carries the same values.', '',
  ].join('\n');
}
