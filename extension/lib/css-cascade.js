/**
 * cssStylesOf: la cascata CSS di un elemento come la mostra il pannello Styles
 * di DevTools — per ogni proprietà la dichiarazione che vince (selettore,
 * foglio, posizione della regola, !important, @layer, @media) e quelle che ha
 * battuto. `query_dom` dice quanto vale `margin-top`; questo dice chi lo ha
 * deciso e da dove.
 *
 * Senza chrome.debugger non c'è CSS.getMatchedStylesForNode: si ricostruisce
 * dal CSSOM. Ordine (CSS Cascade 5, origine autore): !important, stile inline,
 * @layer (normali: senza layer > ultimo layer dichiarato > primo; important:
 * inverso), specificità, ordine nel sorgente. I longhand sono l'unità della
 * cascata: `margin: 0` compare come margin-top/right/bottom/left.
 *
 * Fuori portata, e detto nell'output o nella descrizione del tool: gli stili
 * dello user agent (non esposti), @container, @scope e @starting-style (non
 * valutabili senza il motore: contati in `skipped`), le regole :host del
 * shadow root di un host, transizioni e animazioni. I fogli di altra origine
 * senza CORS non espongono cssRules: elencati in `opaque_stylesheets`.
 *
 * Non è un modulo ES (vedi element-label.js): get_css_styles inietta prima
 * questo file e poi usa globalThis.__cbCssStyles. In Node i test passano un
 * CSSOM finto come terzo argomento.
 */
(() => {
  // --- selettori: liste, parentesi, specificità ---

  const isIdentChar = (ch) => /[\w-]/.test(ch) || ch.charCodeAt(0) > 127;
  const skipIdent = (s, i) => {
    while (i < s.length) {
      if (s[i] === '\\') { i += 2; continue; }
      if (!isIdentChar(s[i])) break;
      i += 1;
    }
    return i;
  };
  const skipString = (s, i) => {
    const q = s[i];
    i += 1;
    while (i < s.length && s[i] !== q) i += s[i] === '\\' ? 2 : 1;
    return i + 1;
  };
  const matchParen = (s, i) => {
    let depth = 0;
    for (; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '"' || ch === "'") { i = skipString(s, i) - 1; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) return i; }
    }
    return s.length;
  };
  /** Una lista di selettori spezzata sulle virgole di primo livello. */
  const splitList = (s) => {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '"' || ch === "'") { i = skipString(s, i) - 1; continue; }
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
      else if (ch === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    out.push(s.slice(start).trim());
    return out.filter(Boolean);
  };

  const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
  const ARG_SPECIFICITY = new Set(['is', 'not', 'has', 'matches', 'any', '-webkit-any', '-moz-any']);
  const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const add = (t, u) => { t[0] += u[0]; t[1] += u[1]; t[2] += u[2]; };
  const maxSpec = (list) => list.map(specificity).reduce((m, x) => (cmpSpec(x, m) > 0 ? x : m), [0, 0, 0]);

  /** Specificità (id, classi/attributi/pseudo-classi, tipi/pseudo-elementi) di un selettore complesso. */
  function specificity(sel) {
    const t = [0, 0, 0];
    const s = String(sel);
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"' || ch === "'") { i = skipString(s, i); continue; }
      if (ch === '#') { t[0] += 1; i = skipIdent(s, i + 1); continue; }
      if (ch === '.') { t[1] += 1; i = skipIdent(s, i + 1); continue; }
      if (ch === '[') {
        t[1] += 1;
        const close = s.indexOf(']', i);
        i = close === -1 ? s.length : close + 1;
        continue;
      }
      if (ch === ':') {
        const pseudoElement = s[i + 1] === ':';
        const start = i + (pseudoElement ? 2 : 1);
        const end = skipIdent(s, start);
        const name = s.slice(start, end).toLowerCase();
        i = end;
        let inner = null;
        if (s[i] === '(') { const close = matchParen(s, i); inner = s.slice(i + 1, close); i = close + 1; }
        if (pseudoElement || LEGACY_PSEUDO_ELEMENTS.has(name)) { t[2] += 1; continue; }
        if (name === 'where') continue;
        if (ARG_SPECIFICITY.has(name)) { if (inner != null) add(t, maxSpec(splitList(inner))); continue; }
        t[1] += 1;
        if (inner != null) {
          if (name === 'host' || name === 'host-context') add(t, maxSpec(splitList(inner)));
          else if (name === 'nth-child' || name === 'nth-last-child') {
            const of = /\bof\s+(.+)$/i.exec(inner);
            if (of) add(t, maxSpec(splitList(of[1])));
          }
        }
        continue;
      }
      if (ch === '*') {
        i += 1;
        if (s[i] === '|') { i += 1; if (s[i] === '*') i += 1; else { t[2] += 1; i = skipIdent(s, i); } }
        continue;
      }
      if (isIdentChar(ch) || ch === '\\') {
        i = skipIdent(s, i);
        if (s[i] === '|' && s[i + 1] !== '=') { // ns|tag: conta il tipo, non il namespace
          i += 1;
          if (s[i] === '*') { i += 1; continue; }
          i = skipIdent(s, i);
        }
        t[2] += 1;
        continue;
      }
      i += 1; // combinatori, spazi, & già risolto
    }
    return t;
  }

  // --- cascata ---

  const INHERITED = new Set([
    'border-collapse', 'border-spacing', 'caption-side', 'color', 'color-scheme', 'cursor', 'direction',
    'empty-cells', 'font', 'font-family', 'font-feature-settings', 'font-kerning', 'font-optical-sizing',
    'font-palette', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-synthesis',
    'font-variant', 'font-variant-caps', 'font-variant-east-asian', 'font-variant-ligatures',
    'font-variant-numeric', 'font-variant-position', 'font-variation-settings', 'font-weight',
    'hanging-punctuation', 'hyphens', 'image-rendering', 'letter-spacing', 'line-break', 'line-height',
    'list-style', 'list-style-image', 'list-style-position', 'list-style-type', 'orphans', 'overflow-wrap',
    'paint-order', 'pointer-events', 'quotes', 'ruby-align', 'ruby-position', 'tab-size', 'text-align',
    'text-align-last', 'text-combine-upright', 'text-decoration-skip-ink', 'text-emphasis',
    'text-emphasis-color', 'text-emphasis-position', 'text-emphasis-style', 'text-indent', 'text-justify',
    'text-orientation', 'text-rendering', 'text-shadow', 'text-size-adjust', 'text-transform',
    'text-underline-offset', 'text-underline-position', 'text-wrap', 'text-wrap-mode', 'text-wrap-style',
    'visibility', 'white-space', 'white-space-collapse', 'widows', 'word-break', 'word-spacing', 'word-wrap',
    'writing-mode', 'accent-color', 'caret-color', 'scrollbar-color', 'print-color-adjust',
    'forced-color-adjust', 'math-depth', 'math-style', '-webkit-text-fill-color', '-webkit-text-stroke',
    '-webkit-text-stroke-color', '-webkit-text-stroke-width',
  ]);
  const inherits = (p) => p.startsWith('--') || INHERITED.has(p);
  const MAX_OVERRIDDEN = 5;
  const MAX_ANCESTORS = 40;

  const kindOf = (rule) => rule?.constructor?.name ?? '';
  const sheetLabel = (href, ownerNode, n) => {
    if (href) return href.split('#')[0].split('?')[0].split('/').pop() || href;
    if (ownerNode?.id) return `<style>#${ownerNode.id}`;
    return ownerNode ? `<style> #${n}` : `adopted #${n}`;
  };
  const describe = (el) => {
    const raw = typeof el.className === 'string' ? el.className : (el.getAttribute?.('class') ?? '');
    const classes = raw.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return (el.tagName || '').toLowerCase() + (el.id ? `#${el.id}` : '') + classes.map((c) => `.${c}`).join('');
  };
  const safeMatches = (el, sel) => { try { return el.matches(sel); } catch { return false; } };
  const resolveNested = (sel, parents) => {
    if (!parents) return sel;
    const parent = `:is(${parents.join(', ')})`;
    return sel.includes('&') ? sel.split('&').join(parent) : `${parent} ${sel}`;
  };

  /** Le regole di stile di una radice (document o shadow root), in ordine di cascata, con layer e condizioni. */
  function collect(root, env) {
    const sheets = [];
    const opaque = [];
    const skipped = [];
    const rules = [];
    const layerOrder = new Map();
    const layerCounters = new Map();
    let anonymous = 0;
    let unnamed = 0;
    let order = 0;
    const registerLayer = (path) => {
      for (let i = 1; i <= path.length; i += 1) {
        const key = path.slice(0, i).join('.');
        if (layerOrder.has(key)) continue;
        const parent = path.slice(0, i - 1).join('.');
        const n = layerCounters.get(parent) ?? 0;
        layerCounters.set(parent, n + 1);
        layerOrder.set(key, n);
      }
    };
    const layerPath = (base, name) => {
      const path = (base ?? []).concat(name === '' ? [`(anonymous ${(anonymous += 1)})`] : name.split('.'));
      registerLayer(path);
      return path;
    };
    const rankOf = (path) => path && path.map((_, i) => layerOrder.get(path.slice(0, i + 1).join('.')));
    const countRules = (list) => {
      let n = 0;
      for (const r of list ?? []) { n += 1; if (r.cssRules) n += countRules(r.cssRules); }
      return n;
    };

    const walk = (list, ctx) => {
      for (const rule of list) {
        const kind = kindOf(rule);
        if (kind === 'CSSKeyframesRule' || kind === 'CSSPageRule') continue;
        if (rule.selectorText != null && rule.style) {
          const index = ctx.sheet.rules;
          ctx.sheet.rules += 1;
          const selectors = splitList(rule.selectorText).map((s) => resolveNested(s, ctx.parentSelectors));
          rules.push({ selectors, sheet: ctx.sheet.label, index, layer: ctx.layer, conditions: ctx.conditions, style: rule.style, order: (order += 1) });
          if (rule.cssRules?.length) walk(rule.cssRules, { ...ctx, parentSelectors: selectors, parentIndex: index });
          continue;
        }
        if (kind === 'CSSNestedDeclarations' && rule.style && ctx.parentSelectors) {
          rules.push({ selectors: ctx.parentSelectors, sheet: ctx.sheet.label, index: ctx.parentIndex, layer: ctx.layer, conditions: ctx.conditions, style: rule.style, order: (order += 1) });
          continue;
        }
        if (kind === 'CSSImportRule') {
          const mediaText = rule.media?.mediaText ?? '';
          if (mediaText && !env.matchMedia(mediaText)) continue;
          if (rule.supportsText && !env.supports(rule.supportsText)) continue;
          const layer = rule.layerName == null ? ctx.layer : layerPath(ctx.layer, rule.layerName);
          addSheet(rule.styleSheet, rule.href, { ...ctx, layer });
          continue;
        }
        if (kind === 'CSSLayerStatementRule') {
          for (const name of rule.nameList ?? []) layerPath(ctx.layer, name);
          continue;
        }
        if (kind === 'CSSLayerBlockRule') {
          walk(rule.cssRules, { ...ctx, layer: layerPath(ctx.layer, rule.name ?? '') });
          continue;
        }
        if (kind === 'CSSMediaRule') {
          const text = rule.conditionText ?? rule.media?.mediaText ?? '';
          if (!env.matchMedia(text)) continue;
          walk(rule.cssRules, { ...ctx, conditions: ctx.conditions.concat(`@media ${text}`) });
          continue;
        }
        if (kind === 'CSSSupportsRule') {
          if (!env.supports(rule.conditionText)) continue;
          walk(rule.cssRules, { ...ctx, conditions: ctx.conditions.concat(`@supports ${rule.conditionText}`) });
          continue;
        }
        if (rule.cssRules && (kind === 'CSSContainerRule' || kind === 'CSSScopeRule' || kind === 'CSSStartingStyleRule')) {
          const label = kind === 'CSSContainerRule' ? `@container ${rule.conditionText}`
            : kind === 'CSSScopeRule' ? `@scope (${rule.start ?? ''})` : '@starting-style';
          skipped.push({ condition: label, rules: countRules(rule.cssRules) });
        }
        // @font-face, @property, @namespace, @counter-style: niente da cascata
      }
    };
    const addSheet = (sheet, href, ctx) => {
      let list = null;
      try { list = sheet?.cssRules ?? null; } catch { list = null; }
      if (!list) { opaque.push(href ?? sheet?.href ?? '(unknown)'); return; }
      const ownHref = sheet.href ?? href ?? null;
      const entry = { label: sheetLabel(ownHref, sheet.ownerNode, ownHref ? 0 : (unnamed += 1)), href: ownHref, rules: 0 };
      sheets.push(entry);
      walk(list, { ...ctx, sheet: entry });
    };
    for (const sheet of env.styleSheetsOf(root)) addSheet(sheet, null, { sheet: null, layer: null, conditions: [], parentSelectors: null, parentIndex: null });
    return { rules, sheets, opaque, skipped, rankOf };
  }

  // Confronto di cascata fra due dichiarazioni della stessa proprietà: > 0 se vince a.
  const cmpLayer = (ra, rb, important) => {
    const ua = ra == null;
    const ub = rb == null;
    if (ua && ub) return 0;
    if (ua !== ub) return (ua === !important) ? 1 : -1; // senza layer: vince fra le normali, perde fra le important
    const n = Math.min(ra.length, rb.length);
    for (let i = 0; i < n; i += 1) {
      if (ra[i] !== rb[i]) return ((ra[i] > rb[i]) === !important) ? 1 : -1; // normali: l'ultimo layer vince
    }
    if (ra.length === rb.length) return 0;
    return ((ra.length < rb.length) === !important) ? 1 : -1; // il layer padre batte i suoi sottolayer fra le normali
  };
  const cmpDecl = (a, b) => {
    if (a.important !== b.important) return a.important ? 1 : -1;
    if (a.inline !== b.inline) return a.inline ? 1 : -1;
    return cmpLayer(a.layerRank, b.layerRank, a.important) || cmpSpec(a.spec, b.spec) || a.order - b.order;
  };

  const declarationsOf = (style) => {
    const out = [];
    for (let i = 0; i < style.length; i += 1) {
      const prop = style[i];
      out.push({ prop, value: style.getPropertyValue(prop), important: style.getPropertyPriority(prop) === 'important' });
    }
    return out;
  };

  /** Per ogni proprietà dichiarata su `el`, le dichiarazioni in ordine di cascata (vincitrice prima). */
  function candidatesFor(el, { rules, rankOf }) {
    const byProp = new Map();
    let matched = 0;
    const push = (d) => { if (!byProp.has(d.prop)) byProp.set(d.prop, []); byProp.get(d.prop).push(d); };
    for (const rule of rules) {
      const joined = rule.selectors.length === 1 ? rule.selectors[0] : rule.selectors.join(', ');
      if (!safeMatches(el, joined)) continue;
      matched += 1;
      const matching = rule.selectors.length === 1 ? rule.selectors : rule.selectors.filter((s) => safeMatches(el, s));
      let selector = matching[0] ?? rule.selectors[0];
      let spec = specificity(selector);
      for (const s of matching.slice(1)) { const sp = specificity(s); if (cmpSpec(sp, spec) > 0) { spec = sp; selector = s; } }
      const layerRank = rankOf(rule.layer);
      for (const d of declarationsOf(rule.style)) {
        push({ ...d, inline: false, selector, sheet: rule.sheet, index: rule.index, layer: rule.layer, conditions: rule.conditions, layerRank, spec, order: rule.order });
      }
    }
    if (el.style?.length) {
      for (const d of declarationsOf(el.style)) push({ ...d, inline: true, layerRank: null, spec: [0, 0, 0], order: Infinity });
    }
    for (const list of byProp.values()) list.sort((a, b) => cmpDecl(b, a));
    return { byProp, matched };
  }

  const fmtSource = (d) => {
    if (d.inline) return { inline: true };
    const out = { selector: d.selector, sheet: d.sheet, rule: d.index };
    if (d.layer) out.layer = d.layer.join('.');
    if (d.conditions?.length) out.conditions = d.conditions;
    return out;
  };
  const fmtEntry = (list, computed, inheritedFrom) => {
    const [winner, ...rest] = list;
    const entry = { value: winner.value };
    if (winner.important) entry.important = true;
    if (computed != null) entry.computed = computed;
    if (inheritedFrom) entry.inherited_from = inheritedFrom;
    entry.source = fmtSource(winner);
    entry.overridden = rest.slice(0, MAX_OVERRIDDEN).map((o) => ({ value: o.value, ...(o.important ? { important: true } : {}), ...fmtSource(o) }));
    if (rest.length > MAX_OVERRIDDEN) entry.overridden_more = rest.length - MAX_OVERRIDDEN;
    return entry;
  };
  const parentOf = (node) => node.parentElement ?? (node.parentNode?.host ?? null);

  const defaultEnv = () => ({
    styleSheetsOf: (root) => [...(root.styleSheets ?? []), ...(root.adoptedStyleSheets ?? [])],
    getComputedStyle: (el) => getComputedStyle(el),
    matchMedia: (q) => matchMedia(q).matches,
    supports: (c) => CSS.supports(c),
  });

  /**
   * @param {Element} el
   * @param {{properties?: string[]|null, include_inherited?: boolean, selector?: string}} [opts]
   * @param {object} [env] - CSSOM finto nei test
   */
  function cssStylesOf(el, opts = {}, env = defaultEnv()) {
    const wanted = Array.isArray(opts.properties) && opts.properties.length ? opts.properties.map((p) => String(p).trim().toLowerCase()) : null;
    const want = (p) => !wanted || wanted.some((q) => p === q || p.startsWith(`${q}-`));
    const collections = new Map();
    const collectionOf = (node) => {
      const root = node.getRootNode ? node.getRootNode() : (node.ownerDocument ?? document);
      if (!collections.has(root)) collections.set(root, collect(root, env));
      return collections.get(root);
    };
    const own = collectionOf(el);
    const computed = env.getComputedStyle(el);
    const computedOf = (p) => computed.getPropertyValue(p);
    const usedSheets = new Set();
    const noteSheets = (list) => { for (const d of list) if (!d.inline) usedSheets.add(d.sheet); };

    const properties = {};
    const { byProp, matched } = candidatesFor(el, own);
    for (const [prop, list] of byProp) {
      if (!want(prop)) continue;
      properties[prop] = fmtEntry(list, computedOf(prop), null);
      noteSheets(list);
    }
    if (opts.include_inherited) {
      let node = parentOf(el);
      for (let depth = 0; node && node.nodeType === 1 && depth < MAX_ANCESTORS; depth += 1, node = parentOf(node)) {
        const ancestor = candidatesFor(node, collectionOf(node));
        for (const [prop, list] of ancestor.byProp) {
          if (properties[prop] || !inherits(prop) || !want(prop)) continue;
          properties[prop] = fmtEntry(list, computedOf(prop), describe(node));
          noteSheets(list);
        }
      }
    }

    const sorted = {};
    for (const k of Object.keys(properties).sort()) sorted[k] = properties[k];
    const out = { selector: opts.selector ?? null, element: describe(el), matched_rules: matched };
    const sheets = [];
    for (const c of collections.values()) for (const s of c.sheets) if (usedSheets.has(s.label)) sheets.push(s.href ? { sheet: s.label, href: s.href, rules: s.rules } : { sheet: s.label, rules: s.rules });
    out.stylesheets = sheets;
    const opaque = [...collections.values()].flatMap((c) => c.opaque);
    if (opaque.length) out.opaque_stylesheets = opaque;
    const skipped = [...collections.values()].flatMap((c) => c.skipped);
    if (skipped.length) out.skipped = skipped;
    out.properties = sorted;
    return out;
  }

  globalThis.__cbCssStyles = cssStylesOf;
  globalThis.__cbCssSpecificity = specificity;
})();
