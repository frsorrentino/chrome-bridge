#!/usr/bin/env python3
"""claude-observe — la casella delle osservazioni su un plugin di Claude Code (23/09/2026).

Fonte unica: github.com/frsorrentino/claude-observe. Ogni plugin ne porta una copia in <plugin>/observe/ (sync.py), con
la propria voce in tool.json; il release.sh del plugin verifica la copia contro la fonte (check.sh). Ogni copia
raccoglie SOLO gli errori del proprio plugin e scrive nel proprio file della cartella comune
${XDG_STATE_HOME:-~/.local/state}/claude-observe/<plugin>.jsonl. Formato dei record: FORMAT.md.

Gli errori li scrive un hook, il modello aggiunge solo
cio' che un hook non sa (l'aggiramento, il giudizio): fable-director ha misurato 0-9 % di eventi chiesti al modello
contro il 100 % di quelli scritti da un hook.

  observe hook                         PostToolUseFailure (payload su stdin): MCP e Bash di questo plugin
  observe session-start                SessionStart (payload su stdin): conteggio a chi mantiene, proposta d'invio
  observe add TOOL "cosa" [--error E] [--workaround W] [--class D|L|S] [--on ID]
  observe list [TOOL] [--all] [--raw] [--json]
  observe show ID [--raw]
  observe mark ID [D|L|S|done|new] [--fixed-in VERSIONE]   --fixed-in: corretto in quella versione dello strumento
  observe export TOOL                  tabella markdown per il triage
  observe report TOOL [--send HASH]    UNA issue con le osservazioni non ancora inviate dello strumento: bozza
                                       anonimizzata; con --send (l'hash della bozza mostrata) la apre con gh, o commenta
                                       quella uguale gia' aperta, o senza gh stampa il link GitHub precompilato

La voce del plugin e' tool.json: nome, repo, match (prefissi mcp, regex bash), benign_exits, known, version_from.
Deduplica per errore normalizzato; il file e' condiviso dai due account (cartelle di config di Claude Code).

Privacy (decisione del 23/09): dei parametri dei tool si tengono solo i nomi dei campi e la lunghezza dei testi; il
comando Bash passa da un redattore; l'errore e' troncato e ripulito. I record di un altro account si leggono
anonimizzati, interi solo con --raw. Niente esce dalla macchina senza `report --send` con l'hash del testo mostrato.

Invio (23/09/2026): un solo si'. Claude lo propone in un momento naturale (SessionStart gli dice quando uno
strumento ha accumulato osservazioni), mostra il testo gia' pronto, chiede una conferma; le osservazioni dello stesso
strumento vanno in una issue; gh non e' richiesto; una issue uguale gia' aperta riceve un commento; cio' che e' stato
inviato non si ripropone.

Nella stessa versione: ogni record porta il contesto (versioni dello strumento, di Claude Code e del
modello, sistema, nomi degli ultimi tool chiamati prima); un errore gia' visto che torna restituisce a Claude, come
additionalContext dell'hook, l'aggiramento registrato o «risolto in X: aggiorna»; un record corretto (--fixed-in, o una
voce `known` del registro distribuita col plugin) non si propone come issue.
"""
import platform
import urllib.error
import urllib.parse
import urllib.request
import glob
try:
    import fcntl   # non c'e' su Windows: li' resta il solo lock a cartella
except ImportError:
    fcntl = None
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORMAT = 1   # versione del formato dei record (FORMAT.md): chi legge ignora i campi ignoti, chi riscrive li conserva
LOCK_WAIT_S, LOCK_STALE_S = 3.0, 10.0   # un hook non aspetta oltre 3 s; un lock di 10 s e' di un processo morto
OPS = {"|", "||", "&&", ";", "&", "|&"}
VERBS = {"arm", "list", "show", "add", "mark", "export", "report", "hook", "status", "push", "serve", "set", "get",
         "open", "close", "check"}
CLASSES = ("D", "L", "S", "done", "new")
DEFAULTS = {"enabled": True, "dir": "", "max_records": 2000, "max_days": 90, "anonymizer": "", "blocklist": "",
            "propose": True, "propose_after": 3, "propose_after_days": 3, "propose_every_days": 7, "language": "", "tools": {},
            # l'invio anonimo (25/09/2026): l'endpoint del nostro sito che apre la issue con l'account di servizio, senza il
            # nome dell'utente; vuoto = l'opzione non compare
            "endpoint": ""}
MSG = {
 "it": {
  "observe.summary": "OSSERVAZIONI {tool}: {new} nuove, {again} ricorrenti — `{cmd} list {tool}` (triage: `observe mark ID D|L|S|done`)",
  "observe.added": "osservazione {id} registrata per {tool}",
  "observe.updated": "osservazione {id} aggiornata",
  "observe.none": "nessuna osservazione aperta",
  "observe.unknown_id": "{cmd}: nessuna osservazione con id «{id}»",
  "observe.no_repo": "{cmd}: lo strumento «{tool}» non ha un repo nel registro (observe.tools): nessuna issue",
  "observe.bad_class": "{cmd}: classe «{cls}» sconosciuta (D difetto nostro, L limite di altri, S comportamento del sito)",
  "observe.usage_add": "uso: {cmd} add STRUMENTO \"cosa\" [--error E] [--workaround W] [--class D|L|S] [--security] [--severity high]  |  add --on ID [--workaround W] [--class C] [--security] [--severity high]  (strumenti: {tools}). --security: lettura/scrittura fuori perimetro, segreti esposti, codice eseguito non voluto, dati che escono dal computer; --severity high: difetto nostro che blocca il lavoro. Li mette Claude, mai chiesti all'utente.",
  "observe.bad_severity": "{cmd}: severity «{severity}» sconosciuta (solo: high)",
  "observe.stop_line": "{n} osservazioni su {tool} pronte da inviare (anonimizzate, dopo il tuo sì): /{tool}:observe send",
  "observe.stop_line_security": "{n} osservazioni di SICUREZZA su {tool} da inviare in privato ai maintainer: /{tool}:observe send --security",
  "observe.ask_head": "OPZIONI per AskUserQuestion (una riga JSON per opzione: label, description, command):",
  "observe.ask_tail": "Le opzioni sono esattamente queste; niente altro nella domanda.",
  "observe.opt_own": "Invia dal mio GitHub",
  "observe.opt_own_desc": "Una issue a tuo nome su {repo}, con gh: puoi seguirla",
  "observe.opt_own_desc_nogh": "Apre nel browser un link GitHub già compilato: la issue esce a tuo nome, puoi seguirla",
  "observe.opt_anon": "Invia in forma anonima",
  "observe.opt_anon_desc": "La issue la apre il nostro account di servizio, senza il tuo nome",
  "observe.opt_private": "Invia in privato dal mio GitHub",
  "observe.opt_private_desc": "Segnalazione privata di vulnerabilità su {repo}: la vedono solo i maintainer, mai una issue pubblica",
  "observe.opt_private_desc_nogh": "Apre la pagina «Report a vulnerability» di {repo} nel browser, con il testo da incollare: la vedono solo i maintainer",
  "observe.opt_contact": "Manda all'indirizzo dei maintainer",
  "observe.opt_contact_desc": "Il testo va a {contact} (SECURITY.md), mai in una issue pubblica",
  "observe.opt_later": "Non ora",
  "observe.opt_later_desc": "La proposta torna fra {days} giorni",
  "observe.later": "va bene: la proposta per {tool} torna fra {days} giorni",
  "observe.no_endpoint": "observe.endpoint vuoto nella config: l'invio anonimo non è disponibile",
  "observe.reported_anonymous": "inviato in forma anonima: {url}",
  "observe.summary_flags": "⚠ SICUREZZA {sec} · GRAVI {high} — ",
  "observe.propose_security": "OSSERVAZIONE DI SICUREZZA DA INVIARE {tool}: {n}, percorso PRIVATO (mai in una issue pubblica). Al primo momento naturale proponi all'utente di inviarla: `{cmd} report {tool} --security` prepara UNA segnalazione anonimizzata che vedono solo i maintainer; mostragliela com'è e chiedi un solo sì, poi lancia il comando con --send che stampa.",
  "observe.draft_head_security": "BOZZA PRIVATA per {repo}: {n} osservazioni di sicurezza (anonimizzate; niente è stato inviato). Destinazione: {channel}",
  "observe.channel_advisory": "segnalazione privata di vulnerabilità di GitHub su {repo} (la vedono solo i maintainer)",
  "observe.draft_nogh_security": "gh non c'è o non è autenticato: l'invio stamperà il testo e il link della pagina «Report a vulnerability» di {repo}, da aprire nel browser (già loggato) e compilare a mano.",
  "observe.draft_tail_security": "Mostra questo testo all'utente com'è. Poi chiedi con AskUserQuestion, con le opzioni qui sotto (tasti, non testo libero), ed esegui SOLO il comando dell'opzione scelta: MAI una issue pubblica. Hash della bozza: {hash}",
  "observe.reported_security": "segnalazione privata inviata: {url}",
  "observe.link_security": "apri questa pagina (GitHub, «Report a vulnerability») e incolla il testo qui sotto: {url}",
  "observe.security_contact": "manda il testo qui sotto a {contact} (indirizzo in SECURITY.md); il record è segnato come inviato",
  "observe.no_security_channel": "{cmd}: tool.json di «{tool}» non dice dove vanno le segnalazioni di sicurezza (chiave security: «advisory», un mailto: o un URL): non invio; chiedi al maintainer, mai in una issue pubblica",
  "observe.usage_mark": "uso: {cmd} mark ID [D|L|S|done|new] [--fixed-in VERSIONE]",
  "observe.usage_report": "uso: {cmd} report STRUMENTO [--send HASH]",
  "observe.usage": "uso: {cmd} <add|list|show|mark|export|report> [...]",
  "observe.draft_head": "BOZZA per {repo}: {n} osservazioni in una issue (anonimizzata; niente è stato inviato)",
  "observe.draft_tail": "Mostra questo testo all'utente com'è. Poi chiedi con AskUserQuestion, con le opzioni qui sotto (tasti, non testo libero), ed esegui SOLO il comando dell'opzione scelta. Hash della bozza: {hash}",
  "observe.hash_mismatch": "{cmd}: la bozza è cambiata (hash attuale {hash}): rimostrala all'utente prima di inviare",
  "observe.reported": "issue aperta: {url}",
  "observe.known_workaround": "Errore noto di {tool} {version}. Aggiramento registrato: {workaround}",
  "observe.known_fixed": "Errore noto di {tool}: è corretto nella versione {fixed} (qui c'è la {have}). Proponi all'utente di aggiornare {tool} invece di segnalarlo.",
  "observe.link": "apri questo link (GitHub, già compilato) e premi «Submit new issue»: {url}",
  "observe.draft_nogh": "gh non c'è o non è autenticato: l'invio stamperà un link GitHub precompilato da aprire nel browser (già loggato).",
  "observe.draft_existing": "Esiste già una issue aperta sullo stesso errore: #{number} «{title}» ({url}). L'invio aggiunge un COMMENTO lì, non una issue nuova.",
  "observe.nothing_to_send": "nessuna osservazione da inviare per {tool}",
  "observe.propose": "OSSERVAZIONI DA INVIARE {tool}: {n} (errori registrati dall'hook o note a mano) sul plugin {tool}. In un momento naturale (a fine lavoro) proponi all'utente di inviarle: `{cmd} report {tool}` prepara UNA issue anonimizzata; mostragliela com'è e chiedi un solo sì, poi lancia il comando con --send che stampa."
 },
 "en": {
  "observe.summary": "OBSERVATIONS {tool}: {new} new, {again} recurring — `{cmd} list {tool}` (triage: `observe mark ID D|L|S|done`)",
  "observe.added": "observation {id} recorded for {tool}",
  "observe.updated": "observation {id} updated",
  "observe.none": "no open observations",
  "observe.unknown_id": "{cmd}: no observation with id “{id}”",
  "observe.no_repo": "{cmd}: tool “{tool}” has no repo in the registry (observe.tools): no issue",
  "observe.bad_class": "{cmd}: unknown class “{cls}” (D our defect, L someone else's limit, S the site's behaviour)",
  "observe.usage_add": "usage: {cmd} add TOOL \"what\" [--error E] [--workaround W] [--class D|L|S] [--security] [--severity high]  |  add --on ID [--workaround W] [--class C] [--security] [--severity high]  (tools: {tools}). --security: read/write outside the perimeter, secrets exposed, unwanted code execution, data leaving the computer; --severity high: a defect of ours that blocks the work. Claude sets them, never asked to the user.",
  "observe.bad_severity": "{cmd}: unknown severity “{severity}” (only: high)",
  "observe.stop_line": "{n} observations on {tool} ready to send (anonymized, after your yes): /{tool}:observe send",
  "observe.stop_line_security": "{n} SECURITY observations on {tool} to send privately to the maintainers: /{tool}:observe send --security",
  "observe.ask_head": "OPTIONS for AskUserQuestion (one JSON line per option: label, description, command):",
  "observe.ask_tail": "The options are exactly these; nothing else in the question.",
  "observe.opt_own": "Send from my GitHub",
  "observe.opt_own_desc": "An issue in your name on {repo}, through gh: you can follow it",
  "observe.opt_own_desc_nogh": "Opens a prefilled GitHub link in the browser: the issue goes out in your name, you can follow it",
  "observe.opt_anon": "Send anonymously",
  "observe.opt_anon_desc": "Our service account opens the issue, without your name",
  "observe.opt_private": "Send privately from my GitHub",
  "observe.opt_private_desc": "A private vulnerability report on {repo}: only the maintainers see it, never a public issue",
  "observe.opt_private_desc_nogh": "Opens the “Report a vulnerability” page of {repo} in the browser, with the text to paste: only the maintainers see it",
  "observe.opt_contact": "Send to the maintainers' address",
  "observe.opt_contact_desc": "The text goes to {contact} (SECURITY.md), never a public issue",
  "observe.opt_later": "Not now",
  "observe.opt_later_desc": "The offer comes back in {days} days",
  "observe.later": "fine: the offer for {tool} comes back in {days} days",
  "observe.no_endpoint": "observe.endpoint is empty in the config: anonymous sending is not available",
  "observe.reported_anonymous": "sent anonymously: {url}",
  "observe.summary_flags": "⚠ SECURITY {sec} · HIGH {high} — ",
  "observe.propose_security": "SECURITY OBSERVATION TO SEND {tool}: {n}, PRIVATE path (never a public issue). At the first natural moment offer the user to send it: `{cmd} report {tool} --security` prepares ONE anonymized report seen by the maintainers only; show it as it is and ask for a single yes, then run the --send command it prints.",
  "observe.draft_head_security": "PRIVATE DRAFT for {repo}: {n} security observations (anonymized; nothing has been sent). Destination: {channel}",
  "observe.channel_advisory": "GitHub private vulnerability report on {repo} (seen by the maintainers only)",
  "observe.draft_nogh_security": "gh is missing or not logged in: sending will print the text and the link of the “Report a vulnerability” page of {repo}, to open in the browser (already logged in) and fill by hand.",
  "observe.draft_tail_security": "Show this text to the user as it is. Then ask with AskUserQuestion, with the options below (buttons, not free text), and run ONLY the command of the chosen option: NEVER a public issue. Draft hash: {hash}",
  "observe.reported_security": "private report sent: {url}",
  "observe.link_security": "open this page (GitHub, “Report a vulnerability”) and paste the text below: {url}",
  "observe.security_contact": "send the text below to {contact} (the address in SECURITY.md); the record is marked as sent",
  "observe.no_security_channel": "{cmd}: tool.json of “{tool}” does not say where security reports go (key security: “advisory”, a mailto: or a URL): not sending; ask the maintainer, never a public issue",
  "observe.usage_mark": "usage: {cmd} mark ID [D|L|S|done|new] [--fixed-in VERSION]",
  "observe.usage_report": "usage: {cmd} report TOOL [--send HASH]",
  "observe.usage": "usage: {cmd} <add|list|show|mark|export|report> [...]",
  "observe.draft_head": "DRAFT for {repo}: {n} observations in one issue (anonymized; nothing has been sent)",
  "observe.draft_tail": "Show this text to the user as it is. Then ask with AskUserQuestion, with the options below (buttons, not free text), and run ONLY the command of the chosen option. Draft hash: {hash}",
  "observe.hash_mismatch": "{cmd}: the draft changed (current hash {hash}): show it to the user again before sending",
  "observe.reported": "issue opened: {url}",
  "observe.known_workaround": "Known {tool} {version} error. Recorded workaround: {workaround}",
  "observe.known_fixed": "Known {tool} error: fixed in version {fixed} (this machine has {have}). Offer the user to update {tool} instead of reporting it.",
  "observe.link": "open this link (GitHub, prefilled) and press “Submit new issue”: {url}",
  "observe.draft_nogh": "gh is missing or not logged in: sending will print a prefilled GitHub link to open in the browser (already logged in).",
  "observe.draft_existing": "An open issue on the same error exists: #{number} “{title}” ({url}). Sending adds a COMMENT there, not a new issue.",
  "observe.nothing_to_send": "no observations to send for {tool}",
  "observe.propose": "OBSERVATIONS TO SEND {tool}: {n} (errors recorded by the hook or notes added by hand) on the {tool} plugin. At a natural moment (end of the task) offer the user to send them: `{cmd} report {tool}` prepares ONE anonymized issue; show it as it is and ask for a single yes, then run the --send command it prints."
 }
}


def expand(p):
    return os.path.expandvars(os.path.expanduser(str(p or "")))


def load_config():
    """~/.config/claude-observe/config.json (o CLAUDE_OBSERVE_CONFIG): uguale per tutte le copie, di tutti i plugin."""
    path = os.environ.get("CLAUDE_OBSERVE_CONFIG") or expand("${XDG_CONFIG_HOME:-~/.config}/claude-observe/config.json")
    path = path.replace("${XDG_CONFIG_HOME:-~/.config}", os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"))
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.load(open(path)) or {})
    except (OSError, ValueError, TypeError):
        pass
    return cfg


O = load_config()


def load_tool():
    """La voce del plugin di questa copia: tool.json accanto allo script (CLAUDE_OBSERVE_TOOL nei test). L'utente puo'
    aggiungere `known`, `benign_exits` o spegnere il plugin da tools.<nome> nella config."""
    try:
        t = json.load(open(os.environ.get("CLAUDE_OBSERVE_TOOL") or HERE / "tool.json"))
    except (OSError, ValueError):
        return {}
    over = (O.get("tools") or {}).get(t.get("name")) or {}
    t = {**t, **{k: v for k, v in over.items() if k != "known"}}
    t["known"] = list(t.get("known") or []) + list(over.get("known") or [])
    return t


TOOL = load_tool()
CMD = TOOL.get("command") or f'python3 "{HERE / "observe.py"}"'


def language():
    if O.get("language"):
        return O["language"]
    conf = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    try:
        lang = str(json.load(open(os.path.join(conf, "settings.json"))).get("language") or "").lower()
        if lang:
            return "it" if lang.startswith(("it", "ital")) else "en"
    except (OSError, ValueError, AttributeError):
        pass
    return "it" if (os.environ.get("LANG") or "").lower().startswith("it") else "en"


def M(key, **kw):
    text = MSG.get(language(), MSG["en"]).get(key) or MSG["en"].get(key) or key
    return text.format(cmd=CMD, **kw)


def tools():
    return {TOOL["name"]: TOOL} if TOOL.get("name") and TOOL.get("enabled", True) else {}


def box_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return Path(expand(O.get("dir")) if O.get("dir") else Path(base) / "claude-observe")


def account_name():
    """L'account e' la cartella di config di Claude Code (.claude, .claude-pixel…): il confine fra organizzazioni."""
    return os.path.basename(os.path.realpath(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")))


# ------------------------------------------------------------------ privacy: redattore e normalizzazione
def scrub(text, limit=300):
    """Il testo di un errore come si puo' tenere: niente home, email, query degli URL, segreti, valori digitati."""
    t = str(text or "")
    home = os.path.expanduser("~")
    if home and home != "/":
        t = t.replace(home, "~")
    t = re.sub(r"[\w.+-]+@[\w-]+\.[\w.-]+", "<EMAIL>", t)
    t = re.sub(r"(https?://[^/\s?#\"'»]+)[^\s\"'»]*", r"\1/…", t)
    t = re.sub(r"(?i)\b(token|password|passwd|secret|api[_-]?key|authorization|bearer)(\"?\s*[:=]\s*|\s+)\S+", r"\1\2<SECRET>", t)
    t = re.sub(r"(?i)\b(value_after|value|text)(\"?\s*[:=]?\s*)(\"[^\"]*\"|'[^']*'|«[^»]*»)", r"\1\2<STR>", t)
    t = re.sub(r"\b(?=[A-Za-z0-9_\-+/]*\d)(?=[A-Za-z0-9_\-+/]*[A-Za-z])[A-Za-z0-9_\-+/=]{24,}\b", "<SECRET>", t)
    return t[:limit]


def normalize(text):
    """La chiave di deduplica: lo stesso errore con id, numeri e testi diversi e' lo stesso errore."""
    t = scrub(text, 400)
    t = re.sub(r"«[^»]*»|\"[^\"]*\"|'[^']*'", "<STR>", t)
    t = re.sub(r"(~|\.{0,2})/[\w.\-/~<>…]+", "<PATH>", t)
    t = re.sub(r"\d+", "<N>", t)
    return re.sub(r"\s+", " ", t).strip()[:300]


def shape(tool_input):
    """Di tool_input solo la forma: nomi dei campi, lunghezza dei testi, tipo del resto. Mai un valore."""
    out = {}
    for k, v in (tool_input or {}).items():
        if isinstance(v, str):
            out[k] = len(v)
        elif isinstance(v, bool):
            out[k] = "bool"
        elif isinstance(v, (int, float)):
            out[k] = "number"
        elif isinstance(v, list):
            out[k] = f"list[{len(v)}]"
        elif isinstance(v, dict):
            out[k] = f"object[{len(v)}]"
        else:
            out[k] = "null"
    return out


def tokens(cmd):
    try:
        lx = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lx.whitespace_split = True
        return list(lx)
    except ValueError:
        return cmd.split()


def last_segment(cmd):
    toks = tokens(cmd)
    idx = max((i for i, t in enumerate(toks) if t in OPS), default=-1)
    return toks[idx + 1:]


def redact_cmd(toks, tool=None):
    """Il comando come si puo' tenere: strumento, sottocomando, nomi delle opzioni. Gli argomenti diventano <ARG>."""
    benign = " ".join((tool or {}).get("benign_exits") or {})
    out, words = [], 0
    for i, t in enumerate(toks):
        if re.fullmatch(r"\d*[<>]+&?\d*", t) or t in OPS:
            out.append(t)
        elif "=" in t and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", t) and not out:
            out.append(t.split("=", 1)[0] + "=<ARG>")          # VAR=valore davanti al comando
        elif not out or (t.endswith((".py", ".sh")) and "/" in t) or (i == 1 and out[0] in ("python3", "python", "bash", "sh")):
            out.append(os.path.basename(t) if (t.endswith((".py", ".sh")) or not out) else "<ARG>")
        elif t.startswith("-"):
            out.append(t.split("=", 1)[0] + ("=<ARG>" if "=" in t else ""))
        elif words == 0 and re.fullmatch(r"[a-z][a-z0-9-]{0,19}", t):
            out.append(t); words = 1
        elif words == 1 and re.fullmatch(r"[a-z][a-z0-9-]{0,19}", t) and (t in VERBS or f"{out[-1]} {t}" in benign):
            out.append(t); words = 2
        else:
            out.append("<ARG>")
            words = 2
    return " ".join(out)


# ------------------------------------------------------------------ registro: di quale strumento e' la chiamata
def tool_of(tool_name, tool_input):
    """(nome, strumento, segmento, certo) oppure None."""
    for name, t in tools().items():
        m = t.get("match") or {}
        if any(tool_name.startswith(p) for p in m.get("mcp") or [] if p):
            return name, t, None, True
    if tool_name != "Bash":
        return None
    cmd = str((tool_input or {}).get("command") or "")
    seg = last_segment(cmd)
    seg_text = " ".join(seg)
    for name, t in tools().items():
        pats = [p for p in (t.get("match") or {}).get("bash") or [] if p]
        if any(re.search(p, seg_text) for p in pats):
            return name, t, seg, True
        if any(re.search(p, cmd) for p in pats):
            return name, t, tokens(cmd), False   # il nostro comando non e' l'ultimo: il codice d'uscita e' di un altro
    return None


def is_benign(tool, seg, code):
    """Un codice d'uscita documentato come normale. La chiave e' un sottocomando («restart arm»: le parole dopo il
    programma) o il nome di uno script («external-exec.py»: script senza sottocomandi), con i suoi eventuali
    sottocomandi («fd-telemetry.py budget-open»)."""
    if code is None:
        return False
    words = " ".join(x for x in seg[1:] if not x.startswith("-") and re.fullmatch(r"[a-z][a-z0-9-]*", x))
    red = " " + redact_cmd(seg, tool) + " "
    for k, codes in (tool.get("benign_exits") or {}).items():
        if code not in codes:
            continue
        if (words + " ").startswith(k + " ") or (k.split()[0].endswith((".py", ".sh")) and f" {k} " in red):
            return True
    return False


# ------------------------------------------------------------------ contesto e versioni
VERSION_RE = re.compile(r"\d+(?:\.\d+)+")


def ver_tuple(v):
    try:
        return tuple(int(x) for x in str(v).split("."))
    except ValueError:
        return ()


def tool_version(name, t):
    """La versione installata: il plugin dell'account corrente (installed_plugins.json), oppure `version_file` del
    registro (un json con "version": per esempio il package.json di un server MCP), oppure ""."""
    conf = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    try:
        plugins = (json.load(open(os.path.join(conf, "plugins", "installed_plugins.json"))) or {}).get("plugins") or {}
        for key, rows in plugins.items():
            if key.split("@")[0] == name and rows:
                return str(rows[-1].get("version") or "")
    except (OSError, ValueError, AttributeError):
        pass
    vf = t.get("version_file") or (str(HERE.parent / t["version_from"]) if t.get("version_from") else "")
    if vf:
        try:
            return str(json.load(open(expand(vf))).get("version") or "")
        except (OSError, ValueError, AttributeError):
            pass
    return ""


def claude_code_version():
    exe = os.environ.get("CLAUDE_CODE_EXECPATH") or ""
    if VERSION_RE.fullmatch(os.path.basename(exe)):
        return os.path.basename(exe)
    pid = os.getppid()
    for _ in range(6):   # hook → shell → claude: si risale finche' un eseguibile si chiama come una versione
        try:
            name = os.path.basename(os.readlink(f"/proc/{pid}/exe"))
            if VERSION_RE.fullmatch(name):
                return name
            pid = int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return ""


def transcript_tail(p, size=256 * 1024):
    path = str(p.get("transcript_path") or "")
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - size))
            return f.read().decode(errors="replace").splitlines()[1:]
    except OSError:
        return []


def context(p, name, t):
    """Il contesto di un errore: versioni, sistema, modello, i NOMI degli ultimi tool chiamati prima (mai i parametri)."""
    model, calls = "", []
    for line in transcript_tail(p):
        if '"type":"assistant"' not in line:
            continue
        try:
            msg = json.loads(line).get("message") or {}
        except ValueError:
            continue
        m = str(msg.get("model") or "")
        if m and not m.startswith("<"):
            model = m
        calls += [str(c.get("name")) for c in msg.get("content") or [] if isinstance(c, dict) and c.get("type") == "tool_use"]
    if calls and calls[-1] == p.get("tool_name"):
        calls = calls[:-1]   # l'ultima e' la chiamata fallita
    return {"tool_version": tool_version(name, t), "claude_code": claude_code_version(), "model": model,
            "os": f"{platform.system()} {platform.release()}", "recent_tools": calls[-3:]}


def known_hint(name, t, rec, head, err, ctx):
    """Cosa dire a Claude su un errore gia' noto: prima la correzione (piu' vecchia della versione installata →
    aggiornare), poi l'aggiramento registrato. Il testo di un aggiramento scritto da un altro account non passa."""
    fixed = [(k.get("fixed_in"), k.get("workaround")) for k in t.get("known") or []
             if isinstance(k, dict) and k.get("call") in (head, None, "") and str(k.get("error") or "").lower() in err.lower()]
    if rec:
        fixed.insert(0, (rec.get("fixed_in"), rec.get("workaround") if rec.get("account") == account_name() else None))
    have = ctx.get("tool_version") or ""
    for fix, _ in fixed:
        if fix and (not have or ver_tuple(have) < ver_tuple(fix)):
            return M("observe.known_fixed", tool=name, fixed=fix, have=have or "?")
    for _, work in fixed:
        if work:
            return M("observe.known_workaround", tool=name, version=have or "?", workaround=scrub(work, 500))
    return ""


# ------------------------------------------------------------------ la casella
class Box:
    def __init__(self, tool):
        self.dir = box_dir()
        self.path = self.dir / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', tool)}.jsonl"

    def __enter__(self):
        """Due lock, sempre in quest'ordine (FORMAT.md): flock su <dir>/.lock dove il sistema ce l'ha, che esclude le
        copie gia' distribuite (fino ad a787654 prendevano solo quello), poi la cartella <file>.lock creata con mkdir,
        atomica ovunque e uguale per chi scrive in Node senza flock. Nessuno stallo: chi prende solo mkdir non aspetta mai
        flock. Una cartella di lock piu' vecchia di LOCK_STALE_S e' di un processo morto."""
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o700)
        self.lock = Path(str(self.path) + ".lock")
        end = time.time() + LOCK_WAIT_S
        self.flock = None
        if fcntl is not None:
            self.flock = open(self.dir / ".lock", "w")
            while True:
                try:
                    fcntl.flock(self.flock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.time() > end:
                        self.flock.close()
                        raise TimeoutError(f"flock {self.dir / '.lock'}")
                    time.sleep(0.05)
        while True:
            try:
                os.mkdir(self.lock)
                break
            except FileExistsError:
                try:
                    if time.time() - self.lock.stat().st_mtime > LOCK_STALE_S:
                        os.rmdir(self.lock)
                        continue
                except OSError:
                    continue
                if time.time() > end:
                    self._release_flock()
                    raise TimeoutError(f"lock {self.lock}")
                time.sleep(0.05)
        self.recs = read(self.path)
        # le voci rimaste in attesa (lock occupato): si incorporano ora, sotto lock, e il file si svuota all'uscita
        self.pending = Path(str(pending_path(self.path.stem)))
        self.taken = None
        if self.pending.exists():
            self.taken = self.pending.with_suffix(f".{os.getpid()}.taking")
            try:
                os.replace(self.pending, self.taken)
                for e in read(self.taken):
                    if int(e.get("v") or 1) <= FORMAT and e.get("id"):
                        apply(self.recs, e.get("tool") or self.path.stem, e["id"], e.get("fields") or {}, e.get("example"),
                              float(e.get("at") or time.time()))
            except OSError:
                self.taken = None
        return self

    def __exit__(self, *exc):
        # un file scritto da una copia piu' nuova (formato incompatibile): questa copia non lo riscrive
        if exc[0] is None and all(int(r.get("v") or 1) <= FORMAT for r in self.recs):
            rotate(self.recs)
            tmp = self.path.with_suffix(".tmp")
            with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
                for r in self.recs:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            os.replace(tmp, self.path)
            if self.taken is not None:
                self.taken.unlink(missing_ok=True)
        elif self.taken is not None:
            try:   # non riscritto: le voci prese tornano in attesa
                with open(self.pending, "a") as f:
                    f.write(self.taken.read_text())
                self.taken.unlink()
            except OSError:
                pass
        try:
            os.rmdir(self.lock)
        except OSError:
            pass
        self._release_flock()
        return False

    def _release_flock(self):
        if self.flock is not None:
            try:
                fcntl.flock(self.flock, fcntl.LOCK_UN)
            finally:
                self.flock.close()
                self.flock = None


def read(path):
    out = []
    try:
        for line in open(path):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    return out


def rotate(recs, now=None):
    now = now or time.time()
    days = float(O.get("max_days") or 90)
    cap = int(O.get("max_records") or 2000)
    recs[:] = [r for r in recs if now - float(r.get("last_seen") or 0) <= days * 86400]
    if len(recs) > cap:
        recs.sort(key=lambda r: (r.get("status") != "done", float(r.get("last_seen") or 0)))
        del recs[:len(recs) - cap]


def all_records():
    out = []
    for p in sorted(box_dir().glob("*.jsonl")):
        out += read(p)
    return out


def apply(recs, tool, rec_id, fields, example, now):
    """Aggiunge o aggiorna (count, last_seen, fino a tre esempi) il record rec_id nella lista."""
    r = next((x for x in recs if x.get("id") == rec_id), None)
    if r is None:
        r = {"v": FORMAT, "id": rec_id, "tool": tool, "count": 0, "first_seen": now, "examples": [], "workaround": None,
             "class": None, "status": "new", **fields}
        recs.append(r)
    else:
        for k in ("workaround", "class", "note", "context", "security", "severity"):
            if fields.get(k):
                r[k] = fields[k]
        if r.get("status") == "done" and fields.get("source", "").startswith("hook"):
            r["status"] = "new"   # un errore segnato risolto che torna: va rivisto
    r["count"] = int(r.get("count") or 0) + (1 if example is not None or not r["count"] else 0)
    r["last_seen"] = max(float(r.get("last_seen") or 0), now)
    if example is not None:
        r["examples"] = (r.get("examples") or [])[-2:] + [dict(example, at=now)]
    return r


def pending_path(tool):
    return box_dir() / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', tool)}.pending.jsonl"


def record(tool, rec_id, fields, example=None):
    """Registra nella casella del plugin. Se il lock resta occupato oltre l'attesa (carico alto: il 23/09 un record si
    perdeva in silenzio), la voce va in <plugin>.pending.jsonl con una sola scrittura in append, atomica senza lock; il
    prossimo scrittore che ha il lock la incorpora (FORMAT.md). Niente si perde."""
    now = round(time.time(), 3)   # frazioni di secondo: un aggiornamento nello stesso secondo dell'avviso conta
    try:
        with Box(tool) as box:
            return apply(box.recs, tool, rec_id, fields, example, now)
    except TimeoutError:
        line = json.dumps({"v": FORMAT, "tool": tool, "id": rec_id, "fields": fields, "example": example, "at": now},
                          ensure_ascii=False) + "\n"
        box_dir().mkdir(parents=True, exist_ok=True)
        fd = os.open(pending_path(tool), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line.encode())
        finally:
            os.close(fd)
        return {"id": rec_id, "tool": tool, "pending": True, **fields}


def rid(tool, key):
    digest = hashlib.sha256((tool + "\0" + key).encode()).hexdigest()[:8]
    return f"{tool[:12]}-{digest}"


# ------------------------------------------------------------------ hook
def hook(p):
    if not O.get("enabled", True) or p.get("hook_event_name", "PostToolUseFailure") != "PostToolUseFailure" or p.get("is_interrupt"):
        return 0
    name = str(p.get("tool_name") or "")
    hit = tool_of(name, p.get("tool_input") or {})
    if not hit:
        return 0
    tool, t, seg, certain = hit
    err = str(p.get("error") or "")
    code = None
    if name == "Bash":
        mm = re.match(r"Exit code (\d+)", err)
        code = int(mm.group(1)) if mm else None
        if certain and is_benign(t, seg, code):
            return 0
        rest = [l for l in err.splitlines()[1:] if l.strip()]
        err = (f"Exit code {code}" if code is not None else err.splitlines()[0] if err else "") + (": " + rest[0] if rest else "")
        call = redact_cmd(seg, t)
        head = " ".join(call.split()[:3])
    else:
        call = name
        head = name
    key = normalize(f"{head} {err}")
    ctx = context(p, tool, t)
    prev = next((r for r in read(box_dir() / f"{tool}.jsonl") if r.get("id") == rid(tool, key)), None)
    ex = {"input_shape": shape(p.get("tool_input")) if name != "Bash" else {"command": call}, "error_raw": scrub(err),
          "session_id": str(p.get("session_id") or ""), "duration_ms": p.get("duration_ms"), "context": ctx}
    record(tool, rid(tool, key), {"context": ctx, "source": "hook-mcp" if name != "Bash" else "hook-bash", "kind": "error", "call": head,
                                  "error": scrub(err), "key": key, "account": account_name(),
                                  "project": os.path.basename(os.path.realpath(p.get("cwd") or os.getcwd())),
                                  **({} if certain else {"attribution": "uncertain"})}, ex)
    hint = known_hint(tool, t, prev, head, err, ctx) if certain else ""
    if hint:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUseFailure", "additionalContext": hint}}, ensure_ascii=False))
    return 0


def record_external(source, call, text, project="", account=""):
    """Un errore visto da un componente del plugin fuori dagli hook (il relay di claude-master per i comandi del polso,
    un server MCP senza plugin): stesso record, `source` suo."""
    if not O.get("enabled", True) or not tools():
        return None
    tool = TOOL["name"]
    key = normalize(f"{call} {text}")
    return record(tool, rid(tool, key), {"source": source, "kind": "error", "call": scrub(call, 200), "error": scrub(text),
                                         "key": key, "account": account or account_name(), "project": project},
                  {"error_raw": scrub(text)})


# ------------------------------------------------------------------ lettura
def view(r, raw=False):
    """Il record come lo puo' vedere questa sessione: interi quelli del suo account, gli altri anonimizzati."""
    if raw or r.get("account") == account_name():
        return dict(r)
    v = {k: r.get(k) for k in ("id", "tool", "source", "kind", "call", "count", "first_seen", "last_seen", "class", "status",
                               "attribution", "security", "severity") if k in r}
    v["account"] = r.get("account")
    v["project"] = "[PROGETTO_" + hashlib.sha256(str(r.get("project")).encode()).hexdigest()[:4] + "]"
    v["error"] = r.get("key") or ""
    v["anonymized"] = True
    return v


def when(ts):
    return time.strftime("%d/%m %H:%M", time.localtime(float(ts or 0)))


def flag_of(r):
    """Il prefisso di list/export: SEC (sicurezza), HIGH (grave), altrimenti vuoto."""
    return "SEC  " if r.get("security") else ("HIGH " if r.get("severity") == "high" else "     ")


def find(rec_id):
    return next((r for r in all_records() if r.get("id") == rec_id), None)


def mine_tools(real):
    """Gli strumenti di cui la cartella `real` e' la sessione che li mantiene (maintainer_dir, o il remote origin = repo)."""
    try:
        origin = subprocess.run(["git", "-C", real, "remote", "get-url", "origin"], capture_output=True, text=True,
                                timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        origin = ""
    slug = re.sub(r"(\.git)?/?$", "", re.sub(r"^.*github\.com[:/]", "", origin)).lower()
    out = []
    for name, t in tools().items():
        md = expand(t.get("maintainer_dir") or "")
        if (md and (real == os.path.realpath(md) or real.startswith(os.path.realpath(md) + os.sep))) or \
           (slug and slug == str(t.get("repo") or "").lower()):
            out.append(name)
    return out


def stop(cwd):
    """Per l'hook Stop (25/09/2026): quando la regola di proposta scatta (soglia, eta', classe D, security, severity) UNA
    riga a schermo per l'utente — systemMessage, non additionalContext — una volta sola per proposta, poi silenzio per
    observe.propose_every_days; mai nella sessione che mantiene il plugin. Torna la riga o ''."""
    if not O.get("enabled", True) or not O.get("propose", True):
        return ""
    real = os.path.realpath(cwd or os.getcwd())
    mine = mine_tools(real)
    now, lines = time.time(), []
    for name, t in tools().items():
        if name in mine or not t.get("repo"):
            continue
        for security, suffix in ((True, "sec-"), (False, "")):
            pend = pending(name, security=security)
            if not (pend if security else (pend and due(pend, now))):
                continue
            f = box_dir() / f".shown-{suffix}{name}"
            try:
                last = float(f.read_text().strip() or 0)
            except (OSError, ValueError):
                last = 0.0
            if now - last < float(O.get("propose_every_days") or 7) * 86400:
                continue
            lines.append(M("observe.stop_line_security" if security else "observe.stop_line", tool=name, n=len(pend)))
            try:
                box_dir().mkdir(parents=True, exist_ok=True)
                f.write_text(str(now))
            except OSError:
                pass
    return " ".join(lines)


def summary(cwd):
    """Per SessionStart: una riga per ogni strumento di cui questa cartella e' la sessione che lo mantiene."""
    if not O.get("enabled", True):
        return ""
    real = os.path.realpath(cwd or os.getcwd())
    lines, mine_names = [], mine_tools(real)
    for name, t in tools().items():
        if name not in mine_names:
            continue
        seen_f = box_dir() / f".seen-{name}"
        try:
            seen = float(seen_f.read_text().strip() or 0)
        except (OSError, ValueError):
            seen = 0.0
        recs = [r for r in read(box_dir() / f"{name}.jsonl") if r.get("status") != "done" and r.get("attribution") != "uncertain"]
        new = sum(1 for r in recs if float(r.get("first_seen") or 0) > seen)
        again = sum(1 for r in recs if float(r.get("first_seen") or 0) <= seen < float(r.get("last_seen") or 0))
        if new or again:
            sec = sum(1 for r in recs if r.get("security") and r.get("status") != "reported")
            high = sum(1 for r in recs if r.get("severity") == "high" and not r.get("security") and r.get("status") != "reported")
            prefix = M("observe.summary_flags", sec=sec, high=high) if sec or high else ""
            lines.append(prefix + M("observe.summary", tool=name, new=new, again=again))
            try:
                box_dir().mkdir(parents=True, exist_ok=True)
                seen_f.write_text(str(time.time()))
            except OSError:
                pass
    return "\n".join(lines + proposals(real, mine_tools=mine_names))


def pending(tool, security=False):
    """Le osservazioni da inviare: non inviate, non chiuse, attribuite con certezza, non solo note a mano senza errore.
    Con security=True quelle di sicurezza, che non entrano MAI nella issue pubblica: hanno un percorso privato (report
    --security); senza, tutte le altre."""
    return [r for r in read(box_dir() / f"{tool}.jsonl")
            if r.get("status") not in ("done", "reported") and r.get("attribution") != "uncertain" and not r.get("fixed_in")
            and bool(r.get("security")) == security]


def urgent(r):
    """Una classe D (difetto nostro segnato a mano), una security o una severity high: la proposta scatta subito."""
    return r.get("class") == "D" or bool(r.get("security")) or r.get("severity") == "high"


def due(pend, now=None):
    """Le osservazioni in attesa meritano una proposta quando (25/09/2026): sono almeno observe.propose_after; oppure la
    piu' vecchia aspetta da almeno observe.propose_after_days giorni (0 = mai per eta'), cosi' chi ne ha una o due
    non resta senza proposta per sempre; oppure una ha classe D, un difetto nostro segnato a mano: subito."""
    if not pend:
        return False
    now = now or time.time()
    if len(pend) >= int(O.get("propose_after") or 3):
        return True
    if any(urgent(r) for r in pend):
        return True
    days = O.get("propose_after_days")
    days = 3.0 if days is None else float(days or 0)
    oldest = min(float(r.get("first_seen") or now) for r in pend)
    return days > 0 and now - oldest >= days * 86400


def proposals(real, mine_tools=()):
    """SessionStart in una sessione qualsiasi: se uno strumento con un repo ha osservazioni da inviare che lo meritano
    (vedi `due`), una riga che dice a Claude di proporre l'invio (un solo si') in un momento naturale. Non piu' di una
    volta ogni observe.propose_every_days per strumento, mai nella sessione che lo mantiene."""
    if not O.get("propose", True):
        return []
    out, now = [], time.time()

    def gate(f):
        try:
            last = float(f.read_text().strip() or 0)
        except (OSError, ValueError):
            last = 0.0
        if now - last < float(O.get("propose_every_days") or 7) * 86400:
            return False
        try:
            f.write_text(str(now))
        except OSError:
            pass
        return True

    for name, t in tools().items():
        if name in mine_tools or not t.get("repo"):
            continue
        sec = pending(name, security=True)   # binario privato, subito, con il suo intervallo
        if sec and gate(box_dir() / f".proposed-sec-{name}"):
            out.append(M("observe.propose_security", tool=name, n=len(sec)))
        pend = pending(name)
        if due(pend, now) and gate(box_dir() / f".proposed-{name}"):
            out.append(M("observe.propose", tool=name, n=len(pend)))
    return out


# ------------------------------------------------------------------ issue
def anonymizer():
    p = O.get("anonymizer") or ""
    if p:
        return expand(p) if os.path.isfile(expand(p)) else ""
    found = sorted(glob.glob(os.path.expanduser("~/.claude*/plugins/cache/*/fable-director/*/scripts/anonymizer.py")), key=os.path.getmtime)
    return found[-1] if found else ""


def gh_ok():
    try:
        return subprocess.run(["gh", "auth", "status", "-h", "github.com"], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def redact_out(text, tag):
    """Il testo che esce: blocklist dell'utente, poi l'anonimizzatore di fable-director se c'e'."""
    words = [w.strip() for w in (Path(expand(O["blocklist"])).read_text().splitlines() if O.get("blocklist") and
             os.path.isfile(expand(O["blocklist"])) else []) if w.strip() and not w.startswith("#")]
    for w in words:
        text = re.sub(re.escape(w), "[REDACTED]", text, flags=re.I)
    an = anonymizer()
    if an:
        try:
            res = subprocess.run([sys.executable, an, "redact", "--stdin", "--map", f"observe-{tag}"], input=text,
                                 capture_output=True, text=True, timeout=30)
            if res.returncode == 0 and res.stdout.strip():
                text = res.stdout.rstrip("\n")
        except (OSError, subprocess.SubprocessError):
            pass
    return text


def existing_issue(repo, recs):
    """Una issue aperta sullo stesso errore: si cerca la chiamata e le parole dell'errore piu' frequente."""
    top = recs[0]
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z_]{3,}", str(view(top).get("error") or ""))][:5]
    q = " ".join([str(top.get("call") or "").split()[0]] + words) + " in:title,body"
    try:
        res = subprocess.run(["gh", "issue", "list", "-R", repo, "--state", "open", "--search", q, "--json", "number,title,url",
                              "--limit", "3"], capture_output=True, text=True, timeout=30)
        found = json.loads(res.stdout or "[]") if res.returncode == 0 else []
    except (OSError, subprocess.SubprocessError, ValueError):
        found = []
    return found[0] if found else None


def draft(tool, recs, target=None, security=False):
    """Titolo e corpo di UNA issue (o di un commento) con le osservazioni dello strumento, gia' anonimizzati. Con
    security=True il testo della segnalazione privata (advisory GitHub o indirizzo di SECURITY.md), mai di una issue."""
    vs = [view(r) for r in sorted(recs, key=lambda r: -int(r.get("count") or 0))]
    recs_by_id = {r.get("id"): r for r in recs}
    rows = []
    for v in vs[:20]:
        c = (recs_by_id.get(v.get("id")) or {}).get("context") or {}
        env_ = ", ".join(x for x in (f"{tool} {c['tool_version']}" if c.get("tool_version") else "",
                                     f"Claude Code {c['claude_code']}" if c.get("claude_code") else "", c.get("model") or "",
                                     c.get("os") or "") if x)
        rows.append(f"- `{v.get('call')}` — {scrub(v.get('error') or '', 300)} (×{v.get('count')}, "
                    f"{when(v.get('first_seen'))}–{when(v.get('last_seen'))}{'; ' + env_ if env_ else ''}"
                    f"{'; after ' + ', '.join(c['recent_tools']) if c.get('recent_tools') else ''})")
        if v.get("workaround") and not v.get("anonymized"):
            rows.append(f"  - workaround: {scrub(v['workaround'], 300)}")
    if len(vs) > 20:
        rows.append(f"- … and {len(vs) - 20} more")
    errors = sum(1 for v in vs if v.get("kind") != "note")
    kinds = ", ".join(x for x in (f"{errors} error(s)" if errors else "", f"{len(vs) - errors} note(s)" if len(vs) > errors else "") if x)
    if security:
        title = f"[{tool}] security observation(s): {len(vs)}"
        body = "\n".join([f"Private security report prepared on {time.strftime('%Y-%m-%d')} by claude-observe "
                          "(https://github.com/frsorrentino/claude-observe), for the maintainers only — never a public issue. "
                          "Parameter values are never stored.", "", *rows])
    else:
        title = f"[{tool}] field observations: {kinds}, most frequent `{vs[0].get('call')}`"
        body = "\n".join([f"Collected on {time.strftime('%Y-%m-%d')} by claude-observe (https://github.com/frsorrentino/claude-observe): "
                          "errors recorded by a hook and notes added by hand; parameter values are never stored.", "", *rows])
    text = redact_out(f"{title}\n\n{body}", tool)
    title, _, body = text.partition("\n\n")
    head = "security" if security else (f"comment #{target['number']}" if target else "new")
    return title, body, hashlib.sha256(f"{head}\n{text}".encode()).hexdigest()[:10]


def options(tool, t, h, security, has_gh):
    """Le scelte da porre all'utente con AskUserQuestion (tasti, mai testo libero), dopo la bozza: dal suo GitHub (mai per
    una security: quella va solo in privato), in forma anonima dal nostro endpoint (solo se observe.endpoint e'
    configurato), non ora (torna dopo propose_every_days). Ogni riga: etichetta, descrizione, comando da eseguire."""
    repo = str(t.get("repo") or "")
    days = int(float(O.get("propose_every_days") or 7))
    base = f"{CMD} report {tool}" + (" --security" if security else "")
    out = []
    if not security:
        out.append({"label": M("observe.opt_own"), "description": M("observe.opt_own_desc" if has_gh else "observe.opt_own_desc_nogh", repo=repo),
                    "command": f"{base} --send {h}"})
    if str(O.get("endpoint") or "").strip():
        out.append({"label": M("observe.opt_anon"), "description": M("observe.opt_anon_desc"), "command": f"{base} --send {h} --anonymous"})
    if security:
        channel = str(t.get("security") or "").strip()
        if channel == "advisory":
            out.append({"label": M("observe.opt_private"), "description": M("observe.opt_private_desc" if has_gh else "observe.opt_private_desc_nogh", repo=repo),
                        "command": f"{base} --send {h}"})
        elif channel:
            out.append({"label": M("observe.opt_contact"), "description": M("observe.opt_contact_desc", contact=channel), "command": f"{base} --send {h}"})
    out.append({"label": M("observe.opt_later"), "description": M("observe.opt_later_desc", days=days), "command": f"{base} --later"})
    return out


def print_options(opts):
    print("\n" + M("observe.ask_head"))
    for o in opts:
        print(json.dumps(o, ensure_ascii=False))
    print(M("observe.ask_tail"))


def later(tool):
    """«Non ora»: la proposta (al modello e a schermo) tace per propose_every_days, poi torna."""
    now = str(time.time())
    for f in (".proposed-", ".proposed-sec-", ".shown-", ".shown-sec-"):
        try:
            box_dir().mkdir(parents=True, exist_ok=True)
            (box_dir() / f"{f}{tool}").write_text(now)
        except OSError:
            pass
    print(M("observe.later", tool=tool, days=int(float(O.get("propose_every_days") or 7))))
    return 0


def send_anonymous(tool, t, title, body, recs, security):
    """L'invio anonimo: POST JSON a observe.endpoint con la bozza anonimizzata piu' plugin, versione e i flag — niente
    altro. La issue la apre l'account di servizio del sito, senza il nome dell'utente. Torna l'URL (o l'endpoint)."""
    url = str(O.get("endpoint") or "").strip()
    if not url:
        raise ValueError(M("observe.no_endpoint"))
    payload = {"plugin": tool, "version": tool_version(tool, t) or None, "security": bool(security),
               "severity": "high" if any(r.get("severity") == "high" for r in recs) else None, "title": title, "body": body}
    req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "claude-observe"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode()
    try:
        return str(json.loads(raw).get("url") or url)
    except (ValueError, AttributeError):
        return url


def issue_link(repo, title, body, limit=7500):
    """Il link GitHub precompilato per chi non ha gh: l'utente lo apre gia' loggato. Oltre il limite dell'URL il corpo si
    taglia per righe, con una nota."""
    base = f"https://github.com/{repo}/issues/new?"
    lines = body.splitlines()
    cut = 0
    while True:
        b = "\n".join(lines[:len(lines) - cut]) + (f"\n\n(truncated: {cut} more line(s) not included)" if cut else "")
        url = base + urllib.parse.urlencode({"title": title, "body": b})
        if len(url) <= limit or cut >= len(lines):
            return url[:limit]
        cut += 1


def report_security(tool, t, repo, send, anonymous=False):
    """Il percorso privato: tool.json → `security` dice dove vanno («advisory» = segnalazione privata di vulnerabilita' di
    GitHub sul repo, con gh; senza gh la pagina «Report a vulnerability» da aprire; oppure un mailto:/URL da SECURITY.md,
    stampato con il testo). Sempre anonimizzato, sempre dopo il si' dell'utente, mai in una issue."""
    channel = str(t.get("security") or "").strip()
    recs = pending(tool, security=True)
    if not recs:
        print(M("observe.nothing_to_send", tool=tool))
        return 0
    if not channel and not str(O.get("endpoint") or "").strip():
        print(M("observe.no_security_channel", tool=tool), file=sys.stderr)
        return 2
    title, body, h = draft(tool, recs, security=True)
    has_gh = channel == "advisory" and gh_ok()
    if send is None:
        print(M("observe.draft_head_security", repo=repo, n=len(recs), channel=(M("observe.channel_advisory", repo=repo) if channel == "advisory" else channel)))
        if channel == "advisory" and not has_gh:
            print(M("observe.draft_nogh_security", repo=repo))
        print("\n" + title + "\n\n" + body)
        print("\n" + M("observe.draft_tail_security", tool=tool, hash=h))
        print_options(options(tool, t, h, True, has_gh))
        return 0
    if send != h:
        print(M("observe.hash_mismatch", hash=h), file=sys.stderr)
        return 3
    if anonymous:
        try:
            where = send_anonymous(tool, t, title, body, recs, True)
        except (ValueError, OSError, urllib.error.URLError) as e:
            print(str(e), file=sys.stderr)
            return 4
        print(M("observe.reported_anonymous", url=where))
    elif has_gh:
        payload = json.dumps({"summary": title[:1024], "description": body[:65000]})
        res = subprocess.run(["gh", "api", "-X", "POST", f"repos/{repo}/security-advisories/reports", "--input", "-"],
                             input=payload, capture_output=True, text=True, timeout=60)
        if res.returncode != 0:
            print(res.stderr.strip() or res.stdout.strip(), file=sys.stderr)
            return 4
        try:
            where = str(json.loads(res.stdout).get("html_url") or "")
        except ValueError:
            where = ""
        where = where or f"https://github.com/{repo}/security/advisories"
        print(M("observe.reported_security", url=where))
    elif channel == "advisory":
        where = f"https://github.com/{repo}/security/advisories/new"
        print(M("observe.link_security", url=where))
        print("\n" + title + "\n\n" + body)
    else:
        where = channel
        print(M("observe.security_contact", contact=channel))
        print("\n" + title + "\n\n" + body)
    ids = {r["id"] for r in recs}
    with Box(tool) as box:
        for x in box.recs:
            if x.get("id") in ids:
                x["status"], x["reported"] = "reported", where[:200]
    return 0


def report(tool, send=None, security=False, anonymous=False):
    t = tools().get(tool)
    if not t:
        print(M("observe.usage_report"), file=sys.stderr)
        return 2
    repo = str(t.get("repo") or "")
    if not repo:
        print(M("observe.no_repo", tool=tool), file=sys.stderr)
        return 2
    if security:
        return report_security(tool, t, repo, send, anonymous)
    recs = pending(tool)
    if not recs:
        print(M("observe.nothing_to_send", tool=tool))
        return 0
    has_gh = gh_ok()
    target = existing_issue(repo, recs) if has_gh else None
    title, body, h = draft(tool, recs, target)
    if send is None:
        print(M("observe.draft_head", repo=repo, n=len(recs)))
        if target:
            print(M("observe.draft_existing", number=target["number"], title=target.get("title") or "", url=target.get("url") or ""))
        elif not has_gh:
            print(M("observe.draft_nogh"))
        print("\n" + title + "\n\n" + body)
        print("\n" + M("observe.draft_tail", tool=tool, hash=h))
        print_options(options(tool, t, h, False, has_gh))
        return 0
    if send != h:
        print(M("observe.hash_mismatch", hash=h), file=sys.stderr)
        return 3
    if anonymous:
        try:
            where = send_anonymous(tool, t, title, body, recs, False)
        except (ValueError, OSError, urllib.error.URLError) as e:
            print(str(e), file=sys.stderr)
            return 4
        print(M("observe.reported_anonymous", url=where))
    elif has_gh:
        args = (["gh", "issue", "comment", str(target["number"]), "-R", repo, "--body-file", "-"] if target else
                ["gh", "issue", "create", "-R", repo, "--title", title, "--body-file", "-"])
        res = subprocess.run(args, input=(f"**{title}**\n\n{body}" if target else body), capture_output=True, text=True, timeout=60)
        if res.returncode != 0:
            print(res.stderr.strip() or res.stdout.strip(), file=sys.stderr)
            return 4
        where = (res.stdout.strip().splitlines() or [""])[-1] or (target or {}).get("url", "")
        print(M("observe.reported", url=where))
    else:
        where = issue_link(repo, title, body)
        print(M("observe.link", url=where))
    ids = {r["id"] for r in recs}
    with Box(tool) as box:
        for x in box.recs:
            if x.get("id") in ids:
                x["status"], x["reported"] = "reported", where[:200]
    return 0


# ------------------------------------------------------------------ CLI
def opt(argv, name):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            v = argv[i + 1]
            del argv[i:i + 2]
            return v
    return None


def main(argv):
    sub = argv[0] if argv else "list"
    rest = list(argv[1:])
    if sub == "hook":
        try:
            p = json.load(sys.stdin)
        except (ValueError, OSError):
            return 0
        try:
            return hook(p)
        except Exception:   # noqa: BLE001 — un hook non deve mai disturbare la sessione
            return 0
    if sub == "stop":
        try:
            p = json.load(sys.stdin)
        except (ValueError, OSError):
            p = {}
        try:
            line = stop(p.get("cwd") or os.getcwd())
            if line:
                print(json.dumps({"systemMessage": line}, ensure_ascii=False))
        except Exception:   # noqa: BLE001 — un hook Stop non deve mai fermare nulla
            pass
        return 0
    if sub == "send":   # il comando /<plugin>:observe send: la bozza e il solo si', come report
        sub = "report"
    if sub == "session-start":
        try:
            p = json.load(sys.stdin)
        except (ValueError, OSError):
            p = {}
        try:
            out = summary(p.get("cwd") or os.getcwd())
            if out:
                print(out)
        except Exception:   # noqa: BLE001 — un'informazione in piu': mai far cadere l'avvio
            pass
        return 0
    if sub == "add":
        error, work, cls, on = opt(rest, "--error"), opt(rest, "--workaround"), opt(rest, "--class"), opt(rest, "--on")
        # --security: lettura o scrittura fuori perimetro, segreti esposti, codice eseguito non voluto, dati che escono
        # dal computer; --severity high: difetto nostro che blocca il lavoro. Li mette Claude nella sessione, mai chiesti
        # all'utente. Percorso privato per le security (report --security), proposta subito per tutte e due.
        security = "--security" in rest
        rest = [x for x in rest if x != "--security"]
        severity = opt(rest, "--severity")
        if severity is not None and severity != "high":
            print(M("observe.bad_severity", severity=severity), file=sys.stderr)
            return 2
        flags = {**({"security": True} if security else {}), **({"severity": "high"} if severity else {})}
        if on:
            r = find(on)
            if not r:
                print(M("observe.unknown_id", id=on), file=sys.stderr)
                return 1
            record(r["tool"], on, {"workaround": scrub(work, 1000) if work else None, "class": cls,
                                   "note": scrub(" ".join(rest), 1000) if rest else None, "source": "manual", **flags})
            print(M("observe.updated", id=on))
            return 0
        if len(rest) < 2 or rest[0] not in tools():
            print(M("observe.usage_add", tools=", ".join(tools())), file=sys.stderr)
            return 2
        tool, what = rest[0], " ".join(rest[1:])
        if cls and cls not in CLASSES[:3]:
            print(M("observe.bad_class", cls=cls), file=sys.stderr)
            return 2
        key = normalize(f"manual {what} {error or ''}")
        r = record(tool, rid(tool, key), {"source": "manual", "kind": "note", "call": scrub(what, 200),
                                          "error": scrub(error or "", 500), "key": key, "workaround": scrub(work, 1000) if work else None,
                                          "class": cls, "account": account_name(), "project": os.path.basename(os.getcwd()), **flags})
        print(M("observe.added", id=r["id"], tool=tool))
        return 0
    if sub == "list":
        raw, js, show_all = "--raw" in rest, "--json" in rest, "--all" in rest
        which = next((x for x in rest if not x.startswith("--")), None)
        recs = [view(r, raw) for r in all_records() if (not which or r.get("tool") == which) and (show_all or r.get("status") not in ("done", "reported"))]
        recs.sort(key=lambda r: (not r.get("security"), r.get("severity") != "high", -float(r.get("last_seen") or 0)))
        if js:
            print(json.dumps(recs, ensure_ascii=False, indent=1))
            return 0
        if not recs:
            print(M("observe.none"))
            return 0
        for r in recs:
            flag = " ?" if r.get("attribution") == "uncertain" else ""
            print(f"{flag_of(r):<5}{r['id']:<22} {r.get('status') or '':<8} {r.get('class') or '-':<2} ×{r.get('count'):<4} {when(r.get('last_seen'))}  "
                  f"{r.get('call') or ''}: {(r.get('error') or '')[:90]}{flag}")
        return 0
    if sub == "show":
        r = find(rest[0]) if rest else None
        if not r:
            print(M("observe.unknown_id", id=rest[0] if rest else ""), file=sys.stderr)
            return 1
        print(json.dumps(view(r, "--raw" in rest), ensure_ascii=False, indent=1))
        return 0
    if sub == "mark":
        fixed_in = opt(rest, "--fixed-in")
        if fixed_in is not None and not VERSION_RE.fullmatch(fixed_in):
            print(M("observe.usage_mark"), file=sys.stderr)
            return 2
        if fixed_in and len(rest) == 1:
            rest.append("done")
        if len(rest) < 2 or rest[1] not in CLASSES:
            print(M("observe.usage_mark"), file=sys.stderr)
            return 2
        r = find(rest[0])
        if not r:
            print(M("observe.unknown_id", id=rest[0]), file=sys.stderr)
            return 1
        with Box(r["tool"]) as box:
            for x in box.recs:
                if x.get("id") == rest[0]:
                    if rest[1] in ("done", "new"):
                        x["status"] = rest[1]
                    else:
                        x["class"], x["status"] = rest[1], "triaged"
                    if fixed_in:
                        x["fixed_in"] = fixed_in
        print(M("observe.updated", id=rest[0]))
        return 0
    if sub == "export":
        which = rest[0] if rest else ""
        recs = sorted((view(r) for r in all_records() if r.get("tool") == which),
                      key=lambda r: (not r.get("security"), r.get("severity") != "high", -int(r.get("count") or 0)))
        print("| flag | id | classe | volte | ultima | chiamata | errore | aggiramento |\n|---|---|---|---|---|---|---|---|")
        for r in recs:
            cell = lambda s: str(s or "").replace("|", "\\|").replace("\n", " ")  # noqa: E731
            print(f"| {flag_of(r).strip()} | {r['id']} | {r.get('class') or ''} | {r.get('count')} | {when(r.get('last_seen'))} | `{cell(r.get('call'))}` | "
                  f"{cell(r.get('error'))} | {cell(r.get('workaround'))} |")
        return 0
    if sub == "report":
        send = opt(rest, "--send")
        security, anonymous, is_later = "--security" in rest, "--anonymous" in rest, "--later" in rest
        rest = [x for x in rest if x not in ("--security", "--anonymous", "--later")]
        if not rest:
            print(M("observe.usage_report"), file=sys.stderr)
            return 2
        if is_later:
            return later(rest[0])
        return report(rest[0], send, security=security, anonymous=anonymous)
    print(M("observe.usage"), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
