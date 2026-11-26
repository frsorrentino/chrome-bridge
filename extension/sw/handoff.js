/**
 * handoff e handoff_end: il banner in pagina che passa la mano all'utente e aspetta Done, una risposta o gli elementi scelti.
 * Parte di service-worker.js, che lo importa: vedi la nota in testa a quel file.
 */
import { resolveTabId } from './tab-target.js';

// --- handoff ---
// L'umano davanti al browser è la risorsa che un laboratorio headless non ha:
// 2FA, CAPTCHA, "quale elemento intendi?". Un banner in pagina (shadow DOM,
// nessun permesso nuovo) con il messaggio e un bottone Fatto; il comando
// torna quando l'utente preme, o allo scadere del timeout. Se la pagina
// naviga nel frattempo (login → redirect) il banner viene reiniettato.
// Con pick_element il prossimo clic sulla pagina sceglie un elemento e ne
// torna il selettore.

export const handoffs = new Map(); // tabId → { id, resolve, timer, onNav }

function handoffBanner(id, message, pick, ask, pickMax) {
  const old = document.getElementById('cb-handoff-host');
  if (old) old.remove();
  const host = document.createElement('div');
  host.id = 'cb-handoff-host';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .bar{font:14px/1.4 system-ui,sans-serif;background:#1a1a1a;color:#fff;padding:10px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.4)}
    .bar b{color:#ffb454}.bar span{flex:1}
    button{font:inherit;padding:6px 14px;border:0;border-radius:6px;cursor:pointer;background:#ffb454;color:#1a1a1a;font-weight:600}
    button.sec{background:#444;color:#fff}
    input.ask{font:inherit;padding:6px 10px;border:0;border-radius:6px;min-width:220px;background:#fff;color:#1a1a1a}
  </style><div class="bar"><b>Claude</b><span></span>${ask ? '<input class="ask" type="text" placeholder="Your reply">' : ''}${pick ? '<button class="pick">Pick element</button>' : ''}<button class="done">Done</button><button class="sec cancel">Cancel</button></div>`;
  root.querySelector('span').textContent = message;
  document.documentElement.appendChild(host);
  // ask: la risposta scritta; pick_max: gli elementi indicati, con contorno
  // finché il banner resta. Done chiude in entrambi i casi (Invio nella casella).
  const picks = []; const marked = [];
  const askInput = root.querySelector('input.ask');
  const answerOf = () => (askInput ? askInput.value : undefined);
  const finish = (result) => { host.remove(); cleanupPick(); for (const m of marked) m.style.outline = m.__cbOutline ?? ''; chrome.runtime.sendMessage({ type: 'cb_handoff_done', id, result }); };
  const done = () => finish(picks.length
    ? { done: true, action: 'picked', answer: answerOf(), picked: picks[0], picked_all: picks }
    : { done: true, action: 'done', answer: answerOf() });
  const addPick = (el, p) => {
    picks.push(p);
    if (!marked.includes(el)) { el.__cbOutline = el.style.outline; el.style.outline = '2px solid #ffb454'; marked.push(el); }
    if (picks.length >= pickMax) { done(); return; }
    root.querySelector('span').textContent = `${message} — ${picks.length}/${pickMax} picked, click more or Done`;
  };
  root.querySelector('.done').onclick = done;
  if (askInput) { askInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) done(); }; setTimeout(() => askInput.focus(), 0); }
  root.querySelector('.cancel').onclick = () => finish({ done: false, action: 'cancel' });
  let box = null; let onMove = null; let onClick = null;
  function cleanupPick() {
    if (box) box.remove(); box = null;
    if (onMove) document.removeEventListener('mousemove', onMove, true); onMove = null;
    if (onClick) document.removeEventListener('click', onClick, true); onClick = null;
  }
  const selectorOf = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) return `${tag}[name="${name}"]`;
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 4) {
      const t = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => !/^(active|hover|focus|selected|is-|js-)/.test(c)).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
      const p = cur.parentElement;
      const idx = p ? [...p.children].filter((c) => c.tagName === cur.tagName).indexOf(cur) + 1 : 1;
      parts.unshift(`${t}${cls}${p && [...p.children].filter((c) => c.tagName === cur.tagName).length > 1 ? `:nth-of-type(${idx})` : ''}`);
      if (cur.id) { parts[0] = `#${CSS.escape(cur.id)}`; break; }
      cur = p;
    }
    return parts.join(' > ');
  };
  const pickBtn = root.querySelector('.pick');
  if (pickBtn) pickBtn.onclick = () => {
    root.querySelector('span').textContent = `${message} — ${pickMax > 1 ? `click up to ${pickMax} elements, then Done` : 'now click the element'}`;
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #ffb454;background:rgba(255,180,84,.15);transition:all .05s';
    document.documentElement.appendChild(box);
    onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === host || host.contains(el)) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    onClick = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === host || host.contains(el)) return;
      e.preventDefault(); e.stopPropagation();
      const r = el.getBoundingClientRect();
      // Checkbox e radio: il value ("on") non dice niente, l'etichetta sì
      const labelFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const isToggle = el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type);
      const label = (labelFor?.textContent || el.closest('label')?.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      const text = (isToggle ? label || el.name : (el.innerText || el.value || el.getAttribute('aria-label') || label || '')).trim().replace(/\s+/g, ' ').slice(0, 80);
      addPick(el, { selector: selectorOf(el), tag: el.tagName.toLowerCase(), text, rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } });
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
  };
  return true;
}

export async function cmdHandoff({ message, pick_element = false, ask = false, pick_max = 1, timeout = 300000, tab_id }) {
  if (!message) throw new Error('Missing required parameter: message');
  const tabId = await resolveTabId(tab_id);
  if (handoffs.has(tabId)) throw new Error('A handoff is already waiting on this tab');
  const id = `h${Date.now()}`;
  const inject = () => chrome.scripting.executeScript({ target: { tabId }, func: handoffBanner, args: [id, String(message), !!pick_element, !!ask, Math.max(1, Number(pick_max) || 1)] });
  try { await inject(); } catch (err) { throw new Error(`Cannot show the handoff banner on this page (${err.message}) — chrome:// and store pages are not injectable`); }
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  return await new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(entry.timer);
      chrome.webNavigation.onCompleted.removeListener(entry.onNav);
      handoffs.delete(tabId);
      resolve(result);
    };
    const entry = {
      id,
      resolve: finish,
      timer: setTimeout(async () => {
        try { await chrome.scripting.executeScript({ target: { tabId }, func: () => document.getElementById('cb-handoff-host')?.remove() }); } catch { /* tab chiusa */ }
        finish({ done: false, action: 'timeout', url: null });
      }, Math.max(1000, Number(timeout) || 300000)),
      // Login → redirect: la pagina nuova non ha il banner, lo rimettiamo
      onNav: (d) => { if (d.tabId === tabId && d.frameId === 0) inject().catch(() => {}); },
    };
    chrome.webNavigation.onCompleted.addListener(entry.onNav);
    chrome.tabs.onRemoved.addListener(function onGone(closed) { if (closed === tabId) { chrome.tabs.onRemoved.removeListener(onGone); finish({ done: false, action: 'tab_closed', url: null }); } });
    handoffs.set(tabId, entry);
  });
}

// handoff_end: l'utente ha risposto nel terminale (elicitation MCP) prima che
// nella pagina. Il banner va tolto e l'handoff in attesa finisce con quella
// risposta, così la chiamata handoff originale ritorna una sola volta.
export async function cmdHandoffEnd({ action = 'done', answer, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const entry = handoffs.get(tabId);
  if (!entry) return { ended: false };
  try { await chrome.scripting.executeScript({ target: { tabId }, func: () => document.getElementById('cb-handoff-host')?.remove() }); } catch { /* tab chiusa */ }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  entry.resolve({ done: action === 'done', action, url: tab?.url ?? null, via: 'terminal', ...(typeof answer === 'string' && { answer }) });
  return { ended: true };
}
