/**
 * findTextInPage gira nella pagina: chrome.scripting ne serializza il
 * sorgente, quindi è autocontenuta (niente import, niente chiusure).
 *
 * Cerca sul testo degli elementi, non dei singoli nodi di testo: un'etichetta
 * spezzata in più nodi («<span>Prestazioni</span> e <b>clic</b>», o con
 * &nbsp;) prima non veniva mai trovata, ed è la forma normale dei menu di
 * Meta. Fra le parole dell'ago vale qualunque sequenza di spazi o &nbsp;.
 * Ogni occorrenza è riportata una volta, dall'elemento più interno che la
 * contiene tutta; si entra anche negli shadow root aperti.
 *
 * Il costo resta basso sulle pagine grandi: si scende solo nei rami il cui
 * testo contiene l'ago.
 */
export function findTextInPage(needleRaw, caseSensitive, maxResults, doc = document, win = window) {
  const words = String(needleRaw || '').split(/[\s ]+/).filter(Boolean);
  if (!words.length) return { count: 0, matches: [] };
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\u00a0]+');
  const flags = caseSensitive ? 'g' : 'gi';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  const textOf = (node) => {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return '';
    let out = '';
    for (const c of node.childNodes) out += textOf(c);
    return out;
  };
  const ranges = (text) => {
    const re = new RegExp(pattern, flags);
    const out = [];
    let m;
    while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
    return out;
  };
  const selectorFor = (el) => {
    if (el.id) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    const cls = el.classList && el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
    return `${tag}${cls}`;
  };

  const matches = [];
  const visit = (el, inShadow) => {
    if (matches.length >= maxResults || SKIP.has(el.tagName)) return;
    const text = textOf(el);
    const found = ranges(text);
    if (!found.length) return;
    // Intervalli dei figli elemento nel testo di el: textOf concatena i figli
    // in ordine, quindi gli offset coincidono.
    const kids = [];
    let off = 0;
    for (const c of el.childNodes) {
      const len = textOf(c).length;
      if (c.nodeType === 1) kids.push({ el: c, from: off, to: off + len });
      off += len;
    }
    const owned = found.filter(([a, b]) => !kids.some((k) => a >= k.from && b <= k.to));
    if (owned.length) {
      const rect = el.getBoundingClientRect();
      const flat = text.replace(/[\s ]/g, ' ');
      for (const [a, b] of owned) {
        if (matches.length >= maxResults) break;
        matches.push({
          selector: selectorFor(el),
          context: flat.substring(Math.max(0, a - 40), b + 40).replace(/ +/g, ' ').trim(),
          visible: rect.width > 0 && rect.height > 0,
          position: { x: Math.round(rect.x + win.scrollX), y: Math.round(rect.y + win.scrollY) },
          ...(inShadow ? { in_shadow: true } : {}),
        });
      }
    }
    for (const k of kids) {
      if (found.some(([a, b]) => a >= k.from && b <= k.to)) visit(k.el, inShadow);
    }
  };

  // Gli shadow root non compaiono nel testo dell'ospite: si cercano a parte,
  // anche annidati, dopo il documento.
  const roots = [];
  const collectShadows = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
        collectShadows(el.shadowRoot);
      }
    }
  };
  if (doc.body) {
    visit(doc.body, false);
    collectShadows(doc.body);
  }
  for (const root of roots) {
    for (const c of root.children) visit(c, true);
  }
  return { count: matches.length, matches };
}
