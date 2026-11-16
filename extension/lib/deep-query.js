/**
 * Fonte unica di deepQuery e deepQueryAll, i resolver dei selettori con ">>>".
 *
 * Ogni func passata a chrome.scripting.executeScript viene serializzata: un
 * helper definito fuori non esiste nella pagina. Per questo service-worker.js
 * ne porta una copia inline per tool, tra i marcatori «deep-query:begin» e
 * «deep-query:end». Si cambia questo file, poi `node tools/sync-deep-query.mjs`
 * riscrive le copie; test/unit/deep-query.test.js fallisce se divergono.
 *
 * «A >>> B» cerca B nello shadowRoot del primo elemento che A trova.
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
  const last = parts.pop();
  let ctx = document;
  for (const p of parts) {
    const found = ctx.querySelector(p);
    if (!found || !found.shadowRoot) return [];
    ctx = found.shadowRoot;
  }
  if (!firstOnly) return [...ctx.querySelectorAll(last)];
  const el = ctx.querySelector(last);
  return el ? [el] : [];
}

export function deepQuery(sel) {
  return deepQueryAll(sel, true)[0] || null;
}
// deep-query:end
