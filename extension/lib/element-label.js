/**
 * labelOf: il nome con cui un utente riconosce un elemento interattivo.
 * Prima get_interactives prendeva aria-label || value || textContent: i campi
 * con <label for>, <label> avvolgente o aria-labelledby uscivano senza nome
 * (httpbin.org/forms/post: Customer name, Telephone, E-mail…) e radio e
 * checkbox mostravano il value («small», «bacon») invece del testo visibile.
 *
 * Ordine: aria-label, aria-labelledby, <label> (el.labels copre for e
 * avvolgente), testo o value per bottoni e altri elementi che non sono campi,
 * title, placeholder. Spazi normalizzati, 80 caratteri.
 *
 * Non è un modulo ES: chrome.scripting serializza solo la funzione iniettata,
 * quindi get_interactives inietta prima questo file (files:, world MAIN) e poi
 * usa globalThis.__cbLabelOf. Nei test Node si importa per side effect, come
 * stack-detect.js.
 */
(() => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  // Nel testo di un <label> avvolgente non entrano il campo stesso né le
  // opzioni di una select: «Size <select>…» deve dare «Size».
  const SKIP = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'SCRIPT', 'STYLE', 'TEMPLATE']);
  const textOf = (node) => {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return '';
    let out = '';
    for (const c of node.childNodes) out += textOf(c);
    return out;
  };
  const BUTTON_INPUT = /^(submit|button|reset)$/i;

  function labelOf(el, doc) {
    const d = doc || el.ownerDocument;
    const attr = (n) => (el.getAttribute(n) || '').trim();

    const aria = clean(attr('aria-label'));
    if (aria) return aria;

    const ids = attr('aria-labelledby').split(/\s+/).filter(Boolean);
    if (ids.length && d) {
      const t = clean(ids.map((id) => { const n = d.getElementById(id); return n ? n.textContent : ''; }).join(' '));
      if (t) return t;
    }

    for (const lab of el.labels || []) {
      const t = clean(textOf(lab));
      if (t) return t;
    }

    const tag = el.tagName;
    const isField = tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && !BUTTON_INPUT.test(el.getAttribute('type') || ''));
    if (!isField) {
      const t = clean(tag === 'INPUT' ? el.value : el.textContent);
      if (t) return t;
    }

    return clean(attr('title')) || clean(attr('placeholder'));
  }

  globalThis.__cbLabelOf = labelOf;
})();
