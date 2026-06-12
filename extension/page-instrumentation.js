/**
 * Iniettato a document_start in MAIN world: raccoglie Web Vitals
 * (CLS, LCP, long task, INP approssimato) e censisce gli event listener
 * registrati via addEventListener.
 */
(() => {
  if (window.__chromeBridge_instrumented) return;
  window.__chromeBridge_instrumented = true;

  // --- Web Vitals ---
  const vitals = {
    cls: 0,
    lcp: null,
    longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    maxEventDelayMs: null, // INP approssimato (max event duration)
  };
  window.__chromeBridge_vitals = vitals;

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) vitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) vitals.lcp = Math.round(entries[entries.length - 1].startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        vitals.longTasks.count++;
        vitals.longTasks.totalMs += Math.round(entry.duration);
        vitals.longTasks.maxMs = Math.max(vitals.longTasks.maxMs, Math.round(entry.duration));
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (vitals.maxEventDelayMs === null || entry.duration > vitals.maxEventDelayMs) {
          vitals.maxEventDelayMs = Math.round(entry.duration);
        }
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 40 });
  } catch {}

  // --- Censimento event listener ---
  const listeners = [];
  window.__chromeBridge_listeners = listeners;
  const MAX_LISTENERS = 2000;

  const describeTarget = (t) => {
    if (t === window) return 'window';
    if (t === document) return 'document';
    if (t && t.nodeType === 1) {
      const tag = t.tagName.toLowerCase();
      const id = t.id ? `#${t.id}` : '';
      const cls = t.classList && t.classList.length ? `.${[...t.classList].slice(0, 2).join('.')}` : '';
      return `${tag}${id}${cls}`;
    }
    return String(t && t.constructor ? t.constructor.name : t);
  };

  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (listeners.length < MAX_LISTENERS) {
      listeners.push({
        type,
        target: describeTarget(this),
        capture: typeof opts === 'boolean' ? opts : !!(opts && opts.capture),
        once: !!(opts && opts.once),
        passive: !!(opts && opts.passive),
        timestamp: Date.now(),
      });
    }
    return origAdd.call(this, type, fn, opts);
  };
})();
