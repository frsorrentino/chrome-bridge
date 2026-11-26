/**
 * observe: registra i passi che l'utente fa nella pagina (session_record).
 * Parte di service-worker.js, che lo importa: vedi la nota in testa a quel file.
 */
import { resolveTabId } from './tab-target.js';

// --- observe ("guarda come faccio") ---
// La persona esegue la procedura nel proprio browser; noi registriamo clic,
// campi compilati e navigazioni di QUELLA scheda, con un badge visibile, e
// mai il valore dei campi sensibili (password, carte, IBAN, token): al loro
// posto un segnaposto {{campo}}. Il file esce nello stesso jsonl di replay.

export let observeState = null; // { tabId, name, values, startedAt, steps, onNav, onDone }

function observeContentScript(recordValues) {
  if (window.__cbObserveInstalled) return true;
  window.__cbObserveInstalled = true;
  const SENSITIVE = /pass|pwd|card|cvv|cvc|iban|ssn|fiscal|codice.?fiscale|secret|token|otp|pin\b/i;
  const send = (step) => { try { chrome.runtime.sendMessage({ type: 'cb_observe', step }); } catch { /* estensione ricaricata */ } };
  const badge = document.createElement('div');
  badge.id = 'cb-observe-badge';
  badge.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px system-ui,sans-serif;background:#1a1a1a;color:#ffb454;padding:6px 10px;border-radius:14px;box-shadow:0 2px 6px rgba(0,0,0,.4);pointer-events:none';
  badge.textContent = '● Claude is watching this tab';
  document.documentElement.appendChild(badge);
  const selectorOf = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) return `${tag}[name="${name}"]`;
    const parts = []; let cur = el;
    while (cur && cur !== document.body && parts.length < 4) {
      const t = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => !/^(active|hover|focus|selected|is-|js-)/.test(c)).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
      const p = cur.parentElement;
      const sib = p ? [...p.children].filter((c) => c.tagName === cur.tagName) : [cur];
      parts.unshift(`${t}${cls}${sib.length > 1 ? `:nth-of-type(${sib.indexOf(cur) + 1})` : ''}`);
      if (cur.id) { parts[0] = `#${CSS.escape(cur.id)}`; break; }
      cur = p;
    }
    return parts.join(' > ');
  };
  const labelOf = (el) => {
    const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return (id?.textContent || el.getAttribute('aria-label') || el.closest('label')?.textContent || el.getAttribute('placeholder') || el.name || el.id || el.tagName.toLowerCase()).trim().replace(/\s+/g, ' ').slice(0, 60);
  };
  const isSensitive = (el) => el.type === 'password' || /^cc-/.test(el.getAttribute('autocomplete') || '') || SENSITIVE.test(`${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`);
  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.('a, button, input[type=submit], input[type=button], input[type=checkbox], input[type=radio], [role=button], summary, [onclick]') || e.target;
    if (!el || el === badge) return;
    // Per checkbox e radio il "testo" è il value (spesso "on"): l'etichetta dice di più
    const isToggle = el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type);
    const text = isToggle ? labelOf(el) : (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    send({ command: 'click', params: { selector: selectorOf(el) }, human: { label: text || labelOf(el), tag: el.tagName.toLowerCase() } });
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    if (/^(checkbox|radio|submit|button|file)$/.test(el.type)) return;
    const field = (el.name || el.id || labelOf(el)).replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
    const sensitive = isSensitive(el);
    const value = sensitive || !recordValues ? `{{${field}}}` : String(el.value);
    send({ command: 'type_text', params: { selector: selectorOf(el), text: value }, human: { label: labelOf(el), sensitive, placeholder: sensitive || !recordValues } });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && e.target && /^(INPUT)$/.test(e.target.tagName)) send({ command: 'press_key', params: { key: 'Enter', selector: selectorOf(e.target) }, human: { label: labelOf(e.target) } });
  }, true);
  return true;
}

export function pushObserveStep(step) {
  if (!observeState) return;
  const steps = observeState.steps;
  const last = steps[steps.length - 1];
  // Due change sullo stesso campo: resta l'ultimo valore
  if (last && step.command === 'type_text' && last.command === 'type_text' && last.params.selector === step.params.selector) { steps[steps.length - 1] = { ...step, ts: Date.now() }; return; }
  steps.push({ ...step, ts: Date.now() });
}

export async function cmdObserve({ action = 'start', name, values = false, tab_id }) {
  if (action === 'status') return observeState ? { observing: observeState.name, tabId: observeState.tabId, steps: observeState.steps.length, since: observeState.startedAt } : { observing: null };
  if (action === 'stop') {
    if (!observeState) return { stopped: null, steps: [] };
    const st = observeState; observeState = null;
    chrome.webNavigation.onCommitted.removeListener(st.onNav);
    chrome.webNavigation.onCompleted.removeListener(st.onDone);
    try { await chrome.scripting.executeScript({ target: { tabId: st.tabId }, func: () => { document.getElementById('cb-observe-badge')?.remove(); window.__cbObserveInstalled = false; } }); } catch { /* tab chiusa */ }
    let url = null; try { url = (await chrome.tabs.get(st.tabId)).url; } catch { /* chiusa */ }
    return { stopped: st.name, tabId: st.tabId, started_at: st.startedAt, ended_at: Date.now(), final_url: url, steps: st.steps };
  }
  if (observeState) throw new Error(`Already observing "${observeState.name}" on tab ${observeState.tabId}: stop it first`);
  const tabId = await resolveTabId(tab_id);
  const tab = await chrome.tabs.get(tabId);
  const inject = () => chrome.scripting.executeScript({ target: { tabId }, func: observeContentScript, args: [!!values] });
  try { await inject(); } catch (err) { throw new Error(`Cannot observe this page (${err.message}) — chrome:// and store pages are not injectable`); }
  const st = { tabId, name: name || 'observed', values: !!values, startedAt: Date.now(), steps: [{ command: 'navigate', params: { url: tab.url }, human: { label: tab.title }, ts: Date.now() }] };
  st.onNav = (d) => { if (d.tabId === tabId && d.frameId === 0 && observeState === st) pushObserveStep({ command: 'navigate', params: { url: d.url }, human: { transition: d.transitionType } }); };
  st.onDone = (d) => { if (d.tabId === tabId && d.frameId === 0 && observeState === st) inject().catch(() => {}); };
  chrome.webNavigation.onCommitted.addListener(st.onNav);
  chrome.webNavigation.onCompleted.addListener(st.onDone);
  observeState = st;
  return { observing: st.name, tabId, url: tab.url, values: st.values, note: 'A badge marks the tab; stop with action=stop. Sensitive fields are never recorded as values.' };
}
