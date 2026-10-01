/**
 * screencast: dai JPEG con il loro tempo a un video, con ffmpeg.
 *
 * Chrome manda un fotogramma solo quando la pagina cambia: un video a fps
 * fisso rallenterebbe o accelererebbe le animazioni. Il concat demuxer di
 * ffmpeg riceve per ogni fotogramma la sua durata vera (tempo fino al
 * successivo), poi -fps_mode cfr lo porta a fps costante per i lettori.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Testo per il concat demuxer: file e durata di ogni fotogramma, in secondi. */
export function concatList(frames, endTime) {
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(endTime ?? f.t, f.t + 0.04);
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  // Il concat demuxer ignora la durata dell'ultima voce se il file non è
  // ripetuto: si ripete l'ultimo fotogramma.
  if (frames.length) lines.push(`file '${frames[frames.length - 1].file}'`);
  return lines.join('\n') + '\n';
}

/** Argomenti di ffmpeg per il formato scelto; le dimensioni pari le vogliono x264 e vp9. */
export function ffmpegArgs(listPath, out, { format = 'mp4', fps = 30 } = {}) {
  const codec = format === 'webm'
    ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-row-mt', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  return ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-fps_mode', 'cfr', '-r', String(fps), ...codec, out];
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let err = '';
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { resolve({ code: -1, err: e.message }); return; }
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, err: e.message, missing: e.code === 'ENOENT' }));
    p.on('close', (code) => resolve({ code, err }));
  });
}

/**
 * Monta il video. Senza ffmpeg restituisce la cartella e il comando da
 * lanciare a mano, invece di fallire: i fotogrammi restano utili.
 */
export async function assembleVideo(dir, frames, endTime, out, opts = {}) {
  const listPath = join(dir, 'frames.ffconcat');
  await writeFile(listPath, concatList(frames, endTime));
  const args = ffmpegArgs(listPath, out, opts);
  const command = `ffmpeg ${args.map((a) => (/[\s'*()]/.test(a) ? `"${a}"` : a)).join(' ')}`;
  const r = await run(process.env.CHROME_BRIDGE_FFMPEG || 'ffmpeg', args);
  if (r.code === 0) return { video: out };
  return { video: null, frames_dir: dir, command, error: r.missing ? 'ffmpeg not found: install it, or run the command yourself' : (r.err || '').trim().slice(-300) };
}
