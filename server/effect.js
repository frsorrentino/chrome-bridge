/**
 * Delta fra due impronte di pagina (extension/lib/page-fingerprint.js), prima
 * e dopo un'azione. Solo ciò che è cambiato, con segno: null quando la pagina
 * è stabile, così page_changed costa zero byte nel caso comune. Un'impronta
 * parziale (estensione vecchia: solo url/title) confronta solo i campi che ha.
 */

const COUNTS = ['nodes', 'text', 'open', 'expanded', 'checked', 'selected', 'dialogs'];

export function fingerprintDelta(before, after) {
  if (!before || !after) return null;
  const d = {};
  if (before.url !== undefined && after.url !== undefined && after.url !== before.url) d.url = after.url;
  if (before.title !== undefined && after.title !== undefined && after.title !== before.title) d.title = after.title;
  for (const k of COUNTS) {
    if (typeof before[k] !== 'number' || typeof after[k] !== 'number') continue;
    const diff = after[k] - before[k];
    if (diff !== 0) d[k] = `${diff > 0 ? '+' : ''}${diff}`;
  }
  if (typeof before.focus === 'string' && typeof after.focus === 'string' && after.focus !== before.focus) d.focus = after.focus;
  return Object.keys(d).length ? d : null;
}
