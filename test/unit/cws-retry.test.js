/**
 * Un ritentativo periodico deve distinguere due fallimenti che l'API dello store
 * riporta allo stesso modo:
 *
 * - **bloccato**: c'è una versione in revisione, non si può fare nulla e si
 *   riprova più tardi. Non è un errore: se lo trattiamo come tale, ogni sei ore
 *   parte una notifica rossa per una situazione normale, e in due giorni nessuno
 *   guarda più le notifiche.
 * - **rotto**: credenziali scadute, zip rifiutato, versione duplicata. Qui il
 *   silenzio è il danno.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../../tools/cws-upload.mjs';

test('l\'item in revisione è un\'attesa, non un errore', () => {
  assert.equal(
    classifyFailure(['The item cannot be updated now because it is in pending review, ready to publish, or deleted status.']),
    'locked',
  );
  assert.equal(classifyFailure(['You may not edit or publish an item that is in review.']), 'locked');
});

test('una versione già pubblicata è un\'attesa: il tag corrente è già sullo store', () => {
  assert.equal(classifyFailure(['Version number is the same as the published one']), 'locked');
});

test('tutto il resto è un errore che va visto', () => {
  assert.equal(classifyFailure(['Invalid manifest: missing required key']), 'error');
  assert.equal(classifyFailure(['invalid_grant']), 'error');
  assert.equal(classifyFailure([]), 'error');
});
