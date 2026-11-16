/**
 * Fonte unica di deepQuery e deepQueryAll, i resolver dei selettori con ">>>".
 *
 * Ogni func passata a chrome.scripting.executeScript viene serializzata: un
 * helper definito fuori non esiste nella pagina. Per questo service-worker.js
 * ne porta una copia inline per tool, tra i marcatori «deep-query:begin» e
 * «deep-query:end». Si cambia questo file, poi `node tools/sync-deep-query.mjs`
 * riscrive le copie; test/unit/deep-query.test.js fallisce se divergono.
 *
 * «A >>> B» è un combinatore discendente che attraversa gli shadow root: B si
 * cerca sotto ogni elemento che A trova, nel suo shadowRoot, nel suo light DOM
 * e in ogni shadow root più in basso, a qualunque profondità. Fino alla 1.32.3
 * B si cercava solo nello shadowRoot del primo elemento di A: «main >>> span»,
 * con lo span dentro un componente sotto main, non trovava niente (note
 * observe chrome-bridg-6379570f, chrome-bridg-f262acc4). Le radici di uno
 * scope si visitano a partire dal suo shadowRoot, quindi dove la regola vecchia
 * trovava un elemento deepQuery restituisce lo stesso. Gli shadow root chiusi
 * restano fuori: element.shadowRoot è null.
 *
 * Usa il `document` globale, come le copie inline nella pagina.
 */

// deep-query:begin
export function deepQueryAll(sel, firstOnly) {
  if (!sel.includes('>>>')) {
    if (!firstOnly) return [...document.querySelectorAll(sel)];
    const el = document.querySelector(sel);
    return el ? [el] : [];
  }
  const parts = sel.split('>>>').map((s) => s.trim());
  let scopes = [...document.querySelectorAll(parts[0])];
  for (let i = 1; i < parts.length && scopes.length; i++) {
    const last = i === parts.length - 1;
    const found = new Set();
    const done = new Set();
    for (const scope of scopes) {
      // Sotto uno scope già visitato le radici sono già state interrogate.
      let up = scope.parentNode || scope.host;
      while (up && !done.has(up)) up = up.parentNode || up.host;
      if (up) continue;
      done.add(scope);
      const roots = scope.shadowRoot ? [scope.shadowRoot, scope] : [scope];
      for (let r = 0; r < roots.length; r++) {
        for (const el of roots[r].querySelectorAll(parts[i])) {
          if (firstOnly && last) return [el];
          found.add(el);
        }
        for (const el of roots[r].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    scopes = [...found];
  }
  return scopes;
}

export function deepQuery(sel) {
  return deepQueryAll(sel, true)[0] || null;
}
// deep-query:end
