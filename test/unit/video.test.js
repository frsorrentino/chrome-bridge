/**
 * screencast: ogni fotogramma dura fino al successivo, così il video tiene i
 * tempi veri anche se Chrome manda fotogrammi solo quando la pagina cambia.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatList, ffmpegArgs } from '../../server/video.js';

test('durate dai tempi dei fotogrammi, ultimo fino alla fine, ultimo file ripetuto', () => {
  const list = concatList([{ file: 'a.jpg', t: 10 }, { file: 'b.jpg', t: 10.5 }, { file: 'c.jpg', t: 12 }], 13);
  assert.equal(list, "ffconcat version 1.0\nfile 'a.jpg'\nduration 0.5000\nfile 'b.jpg'\nduration 1.5000\nfile 'c.jpg'\nduration 1.0000\nfile 'c.jpg'\n");
});

test('fine prima dell ultimo fotogramma: durata minima, mai negativa', () => {
  assert.match(concatList([{ file: 'a.jpg', t: 10 }], 9), /duration 0\.0400/);
});

test('mp4 in H.264 yuv420p a fps costante, webm in VP9; dimensioni pari', () => {
  const mp4 = ffmpegArgs('l.txt', 'o.mp4', { fps: 30 });
  assert.ok(mp4.includes('libx264') && mp4.includes('yuv420p'));
  assert.deepEqual(mp4.slice(mp4.indexOf('-fps_mode'), mp4.indexOf('-fps_mode') + 4), ['-fps_mode', 'cfr', '-r', '30']);
  assert.ok(mp4.includes('scale=trunc(iw/2)*2:trunc(ih/2)*2'));
  assert.ok(ffmpegArgs('l.txt', 'o.webm', { format: 'webm' }).includes('libvpx-vp9'));
});
