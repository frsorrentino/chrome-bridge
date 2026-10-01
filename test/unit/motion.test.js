/**
 * lib/motion.js: la sintesi di animations e frames. Le funzioni pure si
 * provano su oggetti finti con la forma di Animation, LoAF, LayoutShift ed
 * Event Timing; il giro completo nella pagina lo copre l'e2e in launch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/motion.js';

const { describe, summarize, frameStats, shiftsSummary, interactionsSummary, loafEntry, shortEasing } = globalThis.__cbMotion._internals;

const el = (id) => ({ nodeType: 1, id, tagName: 'DIV', getAttribute: () => null, parentElement: null });

function fakeAnimation({ ctor = 'CSSAnimation', name, keyframes, timing = {}, pseudo = null, target = el('box'), playState = 'running', progress = 0.5, extra = {} }) {
  const C = { [ctor]: class {} }[ctor];
  const a = Object.assign(new C(), {
    playState,
    playbackRate: 1,
    timeline: null,
    effect: {
      target,
      pseudoElement: pseudo,
      getKeyframes: () => keyframes,
      getTiming: () => ({ duration: 300, delay: 0, endDelay: 0, iterations: 1, direction: 'normal', fill: 'auto', easing: 'linear', ...timing }),
      getComputedTiming: () => ({ progress }),
    },
    ...extra,
  });
  if (name) a.animationName = name;
  return a;
}

test('animazione CSS: la curva viene dai keyframe, le proprietà in kebab-case', () => {
  const a = fakeAnimation({
    name: 'slide',
    keyframes: [
      { offset: 0, easing: 'cubic-bezier(0.2, 0, 0, 1)', transform: 'translateY(8px)', opacity: '0' },
      { offset: 1, easing: 'cubic-bezier(0.2, 0, 0, 1)', transform: 'none', opacity: '1' },
    ],
  });
  const d = describe(a);
  assert.equal(d.kind, 'CSSAnimation');
  assert.equal(d.name, 'slide');
  assert.equal(d.selector, '#box');
  assert.deepEqual(d.properties, ['transform', 'opacity']);
  assert.equal(d.easing, 'cubic-bezier(0.2, 0, 0, 1)');
  assert.equal(d.composited_estimate, true);
  assert.equal(d.fade_only, false);
  assert.equal(d.duration_ms, 300);
});

test('transizione: proprietà dal nome, curva dalla timing, layout non composto', () => {
  const a = fakeAnimation({
    ctor: 'CSSTransition',
    keyframes: [{ offset: 0, easing: 'linear', backgroundColor: 'red' }, { offset: 1, easing: 'linear', backgroundColor: 'blue' }],
    timing: { easing: 'ease-out', duration: 150 },
    extra: { transitionProperty: 'background-color' },
  });
  const d = describe(a);
  assert.equal(d.kind, 'CSSTransition');
  assert.equal(d.name, 'background-color');
  assert.deepEqual(d.properties, ['background-color']);
  assert.equal(d.easing, 'ease-out');
  assert.equal(d.composited_estimate, false);
});

test('dissolvenza e View Transition riconosciute; iterazioni infinite in chiaro', () => {
  const fade = describe(fakeAnimation({ ctor: 'Animation', keyframes: [{ offset: 0, opacity: '0' }, { offset: 1, opacity: '1' }], timing: { iterations: Infinity } }));
  assert.equal(fade.fade_only, true);
  assert.equal(fade.iterations, 'infinite');
  const vt = describe(fakeAnimation({ keyframes: [{ offset: 0, opacity: '1' }], pseudo: '::view-transition-old(root)', target: { nodeType: 1, tagName: 'HTML', id: '', getAttribute: () => null, parentElement: null } }));
  assert.equal(vt.view_transition, true);
  assert.equal(vt.pseudo, '::view-transition-old(root)');
});

test('linear() lunga: tagliata, con il numero di punti', () => {
  const pts = Array.from({ length: 60 }, (_, i) => (i / 59).toFixed(4)).join(', ');
  const s = shortEasing(`linear(${pts})`);
  assert.ok(s.length < 240);
  assert.match(s, /\(60 points\)$/);
  assert.equal(shortEasing('ease'), 'ease');
});

test('sintesi: conteggi per tipo, infinite, non composte, curve distinte', () => {
  const list = [
    describe(fakeAnimation({ name: 'a', keyframes: [{ offset: 0, easing: 'ease', transform: 'none' }], timing: { iterations: Infinity, duration: 1000 } })),
    describe(fakeAnimation({ ctor: 'CSSTransition', keyframes: [{ offset: 0, width: '1px' }], timing: { easing: 'ease', duration: 200 }, extra: { transitionProperty: 'width' } })),
  ];
  const s = summarize(list);
  assert.equal(s.count, 2);
  assert.deepEqual(s.by_kind, { CSSAnimation: 1, CSSTransition: 1 });
  assert.equal(s.infinite, 1);
  assert.equal(s.max_duration_ms, 1000);
  assert.equal(s.not_composited_estimate, 1);
  assert.deepEqual(s.easings, ['ease']);
});

test('ritmo dei fotogrammi: fps, frequenza stimata, fotogrammi persi', () => {
  const t = [0, 16.7, 33.4, 50.1, 100.2, 116.9, 133.6];
  const f = frameStats(t);
  assert.equal(f.refresh_estimate_hz, 60);
  assert.equal(f.max_gap_ms, 50);
  assert.equal(f.dropped_estimate, 2);
  assert.ok(frameStats([0, 16]).note);
});

test('layout shift: esclusi quelli dopo un input, sorgenti con lo spostamento', () => {
  const s = shiftsSummary([
    { value: 0.12, hadRecentInput: false, sources: [{ node: el('hero'), previousRect: { x: 0, y: 0 }, currentRect: { x: 0, y: 40 } }] },
    { value: 0.3, hadRecentInput: true, sources: [] },
  ]);
  assert.equal(s.cls, 0.12);
  assert.equal(s.count, 1);
  assert.equal(s.after_input_excluded, 1);
  assert.deepEqual(s.top[0].sources[0], { selector: '#hero', moved_px: { x: 0, y: 40 } });
});

test('INP: la più lunga per interactionId, fasi sull insieme delle voci', () => {
  const ev = (interactionId, name, startTime, processingStart, processingEnd, duration, target = el('btn')) => ({ interactionId, name, startTime, processingStart, processingEnd, duration, target });
  const s = interactionsSummary([
    ev(1, 'pointerdown', 100, 102, 104, 96),
    ev(1, 'pointerup', 110, 111, 111, 96, null),
    ev(1, 'click', 112, 113, 180, 88),
    ev(0, 'mousemove', 300, 301, 302, 16),
    ev(2, 'keydown', 500, 502, 510, 40),
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.inp_ms, 96);
  assert.deepEqual(s.worst, {
    event: 'click', events: ['pointerdown', 'pointerup', 'click'], selector: '#btn',
    input_delay_ms: 2, processing_ms: 78, presentation_delay_ms: 16,
  });
  const none = interactionsSummary([]);
  assert.equal(none.inp_ms, null);
  assert.match(none.note, /trusted/);
});

test('Long Animation Frame: fasi relative all inizio, i tre script più lunghi', () => {
  const e = loafEntry({
    startTime: 1000, duration: 120, blockingDuration: 70, renderStart: 1090, styleAndLayoutStart: 1100,
    scripts: [
      { invoker: 'BUTTON#go.onclick', invokerType: 'event-listener', sourceURL: 'https://x/app.js', sourceFunctionName: 'go', sourceCharPosition: 120, duration: 80, forcedStyleAndLayoutDuration: 12 },
      { invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback', sourceURL: '', sourceFunctionName: '', sourceCharPosition: -1, duration: 5 },
    ],
  });
  assert.equal(e.render_start_ms, 90);
  assert.equal(e.style_layout_start_ms, 100);
  assert.equal(e.scripts[0].source, 'https://x/app.js go:120');
  assert.equal(e.scripts[0].forced_layout_ms, 12);
  assert.equal(e.scripts.length, 2);
});
