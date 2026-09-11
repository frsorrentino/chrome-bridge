/**
 * Impronta della pagina: pochi interi che un'azione può cambiare. Il server
 * la prende prima e dopo click/fill_form e riporta solo le differenze in
 * page_changed: "il menu si è aperto" senza screenshot.
 *
 * Autocontenuta apposta: chrome.scripting.executeScript ne serializza il
 * sorgente e la esegue nella pagina, dove niente di questo modulo esiste.
 * Prende `doc` per essere testabile su un DOM finto (test/unit).
 */
export function pageFingerprint(doc) {
  const d = doc || document;
  const count = (sel) => { try { return d.querySelectorAll(sel).length; } catch { return 0; } };
  let checked = 0;
  try { for (const el of d.querySelectorAll('input')) if (el.checked) checked += 1; } catch { /* nessun input */ }
  let focus = 'body';
  const a = d.activeElement;
  if (a && a.tagName) {
    const tag = a.tagName.toLowerCase();
    const name = a.getAttribute ? a.getAttribute('name') : null;
    focus = a.id ? `${tag}#${a.id}` : (name ? `${tag}[name="${name}"]` : tag);
  }
  const body = d.body;
  const text = body ? (typeof body.innerText === 'string' ? body.innerText : (body.textContent || '')).length : 0;
  return {
    url: d.location ? d.location.href : null,
    title: d.title || '',
    nodes: d.getElementsByTagName('*').length,
    text,
    open: count('[open]'),
    expanded: count('[aria-expanded="true"]'),
    checked,
    selected: count('[aria-selected="true"], [aria-pressed="true"]'),
    dialogs: count('dialog[open], [role="dialog"], [role="alertdialog"]'),
    focus,
  };
}
