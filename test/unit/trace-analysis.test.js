/**
 * trace-analysis: le conclusioni di perf_trace da eventi con la forma di
 * Chrome 154 (presa da un trace reale di bench/motion.html, 01/10/2026),
 * ridotti all'osso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrace, traceEventsOf } from '../../server/trace-analysis.js';

const PID = 10; const TID = 1; const NAV = 'NAV1'; const T0 = 1_000_000_000;
const at = (ms) => T0 + ms * 1000;

function trace({ image = false, shifts = [], interactions = [], tasks = [] } = {}) {
  const ev = [
    { name: 'TracingStartedInBrowser', ph: 'I', pid: 1, tid: 1, ts: T0 - 5000, args: { data: { frames: [{ frame: 'F', isOutermostMainFrame: true, processId: PID, url: 'https://a.it/' }] } } },
    { name: 'thread_name', ph: 'M', pid: PID, tid: TID, args: { name: 'CrRendererMain' } },
    { name: 'navigationStart', ph: 'R', pid: PID, tid: TID, ts: at(0), args: { frame: 'F', data: { documentLoaderURL: 'https://a.it/', isOutermostMainFrame: true, navigationId: NAV } } },
    { name: 'ResourceSendRequest', ph: 'I', pid: PID, tid: TID, ts: at(2), args: { data: { requestId: NAV, url: 'https://a.it/', resourceType: 'Document' } } },
    // requestTime in secondi sullo stesso orologio di ts: TTFB = 100 ms.
    { name: 'ResourceReceiveResponse', ph: 'I', pid: PID, tid: TID, ts: at(100), args: { data: { requestId: NAV, statusCode: 200, timing: { requestTime: (T0 / 1e6) + 0.002, receiveHeadersStart: 98 } } } },
    { name: 'ResourceFinish', ph: 'I', pid: PID, tid: TID, ts: at(120), args: { data: { requestId: NAV, finishTime: (T0 / 1e6) + 0.12, encodedDataLength: 5000 } } },
    { name: 'ResourceSendRequest', ph: 'I', pid: PID, tid: TID, ts: at(110), args: { data: { requestId: 'CSS', url: 'https://a.it/app.css', resourceType: 'Stylesheet', renderBlocking: 'blocking' } } },
    { name: 'ResourceFinish', ph: 'I', pid: PID, tid: TID, ts: at(300), args: { data: { requestId: 'CSS' } } },
    { name: 'firstContentfulPaint', ph: 'R', pid: PID, tid: TID, ts: at(350), args: { data: { navigationId: NAV } } },
  ];
  if (image) {
    ev.push(
      { name: 'ResourceSendRequest', ph: 'I', pid: PID, tid: TID, ts: at(400), args: { data: { requestId: 'IMG', url: 'https://a.it/hero.jpg', resourceType: 'Image' } } },
      { name: 'ResourceFinish', ph: 'I', pid: PID, tid: TID, ts: at(900), args: { data: { requestId: 'IMG', finishTime: (T0 / 1e6) + 0.9 } } },
      // Chrome 154: l'URL solo nel gemello LargestImagePaint::Candidate.
      { name: 'LargestImagePaint::Candidate', ph: 'R', pid: PID, tid: TID, ts: at(1000), args: { data: { DOMNodeId: 14, imageUrl: 'https://a.it/hero.jpg' } } },
      { name: 'largestContentfulPaint::Candidate', ph: 'R', pid: PID, tid: TID, ts: at(1000), args: { data: { candidateIndex: 2, nodeId: 14, navigationId: NAV, isOutermostMainFrame: true, type: 'image', nodeName: 'IMG', size: 90000, ...(image === 'timed' && { imageLoadStart: 450, imageLoadEnd: 880 }) } } },
    );
  }
  ev.push({ name: 'largestContentfulPaint::Candidate', ph: 'R', pid: PID, tid: TID, ts: at(350), args: { data: { candidateIndex: 1, navigationId: NAV, isOutermostMainFrame: true, type: 'text', nodeName: 'H1', size: 1000 } } });
  for (const [ms, score, recent = false] of shifts) {
    ev.push({ name: 'LayoutShift', ph: 'I', pid: PID, tid: TID, ts: at(ms), args: { frame: 'F', data: { is_main_frame: true, had_recent_input: recent, weighted_score_delta: score, impacted_nodes: [{}] } } });
  }
  interactions.forEach(([id, type, ms, dur, ps, pe], i) => {
    ev.push({ name: 'EventTiming', ph: 'b', id: `0x${i}`, pid: PID, tid: TID, ts: at(ms), args: { data: { interactionId: id, type, duration: dur, timeStamp: ms, processingStart: ps, processingEnd: pe } } });
    ev.push({ name: 'EventTiming', ph: 'e', id: `0x${i}`, pid: PID, tid: TID, ts: at(ms + dur), args: {} });
  });
  for (const [ms, dur, fn] of tasks) {
    ev.push({ name: 'RunTask', ph: 'X', pid: PID, tid: TID, ts: at(ms), dur: dur * 1000 });
    if (fn) ev.push({ name: 'FunctionCall', ph: 'X', pid: PID, tid: TID, ts: at(ms + 1), dur: (dur - 2) * 1000, args: { data: { functionName: fn, url: 'https://a.it/app.js', lineNumber: 9 } } });
    ev.push({ name: 'AnimationFrame', ph: 'b', id: ms, pid: PID, tid: TID, ts: at(ms) }, { name: 'AnimationFrame', ph: 'e', id: ms, pid: PID, tid: TID, ts: at(ms + dur + 5) });
  }
  return { traceEvents: ev, metadata: {} };
}

test('documento, FCP e LCP di testo: TTFB e ritardo di rendering', () => {
  const r = analyzeTrace(trace());
  assert.equal(r.navigation, true);
  assert.deepEqual(r.document, { url: 'https://a.it/', status: 200, ttfb_ms: 100, finished_ms: 120, bytes: 5000 });
  assert.equal(r.fcp_ms, 350);
  assert.deepEqual(r.lcp, { ms: 350, type: 'text', element: 'H1', size: 1000, phases: { ttfb_ms: 100, render_delay_ms: 250 } });
  assert.deepEqual(r.render_blocking.resources, [{ url: 'https://a.it/app.css', type: 'Stylesheet', start_ms: 110, finished_ms: 300 }]);
});

test('LCP immagine: le quattro fasi di DevTools', () => {
  const r = analyzeTrace(trace({ image: true }));
  assert.equal(r.lcp.ms, 1000);
  assert.equal(r.lcp.url, 'https://a.it/hero.jpg');
  assert.deepEqual(r.lcp.phases, { ttfb_ms: 100, load_delay_ms: 300, load_duration_ms: 500, render_delay_ms: 100 });
  const timed = analyzeTrace(trace({ image: 'timed' }));
  assert.deepEqual(timed.lcp.phases, { ttfb_ms: 100, load_delay_ms: 350, load_duration_ms: 430, render_delay_ms: 120 }, 'imageLoadStart/End del candidato prevalgono');
});

test('CLS a finestre di sessione; gli shift dopo un input non contano', () => {
  const r = analyzeTrace(trace({ shifts: [[1000, 0.05], [1500, 0.05], [4000, 0.08], [4100, 0.5, true]] }));
  assert.equal(r.cls.value, 0.1, 'la prima finestra (0,05 + 0,05) vale più della seconda (0,08)');
  assert.equal(r.cls.shifts, 3);
});

test('INP: interazione più lunga, con le tre fasi', () => {
  const r = analyzeTrace(trace({ interactions: [[7, 'pointerdown', 2000, 40, 2002, 2010], [7, 'click', 2001, 120, 2003, 2100], [9, 'keydown', 3000, 56, 3001, 3020]] }));
  assert.deepEqual(r.inp, { ms: 120, event: 'click', interactions: 2, input_delay_ms: 2, processing_ms: 97, presentation_delay_ms: 21 });
});

test('compiti lunghi con la funzione responsabile, fotogrammi lunghi', () => {
  const r = analyzeTrace(trace({ tasks: [[2000, 200, 'busyHandler'], [2500, 30], [3000, 80]] }));
  assert.equal(r.long_tasks.count, 2);
  assert.equal(r.long_tasks.total_blocking_ms, 180);
  assert.deepEqual(r.long_tasks.worst[0], { at_ms: 2000, duration_ms: 200, culprit: 'busyHandler https://a.it/app.js:10' });
  assert.equal(r.long_animation_frames.count, 2);
});

test('array nudo accettato, oggetto sbagliato rifiutato', () => {
  assert.equal(traceEventsOf([{ name: 'x' }]).length, 1);
  assert.throws(() => traceEventsOf({ foo: 1 }), /Not a Chrome trace/);
});
