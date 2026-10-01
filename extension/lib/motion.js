/**
 * Misure di movimento nella pagina, per i tool `animations` e `frames`.
 *
 * Tutto da script di pagina: il dominio CDP `Animation` e
 * `PerformanceTimeline` non sono ammessi a chrome.debugger da un'estensione
 * (prova del 01/10/2026, Chromium 154), quindi si leggono
 * document.getAnimations() e i PerformanceObserver come farebbe il sito.
 *
 * Tre operazioni su globalThis.__cbMotion:
 * - snapshot(opts): le animazioni presenti adesso;
 * - start(opts): apre una finestra di registrazione (animazioni viste a ogni
 *   fotogramma, Long Animation Frames, layout shift, interazioni, ritmo rAF);
 * - stop(): chiude la finestra e restituisce la sintesi.
 * Lo stato della finestra vive nella pagina: una navigazione lo perde, e stop
 * lo dice.
 *
 * Non è un modulo ES: chrome.scripting serializza solo la funzione iniettata,
 * quindi il service worker inietta questo file (files:, world MAIN) e poi
 * chiama __cbMotion. Nei test Node si importa per side effect, come
 * element-label.js.
 */
(() => {
  // Proprietà che il compositor di Chrome anima senza il thread principale.
  // È una stima: will-change, layer e dimensioni possono cambiare l'esito.
  const COMPOSITABLE = new Set(['transform', 'translate', 'rotate', 'scale', 'opacity', 'filter', 'backdrop-filter']);
  // Una «dissolvenza»: con prefers-reduced-motion restano accettabili.
  const FADE = new Set(['opacity', 'visibility']);
  const KF_META = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const EASING_MAX = 200;

  const round = (n, d = 0) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
  const kebab = (p) => (p.startsWith('--') ? p : p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
  // linear() di una molla ha decine di punti: si taglia il testo e si dice
  // quanti punti aveva, così due curve restano distinguibili.
  const shortEasing = (e) => {
    const s = String(e);
    if (s.length <= EASING_MAX) return s;
    const points = s.startsWith('linear(') ? s.slice(7, -1).split(',').length : null;
    return `${s.slice(0, EASING_MAX)}…${points ? ` (${points} points)` : ''}`;
  };
  // Durate e tempi: numeri in ms, oppure CSSNumericValue (percentuali delle
  // timeline di scroll) e 'auto', resi come testo.
  const timeValue = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? round(v) : 'infinite';
    return String(v);
  };

  const stableSelector = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const testid = el.getAttribute && el.getAttribute('data-testid');
    if (testid) return `[data-testid="${testid.replace(/"/g, '\\"')}"]`;
    const parts = [];
    let node = el;
    const root = el.ownerDocument && el.ownerDocument.documentElement;
    while (node && node.nodeType === 1 && node !== root) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift(`#${node.id}`); break; }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };

  const timelineKind = (a) => {
    const t = a.timeline;
    if (t == null) return 'none';
    if (typeof ViewTimeline !== 'undefined' && t instanceof ViewTimeline) return 'view';
    if (typeof ScrollTimeline !== 'undefined' && t instanceof ScrollTimeline) return 'scroll';
    if (typeof document !== 'undefined' && t === document.timeline) return 'document';
    return 'other';
  };

  function describe(a) {
    const effect = a.effect || null;
    const target = effect && effect.target;
    const pseudo = (effect && effect.pseudoElement) || null;
    let keyframes = [];
    try { keyframes = effect && effect.getKeyframes ? effect.getKeyframes() : []; } catch { /* effetto senza keyframe leggibili */ }
    const props = new Set();
    for (const k of keyframes) for (const p of Object.keys(k)) if (!KF_META.has(p)) props.add(kebab(p));
    if (!props.size && a.transitionProperty) props.add(a.transitionProperty);
    const properties = [...props];

    const timing = effect && effect.getTiming ? effect.getTiming() : {};
    const computed = effect && effect.getComputedTiming ? effect.getComputedTiming() : {};
    // Animazioni CSS: la curva sta nei keyframe (animation-timing-function), e
    // la timing dell'effetto è 'linear'. Transizioni e WAAPI: nella timing.
    const kfEasings = [...new Set(keyframes.map((k) => k.easing).filter((e) => e && e !== 'linear'))];
    let easing = timing.easing || 'linear';
    if (easing === 'linear' && kfEasings.length) easing = kfEasings.length === 1 ? kfEasings[0] : kfEasings;
    easing = Array.isArray(easing) ? easing.map(shortEasing) : shortEasing(easing);

    const kind = a.constructor && a.constructor.name ? a.constructor.name : 'Animation';
    const out = {
      kind,
      name: a.animationName || a.transitionProperty || a.id || null,
      selector: stableSelector(target),
      ...(pseudo && { pseudo }),
      properties,
      duration_ms: timeValue(timing.duration),
      delay_ms: timeValue(timing.delay),
      ...(timing.endDelay ? { end_delay_ms: timeValue(timing.endDelay) } : {}),
      easing,
      iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations,
      ...(timing.direction && timing.direction !== 'normal' ? { direction: timing.direction } : {}),
      ...(timing.fill && timing.fill !== 'auto' && timing.fill !== 'none' ? { fill: timing.fill } : {}),
      play_state: a.playState,
      progress: computed.progress == null ? null : round(computed.progress, 2),
      timeline: timelineKind(a),
      view_transition: Boolean(pseudo && pseudo.startsWith('::view-transition')),
      composited_estimate: properties.length > 0 && properties.every((p) => COMPOSITABLE.has(p)),
      fade_only: properties.length > 0 && properties.every((p) => FADE.has(p)),
    };
    if (a.playbackRate != null && a.playbackRate !== 1) out.playback_rate = a.playbackRate;
    return out;
  }

  const inScope = (a, scope) => {
    if (!scope) return true;
    const t = a.effect && a.effect.target;
    try { return Boolean(t && t.closest && t.closest(scope)); } catch { return false; }
  };

  function summarize(list) {
    const by = (key) => list.reduce((m, x) => { m[x[key]] = (m[x[key]] || 0) + 1; return m; }, {});
    const props = {};
    for (const x of list) for (const p of x.properties) props[p] = (props[p] || 0) + 1;
    const durations = list.map((x) => x.duration_ms).filter((d) => typeof d === 'number');
    const easings = [...new Set(list.flatMap((x) => (Array.isArray(x.easing) ? x.easing : [x.easing])))];
    return {
      count: list.length,
      by_kind: by('kind'),
      by_play_state: by('play_state'),
      infinite: list.filter((x) => x.iterations === 'infinite').length,
      max_duration_ms: durations.length ? Math.max(...durations) : null,
      properties: props,
      not_composited_estimate: list.filter((x) => !x.composited_estimate).length,
      not_fade_only: list.filter((x) => !x.fade_only).length,
      view_transitions: list.filter((x) => x.view_transition).length,
      easings,
    };
  }

  const reducedMotion = () => {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return null; }
  };

  function snapshot({ scope = null, limit = 50 } = {}) {
    const list = document.getAnimations().filter((a) => inScope(a, scope)).map(describe);
    return {
      prefers_reduced_motion: reducedMotion(),
      summary: summarize(list),
      animations: list.slice(0, limit),
      ...(list.length > limit ? { truncated: list.length - limit } : {}),
    };
  }

  // --- finestra di registrazione ---

  const supported = () => (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || [];

  function start({ scope = null } = {}) {
    if (globalThis.__cbMotionRec) stopObservers(globalThis.__cbMotionRec);
    const t0 = performance.now();
    const rec = {
      t0, scope, observers: [], seen: new Map(), loaf: [], shifts: [], events: [],
      frames: [], raf: 0, active: true, hiddenDuring: false,
    };
    globalThis.__cbMotionRec = rec;
    const types = supported();
    const observe = (type, opts, onEntry) => {
      if (!types.includes(type)) return false;
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) onEntry(e); });
      try { po.observe({ type, ...opts }); } catch { return false; }
      rec.observers.push({ po, onEntry });
      return true;
    };
    rec.support = {
      long_animation_frame: observe('long-animation-frame', {}, (e) => { if (e.startTime >= t0) rec.loaf.push(e); }),
      layout_shift: observe('layout-shift', {}, (e) => { if (e.startTime >= t0) rec.shifts.push(e); }),
      event_timing: observe('event', { durationThreshold: 16 }, (e) => { if (e.startTime >= t0) rec.events.push(e); }),
    };
    const sample = () => {
      if (!rec.active) return;
      const now = performance.now();
      rec.frames.push(now);
      for (const a of document.getAnimations()) {
        if (!rec.seen.has(a) && inScope(a, scope)) rec.seen.set(a, round(now - t0));
      }
      rec.raf = requestAnimationFrame(sample);
    };
    rec.onVisibility = () => { if (document.visibilityState === 'hidden') rec.hiddenDuring = true; };
    document.addEventListener('visibilitychange', rec.onVisibility);
    // Una transizione di 150 ms può nascere e finire fra due campioni rAF solo
    // se la pagina perde fotogrammi: transitionrun e animationstart la
    // segnalano comunque, e il campione successivo la trova nel documento.
    rec.onStartEvent = () => {
      for (const a of document.getAnimations()) {
        if (!rec.seen.has(a) && inScope(a, scope)) rec.seen.set(a, round(performance.now() - t0));
      }
    };
    document.addEventListener('transitionrun', rec.onStartEvent, true);
    document.addEventListener('animationstart', rec.onStartEvent, true);
    sample();
    return { recording: true, support: rec.support };
  }

  function stopObservers(rec) {
    rec.active = false;
    cancelAnimationFrame(rec.raf);
    // takeRecords: le voci già prodotte ma non ancora consegnate al callback
    // (l'ultimo fotogramma della finestra) non vanno perse.
    for (const { po, onEntry } of rec.observers) {
      try { for (const e of po.takeRecords()) onEntry(e); po.disconnect(); } catch { /* già scollegato */ }
    }
    document.removeEventListener('visibilitychange', rec.onVisibility);
    document.removeEventListener('transitionrun', rec.onStartEvent, true);
    document.removeEventListener('animationstart', rec.onStartEvent, true);
  }

  // Ritmo dei fotogrammi del thread principale. L'intervallo tipico (mediana)
  // stima la frequenza dello schermo; un intervallo oltre 1,5 volte la mediana
  // è almeno un fotogramma perso. Le animazioni composte possono restare
  // fluide anche quando il thread principale salta.
  function frameStats(times) {
    if (times.length < 3) return { count: times.length, note: 'Too few frames: was the page hidden or the window too short?' };
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const sorted = [...gaps].sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    const span = times[times.length - 1] - times[0];
    const dropped = gaps.reduce((n, g) => n + (g > median * 1.5 ? Math.round(g / median) - 1 : 0), 0);
    return {
      count: times.length,
      fps: round((gaps.length * 1000) / span, 1),
      refresh_estimate_hz: round(1000 / median),
      max_gap_ms: round(sorted[sorted.length - 1]),
      dropped_estimate: dropped,
    };
  }

  function loafEntry(e) {
    const scripts = (e.scripts || [])
      .map((s) => ({
        invoker: s.invoker || null,
        type: s.invokerType || null,
        source: s.sourceURL ? `${s.sourceURL}${s.sourceFunctionName ? ` ${s.sourceFunctionName}` : ''}${s.sourceCharPosition >= 0 ? `:${s.sourceCharPosition}` : ''}` : (s.sourceFunctionName || null),
        duration_ms: round(s.duration),
        ...(s.forcedStyleAndLayoutDuration ? { forced_layout_ms: round(s.forcedStyleAndLayoutDuration) } : {}),
      }))
      .sort((x, y) => y.duration_ms - x.duration_ms)
      .slice(0, 3);
    const start = e.startTime;
    return {
      duration_ms: round(e.duration),
      blocking_ms: round(e.blockingDuration),
      // Fasi del fotogramma: script prima del rendering, poi stile e layout.
      ...(e.renderStart ? { render_start_ms: round(e.renderStart - start) } : {}),
      ...(e.styleAndLayoutStart ? { style_layout_start_ms: round(e.styleAndLayoutStart - start) } : {}),
      scripts,
    };
  }

  function shiftsSummary(entries) {
    const counted = entries.filter((e) => !e.hadRecentInput);
    const cls = counted.reduce((s, e) => s + e.value, 0);
    const top = [...counted].sort((x, y) => y.value - x.value).slice(0, 5).map((e) => ({
      value: round(e.value, 4),
      sources: (e.sources || []).slice(0, 3).map((s) => ({
        selector: stableSelector(s.node),
        ...(s.previousRect && s.currentRect ? { moved_px: { x: round(s.currentRect.x - s.previousRect.x), y: round(s.currentRect.y - s.previousRect.y) } } : {}),
      })),
    }));
    return {
      cls: round(cls, 4),
      count: counted.length,
      ...(entries.length > counted.length ? { after_input_excluded: entries.length - counted.length } : {}),
      top,
    };
  }

  // INP sulla finestra: la più lunga fra le interazioni (interactionId > 0).
  // Con meno di 50 interazioni è anche il valore che web-vitals riporterebbe.
  // Le durate degli Event Timing sono arrotondate a 8 ms dal browser. Le fasi
  // si calcolano sull'insieme delle voci dell'interazione (pointerdown,
  // pointerup, click…), come web-vitals/attribution: la voce più lunga da
  // sola è spesso un pointerup senza handler e senza target.
  function interactionsSummary(entries) {
    const byId = new Map();
    for (const e of entries) {
      if (!e.interactionId) continue;
      if (!byId.has(e.interactionId)) byId.set(e.interactionId, []);
      byId.get(e.interactionId).push(e);
    }
    const list = [...byId.values()].map((group) => ({ group, duration: Math.max(...group.map((e) => e.duration)) }))
      .sort((x, y) => y.duration - x.duration);
    if (!list.length) return { count: 0, inp_ms: null, note: 'No interaction in the window. Synthetic events have no interactionId: use action.trusted for INP.' };
    const { group, duration } = list[0];
    const start = Math.min(...group.map((e) => e.startTime));
    const procStart = Math.min(...group.map((e) => e.processingStart));
    const procEnd = Math.max(...group.map((e) => e.processingEnd));
    const main = [...group].sort((x, y) => (y.processingEnd - y.processingStart) - (x.processingEnd - x.processingStart))
      .find((e) => e.target) || group[0];
    return {
      count: list.length,
      inp_ms: round(duration),
      worst: {
        event: main.name,
        events: [...new Set(group.map((e) => e.name))],
        selector: stableSelector(main.target),
        input_delay_ms: round(procStart - start),
        processing_ms: round(procEnd - procStart),
        presentation_delay_ms: round(Math.max(0, start + duration - procEnd)),
      },
    };
  }

  function stop({ threshold_ms = 50, limit = 10 } = {}) {
    const rec = globalThis.__cbMotionRec;
    if (!rec) return { error: 'No recording in this page: it was never started, or the page navigated and lost it.' };
    stopObservers(rec);
    delete globalThis.__cbMotionRec;
    const t0 = rec.t0;
    const animations = [...rec.seen.entries()].map(([a, at]) => ({ first_seen_ms: at, ...describe(a) }));
    const long = rec.loaf.filter((e) => e.duration >= threshold_ms).sort((x, y) => y.duration - x.duration);
    return {
      window_ms: round(performance.now() - t0),
      prefers_reduced_motion: reducedMotion(),
      ...(rec.hiddenDuring ? { page_hidden_during: true } : {}),
      support: rec.support,
      frames: frameStats(rec.frames),
      long_frames: {
        threshold_ms,
        count: long.length,
        total_blocking_ms: round(long.reduce((s, e) => s + (e.blockingDuration || 0), 0)),
        worst: long.slice(0, limit).map((e) => ({ ...loafEntry(e), at_ms: round(e.startTime - t0) })),
      },
      layout_shifts: shiftsSummary(rec.shifts),
      interactions: interactionsSummary(rec.events),
      animations: {
        summary: summarize(animations),
        list: animations.slice(0, limit * 3),
        ...(animations.length > limit * 3 ? { truncated: animations.length - limit * 3 } : {}),
      },
    };
  }

  globalThis.__cbMotion = { snapshot, start, stop, _internals: { describe, summarize, frameStats, shiftsSummary, interactionsSummary, loafEntry, shortEasing } };
})();
