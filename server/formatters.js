/**
 * Formatter riga-per-riga condivisi tra tool MCP (tools.js) e CLI (cli.js).
 * Un'unica fonte: stesso output sui due canali, niente divergenza.
 */

/** Messaggi console: "level<TAB>+Δms<TAB>testo", delta relativo al primo mostrato. */
export function consoleLines(tail, total) {
  const t0 = tail[0]?.timestamp ?? 0;
  const lines = tail.map((m) => `${m.level}\t+${(m.timestamp ?? t0) - t0}ms\t${(m.args ?? []).join(' ')}`);
  return `console total=${total} shown=${tail.length}\n${lines.join('\n')}`;
}

/** Richieste di rete: "status<TAB>ms<TAB>method<TAB>url", errori come ERR(msg). */
export function networkLines(tail, total) {
  const lines = tail.map((r) => `${r.status ?? `ERR(${r.error})`}\t${r.duration}ms\t${r.method}\t${r.url}`);
  return `network total=${total} shown=${tail.length}\n${lines.join('\n')}`;
}

/** Elementi interattivi: flag (disabled/hidden/occluded) solo quando anomali. */
export function interactivesLines(data) {
  const els = data?.elements ?? [];
  const lines = els.map((e) => {
    const flags = [!e.enabled && 'disabled', !e.visible && 'hidden', e.occluded && 'occluded'].filter(Boolean).join(',');
    const rect = e.rect ? `@${e.rect.x},${e.rect.y} ${e.rect.width}x${e.rect.height}` : '';
    return [`${e.selector}`, `${e.tag}${e.type ? `:${e.type}` : ''}`, e.text ?? '', ...(flags ? [flags] : []), rect].join('\t');
  });
  const note = data?.note ? ` note=${data.note}` : '';
  return `interactives count=${data?.count ?? els.length}${note}\n${lines.join('\n')}`;
}

/** Esito verifica link: "status<TAB>url<TAB>error". */
export function linksLines(results, { total, broken, anchors }) {
  const lines = results.map((r) => `${r.status}\t${r.url}${r.error ? `\t${r.error}` : ''}`);
  return `links total=${total} checked=${results.length} broken=${broken} anchors=${anchors}\n${lines.join('\n')}`;
}
