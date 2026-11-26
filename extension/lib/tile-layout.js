/**
 * Divide un'area rettangolare in `count` tessere che la riempiono per intero.
 *
 * Funzione pura, tenuta fuori dal service worker perché è l'unica parte con una
 * geometria da sbagliare: il resto del tool è una sequenza di
 * chrome.windows.update.
 *
 * Sul resto della divisione intera: 3 finestre su 1000px fanno 333 e avanza 1.
 * Buttarlo lascia una striscia di scrivania scoperta, che è esattamente ciò che
 * l'affiancamento dovrebbe eliminare. Qui il resto viene distribuito un pixel
 * per volta sulle prime tessere: le larghezze differiscono al massimo di 1px e
 * lo spazio resta pieno.
 */

// Ripartisce `total` in `parts` interi che sommano esattamente a `total`.
function split(total, parts) {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

// Righe e colonne per una griglia il più quadrata possibile: con 5 finestre
// preferisce 3×2 a 5×1, che su uno schermo largo lascerebbe strisce inutilizzabili.
function gridShape(count) {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

export function computeTiles({ count, area, layout = 'grid', padding = 0 }) {
  if (!count || count < 1) return [];

  const box = {
    left: area.left + padding,
    top: area.top + padding,
    width: area.width - padding * 2,
    height: area.height - padding * 2,
  };

  let rows;
  let colsPerRow;
  if (layout === 'columns') {
    rows = 1;
    colsPerRow = [count];
  } else if (layout === 'rows') {
    rows = count;
    colsPerRow = Array.from({ length: count }, () => 1);
  } else {
    const shape = gridShape(count);
    rows = shape.rows;
    // L'ultima riga può essere incompleta: le sue tessere si allargano a
    // riempirla invece di lasciare un buco a destra.
    colsPerRow = Array.from({ length: rows }, (_, r) => {
      const remaining = count - r * shape.cols;
      return Math.min(shape.cols, remaining);
    });
  }

  const rowHeights = split(box.height, rows);
  const tiles = [];
  let top = box.top;

  for (let r = 0; r < rows; r++) {
    const cols = colsPerRow[r];
    const colWidths = split(box.width, cols);
    let left = box.left;
    for (let c = 0; c < cols; c++) {
      tiles.push({ left, top, width: colWidths[c], height: rowHeights[r] });
      left += colWidths[c];
    }
    top += rowHeights[r];
  }

  return tiles;
}
