/**
 * Euristiche leggere di stack detection, eseguite in MAIN world sulla tab
 * attiva quando l'utente apre il popup. Nessuna libreria esterna: solo
 * global note e indizi DOM. Best-effort dichiarato: un framework ben
 * nascosto (build minificata senza global) non viene rilevato.
 *
 * Nel browser il file viene iniettato via chrome.scripting.executeScript
 * e deposita il risultato in window.__chromeBridge_stackDetect; nei unit
 * test Node si importa per side effect e si usa globalThis.__cbStackDetect.
 */
(() => {
  function detectStack(win, doc) {
    const found = [];
    const add = (name) => { if (!found.includes(name)) found.push(name); };

    if (win.__REACT_DEVTOOLS_GLOBAL_HOOK__ || win.React) add('React');
    if (win.__NEXT_DATA__) add('Next.js');
    if (win.Vue || win.__VUE__) add('Vue');
    if (win.__NUXT__) add('Nuxt');
    if (win.ng || win.getAllAngularRootElements) add('Angular');
    if (win.__svelte || win.__SVELTE_HMR__) add('Svelte');
    if (win.Alpine) add('Alpine.js');
    if (win.jQuery || win.$?.fn?.jquery) add('jQuery');
    if (win.wp || win.wpApiSettings) add('WordPress');
    if (win.prestashop) add('PrestaShop');
    if (win.Shopify) add('Shopify');

    const gen = doc.querySelector('meta[name="generator"]');
    const genText = (gen && gen.content) || '';
    for (const [needle, name] of [
      ['WordPress', 'WordPress'], ['PrestaShop', 'PrestaShop'],
      ['Joomla', 'Joomla'], ['Drupal', 'Drupal'], ['Hugo', 'Hugo'],
      ['Gatsby', 'Gatsby'], ['Astro', 'Astro'],
    ]) {
      if (genText.includes(needle)) add(name);
    }

    for (const s of doc.querySelectorAll('script[src]')) {
      const src = s.src || '';
      if (src.includes('/@vite/')) add('Vite');
      if (src.includes('webpack')) add('webpack');
      if (src.includes('cdn.tailwindcss.com')) add('Tailwind');
    }

    return found;
  }

  globalThis.__cbStackDetect = { detectStack };

  // Esecuzione come content script: deposita il risultato per il service worker
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.document === document) {
    try { window.__chromeBridge_stackDetect = detectStack(window, document); } catch {}
  }
})();
