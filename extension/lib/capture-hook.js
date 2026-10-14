/**
 * capture_downloads, lato pagina: i file che la pagina costruisce da sé
 * arrivano al server senza passare dal download di Chrome.
 *
 * Il problema (14/10/2026): un click su «Esporta» apre la finestra di sistema
 * «Salva con nome», che nessun tool può premere; su ChromeOS con «Chiedi dove
 * salvare ciascun file» si apre anche con saveAs:false. Qui il file viene preso
 * prima che diventi un download:
 * - a[download] con href blob: o data:, cliccato davvero o con a.click() su un
 *   elemento staccato dal DOM (il caso più comune: createElement, click, revoke);
 * - window.showSaveFilePicker: un handle finto raccoglie le scritture e alla
 *   close consegna il file;
 * - URL.createObjectURL tiene un riferimento al Blob mentre la cattura è armata,
 *   così un revokeObjectURL subito dopo il click non lo perde.
 *
 * I file restano nella pagina (window.__cbCapture.items) finché il server li
 * legge a pezzi e li butta. Disarmata, la pagina si comporta come senza hook.
 *
 * Non è un modulo ES: si inietta con files: in MAIN world (come element-label.js).
 */
(() => {
  if (window.__cbCapture) return;
  const st = {
    armed: false,
    max: 0,
    items: [],
    blobs: new Map(),
    seq: 0,
  };
  Object.defineProperty(window, '__cbCapture', { value: st, configurable: true });

  const newId = () => `c${Date.now().toString(36)}${(st.seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function add(blob, name, source) {
    const item = { id: newId(), name: String(name || ''), mime: blob.type || '', size: blob.size, source };
    if (blob.size > st.max) item.error = `too large: ${blob.size} bytes, max_mb allows ${st.max}`;
    else item.blob = blob;
    st.items.push(item);
    return item;
  }

  // Un file preso da un URL (blob:, data:) è asincrono: l'item c'è subito,
  // pending, così l'attesa del server lo vede e non chiude prima del tempo.
  async function fromUrl(url, name, source) {
    const item = { id: newId(), name: String(name || ''), source, pending: true };
    st.items.push(item);
    try {
      const blob = st.blobs.get(url) ?? await (await fetch(url)).blob();
      item.mime = blob.type || '';
      item.size = blob.size;
      if (blob.size > st.max) item.error = `too large: ${blob.size} bytes, max_mb allows ${st.max}`;
      else item.blob = blob;
    } catch (e) {
      item.error = `could not read ${url.slice(0, 60)}: ${e.message}`;
    }
    delete item.pending;
    return item;
  }
  st.fromUrl = fromUrl;

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function createObjectURL(obj) {
    const url = origCreate.call(URL, obj);
    if (st.armed && obj instanceof Blob) st.blobs.set(url, obj);
    return url;
  };

  const capturable = (a) => a instanceof HTMLAnchorElement && a.hasAttribute('download') && /^(blob|data):/i.test(a.href || '');
  const take = (a) => fromUrl(a.href, a.getAttribute('download') || '', a.href.startsWith('data:') ? 'data_url' : 'blob');

  // Click veri o sintetici su un'ancora nel documento: bolla fino a window.
  // Se la pagina ha già annullato il click, il download non era voluto.
  const handled = new WeakSet();
  window.addEventListener('click', (e) => {
    if (!st.armed || e.defaultPrevented || handled.has(e)) return;
    const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement);
    if (!capturable(a)) return;
    handled.add(e);
    e.preventDefault();
    take(a);
  });

  // a.click() su un'ancora staccata: l'evento non arriva a window. Lo si
  // spedisce qui, così i listener della pagina girano comunque. Anche un click
  // sintetico attiva l'ancora (verificato 14/10: blob preso due volte, una
  // dall'hook e una dal download): un listener sull'ancora, aggiunto dopo
  // quelli della pagina, annulla l'azione nativa se la pagina non l'ha fatto.
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click() {
    if (!st.armed || !capturable(this)) return origClick.apply(this, arguments);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window });
    let wanted = false;
    const last = (e) => {
      if (e !== ev || e.defaultPrevented) return;
      wanted = true;
      handled.add(e);
      e.preventDefault();
    };
    this.addEventListener('click', last);
    try { this.dispatchEvent(ev); } finally { this.removeEventListener('click', last); }
    if (wanted) take(this);
  };

  // --- showSaveFilePicker ---
  const toBytes = async (d) => {
    if (typeof d === 'string') return new TextEncoder().encode(d);
    if (d instanceof Blob) return new Uint8Array(await d.arrayBuffer());
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    throw new TypeError('chrome-bridge capture: unsupported data for write()');
  };
  const isParams = (d) => d && typeof d === 'object' && !(d instanceof Blob) && !ArrayBuffer.isView(d) && !(d instanceof ArrayBuffer) && 'type' in d;

  function makeHandle(name, mime) {
    let committed = new Blob([], { type: mime });
    const handle = {
      kind: 'file',
      name,
      getFile: async () => new File([committed], name, { type: mime }),
      createWritable: async (opts = {}) => {
        let buf = new Uint8Array(0);
        let len = 0;
        let pos = 0;
        if (opts.keepExistingData) {
          buf = new Uint8Array(await committed.arrayBuffer());
          len = buf.length;
        }
        const ensure = (n) => {
          if (n > st.max) throw new DOMException(`chrome-bridge capture: ${name} over max_mb`, 'QuotaExceededError');
          if (n <= buf.length) return;
          const nb = new Uint8Array(Math.max(n, buf.length * 2, 64 * 1024));
          nb.set(buf.subarray(0, len));
          buf = nb;
        };
        const apply = async (d) => {
          if (isParams(d)) {
            if (d.type === 'seek') { pos = d.position; return; }
            if (d.type === 'truncate') {
              ensure(d.size);
              if (d.size > len) buf.fill(0, len, d.size);
              len = d.size;
              if (pos > len) pos = len;
              return;
            }
            if (d.position != null) pos = d.position;
            d = d.data;
          }
          const b = await toBytes(d);
          ensure(pos + b.length);
          buf.set(b, pos);
          pos += b.length;
          if (pos > len) len = pos;
        };
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          committed = new Blob([buf.slice(0, len)], { type: mime });
          add(committed, name, 'showSaveFilePicker');
        };
        const ws = new WritableStream({ write: (chunk) => apply(chunk), close: finish });
        // write/seek/truncate/close diretti, come FileSystemWritableFileStream;
        // pipeTo e getWriter passano dal sink qui sopra.
        Object.assign(ws, {
          write: (d) => apply(d),
          seek: async (p) => { pos = p; },
          truncate: async (size) => apply({ type: 'truncate', size }),
          close: async () => finish(),
        });
        try { if (window.FileSystemWritableFileStream) Object.setPrototypeOf(ws, FileSystemWritableFileStream.prototype); } catch {}
        return ws;
      },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      isSameEntry: async (other) => other === handle,
    };
    try { if (window.FileSystemFileHandle) Object.setPrototypeOf(handle, FileSystemFileHandle.prototype); } catch {}
    return handle;
  }

  const origPicker = window.showSaveFilePicker;
  if (typeof origPicker === 'function') {
    window.showSaveFilePicker = function showSaveFilePicker(opts = {}) {
      if (!st.armed) return origPicker.apply(this, arguments);
      const first = opts?.types?.[0]?.accept ?? {};
      const mime = Object.keys(first).find((m) => !m.includes('*')) || '';
      const ext = [].concat(Object.values(first)[0] ?? [])[0] || '';
      const name = opts?.suggestedName || `download${ext}`;
      return Promise.resolve(makeHandle(String(name), mime));
    };
  }

  // Dal service worker: elenco, lettura a pezzi, scarto.
  st.list = () => st.items.map(({ blob, ...meta }) => meta);
  st.read = async (id, offset, length) => {
    const it = st.items.find((x) => x.id === id);
    if (!it?.blob) throw new Error(`capture: no file ${id} in this page`);
    const part = new Uint8Array(await it.blob.slice(offset, offset + length).arrayBuffer());
    let s = '';
    for (let i = 0; i < part.length; i += 0x8000) s += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
    return btoa(s);
  };
  st.drop = (id) => { st.items = st.items.filter((x) => x.id !== id); };
  st.arm = (max) => { st.armed = true; st.max = max; };
  st.disarm = () => { st.armed = false; st.items = []; st.blobs.clear(); };
})();
