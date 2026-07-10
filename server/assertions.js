/**
 * Assertion su condizioni di pagina, con polling fino a timeout.
 * Condivisa tra tool MCP (tools.js) e CLI/replay (cli.js): stessa semantica
 * nei flussi interattivi e nei replay registrati.
 */

import { MessageType } from './protocol.js';

/** Pattern: "/.../" = regex, altrimenti substring. */
export function matchPattern(value, pattern) {
  const s = String(value ?? '');
  if (typeof pattern === 'string' && pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return new RegExp(pattern.slice(1, -1)).test(s);
  }
  return s.includes(String(pattern));
}

/**
 * Valuta le condizioni una volta. Ritorna array di failure (vuoto = passed).
 *
 * @param {(type: string, params?: object) => Promise<object>} send
 * @param {object} p - parametri assert (selector, state, text, count, url, title, tab_id)
 */
async function evaluate(send, p) {
  const failures = [];

  if (p.url != null || p.title != null) {
    const tabs = await send(MessageType.GET_TABS, {});
    const list = Array.isArray(tabs) ? tabs : [];
    const tab = p.tab_id != null ? list.find((t) => t.id === p.tab_id) : list.find((t) => t.active);
    if (!tab) {
      failures.push(`tab ${p.tab_id ?? '(active)'} not found`);
    } else {
      if (p.url != null && !matchPattern(tab.url, p.url)) failures.push(`url "${tab.url}" does not match "${p.url}"`);
      if (p.title != null && !matchPattern(tab.title, p.title)) failures.push(`title "${tab.title}" does not match "${p.title}"`);
    }
  }

  if (p.selector != null) {
    // limit: per count esatto serve vedere se esistono match oltre l'atteso
    const limit = p.count != null ? p.count + 1 : (p.text != null || p.state === 'visible' ? 10 : 1);
    const data = await send(MessageType.QUERY_DOM, { selector: p.selector, limit, tab_id: p.tab_id });
    const els = data?.elements ?? [];
    if (p.count != null) {
      if (els.length !== p.count) failures.push(`count ${els.length >= limit ? `>=${limit}` : els.length} != ${p.count} for "${p.selector}"`);
    } else if (els.length === 0) {
      failures.push(`no element matches "${p.selector}"`);
    }
    if (p.state === 'visible' && els.length && !els.some((e) => e.rect?.width > 0 && e.rect?.height > 0)) {
      failures.push(`"${p.selector}" matched but not visible`);
    }
    if (p.text != null && els.length && !els.some((e) => matchPattern(e.textContent, p.text))) {
      failures.push(`text "${p.text}" not found in "${p.selector}"`);
    }
  } else if (p.text != null) {
    // Pagina intera: find_text è substring-only, niente regex
    const data = await send(MessageType.FIND_TEXT, { text: p.text, max_results: 1, tab_id: p.tab_id });
    if ((data?.count ?? 0) === 0) failures.push(`text "${p.text}" not found on page`);
  }

  return failures;
}

/**
 * Esegue l'assert con retry fino a timeout. Ritorna { passed: true, waited_ms }
 * o lancia Error col dettaglio dell'ultima valutazione fallita.
 */
export async function runAssert(send, params) {
  const { timeout = 5000, interval = 300 } = params;
  if (params.selector == null && params.text == null && params.url == null && params.title == null) {
    throw new Error('assert requires at least one of: selector, text, url, title');
  }
  const start = Date.now();
  const deadline = start + timeout;
  for (;;) {
    const failures = await evaluate(send, params);
    if (!failures.length) return { passed: true, waited_ms: Date.now() - start };
    if (Date.now() >= deadline) throw new Error(`Assertion failed after ${timeout}ms: ${failures.join('; ')}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
