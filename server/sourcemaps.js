/**
 * Stack trace in coordinate originali: `bundle.js:1:284913` non dice niente,
 * `src/cart.ts:42:7 (addItem)` sì. Il JS e la sua source map vengono letti
 * con la fetch che il chiamante passa (nel bridge: http_request, quindi con i
 * cookie e su localhost); le map risolte restano in cache per processo.
 */
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const FRAME_RE = /(https?:\/\/[^\s()'"]+?\.m?js)(?:\?[^\s():'"]*)?:(\d+):(\d+)/g;

export function createResolver(fetchText) {
  const maps = new Map(); // js url → TraceMap | null

  async function mapFor(jsUrl) {
    if (maps.has(jsUrl)) return maps.get(jsUrl);
    let tm = null;
    try {
      const js = await fetchText(jsUrl);
      const m = /\/\/[#@]\s*sourceMappingURL=([^\s]+)\s*$/.exec(js.trimEnd().split('\n').slice(-3).join('\n'));
      if (m) {
        const ref = m[1];
        let raw;
        if (ref.startsWith('data:')) {
          const b64 = ref.slice(ref.indexOf('base64,') + 7);
          raw = Buffer.from(b64, 'base64').toString('utf8');
        } else {
          raw = await fetchText(new URL(ref, jsUrl).href);
        }
        tm = new TraceMap(typeof raw === 'string' ? JSON.parse(raw) : raw);
      }
    } catch { tm = null; }
    maps.set(jsUrl, tm);
    return tm;
  }

  /** Aggiunge " → sorgente:riga:colonna (funzione)" a ogni frame risolvibile. */
  async function resolve(text) {
    if (!text || !FRAME_RE.test(text)) return text;
    FRAME_RE.lastIndex = 0;
    const parts = [];
    let last = 0;
    for (const m of String(text).matchAll(FRAME_RE)) {
      const [whole, jsUrl, line, col] = m;
      parts.push(text.slice(last, m.index + whole.length));
      last = m.index + whole.length;
      const tm = await mapFor(jsUrl);
      if (!tm) continue;
      const pos = originalPositionFor(tm, { line: Number(line), column: Number(col) - 1 });
      if (pos?.source) parts.push(` → ${pos.source}:${pos.line}:${(pos.column ?? 0) + 1}${pos.name ? ` (${pos.name})` : ''}`);
    }
    parts.push(text.slice(last));
    return parts.join('');
  }

  return { resolve, mapFor };
}
