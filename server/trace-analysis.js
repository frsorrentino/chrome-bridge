/**
 * Analisi di un trace di prestazioni (perf_trace): dagli eventi grezzi alle
 * conclusioni, senza dipendenze. Riproduce le metriche del pannello
 * Performance di DevTools che servono a giudicare una pagina: LCP con le sue
 * fasi, FCP, CLS a finestre di sessione, INP, documento, risorse che bloccano
 * il rendering, compiti lunghi e fotogrammi lunghi del thread principale.
 *
 * I nomi e i campi degli eventi sono quelli di Chrome 154 (trace registrato
 * da perf_trace il 01/10/2026); un evento assente dà null, non un errore.
 * I tempi sono in ms dall'inizio della navigazione, o dall'inizio del trace
 * se il trace non contiene una navigazione.
 */

const LONG_TASK_MS = 50;
const round = (n, d = 0) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

/** traceEvents da {traceEvents:[…]} o da un array nudo. */
export function traceEventsOf(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.traceEvents)) return json.traceEvents;
  throw new Error('Not a Chrome trace: expected {traceEvents: [...]} or an array of events');
}

/** Processo e thread principale del frame di primo livello. */
function mainThread(events) {
  const started = events.find((e) => e.name === 'TracingStartedInBrowser');
  const frames = started?.args?.data?.frames ?? [];
  const top = frames.find((f) => f.isOutermostMainFrame || f.isInPrimaryMainFrame) ?? frames[0];
  // Dopo una navigazione fra siti il processo cambia: vale l'ultimo processo
  // che ha avviato una navigazione del frame principale.
  const navs = events.filter((e) => e.name === 'navigationStart' && e.args?.data?.isOutermostMainFrame && e.args?.data?.documentLoaderURL);
  const pid = navs.length ? navs[navs.length - 1].pid : top?.processId;
  const tid = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === pid && e.args?.name === 'CrRendererMain')?.tid;
  return { pid, tid, frame: top?.frame ?? null, url: top?.url ?? null, start: started?.ts ?? null };
}

/** Coppie b/e degli eventi asincroni per id: [{begin, end, dur}]. */
function asyncPairs(events, name, pid) {
  const open = new Map();
  const out = [];
  for (const e of events) {
    if (e.name !== name || (pid != null && e.pid !== pid)) continue;
    if (e.ph === 'b') open.set(e.id, e);
    else if (e.ph === 'e' && open.has(e.id)) {
      const b = open.get(e.id);
      open.delete(e.id);
      out.push({ begin: b, end: e, dur: e.ts - b.ts });
    }
  }
  return out;
}

// CLS come web-vitals: finestre di sessione (pausa di 1 s, al più 5 s),
// vale la finestra con la somma più alta. Gli shift subito dopo un input non
// contano.
function clsOf(events, frame) {
  const shifts = events
    .filter((e) => e.name === 'LayoutShift' && e.args?.data && !e.args.data.had_recent_input && (e.args.data.is_main_frame ?? e.args.frame === frame))
    .sort((a, b) => a.ts - b.ts);
  let best = 0; let bestIdx = []; let cur = 0; let curIdx = []; let first = null; let last = null;
  shifts.forEach((e, i) => {
    const v = e.args.data.weighted_score_delta ?? e.args.data.score ?? 0;
    if (first != null && (e.ts - last > 1e6 || e.ts - first > 5e6)) { cur = 0; curIdx = []; first = null; }
    if (first == null) first = e.ts;
    last = e.ts;
    cur += v; curIdx.push(i);
    if (cur > best) { best = cur; bestIdx = [...curIdx]; }
  });
  return { shifts, value: best, windowShifts: bestIdx.map((i) => shifts[i]) };
}

export function analyzeTrace(json) {
  const events = traceEventsOf(json);
  const main = mainThread(events);
  const nav = events.filter((e) => e.name === 'navigationStart' && e.args?.data?.isOutermostMainFrame && e.args?.data?.documentLoaderURL).pop() ?? null;
  const origin = nav?.ts ?? main.start ?? Math.min(...events.filter((e) => e.ts > 0).map((e) => e.ts));
  const rel = (ts) => round((ts - origin) / 1000);
  const navId = nav?.args?.data?.navigationId ?? null;
  const span = events.reduce((m, e) => (e.ts > m ? e.ts : m), 0) - origin;

  // --- documento ---
  let document = null;
  let ttfb = null;
  if (navId) {
    const send = events.find((e) => e.name === 'ResourceSendRequest' && e.args?.data?.requestId === navId);
    const resp = events.find((e) => e.name === 'ResourceReceiveResponse' && e.args?.data?.requestId === navId);
    const fin = events.find((e) => e.name === 'ResourceFinish' && e.args?.data?.requestId === navId);
    const t = resp?.args?.data?.timing;
    if (t) ttfb = t.requestTime * 1000 + (t.receiveHeadersStart ?? t.receiveHeadersEnd) - origin / 1000;
    document = {
      url: nav.args.data.documentLoaderURL,
      status: resp?.args?.data?.statusCode ?? null,
      ttfb_ms: round(ttfb),
      ...(fin?.args?.data?.finishTime ? { finished_ms: round(fin.args.data.finishTime * 1000 - origin / 1000) } : {}),
      ...(fin?.args?.data?.encodedDataLength != null ? { bytes: fin.args.data.encodedDataLength } : {}),
      ...(send && resp?.args?.data?.fromCache ? { from_cache: true } : {}),
    };
  }

  // --- FCP, LCP con le fasi ---
  const fcp = navId ? events.find((e) => e.name === 'firstContentfulPaint' && e.args?.data?.navigationId === navId) : null;
  const candidates = navId
    ? events.filter((e) => e.name === 'largestContentfulPaint::Candidate' && e.args?.data?.navigationId === navId && e.args.data.isOutermostMainFrame !== false)
    : [];
  const cand = candidates.sort((a, b) => (a.args.data.candidateIndex ?? 0) - (b.args.data.candidateIndex ?? 0)).pop();
  let lcp = null;
  if (cand) {
    const d = cand.args.data;
    const at = rel(cand.ts);
    lcp = { ms: at, type: d.type ?? null, element: d.nodeName ?? null, size: d.size ?? null };
    // Immagine: l'URL sta nel gemello LargestImagePaint::Candidate (stesso
    // istante, DOMNodeId = nodeId); i tempi di caricamento nel candidato
    // stesso (imageLoadStart/End, ms dalla navigazione), altrimenti dagli
    // eventi della richiesta.
    const twin = d.type === 'image'
      ? events.find((e) => e.name === 'LargestImagePaint::Candidate' && (e.ts === cand.ts || e.args?.data?.DOMNodeId === d.nodeId))
      : null;
    const imageUrl = d.url ?? d.imageUrl ?? twin?.args?.data?.imageUrl ?? null;
    if (imageUrl) lcp.url = imageUrl;
    let loadStart = d.imageLoadStart ?? null;
    let loadEnd = d.imageLoadEnd ?? null;
    if (imageUrl && (loadStart == null || loadEnd == null)) {
      const req = events.find((e) => e.name === 'ResourceSendRequest' && e.args?.data?.url === imageUrl);
      const fin = req ? events.find((e) => e.name === 'ResourceFinish' && e.args?.data?.requestId === req.args.data.requestId) : null;
      if (req && fin) {
        loadStart = rel(req.ts);
        loadEnd = fin.args.data.finishTime ? fin.args.data.finishTime * 1000 - origin / 1000 : rel(fin.ts);
      }
    }
    if (ttfb != null) {
      // Fasi di DevTools: TTFB, ritardo e durata del caricamento della
      // risorsa (solo immagini), ritardo di rendering.
      lcp.phases = { ttfb_ms: round(ttfb) };
      if (d.type === 'image' && loadStart != null && loadEnd != null) {
        Object.assign(lcp.phases, { load_delay_ms: round(loadStart - ttfb), load_duration_ms: round(loadEnd - loadStart), render_delay_ms: round(at - loadEnd) });
      } else {
        lcp.phases.render_delay_ms = round(at - ttfb);
      }
    }
  }

  // --- CLS ---
  const cls = clsOf(events, main.frame);

  // --- INP ---
  const timings = asyncPairs(events, 'EventTiming', main.pid).map((p) => p.begin.args?.data).filter((d) => d?.interactionId > 0);
  const byInteraction = new Map();
  for (const d of timings) {
    const cur = byInteraction.get(d.interactionId);
    if (!cur || d.duration > cur.duration) byInteraction.set(d.interactionId, d);
  }
  const interactions = [...byInteraction.values()].sort((a, b) => b.duration - a.duration);
  // Con 50 o più interazioni web-vitals scarta la peggiore ogni 50.
  const inpEntry = interactions[Math.min(Math.floor(interactions.length / 50), interactions.length - 1)];

  // --- compiti e fotogrammi lunghi sul thread principale ---
  const onMain = (e) => e.pid === main.pid && (main.tid == null || e.tid === main.tid);
  const tasks = events.filter((e) => e.name === 'RunTask' && e.ph === 'X' && onMain(e) && e.dur >= LONG_TASK_MS * 1000).sort((a, b) => b.dur - a.dur);
  const calls = events.filter((e) => (e.name === 'FunctionCall' || e.name === 'EvaluateScript' || e.name === 'EventDispatch' || e.name === 'TimerFire') && e.ph === 'X' && onMain(e));
  const culprit = (task) => {
    const inside = calls.filter((c) => c.ts >= task.ts && c.ts + (c.dur ?? 0) <= task.ts + task.dur && c.name !== 'EventDispatch');
    const top = inside.sort((a, b) => b.dur - a.dur)[0];
    if (!top) {
      const ev = calls.find((c) => c.name === 'EventDispatch' && c.ts >= task.ts && c.ts <= task.ts + task.dur);
      return ev ? `event ${ev.args?.data?.type}` : null;
    }
    const d = top.args?.data ?? {};
    return [d.functionName || top.name, d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : null].filter(Boolean).join(' ');
  };
  const frames = asyncPairs(events, 'AnimationFrame', main.pid).filter((p) => p.dur >= LONG_TASK_MS * 1000).sort((a, b) => b.dur - a.dur);

  // --- risorse che bloccano il rendering ---
  const blocking = events
    .filter((e) => e.name === 'ResourceSendRequest' && e.args?.data?.renderBlocking === 'blocking')
    .map((e) => {
      const fin = events.find((f) => f.name === 'ResourceFinish' && f.args?.data?.requestId === e.args.data.requestId);
      return { url: e.args.data.url, type: e.args.data.resourceType ?? null, start_ms: rel(e.ts), finished_ms: fin ? rel(fin.ts) : null };
    });

  return {
    url: document?.url ?? main.url,
    navigation: Boolean(nav),
    window_ms: round(span / 1000),
    events: events.length,
    ...(document && { document }),
    fcp_ms: fcp ? rel(fcp.ts) : null,
    lcp,
    cls: {
      value: round(cls.value, 4),
      shifts: cls.shifts.length,
      worst: cls.windowShifts.sort((a, b) => (b.args.data.weighted_score_delta ?? 0) - (a.args.data.weighted_score_delta ?? 0)).slice(0, 3)
        .map((e) => ({ at_ms: rel(e.ts), score: round(e.args.data.weighted_score_delta ?? e.args.data.score, 4), nodes: (e.args.data.impacted_nodes ?? []).length })),
    },
    inp: inpEntry
      ? { ms: round(inpEntry.duration), event: inpEntry.type, interactions: interactions.length, input_delay_ms: round(inpEntry.processingStart - inpEntry.timeStamp), processing_ms: round(inpEntry.processingEnd - inpEntry.processingStart), presentation_delay_ms: round(inpEntry.timeStamp + inpEntry.duration - inpEntry.processingEnd) }
      : { ms: null, interactions: 0 },
    render_blocking: { count: blocking.length, resources: blocking.slice(0, 10) },
    long_tasks: {
      count: tasks.length,
      total_blocking_ms: round(tasks.reduce((s, t) => s + (t.dur / 1000 - LONG_TASK_MS), 0)),
      worst: tasks.slice(0, 5).map((t) => ({ at_ms: rel(t.ts), duration_ms: round(t.dur / 1000), culprit: culprit(t) })),
    },
    long_animation_frames: {
      count: frames.length,
      worst: frames.slice(0, 5).map((p) => ({ at_ms: rel(p.begin.ts), duration_ms: round(p.dur / 1000) })),
    },
  };
}
