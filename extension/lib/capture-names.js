/**
 * Il nome di un file intercettato da capture_downloads, prima della pulizia
 * del server (server/capture.js, che decide il nome sul disco).
 *
 * Ordine: filename* di Content-Disposition (RFC 5987, UTF-8 percent-encoded),
 * filename, il nome che Chrome aveva già scelto, l'ultimo segmento dell'URL.
 */
export function dispositionName(header) {
  const h = String(header || '');
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(h);
  if (star) {
    try { return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')); } catch {}
  }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(h);
  if (plain) return (plain[2] != null ? plain[2].replace(/\\(.)/g, '$1') : plain[1]).trim();
  return '';
}

export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

export function downloadName({ disposition, chromeName, url }) {
  return dispositionName(disposition) || String(chromeName || '').split(/[\\/]/).pop() || nameFromUrl(url) || '';
}
