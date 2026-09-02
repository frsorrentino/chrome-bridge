/**
 * `chrome-bridge fill_form --from file.csv --map '{"#name":"name"}' --each`:
 * la compilazione di un modulo lungo da dati strutturati, a zero token. Il
 * modello scrive la mappa una volta; le righe non passano mai dal contesto.
 */

/** CSV con intestazione: virgolette, virgola o punto e virgola, righe vuote ignorate. */
export function parseCsv(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === sep) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };
  const header = split(lines[0]);
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows;
}

/** {selector: column} → fields di fill_form per una riga; una colonna mancante è un errore, non un vuoto silenzioso. */
export function rowToFields(row, map) {
  const fields = [];
  for (const [selector, column] of Object.entries(map)) {
    if (!(column in row)) throw new Error(`Column "${column}" not in CSV (have: ${Object.keys(row).join(', ')})`);
    fields.push({ selector, value: String(row[column]) });
  }
  return fields;
}

/**
 * @param {(type:string, params:object)=>Promise<any>} send
 * @param {{rows:Array, map:object, url?:string, submit?:string, tab_id?:number, assert_text?:string, delay_ms?:number}} o
 */
export async function fillFromRows(send, { rows, map, url, submit, tab_id, assert_text, delay_ms = 0 }) {
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (url) { await send('navigate', { url, tab_id }); await send('wait_for_network_idle', { idle_ms: 500, timeout: 15000, tab_id }).catch(() => {}); }
      const fields = rowToFields(row, map);
      await send('fill_form', { fields, submit_selector: submit, tab_id });
      if (submit) await send('wait_for_network_idle', { idle_ms: 500, timeout: 15000, tab_id }).catch(() => {});
      let verdict = 'ok';
      if (assert_text) {
        const f = await send('find_text', { text: assert_text, max_results: 1, tab_id });
        verdict = f?.matches?.length ? 'ok' : `no "${assert_text}" on the page`;
      }
      results.push({ row: i + 1, verdict });
    } catch (err) {
      results.push({ row: i + 1, verdict: 'error', error: err.message });
    }
    if (delay_ms && i < rows.length - 1) await new Promise((r) => setTimeout(r, delay_ms));
  }
  return results;
}

export function fillLines(results) {
  const bad = results.filter((r) => r.verdict !== 'ok');
  return `fill_form rows=${results.length} ok=${results.length - bad.length} failed=${bad.length}\n${results.map((r) => `${r.row}\t${r.verdict}${r.error ? `\t${r.error}` : ''}`).join('\n')}`;
}
