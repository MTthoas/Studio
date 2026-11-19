// Espace agents : tous les agents Claude Code de tous les projets, organisés comme Linear.
// À gauche, la liste des conversations, regroupées par état (En cours, À relire, Récentes) et filtrables. À droite,
// une grille de 1, 2, 3, 4, 6 ou 8 vues : chacune suit un agent en direct, avec son propre champ pour lui répondre,
// ou lance un nouvel agent dans le projet choisi. « Diffuser » envoie la même consigne à plusieurs vues à la fois.
// Tout passe par le Mac où se trouvent les dossiers des projets (remote.ts : ce Mac, ou un Mac lié).
// Clavier (hors champ de saisie) : 1-8 choisit une vue, J/K parcourt la liste, Entrée l'ouvre dans la vue choisie,
// Par défaut (« Auto », `st.auto`), chaque agent qui travaille, dans n'importe quel projet, reçoit sa vue (`autoShow`).
// C crée un agent, F agrandit la vue, X la vide, L change de disposition, / cherche, D diffuse, T tableau d'équipe.
// Chaque vue porte aussi la copie de son agent (étape, branche) et tous ses gestes : publier (commit, push, PR),
// mettre à jour, fusionner dans la branche mère d'un groupe, revue, VS Code, nouvelle branche, suppression
// (copyStrip / copyAct de sessions.ts). Le tableau d'équipe (AgentBoard, Agents.swift) montre ce que l'agent, ses
// sous-agents et les agents de son groupe s'écrivent, et l'utilisateur peut leur y laisser une consigne.
import * as bridge from '../integrations/remote.ts';
import * as projects from './projects/model.ts';
import * as subagents from './projects/subagents.ts';
import { feedBlocks, syncFeed, nameOf, live, STATUS, modelName, agentCount, COUNT_HINT, newGroup, copyStrip, copyAct, COPY_ACTS, groupOfCopy } from './projects/sessions.ts';
import type { AgentRun, Session, Action, Queued, Worktree } from './projects/sessions.ts';
import type { Project } from './projects/model.ts';
import { esc, renderMarkdown } from '../lib/markdown.ts';
import { fold } from '../lib/fuzzy.ts';
import { $, $$, icon, kbd, rel, modal, need, toast, target, paintIfChanged, menu } from '../ui/kit.ts';

/** Une vue : la conversation qu'elle suit (`session`), ou un agent qui démarre (`run`), ou rien (nouvel agent). */
interface Pane { project: string; session: string; run?: string }
interface State { layout: number; panes: (Pane | null)[]; focus: number; max: number; filter: string; draftProject: string; /** Montrer d'office les agents qui travaillent. */ auto: boolean; /** Barre de la liste réduite à une colonne d'icônes (réduction visuelle seulement). */ mini: boolean; /** Conversations au travail que l'utilisateur a retirées de leur vue : pas remises d'office tant qu'elles travaillent. */ dismissed: string[] }
interface Detail extends Partial<Session> { actions: Action[]; message?: string; at: number }
interface Row { p: Project; s: Session; status: 'running' | 'error' | 'review' | 'idle' }

export const LAYOUTS = [1, 2, 3, 4, 6, 8];
const KEY = 'studio.workspace', SEEN = 'studio.workspace.seen', TICK = 2500;
const read = <T>(k: string, d: T): T => { try { return (JSON.parse(localStorage.getItem(k) || 'null') as T | null) ?? d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* plein */ } };

const st: State = { layout: 4, panes: [], focus: 0, max: -1, filter: '', draftProject: '', auto: true, mini: false, dismissed: [], ...read<Partial<State>>(KEY, {}) };
if (!LAYOUTS.includes(st.layout)) st.layout = 4;
/** Dernière activité vue, par conversation : ce qui a bougé depuis passe dans « À relire ». */
const seen: Record<string, number> = read(SEEN, {});
/** Première ouverture : tout ce qui existe déjà compte comme vu, sinon « À relire » serait rempli d'anciennes conversations. */
let firstUse = !Object.keys(seen).length;
const save = () => write(KEY, { layout: st.layout, panes: st.panes.slice(0, 8), focus: st.focus, max: st.max, filter: st.filter, draftProject: st.draftProject, auto: st.auto, mini: st.mini, dismissed: st.dismissed.slice(-100) });

const sessionsBy = new Map<string, { list: Session[]; at: number }>();
const runsBy = new Map<string, AgentRun[]>();
const queuedBy = new Map<string, Queued[]>();
const details = new Map<string, Detail>();
/** Copies des agents, par projet (relues toutes les 15 s pour les projets affichés, et après chaque geste). */
const treesBy = new Map<string, { list: Worktree[]; at: number }>();
/** Tableau d'équipe, par projet et copie (`projet/copie`) ; `open` : vues (par conversation) qui l'affichent. */
interface BoardFile { name: string; text: string; at: number }
const boards = new Map<string, { files: BoardFile[]; at: number; missing?: boolean }>();
const boardOpen = new Set<string>(read<string[]>('studio.workspace.boards', []));
let root: HTMLElement | null = null, timer: ReturnType<typeof setInterval> | undefined, tick = 0, cursor = 0, listing = false;
/** Conversations d'agents déjà réclamées à la liste du Mac (relue une fois pour chacune, pas à chaque tour). */
const asked = new Set<string>();

const ms = (iso?: string) => Date.parse(iso || '') || 0;
const pkey = (p: Pane) => `${p.project}/${p.session}`;
const proj = (id: string) => projects.projects().find(p => p.id === id);
const panes = (): (Pane | null)[] => Array.from({ length: st.layout }, (_, i) => st.panes[i] ?? null);

// ---------- Données ----------
function rows(): Row[] {
  const out: Row[] = [];
  for (const p of projects.projects()) {
    const runs = runsBy.get(p.id) ?? [];
    // Les agents lancés (ici, dans l'onglet Claude Code ou ailleurs) dont la conversation n'est pas encore dans la liste
    // du Mac : affichés tout de suite d'après leur lancement, sans attendre la relecture des journaux.
    const listed = sessionsBy.get(p.id)?.list ?? [], known = new Set(listed.map(s => s.id));
    const fresh = runs.filter(r => r.session && !known.has(r.session) && (live(r) || Date.now() - ms(r.finished || r.started) < 36e5))
      .filter((r, i, l) => l.findIndex(x => x.session === r.session) === i)
      .map((r): Session => ({ id: r.session, title: r.prompt, firstPrompt: r.prompt, branch: '', worktree: r.worktree, started: r.started, updated: r.finished || r.started, active: r.finished || r.started, live: live(r), models: [], prompts: 1, lastPrompt: r.prompt, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: {}, files: [] }));
    for (const s of [...listed, ...fresh]) {
      const mine = runs.filter(r => r.session === s.id), last = mine.reduce<AgentRun | undefined>((a, r) => !a || ms(r.started) > ms(a.started) ? r : a, undefined);
      const act = ms(s.active || s.updated);
      const status = mine.some(live) || s.live ? 'running' : last?.status === 'error' ? 'error' : act > (seen[s.id] ?? 0) && Date.now() - act < 3 * 864e5 ? 'review' : 'idle';
      out.push({ p, s, status });
    }
  }
  return out.sort((a, b) => ms(b.s.active || b.s.updated) - ms(a.s.active || a.s.updated));
}

async function loadSessions(p: Project): Promise<void> {
  const r = await bridge.call('project', 'sessions', { project: p.id }, 20000);
  if (!r.ok) return;
  const list = r.found ? (r.sessions as Session[] | undefined) ?? [] : [];
  sessionsBy.set(p.id, { list, at: Date.now() });
  if (firstUse) { for (const x of list) if (!x.live) seen[x.id] = ms(x.active || x.updated); write(SEEN, seen); }
}
async function loadRuns(pid: string): Promise<void> {
  const l = await bridge.call('agent', 'list', { project: pid }, 10000);
  if (!l.ok) return;
  runsBy.set(pid, (l.runs as AgentRun[] | undefined) ?? []);
  queuedBy.set(pid, (l.queued as Queued[] | undefined) ?? []);
}
async function loadTrees(pid: string): Promise<void> {
  const r = await bridge.call('agent', 'worktrees', { project: pid }, 30000);
  if (r.ok) treesBy.set(pid, { list: (r.worktrees as Worktree[] | undefined) ?? [], at: Date.now() });
}
async function loadBoard(pid: string, wt: string): Promise<void> {
  const r = await bridge.call('agent', 'board', { project: pid, worktree: wt }, 10000);
  boards.set(`${pid}/${wt}`, r.ok ? { files: (r.files as BoardFile[] | undefined) ?? [], at: Date.now() } : { files: [], at: Date.now(), missing: true });
}
/** Copie où travaille l'agent d'une vue : celle de sa conversation, sinon celle de son lancement. */
function paneTree(x: Pane): string {
  const d = details.get(pkey(x));
  if (d?.worktree) return d.worktree;
  const r = (runsBy.get(x.project) ?? []).filter(y => (!!x.session && y.session === x.session) || (!!x.run && y.run === x.run)).find(y => y.worktree);
  return r?.worktree ?? '';
}
async function loadDetail(p: Pane): Promise<void> {
  const d = await bridge.call('project', 'session', { project: p.project, session: p.session }, 20000);
  details.set(pkey(p), d.ok ? { ...(d as unknown as Partial<Session>), id: p.session, actions: (d.actions as Action[] | undefined) ?? [], at: Date.now() } : { actions: [], message: d.message ?? 'Conversation introuvable.', at: Date.now() });
}

async function refresh(): Promise<void> {
  if (!root?.isConnected) { stop(); return; }
  // Fenêtre cachée : aucun appel au Mac ; le tour suivant (2,5 s au plus après le retour) rattrape tout.
  if (document.hidden) return;
  const all = projects.projects(), shown = panes().filter((x): x is Pane => !!x);
  // Les agents (lecture en mémoire sur le Mac, rapide) : à chaque tour pour les projets affichés ou qui travaillent, un tour sur deux pour les autres.
  const busy = new Set([...shown.map(x => x.project), ...[...runsBy].filter(([, l]) => l.some(live)).map(([k]) => k)]);
  await Promise.all(all.filter(p => busy.has(p.id) || tick % 2 === 0).map(p => loadRuns(p.id)));
  // Un agent dont la conversation manque à la liste : la liste de son projet est relue tout de suite (une fois par agent).
  for (const p of all) {
    const known = new Set((sessionsBy.get(p.id)?.list ?? []).map(s => s.id));
    const missing = (runsBy.get(p.id) ?? []).filter(r => r.session && !known.has(r.session) && !asked.has(r.session));
    if (missing.length && sessionsBy.has(p.id)) { missing.forEach(r => asked.add(r.session)); void loadSessions(p).then(paintList); }
  }
  // Une vue qui attend son agent : la conversation apparaît dès que le Mac l'a créée.
  for (const x of shown) if (!x.session && x.run) { const r = runsBy.get(x.project)?.find(y => y.run === x.run); if (r?.session) { x.session = r.session; save(); } }
  // Les fils : à chaque tour tant que l'agent travaille, une fois sur quatre au repos.
  await Promise.all(shown.filter(x => x.session).map(x => {
    const d = details.get(pkey(x)), working = d?.live || (runsBy.get(x.project) ?? []).some(r => r.session === x.session && live(r));
    return !d || working || tick % 4 === 0 ? loadDetail(x) : Promise.resolve();
  }));
  // Les copies des projets affichés (étape, branche, gestes possibles) : toutes les 15 s, et tout de suite pour un nouveau projet.
  const withTree = [...new Set(shown.filter(x => paneTree(x)).map(x => x.project))];
  // Une copie que la liste ne connaît pas encore (agent qui vient d'être lancé) fait relire son projet tout de suite.
  const unknown = (pid: string) => shown.some(x => x.project === pid && paneTree(x) && !treesBy.get(pid)?.list.some(t => t.name === paneTree(x)));
  await Promise.all(withTree.filter(pid => !treesBy.has(pid) || tick % 6 === 0 || (tick % 2 === 0 && unknown(pid))).map(loadTrees));
  // Les tableaux d'équipe ouverts : un tour sur deux.
  await Promise.all(shown.filter(x => boardOpen.has(pkey(x)) && paneTree(x)).map(x => {
    const k = `${x.project}/${paneTree(x)}`; return !boards.has(k) || tick % 2 === 0 ? loadBoard(x.project, paneTree(x)) : Promise.resolve();
  }));
  // La liste des conversations (lecture des journaux, la plus lente) : toutes les 30 s, un projet après l'autre.
  if (!listing && (tick % 12 === 0 || all.some(p => !sessionsBy.has(p.id)))) {
    listing = true;
    void (async () => { for (const p of all) { if (!root?.isConnected) break; await loadSessions(p); paintList(); } listing = false; firstUse = false; })();
  }
  tick++;
  autoShow();
  paint();
}
// Chaque ouverture relit tout de suite la liste des conversations (tick à 0), puis toutes les 30 s.
function start(): void { stop(); tick = 0; void refresh(); timer = setInterval(() => void refresh(), TICK); }
export function stop(): void { clearInterval(timer); timer = undefined; }

// ---------- Rendu ----------
const ICON: Record<Row['status'], string> = { running: '<span class="aw-ring"></span>', error: `<span class="aw-st err">${icon('x')}</span>`, review: '<span class="aw-st review"></span>', idle: `<span class="aw-st done">${icon('check')}</span>` };
const GROUPS: [Row['status'], string][] = [['running', 'En cours'], ['review', 'À relire'], ['error', 'En erreur'], ['idle', 'Récentes']];

/** Lettre de la conversation, pour la liste réduite. */
const initial = (t: string) => (t.match(/[\p{L}\p{N}]/u)?.[0] ?? '·').toUpperCase();
function paintList(): void {
  const box = root && $('.aw-list', root); if (!box) return;
  const q = fold(st.filter.trim()), open = new Map(panes().map((x, i) => [x?.session ?? '', i + 1]));
  const list = rows().filter(r => !q || fold(`${nameOf(r.s)} ${r.p.name}`).includes(q));
  const scroll = box.scrollTop;
  cursor = Math.min(cursor, Math.max(0, list.length - 1));
  let i = 0;
  const groups = GROUPS.map(([k, label]) => {
    const g = list.filter(r => r.status === k).slice(0, k === 'idle' ? 40 : 99);
    if (!g.length) return '';
    return `<div class="aw-group"><h4>${label}<span>${g.length}</span></h4>${g.map(r => {
      const n = open.get(r.s.id), idx = i++;
      return `<button class="aw-row${idx === cursor ? ' cur' : ''}${n ? ' shown' : ''}" draggable="true" data-row="${idx}" data-p="${esc(r.p.id)}" data-s="${esc(r.s.id)}" title="${esc(`${nameOf(r.s)} · ${r.p.name}`)}" aria-label="${esc(nameOf(r.s))}">${ICON[r.status]}<i class="aw-ini" style="--c:var(--c-${r.p.hue})" aria-hidden="true">${esc(initial(nameOf(r.s)))}</i><span class="aw-rt">${esc(nameOf(r.s))}</span><span class="aw-rp"><i class="tag-dot" style="--c:var(--c-${r.p.hue})"></i>${esc(r.p.name)}</span><time>${esc(rel(ms(r.s.active || r.s.updated)))}</time>${n ? `<b class="aw-in">${n}</b>` : ''}</button>`;
    }).join('')}</div>`;
  }).join('');
  const loading = projects.projects().some(p => !sessionsBy.has(p.id));
  // Réécrit seulement ce qui a changé : la liste est redemandée à chaque tour (2,5 s) et pendant la relecture des projets.
  if (paintIfChanged(box, groups || `<p class="aw-empty">${loading ? '<span class="spin"></span>Lecture des conversations…' : q ? 'Aucune conversation ne correspond.' : 'Aucune conversation pour l’instant. Lance un agent dans une vue.'}</p>`)) box.scrollTop = scroll;
  const counts = { running: list.filter(r => r.status === 'running').length, review: list.filter(r => r.status === 'review').length };
  const c = $('.aw-counts', root!); if (c) paintIfChanged(c, `${counts.running ? `<span class="aw-c run">${counts.running} en cours</span>` : ''}${counts.review ? `<span class="aw-c rev">${counts.review} à relire</span>` : ''}`);
}

const projectOptions = (cur: string) => projects.projects().map(p => `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
function newHTML(): string {
  const cur = proj(st.draftProject)?.id ?? projects.projects()[0]?.id ?? '';
  return `<form class="aw-new">
    <div class="aw-new-row"><label class="aw-sel">${icon('folder')}<select name="project" aria-label="Projet">${projectOptions(cur)}</select></label>
      <div class="cx-seg aw-mode" role="radiogroup" aria-label="Mode"><label><input type="radio" name="mode" value="edit" checked>${icon('pencil')}Modifier</label><label><input type="radio" name="mode" value="read">${icon('search')}Analyser</label></div></div>
    <textarea name="prompt" class="aw-big" placeholder="Décris ce que l’agent doit faire… ${COUNT_HINT}" aria-label="Consigne du nouvel agent"></textarea>
    <div class="aw-new-foot"><button type="button" class="btn btn-ghost aw-sub" data-w="sub" title="${esc(subagents.HINT)}">${icon('sparkle')}<span>${esc(subagents.label())}</span></button><span>ou glisse une conversation de la liste ici</span><button class="btn btn-primary">${icon('play')}Lancer ${kbd('mod+enter')}</button></div></form>`;
}
function paneShell(x: Pane | null, i: number): string {
  const act = (a: string, ic: string, t: string, k = '') => `<button type="button" class="icon-btn" data-w="${a}" title="${esc(t)}${k ? ` (${k})` : ''}" aria-label="${esc(t)}">${icon(ic)}</button>`;
  return `<header class="aw-ph"><b class="aw-num">${i + 1}</b><div class="aw-ph-main"></div><div class="aw-ph-acts">${x ? act('stop', 'stop', 'Arrêter l’agent') + act('team', 'board', 'Tableau d’équipe', 'T') + act('open', 'chevronRight', 'Ouvrir dans le projet') : ''}${act('max', 'focus', 'Agrandir', 'F')}${x ? act('close', 'x', 'Vider la vue', 'X') : ''}</div></header>
    ${x ? `<div class="aw-copy-slot"></div><div class="aw-body"><div class="ss-feed aw-feed" role="log" tabindex="0" aria-label="Fil de l’agent ${i + 1}"></div><aside class="aw-board" hidden aria-label="Tableau d’équipe de l’agent ${i + 1}"><div class="aw-board-list"></div><form class="aw-board-say"><input name="note" placeholder="Consigne pour l’équipe, lue à sa prochaine étape…" aria-label="Consigne pour l’équipe" maxlength="4000"><button class="btn" title="Ajouter au tableau (sans interrompre)">${icon('play')}</button></form></aside></div>
    <form class="aw-reply"><textarea name="prompt" rows="1" placeholder="Répondre à l’agent…" aria-label="Réponse à l’agent ${i + 1}"></textarea><button class="btn btn-primary" title="Envoyer (⌘↵) · ⇧⌘↵ interrompt le tour en cours">${icon('play')}</button></form>`
    : `<div class="aw-body aw-blank">${newHTML()}</div>`}`;
}
function headHTML(x: Pane | null): string {
  if (!x) return `<span class="aw-pt muted">Nouvel agent</span>`;
  const p = proj(x.project), d = details.get(pkey(x)), runs = (runsBy.get(x.project) ?? []).filter(r => r.session === x.session || (x.run && r.run === x.run));
  const run = runs.find(live) ?? runs.reduce<AgentRun | undefined>((a, r) => !a || ms(r.started) > ms(a.started) ? r : a, undefined);
  const working = !!runs.find(live) || !!d?.live;
  const title = d && d.id ? nameOf({ id: x.session, title: d.title ?? '', aiTitle: d.aiTitle, firstPrompt: d.firstPrompt, prompts: d.prompts ?? 0 }) : x.session ? 'Conversation' : 'L’agent démarre…';
  const [c, l] = working ? ['amber', 'En cours'] : run ? STATUS[run.status] ?? ['gray', run.status] : ['gray', 'Au repos'];
  return `<i class="ss-live${working ? ' on' : ''}"></i><span class="aw-pt" title="${esc(title)}">${esc(title)}</span>${p ? `<span class="aw-rp"><i class="tag-dot" style="--c:var(--c-${p.hue})"></i>${esc(p.name)}</span>` : ''}<span class="ag-pill${working ? ' live' : ''}" style="--c:var(--c-${c})">${l}</span>${d?.models?.length ? `<span class="aw-meta">${esc(modelName(d.models[d.models.length - 1] ?? ''))}</span>` : ''}`;
}

function paint(): void {
  if (!root) return;
  const grid = need('.aw-grid', root);
  grid.className = `aw-grid l${st.layout}${st.max >= 0 && st.max < st.layout ? ' maxed' : ''}`;
  $$('.aw-seg button', root).forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.layout) === st.layout)));
  const want = panes();
  // Les vues gardent leur DOM tant qu'elles suivent la même conversation : on ne perd ni le texte tapé ni le défilement.
  while (grid.children.length > want.length) grid.lastElementChild?.remove();
  want.forEach((x, i) => {
    let el = grid.children[i] as HTMLElement | undefined;
    const k = x ? (x.session ? pkey(x) : `run:${x.run ?? ''}`) : 'new';
    if (!el || el.dataset.k !== k) {
      const fresh = document.createElement('section');
      fresh.className = 'aw-pane'; fresh.dataset.i = String(i); fresh.dataset.k = k;
      fresh.innerHTML = paneShell(x, i);
      if (el) el.replaceWith(fresh); else grid.append(fresh);
      el = fresh;
    }
    el.classList.toggle('focus', i === st.focus); el.classList.toggle('max', i === st.max);
    const head = need('.aw-ph-main', el), h = headHTML(x);
    if (head.dataset.h !== h) { head.innerHTML = h; head.dataset.h = h; }
    if (!x) return;
    const feed = $('.aw-feed', el), d = x.session ? details.get(pkey(x)) : undefined;
    if (!feed) return;
    const runs = (runsBy.get(x.project) ?? []).filter(r => r.session === x.session || (x.run && r.run === x.run));
    const working = runs.some(live) || !!d?.live;
    $<HTMLButtonElement>('[data-w="stop"]', el)!.hidden = !runs.some(live);
    paintCopy(el, x, working);
    if (d?.message) { syncFeed(feed, [{ key: 'msg', html: `<p class="ss-cut">${esc(d.message)}</p>` }]); return; }
    const end = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    if (syncFeed(feed, feedBlocks(d?.actions ?? [], null, working || !d, (queuedBy.get(x.project) ?? []).filter(q => q.session === x.session))) && end) feed.scrollTop = feed.scrollHeight;
    if (d && x.session) { const a = ms(d.updated); if (a > (seen[x.session] ?? 0)) { seen[x.session] = a; write(SEEN, Object.fromEntries(Object.entries(seen).slice(-500))); } }
  });
  paintList();
}

/** Bandeau de la copie et tableau d'équipe d'une vue. */
function paintCopy(el: HTMLElement, x: Pane, working: boolean): void {
  const wt = paneTree(x), slot = $('.aw-copy-slot', el), board = $('.aw-board', el), team = $<HTMLButtonElement>('[data-w="team"]', el);
  const w = wt ? treesBy.get(x.project)?.list.find(t => t.name === wt) : undefined;
  if (slot) paintIfChanged(slot, w ? copyStrip(w, working) : '');
  if (team) team.hidden = !wt;
  if (!board) return;
  const open = !!wt && boardOpen.has(pkey(x));
  board.hidden = !open; team?.setAttribute('aria-pressed', String(open));
  if (!open) return;
  const b = boards.get(`${x.project}/${wt}`), list = need('.aw-board-list', board);
  const who = (n: string) => n === 'utilisateur.md' ? 'Toi' : n === 'principal.md' ? 'Agent principal' : n.replace(/\.md$/, '').replace(/^agent-(\d)$/, 'Agent $1').replace(/^agent-(\d)-/, 'Agent $1 · ');
  const g = groupOfCopy(wt);
  const empty = `<p class="aw-board-empty">${icon('board')}${b?.missing ? 'Pas de tableau pour cette copie (agent sur serveur, mode Analyser, ou app Mac à mettre à jour).' : `Le tableau se remplit quand l’agent découpe son travail en sous-agents${g ? ' ou que les agents du groupe partagent leurs découvertes' : ''}. Ta consigne ci-dessous y est lue à chaque étape, sans interrompre.`}</p>`;
  const html = !b ? '<p class="aw-board-empty"><span class="spin"></span>Lecture du tableau…</p>' : !b.files.length ? empty
    : b.files.map(f => `<article class="aw-note${f.name === 'utilisateur.md' ? ' me' : ''}"><header><b>${esc(who(f.name))}</b><time>${esc(rel(f.at))}</time></header><div class="md">${renderMarkdown(f.text)}</div></article>`).join('');
  const end = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  if (paintIfChanged(list, html) && end) list.scrollTop = list.scrollHeight;
}
async function boardNote(f: HTMLFormElement, i: number): Promise<void> {
  const x = panes()[i], input = need<HTMLInputElement>('input', f), text = input.value.trim(), wt = x ? paneTree(x) : '';
  if (!x || !text || !wt) return;
  const r = await bridge.call('agent', 'board', { project: x.project, worktree: wt, note: text }, 10000);
  if (!r.ok) { toast(r.message === 'Action inconnue.' ? 'Mets à jour l’app Studio pour Mac.' : r.message ?? 'Écriture impossible.'); return; }
  input.value = '';
  boards.set(`${x.project}/${wt}`, { files: (r.files as BoardFile[] | undefined) ?? [], at: Date.now() });
  paint();
  // L'agent ne lit le tableau qu'à ses étapes : au repos, il faut lui répondre pour qu'il en tienne compte.
  const working = (runsBy.get(x.project) ?? []).some(y => live(y) && y.worktree === wt);
  toast(working ? 'Consigne ajoutée au tableau : l’équipe la lira à sa prochaine étape' : 'Consigne ajoutée au tableau : l’agent la lira à son prochain tour');
}
/** Geste sur la copie d'une vue (publier, mettre à jour, fusionner…), puis relecture de son état. */
async function copyGesture(act: string, wt: string, i: number, b?: HTMLButtonElement): Promise<void> {
  const x = panes()[i], p = x && proj(x.project);
  if (!x || !p || !wt) return;
  if (act === 'more') {
    if (b) menu(b, [
      { label: 'Nouvelle branche', icon: 'refresh', hint: 'repartir de la branche principale', run: () => void copyGesture('newbranch', wt, i) },
      { label: 'Ouvrir dans le projet', icon: 'chevronRight', run: () => openInProject(x) },
      '-',
      { label: 'Supprimer la copie', icon: 'trash', run: () => void copyGesture('discard', wt, i) },
    ]);
    return;
  }
  if (!COPY_ACTS.has(act)) return;
  if (b) b.disabled = true;
  try {
    if (await copyAct(p, act, wt) && act === 'discard') {
      await loadTrees(p.id);
      if (!treesBy.get(p.id)?.list.some(t => t.name === wt)) { st.panes[i] = null; save(); }
    }
  }
  finally { if (b?.isConnected) b.disabled = false; }
  // Une publication ou une mise à jour se poursuit sur le Mac : son état est relu aux tours suivants.
  void loadTrees(p.id).then(paint);
}
function openInProject(x: Pane): void {
  if (!x.session) { toast('La conversation n’a pas encore démarré.'); return; }
  void import('./projects/page.ts').then(m => m.openAgent(x.project, x.session));
}
function toggleBoard(i: number): void {
  const x = panes()[i]; if (!x || !paneTree(x)) return;
  const k = pkey(x);
  if (boardOpen.has(k)) boardOpen.delete(k); else { boardOpen.add(k); void loadBoard(x.project, paneTree(x)).then(paint); }
  write('studio.workspace.boards', [...boardOpen].slice(-50));
  paint();
}

// ---------- Actions ----------
function setPane(i: number, x: Pane | null): void {
  // Une conversation n'est suivie que par une vue à la fois : on la déplace plutôt que de la dupliquer.
  if (x?.session) st.panes = st.panes.map((y, j) => j !== i && y?.session === x.session ? null : y);
  st.panes[i] = x; st.focus = i; save(); paint();
  if (x?.session && !details.has(pkey(x))) void loadDetail(x).then(paint);
}
function openRow(btn: HTMLElement, where = st.focus): void {
  const pid = btn.dataset.p ?? '', sid = btn.dataset.s ?? '';
  const already = panes().findIndex(x => x?.session === sid);
  if (already >= 0) { focusPane(already); return; }
  setPane(where, { project: pid, session: sid });
}
function focusPane(i: number, field = false): void {
  if (i >= st.layout) return;
  st.focus = i; save(); paint();
  const el = $(`.aw-pane[data-i="${i}"]`, root!);
  ($<HTMLElement>(field ? 'textarea' : '.aw-feed', el!) ?? el)?.focus();
}
function setLayout(n: number): void {
  st.layout = n; if (st.focus >= n) st.focus = n - 1; if (st.max >= n) st.max = -1; save(); paint();
}
/** Donne une vue à chaque agent qui travaille et n'en a pas : d'abord les vues vides (sauf un brouillon en cours),
 *  puis une disposition plus grande, enfin, à 8 vues, les vues d'agents au repos (sans réponse en cours d'écriture). */
function autoShow(): void {
  const working = rows().filter(r => r.status === 'running');
  const busy = new Set(working.map(r => r.s.id));
  // Une conversation retirée à la main redevient candidate quand elle a fini (son prochain tour la remontrera).
  const kept = st.dismissed.filter(id => busy.has(id));
  if (kept.length !== st.dismissed.length) { st.dismissed = kept; save(); }
  if (!st.auto) return;
  const shown = panes(), on = new Set(shown.map(x => x?.session).filter(Boolean));
  const shownRuns = new Set(shown.map(x => x?.run).filter(Boolean));
  const missing = working.filter(r => !on.has(r.s.id) && !st.dismissed.includes(r.s.id)
    && !(runsBy.get(r.p.id) ?? []).some(x => x.session === r.s.id && shownRuns.has(x.run)));
  if (!missing.length) return;
  const typed = (i: number) => !!$$<HTMLTextAreaElement>(`.aw-pane[data-i="${i}"] textarea`, root ?? document).some(t => t.value.trim());
  const free = () => panes().map((x, i) => (!x && !typed(i) ? i : -1)).filter(i => i >= 0);
  // Pas assez de vues vides : la plus petite disposition qui les loge tous.
  const need = missing.length - free().length;
  if (need > 0) {
    const want = LAYOUTS.find(n => n >= st.layout + need) ?? 8;
    if (want > st.layout) setLayout(want);
  }
  let slots = free();
  if (slots.length < missing.length) {
    const idle = panes().map((x, i) => {
      if (!x || i === st.focus || typed(i)) return -1;
      const busyHere = busy.has(x.session) || (runsBy.get(x.project) ?? []).some(y => live(y) && (y.session === x.session || (!!x.run && y.run === x.run)));
      return busyHere ? -1 : i;
    }).filter(i => i >= 0);
    slots = [...slots, ...idle];
  }
  let changed = false;
  for (const r of missing) {
    const i = slots.shift(); if (i === undefined) break;
    st.panes[i] = { project: r.p.id, session: r.s.id }; changed = true;
    if (!details.has(`${r.p.id}/${r.s.id}`)) void loadDetail({ project: r.p.id, session: r.s.id }).then(paint);
  }
  if (changed) save();
}
/** Retire la vue `i` ; un agent qui y travaillait n'y est pas remis d'office. */
function closePane(i: number): void {
  const x = st.panes[i];
  if (x?.session && rows().some(r => r.s.id === x.session && r.status === 'running')) st.dismissed = [...st.dismissed, x.session];
  st.panes[i] = null; if (st.max === i) st.max = -1; save(); paint();
}
const paintAuto = (page: HTMLElement) => $('.aw-auto', page)?.setAttribute('aria-pressed', String(st.auto));
const firstEmpty = () => { const i = panes().findIndex(x => !x); return i >= 0 ? i : st.focus; };

async function launch(f: HTMLFormElement, i: number): Promise<void> {
  const ta = need<HTMLTextAreaElement>('textarea', f), { n, text } = agentCount(ta.value);
  const pid = (f.elements.namedItem('project') as HTMLSelectElement).value, p = proj(pid);
  if (!text || !p) { ta.focus(); return; }
  if (n > 8) { toast(`${n} agents demandés : 8 à la fois au plus.`); return; }
  const mode = f.querySelector<HTMLInputElement>('[name=mode]:checked')?.value ?? 'edit';
  const btn = need<HTMLButtonElement>('button.btn-primary', f); btn.disabled = true;
  st.draftProject = pid; save();
  // « 3× … » : chaque agent dans sa vue, celle-ci d'abord puis les vues vides suivantes (les autres restent dans la liste).
  const free = [i, ...panes().map((x, k) => (!x && k !== i ? k : -1)).filter(k => k >= 0)];
  let ok = 0, fail = '';
  // Plusieurs agents qui modifient : une branche mère commune, une sous-branche par agent (voir l'onglet Claude Code du projet).
  const group = n > 1 && mode === 'edit' ? newGroup(text) : '';
  for (let k = 0; k < n; k++) {
    if (n > 1) btn.innerHTML = `<span class="spin"></span>Agent ${k + 1}/${n}…`;
    const r = await startAgent(p, text, mode, group ? { group, slot: k + 1, of: n } : undefined);
    if (!r.ok) { fail = r.message; break; }
    ok++;
    const at = free[k]; if (at !== undefined) st.panes[at] = { project: pid, session: r.session, run: r.run };
  }
  btn.disabled = false;
  if (!ok) { btn.innerHTML = `${icon('play')}Lancer ${kbd('mod+enter')}`; toast(fail); return; }
  save(); st.focus = i; paint();
  toast(n > 1 ? `${ok} agent${ok > 1 ? 's' : ''} sur ${n} au travail${fail ? ` · ${fail}` : ''}` : 'Agent lancé'); void refresh();
  void loadSessions(p).then(paintList);
}
async function startAgent(p: Project, prompt: string, mode = 'edit', group?: { group: string; slot: number; of: number }): Promise<{ ok: true; session: string; run: string } | { ok: false; message: string }> {
  const body: Record<string, unknown> = { project: p.id, prompt, mode, repos: p.stack, ...group };
  const sub = subagents.body(); if (sub) body.subagents = sub;
  const r = await bridge.call('agent', 'start', body, 60000);
  return r.ok ? { ok: true, session: typeof r.session === 'string' ? r.session : '', run: typeof r.run === 'string' ? r.run : '' } : { ok: false, message: r.message ?? 'Lancement impossible.' };
}
async function reply(x: Pane, prompt: string, interrupt = false): Promise<boolean> {
  const p = proj(x.project); if (!p || !x.session) return false;
  const body: Record<string, unknown> = { project: p.id, session: x.session, prompt, repos: p.stack, ...(interrupt ? { interrupt: true } : {}) };
  const sub = subagents.body(); if (sub) body.subagents = sub;
  const r = await bridge.call('agent', 'start', body, 60000);
  if (!r.ok) { toast(r.message ?? 'Envoi impossible.'); return false; }
  if (typeof r.queued === 'number') toast('Message en attente : l’agent le lira à la fin de son tour');
  void loadRuns(x.project).then(() => loadDetail(x)).then(paint);
  return true;
}
async function send(f: HTMLFormElement, i: number, interrupt: boolean): Promise<void> {
  const x = panes()[i], ta = need<HTMLTextAreaElement>('textarea', f), text = ta.value.trim();
  if (!x || !text) return;
  const btn = need<HTMLButtonElement>('button', f); btn.disabled = true;
  if (await reply(x, text, interrupt)) { ta.value = ''; grow(ta); }
  btn.disabled = false;
}
async function stopPane(i: number): Promise<void> {
  const x = panes()[i]; if (!x) return;
  const busy = (runsBy.get(x.project) ?? []).filter(r => live(r) && (r.session === x.session || (!!x.run && r.run === x.run)));
  if (!busy.length) { toast('Cet agent ne travaille pas en ce moment.'); return; }
  const res = await Promise.all(busy.map(r => bridge.call('agent', 'stop', { run: r.run }, 10000)));
  const fail = res.find(r => !r.ok);
  toast(fail ? fail.message ?? 'Arrêt impossible.' : 'Agent arrêté'); void refresh();
}
function grow(ta: HTMLTextAreaElement): void { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 220)}px`; }

/** Diffuser : la même consigne à plusieurs vues (réponse aux agents affichés, nouvel agent dans les vues vides). */
function broadcast(): void {
  const list = panes();
  if (!projects.projects().length) { toast('Crée d’abord un projet.'); return; }
  const m = modal({ cls: 'aw-cast', html: `<div class="aw-cast-head">${icon('share')}<b>Diffuser une consigne</b><span>Réponse aux agents affichés, nouvel agent dans les vues vides</span></div>
    <div class="aw-cast-body"><textarea class="aw-big" aria-label="Consigne à diffuser" placeholder="La même consigne pour chaque vue cochée…" autofocus></textarea>
    <div class="aw-targets">${list.map((x, i) => {
      const p = x ? proj(x.project) : null, d = x ? details.get(pkey(x)) : undefined;
      const title = x ? d?.id ? nameOf({ id: x.session, title: d.title ?? '', aiTitle: d.aiTitle, firstPrompt: d.firstPrompt, prompts: d.prompts ?? 0 }) : 'Conversation' : 'Nouvel agent';
      return `<label class="aw-target"><input type="checkbox" data-t="${i}"${x?.session ? ' checked' : ''}><b class="aw-num">${i + 1}</b><span>${esc(title)}</span>${x ? `<em>${esc(p?.name ?? '')}</em>` : `<select data-tp="${i}" aria-label="Projet du nouvel agent ${i + 1}">${projectOptions(proj(st.draftProject)?.id ?? '')}</select>`}</label>`;
    }).join('')}</div></div>
    <div class="cap-foot"><span class="ask-status"></span><span class="ask-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-primary" data-go>${icon('share')}Diffuser ${kbd('mod+enter')}</button></span></div>` });
  const ta = need<HTMLTextAreaElement>('textarea', m.node), status = need('.ask-status', m.node);
  const sync = () => { const n = $$('[data-t]:checked', m.node).length; status.textContent = n ? `${n} vue${n > 1 ? 's' : ''}` : 'Coche au moins une vue.'; };
  m.node.addEventListener('change', sync); sync();
  need('[data-x]', m.node).onclick = () => m.close();
  const go = async () => {
    const text = ta.value.trim(), picked = $$<HTMLInputElement>('[data-t]:checked', m.node).map(c => Number(c.dataset.t));
    if (!text || !picked.length) { ta.focus(); return; }
    need<HTMLButtonElement>('[data-go]', m.node).disabled = true;
    let ok = 0;
    for (const i of picked) {
      status.innerHTML = `<span class="spin"></span>Vue ${i + 1}…`;
      const x = list[i];
      if (x?.session) { if (await reply(x, text)) ok++; continue; }
      const p = proj($<HTMLSelectElement>(`[data-tp="${i}"]`, m.node)?.value ?? x?.project ?? '');
      if (!p) continue;
      const r = await startAgent(p, text);
      if (r.ok) { st.panes[i] = { project: p.id, session: r.session, run: r.run }; ok++; } else toast(r.message);
    }
    save(); m.close(); paint(); toast(`Consigne envoyée à ${ok} vue${ok > 1 ? 's' : ''}`); void refresh();
    for (const pid of new Set(picked.map(i => st.panes[i]?.project).filter((x): x is string => !!x))) { const p = proj(pid); if (p) void loadSessions(p).then(paintList); }
  };
  need('[data-go]', m.node).onclick = () => void go();
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void go(); } });
}

// ---------- Montage ----------
const layoutIcon = (n: number) => { const [c, r] = ({ 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2] } as Record<number, [number, number]>)[n] ?? [1, 1]; return `<svg class="aw-li" viewBox="0 0 ${c * 6 + 1} ${r * 6 + 1}" aria-hidden="true">${Array.from({ length: c * r }, (_, k) => `<rect x="${(k % c) * 6 + 1}" y="${Math.floor(k / c) * 6 + 1}" width="5" height="5" rx="1"/>`).join('')}</svg>`; };

const sideToggle = () => { const t = st.mini ? 'Déplier la liste' : 'Réduire la liste'; return `<button type="button" class="icon-btn aw-fold" data-w="side" title="${t} (S)" aria-label="${t}" aria-expanded="${!st.mini}">${icon('sidebar')}</button>`; };
/** Réduit ou déplie la liste : seul l'affichage change (filtre, curseur et vues restent). */
function toggleSide(page: HTMLElement): void {
  st.mini = !st.mini; save();
  $('.aw', page)?.classList.toggle('mini', st.mini);
  const b = $('.aw-fold', page); if (b) b.outerHTML = sideToggle();
}

export function mount(main: HTMLElement, toolbarLeft: string): void {
  stop();
  if (!bridge.where()) {
    main.innerHTML = `<header class="toolbar">${toolbarLeft}<div class="crumb"><span>Espace agents</span></div></header><div class="empty"><div class="empty-card">${icon('bot')}<h3>Les agents tournent sur ton Mac</h3><p>Ouvre Studio sur le Mac où se trouvent tes projets, ou relie cet appareil à ton Mac (Réglages → Appareils) pour les suivre d’ici.</p></div></div>`;
    return;
  }
  // Tout est dans `.aw-root` : les écouteurs disparaissent avec la page (#main, lui, sert à toutes les vues).
  main.innerHTML = `<div class="aw-root" tabindex="-1"><header class="toolbar">${toolbarLeft}<div class="crumb"><span>Espace agents</span></div><span class="aw-counts"></span>
      <div class="tb-side tb-right"><div class="aw-seg" role="group" aria-label="Nombre de vues (L)">${LAYOUTS.map(n => `<button type="button" data-layout="${n}" title="${n} vue${n > 1 ? 's' : ''}" aria-pressed="false">${layoutIcon(n)}<span>${n}</span></button>`).join('')}</div>
      <button class="btn btn-ghost aw-auto" data-w="auto" aria-pressed="${st.auto}" title="Ouvrir d’office chaque agent qui travaille dans une vue">${icon('bolt')}<span>Auto</span></button>
      <button class="btn btn-ghost" data-w="cast" title="Envoyer la même consigne à plusieurs vues (D)">${icon('share')}<span>Diffuser</span></button>
      <button class="btn btn-primary" data-w="new" title="Nouvel agent dans la vue choisie (C)">${icon('plus')}<span>Nouvel agent</span></button></div></header>
    <div class="aw${st.mini ? ' mini' : ''}">
      <aside class="aw-side"><div class="aw-side-head"><div class="aw-search">${icon('search')}<input type="search" placeholder="Filtrer les agents…" aria-label="Filtrer les agents" value="${esc(st.filter)}"><kbd>/</kbd></div>${sideToggle()}</div><div class="aw-list" role="listbox" aria-label="Conversations des agents"></div>
        <p class="aw-keys">${kbd('1')}–${kbd('8')} vue · ${kbd('J')}${kbd('K')} liste · ${kbd('↵')} ouvrir · ${kbd('C')} créer · ${kbd('F')} agrandir · ${kbd('X')} vider · ${kbd('L')} disposition · ${kbd('S')} réduire la liste · ${kbd('T')} tableau d’équipe · ${kbd('P')} publier</p></aside>
      <div class="aw-grid"></div>
    </div></div>`;
  const page = need('.aw-root', main);
  root = page;
  const grid = need('.aw-grid', page), list = need('.aw-list', page), search = need<HTMLInputElement>('.aw-search input', page);

  page.addEventListener('click', e => {
    const t = target(e), b = t.closest<HTMLElement>('[data-layout]');
    if (b) { setLayout(Number(b.dataset.layout)); return; }
    const row = t.closest<HTMLElement>('.aw-row');
    if (row) { cursor = Number(row.dataset.row); openRow(row, (e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey ? firstEmpty() : st.focus); return; }
    const w = t.closest<HTMLElement>('[data-w]')?.dataset.w, pane = t.closest<HTMLElement>('.aw-pane'), i = pane ? Number(pane.dataset.i) : st.focus;
    if (w === 'side') { toggleSide(page); return; }
    if (w === 'cast') { broadcast(); return; }
    if (w === 'new') { const k = firstEmpty(); if (panes()[k]) setPane(k, null); focusPane(k, true); return; }
    if (w === 'max') { st.max = st.max === i ? -1 : i; save(); paint(); return; }
    if (w === 'close') { closePane(i); return; }
    if (w === 'auto') { st.auto = !st.auto; save(); paintAuto(page); if (st.auto) { autoShow(); paint(); } toast(st.auto ? 'Les agents qui travaillent s’ouvrent d’office dans une vue' : 'Les vues ne changent plus d’elles-mêmes'); return; }
    if (w === 'stop') { void stopPane(i); return; }
    if (w === 'team') { toggleBoard(i); return; }
    if (w === 'open') { const x = panes()[i]; if (x) openInProject(x); return; }
    if (w === 'sub') { void subagents.edit().then(ok => { if (ok) $$('.aw-sub span', page).forEach(s => { s.textContent = subagents.label(); }); }); return; }
    const cp = t.closest<HTMLElement>('[data-aw-copy]');
    if (cp) { void copyGesture(cp.dataset.awCopy ?? '', cp.dataset.wt ?? '', i, cp as HTMLButtonElement); return; }
    if (t.closest('[data-ag="copy"]')) { const md = t.closest('.ss-msg')?.querySelector('.md') as HTMLElement | null; if (md) void navigator.clipboard.writeText(md.innerText).then(() => toast('Réponse copiée')); return; }
    if (pane && i !== st.focus) { st.focus = i; save(); grid.querySelectorAll('.aw-pane').forEach(p => p.classList.toggle('focus', p === pane)); }
  });
  page.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target as HTMLFormElement, i = Number(f.closest<HTMLElement>('.aw-pane')?.dataset.i ?? st.focus);
    if (f.classList.contains('aw-new')) void launch(f, i); else if (f.classList.contains('aw-board-say')) void boardNote(f, i); else void send(f, i, false);
  });
  page.addEventListener('input', e => {
    const t = e.target as HTMLElement;
    if (t === search) { st.filter = search.value; cursor = 0; save(); paintList(); }
    else if (t.matches('.aw-reply textarea')) grow(t as HTMLTextAreaElement);
  });
  page.addEventListener('change', e => { const s = e.target as HTMLElement; if (s.matches('.aw-new select[name=project]')) { st.draftProject = (s as HTMLSelectElement).value; save(); } });
  page.addEventListener('keydown', e => {
    const t = e.target as HTMLElement, typing = t.matches('input, textarea, select, [contenteditable]');
    if (typing) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && t.matches('textarea')) {
        e.preventDefault(); const f = t.closest('form') as HTMLFormElement, i = Number(f.closest<HTMLElement>('.aw-pane')?.dataset.i ?? st.focus);
        if (f.classList.contains('aw-new')) void launch(f, i); else void send(f, i, e.shiftKey);
      } else if (e.key === 'Escape') { (t as HTMLElement).blur(); e.stopPropagation(); }
      else if (t === search && (e.key === 'ArrowDown' || e.key === 'Enter')) { e.preventDefault(); search.blur(); if (e.key === 'Enter') { const r = $<HTMLElement>('.aw-row.cur', list); if (r) openRow(r); } }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase(), rowsEl = $$<HTMLElement>('.aw-row', list);
    if (/^[1-8]$/.test(k)) { e.preventDefault(); focusPane(Number(k) - 1); }
    else if (k === 'j' || k === 'arrowdown' || k === 'k' || k === 'arrowup') { e.preventDefault(); cursor = Math.max(0, Math.min(rowsEl.length - 1, cursor + (k === 'j' || k === 'arrowdown' ? 1 : -1))); paintList(); $('.aw-row.cur', list)?.scrollIntoView({ block: 'nearest' }); }
    else if (k === 'enter') { const r = $<HTMLElement>('.aw-row.cur', list); if (r) { e.preventDefault(); openRow(r); } }
    else if (k === 'c') { e.preventDefault(); if (panes()[st.focus]) setPane(st.focus, null); focusPane(st.focus, true); }
    else if (k === 'f') { e.preventDefault(); st.max = st.max === st.focus ? -1 : st.focus; save(); paint(); }
    else if (k === 'x') { e.preventDefault(); closePane(st.focus); }
    else if (k === 'l') { e.preventDefault(); setLayout(LAYOUTS[(LAYOUTS.indexOf(st.layout) + 1) % LAYOUTS.length] ?? 1); }
    else if (k === 'r') { e.preventDefault(); focusPane(st.focus, true); }
    else if (k === 'd') { e.preventDefault(); broadcast(); }
    else if (k === 's') { e.preventDefault(); toggleSide(page); }
    else if (k === 't') { e.preventDefault(); toggleBoard(st.focus); }
    else if (k === 'p') {
      // Publier la vue choisie : le premier geste mis en avant de sa copie (publier, fusionner dans la mère…).
      const b = $<HTMLButtonElement>(`.aw-pane[data-i="${st.focus}"] .aw-copy .btn-primary:not(:disabled)`, page);
      if (b) { e.preventDefault(); b.click(); }
    }
    else if (k === '/') { e.preventDefault(); if (st.mini) toggleSide(page); search.focus(); search.select(); }
  });
  // Glisser une conversation de la liste sur une vue.
  list.addEventListener('dragstart', e => { const r = (e.target as HTMLElement).closest<HTMLElement>('.aw-row'); if (r && e.dataTransfer) { e.dataTransfer.setData('text/x-ws', JSON.stringify({ p: r.dataset.p, s: r.dataset.s })); e.dataTransfer.effectAllowed = 'move'; } });
  grid.addEventListener('dragover', e => { const p = (e.target as HTMLElement).closest('.aw-pane'); if (p && e.dataTransfer?.types.includes('text/x-ws')) { e.preventDefault(); grid.querySelectorAll('.drop').forEach(x => x !== p && x.classList.remove('drop')); p.classList.add('drop'); } });
  grid.addEventListener('dragleave', e => { const p = (e.target as HTMLElement).closest('.aw-pane'); if (p && !p.contains(e.relatedTarget as Node)) p.classList.remove('drop'); });
  grid.addEventListener('drop', e => {
    const p = (e.target as HTMLElement).closest<HTMLElement>('.aw-pane'), raw = e.dataTransfer?.getData('text/x-ws');
    grid.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
    if (!p || !raw) return; e.preventDefault();
    const d = JSON.parse(raw) as { p: string; s: string };
    setPane(Number(p.dataset.i), { project: d.p, session: d.s });
  });
  paint(); start();
  if (!page.contains(document.activeElement)) page.focus({ preventScroll: true });
}
