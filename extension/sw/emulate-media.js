/**
 * emulate_media: via debugger (contrasto, CPU, rete, dispositivo, touch: lib/emulation.js) o dalla pagina (tema, movimento ridotto, stampa, user agent).
 * Parte di service-worker.js, che lo importa: vedi la nota in testa a quel file.
 */
import { holdDebugger, releaseDebugger, debuggerHeld } from '../lib/trusted-input.js';
import { emulationCommands } from '../lib/emulation.js';
import { resolveTabId } from './tab-target.js';

// --- emulate_media ---

// Emulazione via debugger: vive finché il debugger resta agganciato, quindi la
// scheda è «tenuta» fino a reset (o finché l'utente annulla la barra). Lo stato
// si accumula fra le chiamate e si rimanda per intero: setEmulatedMedia
// sostituisce l'elenco delle preferenze, non lo integra.
const emulationState = new Map();
const CDP_ONLY = ['contrast', 'cpu_throttle', 'network', 'device', 'touch'];

export async function cmdEmulateMedia(params) {
  const { via, reset = false, user_agent = null, tab_id } = params;
  const tabId = await resolveTabId(tab_id);
  if (reset) {
    const released = await releaseDebugger(tabId, 'emulation');
    emulationState.delete(tabId);
    await cmdEmulateMediaPage({ reset: true, tabId });
    return { reset: true, ...(released && { debugger_released: true }) };
  }
  const cdpOnly = CDP_ONLY.filter((k) => params[k] != null);
  const useDebugger = via === 'debugger' || (via !== 'page' && cdpOnly.length > 0);
  if (!useDebugger) {
    if (cdpOnly.length) throw new Error(`${cdpOnly.join(', ')} need via: "debugger"`);
    return cmdEmulateMediaPage({ ...params, tabId });
  }
  if (params.reducedMotion || params.colorScheme || params.printMode) {
    // Il ripiego nella pagina sovrascriverebbe le regole del sito: via
    // debugger si toglie, così valgono le @media vere.
    await cmdEmulateMediaPage({ reset: true, tabId }).catch(() => {});
  }
  if (!debuggerHeld(tabId).held) emulationState.delete(tabId);
  const prev = emulationState.get(tabId) ?? {};
  const pick = Object.fromEntries(['colorScheme', 'reducedMotion', 'contrast', 'cpu_throttle', 'network', 'device', 'touch']
    .filter((k) => params[k] != null).map((k) => [k, params[k]]));
  if (params.printMode) pick.printMode = true;
  const merged = { ...prev, ...pick };
  const { commands, emulated } = emulationCommands(merged);
  const send = await holdDebugger(tabId, 'emulation', 'emulate_media via debugger');
  for (const [method, p] of commands) await send(method, p);
  emulationState.set(tabId, merged);
  const out = {
    emulated,
    via: 'debugger',
    debugger_bar: 'Chrome shows a "started debugging this browser" bar until emulate_media reset: true; cancelling it ends the emulation',
  };
  if (user_agent) out.user_agent = (await cmdEmulateMediaPage({ user_agent, tabId })).emulated?.userAgent ?? user_agent;
  return out;
}

async function cmdEmulateMediaPage({ colorScheme, reducedMotion, printMode = false, user_agent = null, reset = false, tabId }) {

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (cs, rm, print, ua, doReset) => {
      const STYLE_ID = '__chromeBridge_media';
      const META_ID = '__chromeBridge_colorScheme';

      if (doReset) {
        const style = document.getElementById(STYLE_ID);
        if (style) style.remove();
        const meta = document.getElementById(META_ID);
        if (meta) meta.remove();
        // Restore original matchMedia if saved
        if (window.__chromeBridge_origMatchMedia) {
          window.matchMedia = window.__chromeBridge_origMatchMedia;
          delete window.__chromeBridge_origMatchMedia;
        }
        // navigator.userAgent è stato ridefinito con un getter: per tornare
        // all'originale va rimossa la proprietà own, così riemerge quella del
        // prototipo.
        if (window.__chromeBridge_uaPatched) {
          for (const prop of ['userAgent', 'appVersion', 'platform']) {
            try { delete navigator[prop]; } catch { /* proprietà non configurabile: si prosegue */ }
          }
          delete window.__chromeBridge_uaPatched;
        }
        return { reset: true };
      }

      // Save original matchMedia
      if (!window.__chromeBridge_origMatchMedia) {
        window.__chromeBridge_origMatchMedia = window.matchMedia.bind(window);
      }

      const overrides = {};
      if (cs) overrides['prefers-color-scheme'] = cs;
      if (rm) overrides['prefers-reduced-motion'] = rm;
      if (print) overrides['print'] = true;

      // Override matchMedia for JS-based checks.
      // NB: spreading a MediaQueryList loses prototype methods (addEventListener ecc.),
      // quindi per le query forzate restituiamo uno stub MQL-compatibile.
      const orig = window.__chromeBridge_origMatchMedia;
      const mkStub = (matches, query) => ({
        matches,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false; },
      });
      window.matchMedia = (query) => {
        for (const [feature, val] of Object.entries(overrides)) {
          if (feature === 'print' && query.includes('print')) return mkStub(true, query);
          if (query.includes(feature) && query.includes(val)) return mkStub(true, query);
          if (query.includes(feature) && !query.includes(val)) return mkStub(false, query);
        }
        return orig(query);
      };

      // Inject CSS + meta for CSS-based checks
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }

      let css = '';
      if (cs === 'dark') css += ':root { color-scheme: dark; }\n';
      else if (cs === 'light') css += ':root { color-scheme: light; }\n';
      if (rm === 'reduce') css += '*, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }\n';
      if (print) css += '@media screen { body { } }\n'; // placeholder, actual print emulation via matchMedia override
      style.textContent = css;

      // Color scheme meta tag
      let meta = document.getElementById(META_ID);
      if (cs) {
        if (!meta) {
          meta = document.createElement('meta');
          meta.id = META_ID;
          meta.name = 'color-scheme';
          document.head.appendChild(meta);
        }
        meta.content = cs === 'dark' ? 'dark' : cs === 'light' ? 'light' : 'light dark';
      } else if (meta) {
        meta.remove();
      }

      // navigator.userAgent non è scrivibile: va ridefinita come getter sull'
      // istanza, che precede quella del prototipo. Vale per il JS della pagina,
      // non per l'header della richiesta (quello è network_rules).
      if (ua) {
        for (const [prop, value] of [
          ['userAgent', ua],
          ['appVersion', ua.replace(/^Mozilla\//, '')],
          ['platform', /iPhone|iPad|Android/i.test(ua) ? 'iPhone' : navigator.platform],
        ]) {
          try {
            Object.defineProperty(navigator, prop, { get: () => value, configurable: true });
          } catch { /* alcune pagine congelano navigator: si prosegue */ }
        }
        window.__chromeBridge_uaPatched = true;
        overrides.userAgent = ua;
      }

      return { emulated: overrides };
    },
    args: [colorScheme || null, reducedMotion || null, printMode, user_agent, reset],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? {};
}
