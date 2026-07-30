/**
 * Rende una pagina in Markdown per il consumo del modello: struttura preservata
 * a una frazione del costo dell'HTML.
 *
 * La funzione viene serializzata e iniettata nella pagina con
 * chrome.scripting.executeScript, quindi deve essere autocontenuta: niente
 * riferimenti a variabili esterne, niente import. Per lo stesso motivo è testata
 * a parte contro un DOM finto (`test/unit/page-markdown.test.js`) invece che dal
 * vivo.
 *
 * Cammina l'albero per blocchi invece di usare un querySelectorAll piatto: un
 * `<li><a>x</a></li>` con il selettore piatto verrebbe emesso due volte, una
 * come voce di lista e una come link.
 */
export function buildMarkdown(doc) {
  const d = doc || document;
  const out = [];

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME']);
  const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const BLOCKS = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'DT', 'DD', 'FIGCAPTION']);
  const MAX_TABLE_ROWS = 50;

  const attr = (el, name) => (el.getAttribute ? el.getAttribute(name) : null);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // Dimensioni: il rect è la verità quando c'è un layout, ma su un'immagine non
  // ancora disposta (o in test) restano solo gli attributi.
  const sizeOf = (el) => {
    let w = 0;
    let h = 0;
    if (typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      w = r.width; h = r.height;
    }
    if (!w) w = Number(attr(el, 'width')) || 0;
    if (!h) h = Number(attr(el, 'height')) || 0;
    return { w, h };
  };

  // Testo inline di un blocco: i link diventano [testo](href) senza che il
  // testo venga emesso una seconda volta dal walker.
  const inline = (node) => {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    if (SKIP.has(tag)) return '';
    if (tag === 'BR') return ' ';
    if (tag === 'IMG') {
      const { w, h } = sizeOf(node);
      if (w >= 50 && h >= 50) {
        const alt = clean(attr(node, 'alt')) || 'no alt text';
        return ` ![${alt} ${Math.round(w)}x${Math.round(h)}](${attr(node, 'src') || ''}) `;
      }
      return '';
    }
    const kids = (node.childNodes || []).map(inline).join('');
    if (tag === 'A') {
      const href = attr(node, 'href');
      const label = clean(kids);
      if (!label) return '';
      return href ? `[${label}](${href})` : label;
    }
    if (tag === 'CODE' || tag === 'KBD') {
      const label = clean(kids);
      return label ? '`' + label + '`' : '';
    }
    if (tag === 'STRONG' || tag === 'B') { const l = clean(kids); return l ? `**${l}**` : ''; }
    if (tag === 'EM' || tag === 'I') { const l = clean(kids); return l ? `*${l}*` : ''; }
    return kids;
  };

  const cellsOf = (row) => (row.childNodes || [])
    .filter((n) => n.nodeType === 1 && (n.tagName === 'TD' || n.tagName === 'TH'))
    .map((c) => clean(c.textContent).replace(/\|/g, '\\|'));

  const renderTable = (table) => {
    const rows = (table.querySelectorAll ? table.querySelectorAll('tr') : []) || [];
    if (!rows.length) return;
    const all = rows.map(cellsOf).filter((r) => r.length);
    if (!all.length) return;

    // Gli header veri, non un segnaposto: la prima riga se contiene th,
    // altrimenti colonne numerate.
    const firstHasTh = (rows[0].childNodes || []).some((n) => n.nodeType === 1 && n.tagName === 'TH');
    const header = firstHasTh ? all[0] : all[0].map((_, i) => `col${i + 1}`);
    const body = firstHasTh ? all.slice(1) : all;
    const width = header.length;

    out.push('');
    out.push(`| ${header.join(' | ')} |`);
    out.push(`|${' --- |'.repeat(width)}`);
    for (const r of body.slice(0, MAX_TABLE_ROWS)) {
      const padded = r.slice(0, width);
      while (padded.length < width) padded.push('');
      out.push(`| ${padded.join(' | ')} |`);
    }
    if (body.length > MAX_TABLE_ROWS) {
      out.push(`_${body.length} rows total, ${body.length - MAX_TABLE_ROWS} omitted — use extract_table with \`where\` to filter server-side instead of reading them here._`);
    }
    out.push('');
  };

  const walk = (node) => {
    if (!node || node.nodeType !== 1) return;
    const tag = node.tagName;
    if (SKIP.has(tag)) return;

    if (tag === 'TABLE') { renderTable(node); return; }

    if (HEADINGS.has(tag)) {
      const text = clean(inline(node));
      if (text) out.push(`${'#'.repeat(Number(tag[1]))} ${text}`, '');
      return;
    }

    if (BLOCKS.has(tag)) {
      const text = clean(inline(node));
      if (!text) return;
      if (tag === 'LI') out.push(`- ${text}`);
      else if (tag === 'BLOCKQUOTE') out.push(`> ${text}`, '');
      else if (tag === 'PRE') out.push('```', text, '```', '');
      else if (tag === 'FIGCAPTION') out.push(`*${text}*`, '');
      else out.push(text, '');
      return;
    }

    if (tag === 'IMG') {
      const rendered = clean(inline(node));
      if (rendered) out.push(rendered, '');
      return;
    }

    for (const child of node.childNodes || []) walk(child);
  };

  const title = clean(d.title);
  if (title) out.push(`# ${title}`, '');

  // Sommario delle immagini grandi: dice al modello se vale la pena chiedere
  // uno screenshot, al costo di una riga.
  const imgs = (d.body?.querySelectorAll ? d.body.querySelectorAll('img') : []) || [];
  const significant = imgs.filter((img) => { const { w, h } = sizeOf(img); return w >= 100 && h >= 100; });
  if (significant.length) {
    out.push(`_${significant.length} image(s) at least 100x100 on this page — take a screenshot if the visual matters._`, '');
  }

  walk(d.body);

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
