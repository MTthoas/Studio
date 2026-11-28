// Tiroir de terminaux : des shells locaux (pont natif `project.term`, app Mac seulement) sous la vue d'un projet.
//
// Monté une fois dans #app, frère de #main (ligne 2 de la grille, colonne du contenu) : les repeints de #main ne le
// touchent pas. Chaque terminal est un `TermView` (src/ui/termview.ts) créé une fois ; son nœud reste dans `.tmd-panes`,
// masqué (`hidden`) quand il n'est pas affiché : fit() ne fait rien à taille nulle, il se recale seul en réapparaissant.
// Au premier passage sur un projet : op `list`, puis `replay` de chaque terminal encore connu du natif (rechargement).
// La sortie poussée (window.carnet.term) arrive dans l'ordre des réponses : ce qui précède la réponse d'un replay y est déjà.
// Intégrations : onglets nommés d'après le programme au premier plan, ports locaux détectés (aperçu dans le Salon),
// envoi de la sortie à Moka (composeur du Salon), aide sur un échec, notification d'une longue commande finie.
import * as native from '../core/native.ts';
import { TermView } from '../ui/termview.ts';
import type { Mark } from '../lib/vt.ts';
import * as projectsModel from './projects/model.ts';
import * as salon from './projects/salon.ts';
import { safePatch } from './projects/sessions.ts';
import * as savedCommands from './commands.ts';
import { esc } from '../lib/markdown.ts';
import { $, $$, el, icon, matches, menu, confirmBox, toast, topLayer, target, need, paintIfChanged } from '../ui/kit.ts';
import type { MenuItem } from '../ui/kit.ts';
import { t as tr } from '../ui/i18n.ts';
import type { ViewState } from '../types.ts';

// ---------- Contrat A (natif) ----------
interface Term { id: string; project: string; where: string; name: string; title: string; cwd: string; cmd: string; started: number; alive: boolean; busy: boolean; fg: string; exit: number | null }
interface Targets { home: string; repos: { name: string; dir: string }[]; copies: { name: string; branch: string; dir: string }[]; servers: { id: string; name: string }[]; scripts: { repo: string; name: string; cmd: string }[] }
/** Où ouvrir : le dossier du projet, un de ses dépôts, une copie d'agent (worktree) ou un serveur SSH ; `cmd` = script lancé. */
export interface Spec { where: 'project' | 'repo' | 'copy' | 'ssh'; name?: string; cmd?: string }

interface Tab {
  t: Term; view: TermView; host: HTMLElement;
  osc: string; cwd: string;
  run: { cmd: string; at: number } | null;
  done: { cmd: string; code: number; ms: number } | null;
  fail: { cmd: string; code: number; cwd: string } | null;
  ports: number[];
  /** Sortie poussée avant la réponse d'`open` (id encore inconnu) ou pendant un replay (null = rien en attente). */
  hold: Uint8Array[] | null; replaying: boolean;
}

interface Ctx { setView(v: ViewState): Promise<void>; viewState(): ViewState; renderSidebar(): void; salonOn(): boolean }

const H_KEY = 'studio.term.h', OPEN_KEY = 'studio.term.open', NAME_KEY = 'studio.term.names';
const MAX_LIVE = 8, LONG_MS = 20000, SIGINT = 130;
const PORT_RE = /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g;
const read = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage plein ou bloqué : tant pis */ } };

let ctx: Ctx | null = null, root: HTMLElement | null = null;
let pid = '', max = false, height = read<number>(H_KEY, 280), seq = 0;
const openBy = read<Record<string, boolean>>(OPEN_KEY, {}), names = read<Record<string, string>>(NAME_KEY, {});
const tabs = new Map<string, Tab>();
const active = new Map<string, string>(), split = new Map<string, string>(), focused = new Map<string, string>();
const listed = new Set<string>(), listing = new Set<string>(), failed = new Map<string, string>();
const targetsOf = new Map<string, Targets>();
/** Sortie poussée pour un id pas encore connu (l'`open` n'a pas répondu). */
const early = new Map<string, Uint8Array[]>();
let opening = 0;

/** Seulement dans l'app Mac : le pont des terminaux n'existe pas ailleurs. */
export const available = (): boolean => native.available() && document.documentElement.dataset.native === 'mac';
const call = (op: string, extra: Record<string, unknown> = {}, project = pid, timeout = 20000) => native.call('project', 'term', { project, op, ...extra }, timeout);
const b64 = (s: string): Uint8Array => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const of = (p: string) => [...tabs.values()].filter(x => x.t.project === p);
const isOpen = (p: string) => !!p && !!openBy[p];
const setOpen = (p: string, on: boolean) => { if (on) openBy[p] = true; else delete openBy[p]; save(OPEN_KEY, openBy); };
const shown = () => !!root && !root.hidden;

// ---------- Libellés ----------
function short(path: string, p = pid): string {
  const h = targetsOf.get(p)?.home || /^\/Users\/[^/]+/.exec(path)?.[0] || '';
  return h && (path === h || path.startsWith(h + '/')) ? '~' + path.slice(h.length) : path;
}
/** Nom de l'onglet : renommé, sinon le programme au premier plan, le titre OSC, le titre du natif. */
function label(x: Tab): string {
  const n = names[x.t.id]; if (n) return n;
  if (x.t.cmd) return x.t.title || x.t.cmd; // un script garde son nom (son premier plan est « node »)
  return (x.t.alive && x.t.fg) || x.osc || x.t.title || 'Terminal';
}
type State = 'idle' | 'run' | 'ok' | 'err';
function state(x: Tab): State {
  if (!x.t.alive) return x.t.exit && x.t.exit !== SIGINT ? 'err' : 'ok';
  if (x.t.busy || x.run) return 'run';
  return x.fail ? 'err' : x.done ? 'ok' : 'idle';
}
const STATE_TIP: Record<State, string> = { idle: 'Prêt', run: 'En cours', ok: 'Terminé', err: 'Échec' };
/** « npm run build » → « build », « npm test » → « tests ». */
function shortCmd(cmd: string): string {
  const w = cmd.trim().replace(/^(npx|npm|pnpm|yarn|bun)\s+(run\s+)?/, '').split(/\s+/).filter(Boolean);
  const s = (w.length > 1 && !w[1]?.startsWith('-') ? w.slice(0, 2) : w.slice(0, 1)).join(' ') || cmd.trim();
  return /^tests?$/.test(s) ? 'tests' : s.slice(0, 40);
}
function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
}

// ---------- Vues ----------
function makeTab(t: Term, show: boolean): Tab {
  const host = el<HTMLElement>('<div class="tmd-pane"></div>');
  host.hidden = !show;
  need('.tmd-panes', root ?? undefined).append(host);
  const x: Tab = { t, view: null as unknown as TermView, host, osc: '', cwd: '', run: null, done: null, fail: null, ports: [], hold: null, replaying: false };
  x.view = new TermView(host, {
    onData: data => { if (x.t.id && x.t.alive) void call('write', { term: x.t.id, data }, x.t.project).catch(() => undefined); },
    onResize: (cols, rows) => { if (x.t.id && x.t.alive) void call('resize', { term: x.t.id, cols, rows }, x.t.project).catch(() => undefined); },
    onTitle: s => { x.osc = s.trim(); soon(); },
    onCwd: p => { x.cwd = p; soon(); },
    onMark: m => mark(x, m),
    onLine: s => ports(x, s),
    onLink: url => openURL(x.t.project, url),
  });
  host.addEventListener('focusin', () => { focused.set(x.t.project, x.t.id); paintFoot(); });
  return x;
}
function feed(x: Tab, data: Uint8Array): void { if (x.hold) x.hold.push(data); else x.view.write(data); }

async function replay(x: Tab): Promise<void> {
  x.replaying = true; x.hold = [];
  try {
    const r = await call('replay', { term: x.t.id }, x.t.project);
    if (r.ok && typeof r.data === 'string' && r.data) x.view.write(b64(r.data));
  } catch { /* le terminal reste vide : la suite s'affichera */ }
  x.replaying = false;
  x.hold = null; // ce qui est arrivé avant la réponse est déjà dans le replay
}

/** Liste les terminaux d'un projet connus du natif et recrée leurs vues (après un rechargement de la page). */
async function list(p: string): Promise<void> {
  if (!available() || listing.has(p)) return;
  listing.add(p); failed.delete(p); soon();
  try {
    const r = await call('list', {}, p);
    if (!r.ok) throw new Error(r.message || 'Liste des terminaux indisponible.');
    listed.add(p);
    const terms = Array.isArray(r.terms) ? r.terms as Term[] : [];
    for (const t of terms) {
      const known = tabs.get(t.id); if (known) { Object.assign(known.t, t); continue; }
      const x = makeTab(t, false); tabs.set(t.id, x);
      if (t.cmd && !t.alive && t.exit) x.fail = { cmd: t.cmd, code: t.exit, cwd: t.cwd };
      void replay(x);
    }
    if (!active.get(p) || !tabs.has(active.get(p) ?? '')) { const first = of(p)[0]; if (first) active.set(p, first.t.id); }
  } catch (e) { failed.set(p, e instanceof Error ? e.message : String(e)); }
  if (!opening) for (const k of [...early.keys()]) if (!tabs.has(k)) early.delete(k); // sortie d'un terminal fermé : rien ne la réclamera (replay couvre les autres)
  listing.delete(p); paint(); sideSoon();
}
let relistT = 0;
function relist(): void { clearTimeout(relistT); relistT = window.setTimeout(() => { if (opening) return relist(); for (const p of [...listed]) void list(p); }, 400); }

// ---------- Sortie poussée (window.carnet.term) ----------
export function onNative(raw: unknown): void {
  const p = raw as { term?: string; data?: string; exit?: number; state?: { busy?: boolean; fg?: string } } | null;
  const id = p?.term; if (!id) return;
  const x = tabs.get(id);
  if (typeof p.data === 'string') {
    const d = b64(p.data);
    if (x) { if (!x.replaying) feed(x, d); return; }
    const q = early.get(id) ?? []; if (q.reduce((a, b) => a + b.length, 0) < 1 << 20) q.push(d); early.set(id, q);
    if (!opening) relist(); // un terminal inconnu (ouvert ailleurs, page rechargée) : on relit la liste
    return;
  }
  if (!x) return;
  if (p.state) { x.t.busy = !!p.state.busy; x.t.fg = p.state.fg ?? ''; soon(); sideSoon(); return; }
  if (p.exit !== undefined) {
    const code = Number(p.exit) || 0;
    Object.assign(x.t, { alive: false, busy: false, fg: '', exit: code });
    if (x.t.cmd) {
      x.fail = code && code !== SIGINT ? { cmd: x.t.cmd, code, cwd: x.cwd || x.t.cwd } : null;
      x.done = { cmd: x.t.cmd, code, ms: Date.now() - x.t.started * 1000 };
      if (x.done.ms > LONG_MS) notify(x, x.done.cmd, code, x.done.ms);
    }
    x.ports = []; paint(); sideSoon();
  }
}

function mark(x: Tab, m: Mark): void {
  if (m.kind === 'start') { x.run = { cmd: m.cmd.trim(), at: Date.now() }; x.fail = null; x.done = null; }
  else if (m.kind === 'end' && x.run) {
    const ms = Date.now() - x.run.at, cmd = x.run.cmd;
    x.done = { cmd, code: m.code, ms }; x.run = null; x.ports = [];
    x.fail = m.code && m.code !== SIGINT ? { cmd, code: m.code, cwd: x.cwd || x.t.cwd } : null;
    if (ms > LONG_MS) notify(x, cmd, m.code, ms);
  } else return;
  soon(); sideSoon();
}

function ports(x: Tab, line: string): void {
  let hit = false;
  for (const m of line.matchAll(PORT_RE)) {
    const n = Number(m[2]);
    if (n >= 80 && n <= 65535 && !x.ports.includes(n)) { x.ports.push(n); hit = true; }
  }
  if (hit) { soon(); sideSoon(); }
}

/** Une longue commande finie pendant que la fenêtre n'a pas le focus : notification système. */
function notify(x: Tab, cmd: string, code: number, ms: number): void {
  if (document.hasFocus()) return;
  const what = shortCmd(cmd), body = code && code !== SIGINT ? tr(`${what} : échec (code ${code})`) : tr(`${what} terminé en ${dur(ms)}`);
  const p = projectsModel.byId(x.t.project);
  window.webkit?.messageHandlers?.carnet?.postMessage({ type: 'notify', title: p?.name ?? 'Studio', body, url: '' });
}

function openURL(p: string, url: string): void {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/.test(url);
  if (local && ctx?.salonOn() && salon.showPreview(p, url)) return;
  window.open(url, '_blank', 'noopener');
}

// ---------- Ouvrir, fermer ----------
const live = () => [...tabs.values()].filter(x => x.t.alive);

/** Ouvre un terminal dans le projet `p` (le tiroir s'ouvre) ; `side` : à côté du terminal affiché. */
export async function openIn(p: string, spec: Spec = { where: 'project' }, side = false): Promise<void> {
  if (!available() || !p) return;
  if (p !== pid) { await ctx?.setView({ type: 'projets', project: p, ...(spec.where === 'copy' ? { tab: ctx.viewState().tab } : {}) }); }
  if (live().length >= MAX_LIVE) {
    const idle = live().filter(x => !x.t.busy).sort((a, b) => a.t.started - b.t.started)[0];
    toast(idle ? tr(`Huit terminaux au plus : ferme « ${label(idle)} » pour en ouvrir un autre.`) : 'Huit terminaux au plus : ferme-en un pour en ouvrir un autre.',
      idle ? { label: 'Fermer', run: () => close(idle.t.id) } : undefined);
    return;
  }
  const wasOpen = isOpen(p); // un échec referme le tiroir seulement s'il était fermé avant
  setOpen(p, true); max = max && !side;
  const t: Term = { id: '', project: p, where: spec.where, name: spec.name ?? '', title: '', cwd: '', cmd: spec.cmd ?? '', started: Date.now() / 1000, alive: false, busy: false, fg: '', exit: null };
  const x = makeTab(t, true), key = `~${++seq}`;
  // Le temps de l'ouverture : la nouvelle vue prend sa place à l'écran (mesurée), les autres s'effacent.
  tabs.set(key, x); t.id = '';
  const before = active.get(p);
  if (side) split.set(p, key); else { active.set(p, key); split.delete(p); }
  opening++; paint();
  const { cols, rows } = x.view.fit();
  try {
    const r = await call('open', { ...spec, name: spec.name ?? '', cmd: spec.cmd ?? '', cols: cols || 100, rows: rows || 24 }, p, 30000);
    const term = r.term as Term | undefined;
    if (!r.ok || !term?.id) throw new Error(r.message || 'Le terminal n’a pas pu s’ouvrir.');
    tabs.delete(key); Object.assign(x.t, term); tabs.set(term.id, x);
    if (active.get(p) === key) active.set(p, term.id);
    if (split.get(p) === key) split.set(p, term.id);
    const q = early.get(term.id); early.delete(term.id);
    for (const d of q ?? []) x.view.write(d);
    if (x.view.cols !== cols || x.view.rows !== rows) void call('resize', { term: term.id, cols: x.view.cols, rows: x.view.rows }, p).catch(() => undefined);
    listed.add(p);
    focused.set(p, term.id);
    if (pid === p) requestAnimationFrame(() => x.view.focus());
  } catch (e) {
    tabs.delete(key); x.view.dispose(); x.host.remove();
    if (active.get(p) === key) { if (before && tabs.has(before)) active.set(p, before); else active.delete(p); }
    if (split.get(p) === key) split.delete(p);
    if (!of(p).length && !wasOpen) setOpen(p, false);
    toast(e instanceof Error ? e.message : String(e));
  }
  opening--; paint(); sideSoon();
}

/** Ferme un terminal (confirmation s'il travaille) ; le dernier fermé replie le tiroir. */
export async function close(id: string, ask = true): Promise<void> {
  const x = tabs.get(id); if (!x) return;
  if (ask && x.t.alive && x.t.busy && !await confirmBox({ title: 'Fermer ce terminal ?', text: tr(`« ${label(x)} » est encore en train de travailler : il sera arrêté.`), ok: 'Fermer', danger: true })) return;
  const p = x.t.project, list = of(p), i = list.indexOf(x), hadFocus = x.view.hasFocus();
  void call('close', { term: id }, p).catch(() => undefined);
  tabs.delete(id); x.view.dispose(); x.host.remove(); delete names[id]; save(NAME_KEY, names);
  if (split.get(p) === id) split.delete(p);
  if (active.get(p) === id) {
    const s = split.get(p), next = s ?? list[i + 1]?.t.id ?? list[i - 1]?.t.id;
    if (s) split.delete(p);
    if (next && next !== id) active.set(p, next); else active.delete(p);
  }
  if (focused.get(p) === id) focused.delete(p);
  if (!of(p).length) { setOpen(p, false); max = false; }
  paint(); sideSoon();
  if (hadFocus) focusCurrent();
}

/** ⌘W (contrat D) : ferme le terminal qui a le focus ; true s'il y en avait un (la fenêtre reste ouverte). */
export function closeFocused(): boolean {
  const x = [...tabs.values()].find(t => t.t.id && t.view.hasFocus());
  if (!x) return false;
  void close(x.t.id);
  return true;
}

function rename(id: string): void {
  const x = tabs.get(id); if (!x) return;
  const tab = root && $(`.tmd-tab[data-id="${CSS.escape(id)}"] .tmd-name`, root);
  if (!tab) return;
  const input = el<HTMLInputElement>(`<input class="tmd-rename" data-no-i18n aria-label="Nom du terminal" value="${esc(label(x))}" maxlength="40">`);
  tab.replaceWith(input); input.focus(); input.select();
  let done = false;
  const end = (keep: boolean) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (keep) { if (v) names[id] = v; else delete names[id]; save(NAME_KEY, names); }
    paint(true); sideSoon(); x.view.focus();
  };
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } if (e.key === 'Escape') { e.preventDefault(); end(false); } });
  input.addEventListener('blur', () => end(true));
}

// ---------- Moka (Salon) ----------
/** Fil du Salon lié : celui de l'agent si le terminal est dans sa copie, sinon le fil ouvert. */
const threadOf = (x: Tab): string => (x.t.where === 'copy' && x.t.name ? salon.threadOfCopy(x.t.project, x.t.name) : '') || salon.openThreadOf(x.t.project);
const mask = (s: string) => safePatch(s).replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|KEY))=("[^"]*"|'[^']*'|\S+)/g, '$1=[secret masqué]');
function fence(s: string): string { const f = '`'.repeat(Math.max(3, ...[...s.matchAll(/`{3,}/g)].map(m => m[0].length + 1))); return `${f}text\n${s}\n${f}`; }
const clean = (s: string) => mask(s.replace(/\s+$/, '').replace(/^\s*\n/, ''));
const cmdOf = (x: Tab) => x.run?.cmd || x.done?.cmd || x.t.cmd || x.t.fg || label(x);

async function sendToMoka(x: Tab): Promise<void> {
  const out = clean(x.view.selection() || x.view.tail(200));
  if (!out) { toast('Rien à envoyer : le terminal est vide.'); return; }
  const text = `${tr(`Sortie de \`${mask(cmdOf(x))}\` (${short(x.cwd || x.t.cwd, x.t.project)}) :`)}\n\n${fence(out)}`;
  await salon.prefill(x.t.project, threadOf(x), text);
}
async function askFix(x: Tab): Promise<void> {
  const f = x.fail; if (!f) return;
  const out = clean(x.view.tail(60));
  const text = tr(`La commande \`${mask(f.cmd)}\` a échoué (code ${f.code}) dans ${short(f.cwd, x.t.project)}. Trouve la cause et corrige-la.`) + (out ? `\n\n${tr('Fin de la sortie :')}\n\n${fence(out)}` : '');
  await salon.prefill(x.t.project, threadOf(x), text);
}

// ---------- Menus ----------
async function targets(p: string): Promise<Targets | null> {
  try {
    const r = await call('targets', {}, p, 8000);
    if (!r.ok) throw new Error(r.message);
    const t: Targets = { home: String(r.home ?? ''), repos: (r.repos as Targets['repos']) ?? [], copies: (r.copies as Targets['copies']) ?? [], servers: (r.servers as Targets['servers']) ?? [], scripts: (r.scripts as Targets['scripts']) ?? [] };
    targetsOf.set(p, t); return t;
  } catch { return targetsOf.get(p) ?? null; }
}
/** Commandes enregistrées (blocs ```commandes) des notes du projet. */
function savedOf(p: string): { label: string; cmd: string }[] {
  const pr = projectsModel.byId(p); if (!pr) return [];
  const ids = new Set(projectsModel.notesOf(pr).map(n => n.id));
  return savedCommands.all().filter(({ note }) => ids.has(note.id)).map(({ c }) => ({ label: c.label || c.cmd.split('\n')[0] || '', cmd: c.cmd.replace(/\\\n\s*/g, ' ') })).slice(0, 8);
}
function targetItems(p: string, t: Targets | null): MenuItem[] {
  const items: MenuItem[] = [{ label: 'Nouveau terminal', icon: 'terminal', keys: 'mod+t', run: () => openIn(p, here(p)) }];
  if (!t) return [...items, { label: 'Dépôts et copies indisponibles' }];
  const places: MenuItem[] = [
    ...t.repos.map(r => ({ label: r.name, icon: 'folder', hint: short(r.dir, p), run: () => openIn(p, { where: 'repo', name: r.name }) })),
    ...t.copies.map(c => ({ label: c.name.replace(/^studio-/, ''), icon: 'pr', hint: c.branch, run: () => openIn(p, { where: 'copy', name: c.name }) })),
    ...t.servers.map(s => ({ label: s.name, icon: 'server', hint: 'SSH', run: () => openIn(p, { where: 'ssh', name: s.id }) })),
  ];
  if (places.length) items.push('-', { label: 'Ouvrir dans' }, ...places);
  if (t.scripts.length) items.push('-', { label: 'Lancer' }, ...t.scripts.slice(0, 12).map(s => ({ label: s.name, icon: 'play', hint: s.repo ? `${s.repo} · ${s.cmd.split(' ')[0]}` : s.cmd.split(' ')[0], run: () => openIn(p, s.repo ? { where: 'repo', name: s.repo, cmd: s.cmd } : { where: 'project', cmd: s.cmd }) })));
  const saved = savedOf(p);
  if (saved.length) items.push('-', { label: 'Commandes enregistrées' }, ...saved.map(c => ({ label: c.label.slice(0, 48), icon: 'terminal', run: () => openIn(p, { ...here(p), cmd: c.cmd }) })));
  return items;
}
/** Même endroit que le terminal affiché (un nouvel onglet dans une copie reste dans la copie). */
function here(p: string): Spec {
  const x = cur(p);
  return x && x.t.where !== 'ssh' ? { where: x.t.where as Spec['where'], ...(x.t.name ? { name: x.t.name } : {}) } : { where: 'project' };
}
/** Menu « + » du tiroir (ou de la palette) : dossiers, copies, serveurs, scripts, commandes enregistrées. */
export async function openMenu(p = pid): Promise<void> {
  if (!available() || !p) return;
  if (p !== pid) await ctx?.setView({ type: 'projets', project: p });
  if (!isOpen(p)) { setOpen(p, true); paint(); }
  const btn = root && $<HTMLElement>('[data-tm="add"]', root);
  const t = targetsOf.get(p) ? (void targets(p), targetsOf.get(p) ?? null) : await targets(p);
  if (!btn || !btn.isConnected) return;
  btn.setAttribute('aria-expanded', 'true');
  const layer = menu(btn, targetItems(p, t));
  const obs = new MutationObserver(() => { if (!layer.node.isConnected) { btn.setAttribute('aria-expanded', 'false'); obs.disconnect(); } });
  obs.observe(need('#layer'), { childList: true });
}
function tabMenu(anchor: Element | { x: number; y: number }, id: string): void {
  const x = tabs.get(id); if (!x) return;
  menu(anchor, [
    { label: 'Renommer…', icon: 'compose', run: () => { show(x.t.project, id); requestAnimationFrame(() => rename(id)); } },
    ...(ctx?.salonOn() ? [{ label: 'Envoyer à Moka', icon: 'sparkle', run: () => sendToMoka(x) }] : []),
    { label: 'Effacer l’écran', icon: 'refresh', run: () => x.view.clear() },
    '-',
    { label: 'Fermer le terminal', icon: 'x', danger: true, run: () => close(id) },
  ]);
}
/** Menu d'une ligne de terminal de la barre latérale (bouton « … » ou clic droit). */
export function sideMenu(anchor: Element | { x: number; y: number }, p: string, id: string): void {
  if (!tabs.has(id)) return;
  menu(anchor, [
    { label: 'Ouvrir', icon: 'terminal', run: () => show(p, id) },
    { label: 'Renommer…', icon: 'compose', run: () => { show(p, id); requestAnimationFrame(() => rename(id)); } },
    '-',
    { label: 'Fermer le terminal', icon: 'x', danger: true, run: () => close(id) },
  ]);
}

// ---------- Affichage ----------
const cur = (p = pid): Tab | undefined => { const f = focused.get(p), a = active.get(p); return tabs.get(f && (f === a || f === split.get(p)) ? f : a ?? ''); };
function focusCurrent(): void { const x = cur(); if (x && shown()) requestAnimationFrame(() => x.view.focus()); }

/** Montre le tiroir du projet `p` sur l'onglet `id` (clic dans la barre latérale). */
export async function show(p: string, id?: string): Promise<void> {
  if (!available()) return;
  if (p !== pid) await ctx?.setView({ type: 'projets', project: p });
  if (id && tabs.has(id) && split.get(p) !== id) active.set(p, id);
  setOpen(p, true); paint();
  const x = id ? tabs.get(id) : cur(p);
  if (x) { focused.set(p, x.t.id); requestAnimationFrame(() => x.view.focus()); }
}

let paintT = 0;
function soon(): void { if (!paintT) paintT = requestAnimationFrame(() => { paintT = 0; paint(); }); }
let sideT = 0;
function sideSoon(): void { clearTimeout(sideT); sideT = window.setTimeout(() => ctx?.renderSidebar(), 120); }

function tabHTML(x: Tab, sel: boolean, side: boolean): string {
  const st = state(x), id = esc(x.t.id), port = x.ports[0];
  return `<div class="tmd-tab${sel ? ' sel' : ''}${side ? ' side' : ''}" role="tab" tabindex="${sel ? 0 : -1}" aria-selected="${sel}" data-id="${id}" title="${esc(STATE_TIP[st])}">`
    + `<i class="tmd-dot tmd-st-${st}" aria-hidden="true"></i><span class="tmd-name" data-no-i18n>${esc(label(x))}</span>`
    + (port ? `<button class="tmd-port" data-port="${port}" title="Ouvrir l’aperçu" data-no-i18n>:${port}</button>` : '')
    + `<button class="tmd-x" data-x="${id}" tabindex="-1" aria-label="Fermer le terminal" title="Fermer le terminal">${icon('x')}</button></div>`;
}

function footHTML(x: Tab | undefined): string {
  if (!x) return '';
  const st = state(x), path = x.cwd || x.t.cwd, salonOn = !!ctx?.salonOn();
  const info = x.run ? `<span data-no-i18n>${esc(x.run.cmd.slice(0, 60))}</span><span>en cours</span>`
    : !x.t.alive && x.t.id ? `<span>${x.t.exit && x.t.exit !== SIGINT ? `échec, code ${x.t.exit}` : 'terminé'}</span>`
    : x.done ? `<span data-no-i18n>${esc(x.done.cmd.slice(0, 60))}</span><span class="tmd-st-${st}">${x.done.code && x.done.code !== SIGINT ? `échec, code ${x.done.code}` : x.done.ms >= 1000 ? `terminé en ${dur(x.done.ms)}` : 'terminé'}</span>` : '';
  return `<code class="tmd-cwd" data-no-i18n title="${esc(path)}">&lrm;${esc(short(path, x.t.project) || '…')}</code>${info ? `<span class="tmd-info">${info}</span>` : ''}<span class="tmd-sp"></span>`
    + (!x.t.alive && x.t.id && x.t.cmd ? `<button class="btn btn-ghost tmd-fbtn" data-tm="again">${icon('refresh')}Relancer</button>` : '')
    + (salonOn && x.t.id ? `<button class="btn btn-ghost tmd-fbtn" data-tm="moka" title="La sélection, ou les 200 dernières lignes, dans le composeur du Salon">${icon('share')}Envoyer à Moka</button>` : '')
    + (salonOn && x.fail ? `<button class="btn tmd-fbtn tmd-fix" data-tm="fix">${icon('sparkle')}Demander à Moka de corriger</button>` : '');
}
function paintFoot(): void { if (root) paintIfChanged(need('.tmd-foot', root), footHTML(cur())); }

function paint(force = false): void {
  if (!root) return;
  const on = available() && isOpen(pid);
  const was = !root.hidden;
  root.hidden = !on;
  document.body.classList.toggle('tmd-on', on);
  document.body.classList.toggle('tmd-max', on && max);
  root.style.setProperty('--tmd-h', `${clampH(height)}px`);
  if (on && !was) { root.classList.remove('tmd-enter'); void root.offsetWidth; root.classList.add('tmd-enter'); }
  const list = on ? of(pid) : [], a = active.get(pid), s = split.get(pid) && split.get(pid) !== a ? split.get(pid) : undefined;
  for (const x of tabs.values()) {
    const id = tabs.get(x.t.id) === x ? x.t.id : [...tabs.entries()].find(([, v]) => v === x)?.[0];
    const vis = on && x.t.project === pid && (id === a || id === s);
    if (x.host.hidden === vis) x.host.hidden = !vis;
    x.host.style.order = id === s ? '2' : '1';
  }
  need('.tmd-panes', root).classList.toggle('tmd-split', !!s);
  const tablist = need('.tmd-tabs', root);
  const had = document.activeElement?.closest<HTMLElement>('.tmd-tab')?.dataset.id;
  if (force || !document.activeElement?.matches('.tmd-rename')) paintIfChanged(tablist, list.filter(x => x.t.id).map(x => tabHTML(x, x.t.id === a, x.t.id === s)).join(''));
  if (had && !tablist.contains(document.activeElement)) $<HTMLElement>(`.tmd-tab[data-id="${CSS.escape(had)}"]`, tablist)?.focus(); // le focus clavier survit au repeint
  // États : chargement (liste ou ouverture), erreur, vide.
  const busy = listing.has(pid) && !list.length, err = failed.get(pid), empty = !busy && !err && !list.length && !opening;
  const stEl = need('.tmd-state', root);
  stEl.hidden = !(busy || err || empty);
  paintIfChanged(stEl, busy ? '<span class="spin"></span><span>Ouverture du terminal…</span>'
    : err ? `<span class="tmd-err">${esc(err)}</span><button class="btn" data-tm="retry">${icon('refresh')}Réessayer</button>`
    : empty ? `<span>Aucun terminal dans ce projet.</span><button class="btn" data-tm="new">${icon('terminal')}Nouveau terminal</button>` : '');
  const splitBtn = need('[data-tm="split"]', root), maxBtn = need('[data-tm="max"]', root);
  splitBtn.setAttribute('aria-pressed', String(!!s)); maxBtn.setAttribute('aria-pressed', String(max));
  splitBtn.classList.toggle('on', !!s); maxBtn.classList.toggle('on', max);
  paintFoot();
}

const clampH = (h: number) => Math.round(Math.max(120, Math.min(h, innerHeight - 160)));
function setH(h: number): void { height = clampH(h); root?.style.setProperty('--tmd-h', `${height}px`); }

// ---------- Actions ----------
function toggle(): void {
  if (!pid) return;
  if (isOpen(pid) && shown()) {
    const inside = root?.contains(document.activeElement);
    if (!inside && of(pid).length) { focusCurrent(); return; } // ⌘J depuis la page : va au terminal
    setOpen(pid, false); max = false; paint();
    ($('#main') as HTMLElement | null)?.focus?.({ preventScroll: true });
    return;
  }
  if (!of(pid).length && listed.has(pid) && !listing.has(pid)) { void openIn(pid); return; }
  setOpen(pid, true); paint(); focusCurrent();
}
function toggleMax(): void { if (!pid) return; if (!isOpen(pid)) setOpen(pid, true); max = !max; paint(); focusCurrent(); }
function toggleSplit(): void {
  if (!pid) return;
  if (split.get(pid)) { split.delete(pid); paint(); focusCurrent(); return; }
  void openIn(pid, here(pid), true);
}
function pick(id: string): void {
  if (!pid || !tabs.has(id)) return;
  if (split.get(pid) === id) { focused.set(pid, id); paint(); focusCurrent(); return; }
  active.set(pid, id); focused.set(pid, id); paint(); focusCurrent();
}

/** Raccourcis du tiroir, appelé en tête du keydown global : true si l'événement est traité (ou appartient au terminal). */
export function key(e: KeyboardEvent): boolean {
  const inTm = !!root && e.target instanceof Node && root.contains(e.target);
  if (inTm && e.defaultPrevented) return true; // touche déjà envoyée au shell (Ctrl+K, Échap…) : rien d'autre ne la prend
  if (!available() || topLayer() || !pid) return false;
  const go = (fn: () => void) => { e.preventDefault(); fn(); return true; };
  if (matches(e, 'mod+shift+j')) return go(toggleMax);
  if (matches(e, 'mod+j')) return go(toggle);
  if (!isOpen(pid) || !shown()) return false;
  if (matches(e, 'mod+t')) return go(() => void openIn(pid, here(pid)));
  if (matches(e, 'mod+d') && inTm) return go(toggleSplit);
  if (inTm && /^[1-9]$/.test(e.key) && matches(e, `mod+${e.key}`)) {
    const x = of(pid).filter(t => t.t.id)[Number(e.key) - 1];
    return go(() => { if (x) pick(x.t.id); });
  }
  return false;
}

/** Suit la vue de l'app (appelé à chaque rendu) : le tiroir est celui du projet affiché. */
export function follow(v: ViewState): void {
  if (!available() || !root) return;
  const p = v.type === 'projets' && v.project ? v.project : '';
  if (p === pid) return;
  if (root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  pid = p;
  if (p && !listed.has(p)) void list(p);
  paint();
}

/** Lignes de terminaux sous un projet de la barre latérale : pastille d'état, port ; un clic ouvre le tiroir sur l'onglet. */
export function sideHTML(p: string): string {
  if (!available()) return '';
  if (!listed.has(p) && !listing.has(p) && !failed.has(p)) void list(p);
  return of(p).filter(x => x.t.id).map(x => {
    const st = state(x), port = x.ports[0];
    const mark = st === 'run' ? '<i class="ss-live on"></i>' : st === 'err' ? '<i class="ss-live tmd-bad"></i>' : icon(x.t.where === 'ssh' ? 'server' : x.t.cmd ? 'play' : 'terminal');
    return `<button class="side-item side-sub2 side-term" data-pj-open="${esc(p)}" data-pj-term="${esc(x.t.id)}" title="${esc(`${label(x)} · ${tr(STATE_TIP[st])}`)}">${mark}<span data-no-i18n>${esc(label(x))}</span>`
      + (port ? `<em class="side-stage tmd-sport" data-no-i18n>:${port}</em>` : '')
      + `<i class="side-more" data-side-more role="button" aria-label="Actions">${icon('more')}</i></button>`;
  }).join('');
}

// ---------- Montage ----------
export function init(c: Ctx): void {
  ctx = c;
  if (!available() || root) return;
  root = el<HTMLElement>(`<section id="tmd" class="tmd" aria-label="Terminaux" hidden>
    <div class="tmd-grip" role="separator" aria-orientation="horizontal" aria-label="Hauteur du tiroir" tabindex="0"></div>
    <header class="tmd-head">
      <div class="tmd-tabs" role="tablist" aria-label="Terminaux"></div>
      <button class="icon-btn tmd-add" data-tm="add" aria-haspopup="menu" aria-expanded="false" aria-label="Nouveau terminal ou dossier" title="Nouveau terminal, ou ouvrir dans un dépôt, une copie, un serveur">${icon('plus')}</button>
      <span class="tmd-sp"></span>
      <button class="icon-btn" data-tm="split" aria-pressed="false" aria-label="Deux terminaux côte à côte" title="Deux terminaux côte à côte">${icon('split')}</button>
      <button class="icon-btn" data-tm="max" aria-pressed="false" aria-label="Agrandir le tiroir" title="Agrandir le tiroir">${icon('focus')}</button>
      <button class="icon-btn" data-tm="hide" aria-label="Masquer le tiroir" title="Masquer le tiroir">${icon('chevron')}</button>
    </header>
    <div class="tmd-body"><div class="tmd-panes"></div><div class="tmd-state" role="status" hidden></div></div>
    <footer class="tmd-foot"></footer>
  </section>`);
  need('#main').after(root);

  root.addEventListener('click', e => {
    const t = target(e);
    const port = t.closest<HTMLElement>('[data-port]');
    if (port) { e.stopPropagation(); openURL(pid, `http://localhost:${port.dataset.port}/`); return; }
    const x = t.closest<HTMLElement>('[data-x]');
    if (x) { e.stopPropagation(); void close(x.dataset.x ?? ''); return; }
    const tab = t.closest<HTMLElement>('.tmd-tab');
    if (tab && !t.closest('.tmd-rename')) { pick(tab.dataset.id ?? ''); return; }
    const act = t.closest<HTMLElement>('[data-tm]')?.dataset.tm, c0 = cur();
    if (act === 'add') void openMenu();
    else if (act === 'new') void openIn(pid);
    else if (act === 'retry') void list(pid);
    else if (act === 'split') toggleSplit();
    else if (act === 'max') toggleMax();
    else if (act === 'hide') { setOpen(pid, false); max = false; paint(); }
    else if (act === 'moka' && c0) void sendToMoka(c0);
    else if (act === 'fix' && c0) void askFix(c0);
    else if (act === 'again' && c0) { const s: Spec = { where: c0.t.where as Spec['where'], ...(c0.t.name ? { name: c0.t.name } : {}), cmd: c0.t.cmd }; void close(c0.t.id, false).then(() => openIn(pid, s)); }
  });
  root.addEventListener('dblclick', e => {
    const tab = target(e).closest<HTMLElement>('.tmd-tab');
    if (tab && !target(e).closest('button')) rename(tab.dataset.id ?? '');
    else if (target(e).closest('.tmd-grip')) toggleMax();
  });
  root.addEventListener('contextmenu', e => {
    const tab = target(e).closest<HTMLElement>('.tmd-tab'); if (!tab) return;
    e.preventDefault(); tabMenu({ x: e.clientX, y: e.clientY }, tab.dataset.id ?? '');
  });
  root.addEventListener('auxclick', e => { const tab = target(e).closest<HTMLElement>('.tmd-tab'); if (tab && e.button === 1) { e.preventDefault(); void close(tab.dataset.id ?? ''); } });
  // Onglets au clavier : flèches entre onglets, Entrée ou Espace pour afficher, Suppr pour fermer.
  need('.tmd-tabs', root).addEventListener('keydown', e => {
    const tab = target(e).closest<HTMLElement>('.tmd-tab'); if (!tab || target(e).closest('.tmd-rename')) return;
    const all = $$<HTMLElement>('.tmd-tab', need('.tmd-tabs', need('#tmd'))), i = all.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]?.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(tab.dataset.id ?? ''); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); void close(tab.dataset.id ?? ''); }
    else if (e.key === 'F2') { e.preventDefault(); rename(tab.dataset.id ?? ''); }
  });
  // Poignée : glisser (bornée), flèches au clavier, double-clic pour agrandir.
  const grip = need('.tmd-grip', root);
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = height; max = false; paint();
    root?.classList.add('tmd-drag');
    const move = (ev: PointerEvent) => setH(h0 + (y0 - ev.clientY));
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); root?.classList.remove('tmd-drag'); save(H_KEY, height); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault(); setH(height + (e.key === 'ArrowUp' ? 24 : -24)); save(H_KEY, height);
  });
  addEventListener('resize', () => { if (shown()) setH(height); });
  salon.onTerminal((p, wt) => void openIn(p, { where: 'copy', name: wt }));
  follow(c.viewState());
}

// Palette : entrées offertes quand un projet est affiché dans l'app Mac.
export const project = (): string => (available() ? pid : '');
export const newTerm = (): Promise<void> => openIn(pid, here(pid));
