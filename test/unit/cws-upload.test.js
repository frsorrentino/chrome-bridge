/**
 * L'API del Web Store risponde HTTP 200 anche quando il caricamento è fallito:
 * l'esito vero sta in `uploadState`, e il motivo in `itemError`. Trattare il 200
 * come successo significa credere di aver pubblicato senza averlo fatto — che
 * è il modo peggiore di sbagliare una pubblicazione.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretUpload, interpretPublish, requireFields } from '../../tools/cws-upload.mjs';

test('un 200 con uploadState FAILURE non è un successo', () => {
  const r = interpretUpload({
    uploadState: 'FAILURE',
    itemError: [{ error_detail: 'Version number is the same as the published one' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /Version number/);
});

test('uploadState SUCCESS è un successo', () => {
  assert.equal(interpretUpload({ uploadState: 'SUCCESS' }).ok, true);
});

test('una risposta senza uploadState non viene scambiata per un successo', () => {
  const r = interpretUpload({});
  assert.equal(r.ok, false);
  assert.equal(r.state, 'UNKNOWN');
});

test('publish accetta OK e il caso con avvertimento, non altro', () => {
  assert.equal(interpretPublish({ status: ['OK'] }).ok, true);
  assert.equal(interpretPublish({ status: ['PUBLISHED_WITH_FRICTION_WARNING'] }).ok, true);
  assert.equal(interpretPublish({ status: ['ITEM_NOT_UPDATABLE'] }).ok, false);
});

test('le credenziali mancanti sono nominate una per una', () => {
  assert.throws(
    () => requireFields({ client_id: 'x' }, ['client_id', 'client_secret', 'refresh_token']),
    /client_secret, refresh_token/,
  );
});
