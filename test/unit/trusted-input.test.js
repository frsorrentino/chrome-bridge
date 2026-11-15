/**
 * Input fidato: i parametri CDP devono produrre gli effetti di default del
 * browser (Enter invia, Ctrl+A seleziona invece di scrivere «a»), e un click
 * fidato è la sequenza mouseMoved → pressed → released per ogni clickCount.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyEvents, modifierMask, mouseClickEvents } from '../../extension/lib/trusted-input.js';

test('modificatori: bitmask di CDP', () => {
  assert.equal(modifierMask({}), 0);
  assert.equal(modifierMask({ alt: true, ctrl: true, meta: true, shift: true }), 15);
  assert.equal(modifierMask({ shift: true }), 8);
});

test('Enter: keyDown con testo \\r e keyCode 13, così il form si invia', () => {
  const [down, up] = keyEvents('Enter');
  assert.equal(down.type, 'keyDown');
  assert.equal(down.text, '\r');
  assert.equal(down.windowsVirtualKeyCode, 13);
  assert.equal(up.type, 'keyUp');
});

test('Ctrl+A non scrive «a»: rawKeyDown senza testo', () => {
  const [down] = keyEvents('a', { ctrl: true });
  assert.equal(down.type, 'rawKeyDown');
  assert.equal(down.text, undefined);
  assert.equal(down.code, 'KeyA');
  assert.equal(down.modifiers, 2);
});

test('Shift+a scrive ancora: Shift non toglie il testo', () => {
  const [down] = keyEvents('A', { shift: true });
  assert.equal(down.type, 'keyDown');
  assert.equal(down.text, 'A');
});

test('frecce e Escape: nessun testo', () => {
  for (const k of ['ArrowDown', 'Escape', 'Tab']) assert.equal(keyEvents(k)[0].text, undefined, k);
  assert.equal(keyEvents('ArrowDown')[0].windowsVirtualKeyCode, 40);
});

test('click fidato: moved, poi pressed/released per ogni click', () => {
  const ev = mouseClickEvents(10, 20, { count: 2 });
  assert.deepEqual(ev.map((e) => `${e.type}${e.clickCount ?? ''}`), ['mouseMoved', 'mousePressed1', 'mouseReleased1', 'mousePressed2', 'mouseReleased2']);
  assert.ok(ev.every((e) => e.x === 10 && e.y === 20));
});

// Nota observe chrome-bridg-8f18b944 e sorelle (13 casi su click, hover,
// type_text, press_key, emulate_media, 1.32.1): Chrome rifiuta l'aggancio del
// debugger a una scheda che contiene un frame di un'altra estensione (password
// manager, traduttore), e il messaggio grezzo non dice né la causa né il
// rimedio: un agente ha riprovato 7 volte lo stesso click.
test('aggancio rifiutato per il frame di un\'altra estensione: causa, estensione e rimedio', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = {
    runtime: { id: 'selfselfselfself' },
    debugger: {
      attach: async () => { throw new Error('Cannot access a chrome-extension:// URL of different extension'); },
      detach: async () => {},
      sendCommand: async () => ({}),
      onDetach: { addListener() {} },
    },
    webNavigation: {
      getAllFrames: async () => [
        { frameId: 0, url: 'https://example.com/' },
        { frameId: 7, url: 'chrome-extension://otherextotherext/inline.html' },
        { frameId: 8, url: 'chrome-extension://selfselfselfself/overlay.html' },
      ],
    },
  };
  try {
    const { withDebugger, holdDebugger } = await import('../../extension/lib/trusted-input.js');
    let ran = false;
    await assert.rejects(withDebugger(1, async () => { ran = true; }), (e) => {
      assert.match(e.message, /^trusted input unavailable: /);
      assert.match(e.message, /another extension/);
      assert.match(e.message, /otherextotherext/);
      assert.doesNotMatch(e.message, /selfselfselfself/);
      assert.match(e.message, /without trusted/);
      assert.match(e.message, /retrying .*will not help|retry.*same.*fail/i);
      return true;
    });
    assert.equal(ran, false);
    await assert.rejects(holdDebugger(2, 'emulation', 'emulate_media via debugger'), /^Error: emulate_media via debugger unavailable: another extension/);
    // getAllFrames che fallisce: la causa e il rimedio restano, senza id
    globalThis.chrome.webNavigation.getAllFrames = async () => { throw new Error('No tab with id: 1'); };
    await assert.rejects(withDebugger(1, async () => {}), /another extension .*without trusted/s);
  } finally {
    globalThis.chrome = prev;
  }
});
