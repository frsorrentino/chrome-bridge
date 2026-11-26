/**
 * Scheda e frame di un comando: tab_id risolto, target di chrome.scripting, attesa del caricamento.
 * Parte di service-worker.js, che lo importa: vedi la nota in testa a quel file.
 */
// --- Utility: waitForComplete ---

export function waitForComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
  });
}

// --- Utility: risolvi tab_id ---

export async function resolveTabId(tab_id) {
  if (tab_id) return tab_id;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}

// --- Utility: target per chrome.scripting con frame opzionale ---

export function scriptTarget(tabId, frame_id) {
  const target = { tabId };
  if (frame_id !== undefined && frame_id !== null) target.frameIds = [frame_id];
  return target;
}
