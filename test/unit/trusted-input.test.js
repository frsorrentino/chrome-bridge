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
