/**
 * Iniettato a document_start in MAIN world: legge e chiama gli strumenti
 * WebMCP che la pagina dichiara, e ne tiene il registro delle chiamate.
 *
 * WebMCP (W3C Web Machine Learning CG): la pagina registra strumenti con
 * document.modelContext.registerTool (imperativi) o li dichiara con
 * <form toolname> (dichiarativi). Senza il flag
 * chrome://flags/#enable-webmcp-testing o l'origin trial document.modelContext
 * non esiste: i form dichiarativi restano visibili ma inerti.
 *
 * Il gancio non crea mai document.modelContext: un sito che fa feature
 * detection deve vedere il browser com'è. Avvolge registerTool dove esiste
 * (nativo a document_start, o un polyfill alla prima lettura), così anche le
 * chiamate dell'agente del browser finiscono nel registro.
 */
(() => {
  if (window.__cbWebmcp) return;

  const MAX_CALLS = 100;
  const CLIP = 2000;
  const calls = [];
  const regs = new Map();          // name → { annotations, execute } dalle registerTool viste
  const patched = new WeakMap();    // modelContext → executeTool originale
  const pending = new Map();       // name → voci di registro di chiamate già aperte e in corso
  let toolchanges = 0;

  const mcOf = () => document.modelContext ?? navigator.modelContext ?? null;

  const clip = (v) => {
    if (v === undefined) return null;
    let s;
    try { s = JSON.stringify(v); } catch { s = String(v); }
    if (s === undefined) return null;
    if (s.length <= CLIP) { try { return JSON.parse(s); } catch { return s; } }
    return `${s.slice(0, CLIP)}…[+${s.length - CLIP} chars]`;
  };

  const record = (entry) => {
    if (calls.length >= MAX_CALLS) calls.shift();
    calls.push(entry);
    return entry;
  };

  // Una chiamata già aperta (da call o da executeTool) passa anche dal
  // wrapper di execute o dal listener di submit: una sola voce, col chiamante
  // giusto.
  const open = (entry) => {
    if (!pending.has(entry.tool)) pending.set(entry.tool, []);
    pending.get(entry.tool).push(entry);
  };
  const close = (entry) => {
    const q = pending.get(entry.tool);
    const i = q ? q.indexOf(entry) : -1;
    if (i >= 0) q.splice(i, 1);
  };
  const takePending = (name) => pending.get(name)?.shift() ?? null;

  const settle = (entry, t0, out, err) => Object.assign(entry, err === undefined
    ? { status: 'ok', output: clip(out), ms: Math.round(performance.now() - t0) }
    : { status: err?.timeout ? 'timeout' : 'error', error: String(err?.message ?? err), ms: Math.round(performance.now() - t0) });

  const patch = (mc) => {
    if (!mc || patched.has(mc) || typeof mc.registerTool !== 'function') return;
    const origExecute = typeof mc.executeTool === 'function' ? mc.executeTool : null;
    patched.set(mc, origExecute);
    try { mc.addEventListener?.('toolchange', () => { toolchanges += 1; }); } catch {}
    // executeTool chiamato dalla pagina o da un altro agente: si registra anche
    // per gli strumenti registrati prima del gancio (un polyfill).
    if (origExecute) {
      mc.executeTool = async function (tool, input, ...rest) {
        const name = String(tool?.name);
        const isForm = declaredForms().some((f) => f.getAttribute('toolname') === name);
        const e = record({ at: Date.now(), tool: name, kind: isForm ? 'declarative' : 'imperative', caller: 'other', input: clip(input), status: 'running' });
        open(e);
        const t0 = performance.now();
        try {
          const out = await origExecute.call(this, tool, input, ...rest);
          settle(e, t0, out);
          return out;
        } catch (err) {
          settle(e, t0, undefined, err);
          throw err;
        } finally { close(e); }
      };
    }
    const orig = mc.registerTool;
    mc.registerTool = function (tool, opts) {
      try {
        if (tool && typeof tool.execute === 'function' && tool.name) {
          const exec = tool.execute;
          const name = String(tool.name);
          const wrapped = async function (input, ...rest) {
            if (takePending(name)) return exec.call(this, input, ...rest);
            const e = record({ at: Date.now(), tool: name, kind: 'imperative', caller: 'other', input: clip(input), status: 'running' });
            const t0 = performance.now();
            try {
              const out = await exec.call(this, input, ...rest);
              settle(e, t0, out);
              return out;
            } catch (err) {
              settle(e, t0, undefined, err);
              throw err;
            }
          };
          regs.set(name, { annotations: tool.annotations ?? null, execute: exec });
          opts?.signal?.addEventListener?.('abort', () => regs.delete(name));
          return orig.call(this, { ...tool, execute: wrapped }, opts);
        }
      } catch {}
      return orig.call(this, tool, opts);
    };
  };
  patch(mcOf());

  // --- strumenti dichiarativi: <form toolname> ---
  const fieldSchema = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const s = {};
    if (el.tagName === 'SELECT') {
      s.type = 'string';
      s.enum = [...el.options].map((o) => o.value);
    } else if (type === 'number' || type === 'range') s.type = 'number';
    else if (type === 'checkbox') s.type = 'boolean';
    else s.type = 'string';
    const d = el.getAttribute('toolparamdescription');
    if (d) s.description = d;
    return s;
  };

  const formSchema = (form) => {
    const properties = {};
    const required = [];
    for (const el of form.elements) {
      const name = el.name;
      if (!name || el.disabled) continue;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['submit', 'button', 'reset', 'image', 'hidden'].includes(type) || el.tagName === 'BUTTON' || el.tagName === 'FIELDSET') continue;
      if (type === 'radio') {
        const p = (properties[name] ??= { type: 'string', enum: [] });
        p.enum.push(el.value);
      } else properties[name] = fieldSchema(el);
      if (el.required && !required.includes(name)) required.push(name);
    }
    return { type: 'object', properties, ...(required.length && { required }) };
  };

  const declaredForms = () => [...document.querySelectorAll('form[toolname]')];

  // Invio di un form dichiarativo da parte di un agente: il risultato arriva
  // con respondWith, che si avvolge sull'istanza prima che il gestore della
  // pagina lo chiami (questo listener è in cattura su window).
  window.addEventListener('submit', (e) => {
    const form = e.target;
    if (!e.agentInvoked || !form?.getAttribute?.('toolname')) return;
    const name = form.getAttribute('toolname');
    const input = {};
    try { for (const [k, v] of new FormData(form)) input[k] = typeof v === 'string' ? v : `[file ${v.name}]`; } catch {}
    const entry = takePending(name) ?? record({ at: Date.now(), tool: name, kind: 'declarative', caller: 'other', input: clip(input), status: 'submitted' });
    const t0 = performance.now();
    if (typeof e.respondWith === 'function') {
      const orig = e.respondWith;
      e.respondWith = function (p) {
        Promise.resolve(p).then((out) => settle(entry, t0, out), (err) => settle(entry, t0, undefined, err));
        return orig.call(this, p);
      };
    }
  }, true);
  window.addEventListener('toolcancel', (e) => {
    const name = e.target?.getAttribute?.('toolname');
    const last = [...calls].reverse().find((c) => c.tool === name && c.kind === 'declarative');
    if (last && last.status === 'submitted') last.status = 'cancelled';
  }, true);

  // --- azioni sensibili ---
  // Acquisti, pagamenti, invii, cancellazioni: partono solo con conferma.
  // Un form dichiarativo è un invio di modulo, tranne il GET (ricerca, filtri),
  // che per HTTP non cambia lo stato del server.
  const SENSITIVE = /check.?out|purchase|buy|pay|order|book|reserv|subscri|send|submit|delete|remove|cancel|transfer|donat|sign.?up|register|acquist|pagament|pagare|ordin|prenot|invi|elimin|cancell|bonific|iscri/i;
  const sensitivity = (t) => {
    if (t.read_only === true) return null;
    if (t.kind === 'declarative') {
      return t.method === 'get' ? null : `declarative form (${t.method.toUpperCase()}): submitting it sends data to the site`;
    }
    const m = `${t.name} ${t.description ?? ''}`.match(SENSITIVE);
    return m ? `"${m[0]}" in name or description: it may buy, send or delete` : null;
  };

  const schemaOf = (raw) => {
    if (typeof raw !== 'string') return raw ?? null;
    try { return JSON.parse(raw); } catch { return raw; }
  };

  async function list() {
    const mc = mcOf();
    patch(mc);
    const forms = declaredForms();
    const formByName = new Map(forms.map((f) => [f.getAttribute('toolname'), f]));
    const out = [];
    const seen = new Set();
    const add = (t) => {
      if (seen.has(t.name)) return;
      seen.add(t.name);
      const n = calls.filter((c) => c.tool === t.name).length;
      const tool = { ...t, ...(n && { calls: n }) };
      const why = sensitivity(tool);
      if (why) tool.sensitive = why;
      delete tool.method;
      out.push(tool);
    };
    const formTool = (f, extra = {}) => ({
      name: f.getAttribute('toolname'),
      description: f.getAttribute('tooldescription') ?? '',
      input_schema: formSchema(f),
      kind: 'declarative',
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      autosubmit: f.hasAttribute('toolautosubmit'),
      ...extra,
    });
    if (mc && typeof mc.getTools === 'function') {
      let tools = [];
      try { tools = (await mc.getTools()) ?? []; } catch {}
      for (const t of tools) {
        const name = String(t.name);
        const f = formByName.get(name);
        if (f) {
          // Lo schema del browser vince su quello letto dai campi, se dice qualcosa.
          const given = schemaOf(t.inputSchema);
          const useful = given && typeof given === 'object' && Object.keys(given.properties ?? {}).length;
          add(formTool(f, { origin: t.origin ?? location.origin, ...(useful && { input_schema: given }) }));
          continue;
        }
        const ann = regs.get(name)?.annotations ?? t.annotations ?? null;
        add({
          name,
          description: t.description ?? '',
          input_schema: schemaOf(t.inputSchema),
          kind: 'imperative',
          origin: t.origin ?? location.origin,
          ...(ann?.readOnlyHint === true && { read_only: true }),
        });
      }
    } else if (mc) {
      // Senza getTools: almeno quelli registrati dopo il gancio.
      for (const [name, r] of regs) add({ name, kind: 'imperative', origin: location.origin, ...(r.annotations?.readOnlyHint === true && { read_only: true }) });
    }
    for (const f of forms) add(formTool(f));
    return { active: Boolean(mc), tools: out, ...(toolchanges && { toolchange_events: toolchanges }) };
  }

  async function summary() {
    const { active, tools } = await list();
    return { active, tools: tools.map((t) => ({ name: t.name, kind: t.kind, ...(t.sensitive && { sensitive: true }) })) };
  }

  async function call(name, input = {}, { timeout = 30000, confirmed = false } = {}) {
    const mc = mcOf();
    const { tools } = await list();
    const meta = tools.find((t) => t.name === name);
    if (!meta) {
      return { status: 'not_found', error: `No WebMCP tool "${name}" on this page`, available: tools.map((t) => t.name) };
    }
    if (!mc) {
      return { status: 'inactive', error: 'WebMCP is off in this Chrome (document.modelContext missing): the tool is only declared' };
    }
    if (meta.sensitive && !confirmed) {
      return { status: 'needs_confirmation', tool: name, reason: meta.sensitive, input };
    }
    const entry = record({ at: Date.now(), tool: name, kind: meta.kind, caller: 'chrome-bridge', input: clip(input), status: 'running' });
    const t0 = performance.now();
    const ac = new AbortController();
    let timer;
    const timedOut = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(Object.assign(new Error(`timed out after ${timeout} ms`), { timeout: true })); }, timeout); });
    open(entry);
    try {
      let run;
      const exec = patched.get(mc);
      if (exec && typeof mc.getTools === 'function') {
        const tool = ((await mc.getTools()) ?? []).find((t) => String(t.name) === name);
        if (!tool) throw new Error(`"${name}" is no longer registered`);
        run = exec.call(mc, tool, input, { signal: ac.signal });
      } else if (regs.has(name)) {
        run = regs.get(name).execute(input);
      } else {
        throw new Error('this WebMCP version has no executeTool and the tool was registered before chrome-bridge could see it');
      }
      const out = await Promise.race([run, timedOut]);
      settle(entry, t0, out);
      return { status: 'ok', result: entry.output, ms: entry.ms };
    } catch (err) {
      settle(entry, t0, undefined, err);
      return { status: entry.status, error: entry.error, ms: entry.ms };
    } finally {
      clearTimeout(timer);
      // Uno strumento che non è passato dal wrapper (registrato prima del
      // gancio) lascerebbe la voce in coda e ruberebbe la prossima chiamata.
      close(entry);
    }
  }

  window.__cbWebmcp = {
    list,
    summary,
    call,
    calls: (limit = 20) => calls.slice(-Math.max(1, limit)),
  };
})();
