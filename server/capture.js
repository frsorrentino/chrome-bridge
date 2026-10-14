/**
 * capture_downloads, lato server: i file presi dalla pagina (blob, data URL,
 * showSaveFilePicker, download annullati) arrivano qui a pezzi, come
 * upload_file al contrario, e vengono scritti nella cartella scelta all'arm.
 *
 * Il nome lo decide la pagina, quindi è input ostile: si tiene solo l'ultimo
 * segmento, senza caratteri di controllo né riservati, senza punti iniziali
 * (niente .bashrc, .env), e un file esistente non viene mai sovrascritto.
 */
import { open, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MessageType } from './protocol.js';

export const CAPTURE_CHUNK_BYTES = 4 * 1024 * 1024;
export const CAPTURE_DEFAULT_MB = 100;
export const CAPTURE_MAX_MB = 200;

const EXT_BY_MIME = {
  'application/pdf': '.pdf', 'text/csv': '.csv', 'application/json': '.json', 'text/plain': '.txt',
  'application/zip': '.zip', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/svg+xml': '.svg',
  'text/html': '.html', 'application/xml': '.xml', 'text/xml': '.xml', 'image/webp': '.webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};
const MAX_NAME_BYTES = 180;

export function sanitizeFileName(name, mime = '') {
  let n = String(name ?? '').split(/[\\/]/).pop().normalize('NFC');
  n = n.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  if (!n) n = `download${EXT_BY_MIME[String(mime).split(';')[0].trim().toLowerCase()] ?? ''}`;
  if (Buffer.byteLength(n) > MAX_NAME_BYTES) {
    const ext = extname(n).slice(0, 16);
    let stem = n.slice(0, n.length - ext.length);
    while (Buffer.byteLength(stem + ext) > MAX_NAME_BYTES) stem = stem.slice(0, -1);
    n = stem + ext;
  }
  return n;
}

/** Apre in esclusiva `dir/name`, o `name (1)`, `name (2)`… se esiste già. */
export async function openUnique(dir, name) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const path = join(dir, i ? `${stem} (${i})${ext}` : name);
    try {
      return { path, fh: await open(path, 'wx') };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`capture: too many files named ${name} in ${dir}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Aspetta i file catturati nella scheda, li scrive in `dir` e li toglie dalla
 * pagina. Appena compare il primo file aspetta ancora `settle` ms: un export
 * può produrne più d'uno.
 */
export async function collectCaptured(send, { tab_id, dir, timeout = 15000, settle = 700, poll = 250, chunk = CAPTURE_CHUNK_BYTES }) {
  const started = Date.now();
  let firstSeen = null;
  let list;
  for (;;) {
    list = await send(MessageType.CAPTURE_FILES, { op: 'list', tab_id });
    const items = list?.items ?? [];
    if (items.length && firstSeen == null) firstSeen = Date.now();
    if (items.length && !items.some((i) => i.pending) && Date.now() - firstSeen >= settle) break;
    if (Date.now() - started >= timeout) break;
    await sleep(poll);
  }
  const saved = [];
  const skipped = [];
  const pending = [];
  for (const it of list?.items ?? []) {
    if (it.pending) { pending.push({ name: it.name, source: it.source }); continue; }
    const drop = () => send(MessageType.CAPTURE_FILES, { op: 'drop', id: it.id, frame_id: it.frame_id, tab_id }).catch(() => {});
    if (it.error) {
      skipped.push({ name: it.name, source: it.source, error: it.error, ...(it.url && { url: it.url }) });
      await drop();
      continue;
    }
    const { path, fh } = await openUnique(dir, sanitizeFileName(it.name, it.mime));
    let written = 0;
    try {
      for (let offset = 0; offset < it.size; offset += chunk) {
        const { b64 } = await send(MessageType.CAPTURE_FILES, { op: 'read', id: it.id, frame_id: it.frame_id, offset, length: chunk, tab_id });
        const buf = Buffer.from(b64 ?? '', 'base64');
        await fh.write(buf);
        written += buf.length;
      }
      await fh.close();
      if (written !== it.size) throw new Error(`${written} bytes arrived, ${it.size} expected`);
    } catch (e) {
      await fh.close().catch(() => {});
      await rm(path, { force: true });
      skipped.push({ name: it.name, source: it.source, error: e.message });
      await drop();
      continue;
    }
    saved.push({ path, bytes: written, mime: it.mime || undefined, source: it.source, ...(it.browser_copy && { browser_copy: it.browser_copy }) });
    await drop();
  }
  return { saved, skipped, pending, armed: list?.armed ?? false, waited_ms: Date.now() - started };
}
