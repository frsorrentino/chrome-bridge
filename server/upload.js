/**
 * upload_file oltre i 10 MB: il file passa a pezzi.
 *
 * Fino alla 1.27 il file viaggiava intero in un solo messaggio, in base64,
 * con un tetto di 10 MB (il 01/10/2026 un video per X è stato ricompresso
 * apposta). Ora sopra CHUNK_BYTES il server manda upload_chunk uno alla volta
 * (ciascuno ben sotto i 32 MB di maxPayload del bridge) e la pagina li
 * accumula; upload_file monta il File dai pezzi. Sotto CHUNK_BYTES resta il
 * messaggio unico, che funziona anche con le estensioni fino alla 1.27.
 */
import { randomBytes } from 'node:crypto';
import { MessageType } from './protocol.js';

export const CHUNK_BYTES = 6 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export async function uploadBuffer(send, { selector, name, mime_type, buf, tab_id }) {
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error(`File too large: ${buf.length} bytes (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
  if (buf.length <= CHUNK_BYTES) {
    return send(MessageType.UPLOAD_FILE, { selector, name, mime_type, content_b64: buf.toString('base64'), tab_id });
  }
  const upload_id = `u${randomBytes(6).toString('hex')}`;
  const total = Math.ceil(buf.length / CHUNK_BYTES);
  try {
    for (let index = 0; index < total; index++) {
      const part = buf.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      await send(MessageType.UPLOAD_CHUNK, { upload_id, index, total, content_b64: part.toString('base64'), tab_id });
    }
  } catch (err) {
    await send(MessageType.UPLOAD_CHUNK, { upload_id, abort: true, tab_id }).catch(() => {});
    if (/Unknown command type: upload_chunk/.test(err.message)) {
      throw new Error(`Files over ${CHUNK_BYTES / 1024 / 1024} MB need the extension from version 1.28: update it, or upload a smaller file`);
    }
    throw err;
  }
  return send(MessageType.UPLOAD_FILE, { selector, name, mime_type, upload_id, size: buf.length, tab_id });
}
