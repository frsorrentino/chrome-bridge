/**
 * Stack trace in coordinate originali: `bundle.js:1:284913` non dice niente,
 * `src/cart.ts:42:7 (addItem)` sì. Il JS e la sua source map vengono letti
 * con la fetch che il chiamante passa (nel bridge: http_request, quindi con i
 * cookie e su localhost); le map risolte restano in cache per processo.
 */
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const FRAME_RE = /(https?:\/\/[^\s()'"]+?\.m?js)(?:\?[^\s():'"]*)?:(\d+):(\d+)/g;

const MAX_CODE_FRAMES = 3;
const MAX_CODE_CHARS = 120;

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
        // I sorgenti della map sono relativi alla map stessa, non al bundle.
        let base = jsUrl;
        if (ref.startsWith('data:')) {
          const b64 = ref.slice(ref.indexOf('base64,') + 7);
          raw = Buffer.from(b64, 'base64').toString('utf8');
        } else {
          base = new URL(ref, jsUrl).href;
          raw = await fetchText(base);
        }
        tm = new TraceMap(typeof raw === 'string' ? JSON.parse(raw) : raw);
        bases.set(tm, base);
      }
    } catch { tm = null; }
    maps.set(jsUrl, tm);
    return tm;
  }

  // Testo del sorgente originale: sourcesContent della map se c'è, altrimenti
  // il file scaricato accanto alla map (una volta per processo).
  const sources = new Map();
  const bases = new WeakMap();
  async function sourceLine(tm, jsUrl, source, lineNo) {
    const key = `${jsUrl}|${source}`;
    if (!sources.has(key)) {
      let text = null;
      const idx = (tm.sources ?? []).indexOf(source);
      const inMap = idx >= 0 ? tm.sourcesContent?.[idx] : null;
      if (typeof inMap === 'string') text = inMap;
      else if (!/node_modules|webpack:\/\/\/?\(webpack\)/.test(source)) {
        try { text = await fetchText(new URL(source, bases.get(tm) ?? jsUrl).href); } catch { text = null; }
      }
      sources.set(key, text ? text.split('\n') : null);
    }
    const lines = sources.get(key);
    const raw = lines?.[lineNo - 1]?.trim();
    if (!raw) return null;
    return raw.length > MAX_CODE_CHARS ? `${raw.slice(0, MAX_CODE_CHARS)}…` : raw;
  }

  /** Aggiunge " → sorgente:riga:colonna (funzione) `codice`" a ogni frame risolvibile. */
  async function resolve(text) {
    if (!text || !FRAME_RE.test(text)) return text;
    FRAME_RE.lastIndex = 0;
    const parts = [];
    let last = 0;
    let shown = 0;
    for (const m of String(text).matchAll(FRAME_RE)) {
      const [whole, jsUrl, line, col] = m;
      parts.push(text.slice(last, m.index + whole.length));
      last = m.index + whole.length;
      const tm = await mapFor(jsUrl);
      if (!tm) continue;
      const pos = originalPositionFor(tm, { line: Number(line), column: Number(col) - 1 });
      if (!pos?.source) continue;
      // La riga di codice originale accanto al frame: senza, per capire
      // l'errore il modello scaricava il sorgente con http_request (1-2 turni
      // nel benchmark debug del 28/09). Solo i primi frame, riga tagliata.
      const code = shown < MAX_CODE_FRAMES ? await sourceLine(tm, jsUrl, pos.source, pos.line) : null;
      if (code) shown += 1;
      parts.push(` → ${pos.source}:${pos.line}:${(pos.column ?? 0) + 1}${pos.name ? ` (${pos.name})` : ''}${code ? ` \`${code}\`` : ''}`);
    }
    parts.push(text.slice(last));
    return parts.join('');
  }

  return { resolve, mapFor };
}
