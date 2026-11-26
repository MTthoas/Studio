// Salon d'un projet : l'équipe d'agents du projet vue comme une discussion, pas comme un terminal.
// Ce n'est PAS un nouveau protocole : ce sont les mêmes données que l'onglet Claude Code, l'Espace agents et le fil
// « Échanges » (conversations du Mac, sous-agents, tableau d'équipe, copie du travail), présentées autrement.
//   - un Salon PAR PROJET : rien ne vient d'un autre projet (tous les caches sont rattachés à l'id du projet monté) ;
//   - les agents ne se parlent qu'au sein d'UNE consigne : l'agent principal (Moka) et ses sous-agents ; les messages
//     du tableau venus d'autres agents d'un groupe (« Agent 2 ») sont ignorés ici ;
//   - les agents portent des prénoms (`persona`), déterministes : le même sous-agent a toujours le même prénom ;
//   - pas de détail technique (outils, fichiers lus, commandes) : « Vue technique » ouvre l'onglet Claude Code.
// Disposition : à gauche les fils, au centre la discussion et le champ, à droite « En ce moment ». Relecture toutes les
// 2,5 s tant que le Salon est à l'écran (la liste des fils, plus lente, toutes les 30 s) ; le fil est mis à jour bloc par
// bloc (syncFeed) et le champ n'est jamais redessiné : texte tapé, défilement et blocs dépliés restent en place.
// Styles : css/salon.css (préfixe `sl-`). Tout ce qui vient du Mac passe par `esc()`.
import * as bridge from '../../integrations/remote.ts';
import * as quota from '../../integrations/quota.ts';
import * as usage from '../../integrations/usage.ts';
import { syncFeed, nameOf, live, copyStage, copyAct, answerHTML, modelName, modelOptions, EFFORTS, cleanUp, sideMenu } from './sessions.ts';
import * as archived from './archive.ts';
import { fold } from '../../lib/fuzzy.ts';
import * as saved from './drafts.ts';
import * as subagents from './subagents.ts';
import * as attach from './attach.ts';
import { AUTO, pickFor, label as autoLabel } from './autopick.ts';
import { exchanges } from './team.ts';
import * as flux from './flux.ts';
import * as catface from '../../ui/catface.ts';
import { startAgent, reply } from '../workspace.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, need, rel, toast, target, paintIfChanged } from '../../ui/kit.ts';
import type { Block, Session, Action, AgentRun, Queued, Worktree, SubAgent } from './sessions.ts';
import type { BoardMsg } from './team.ts';
import type { Project } from './model.ts';
import { t as tr } from '../../ui/i18n.ts';

// ---------- Les prénoms ----------
export interface Persona { name: string; role: string; hue: string }
const FIXED: [RegExp, Persona][] = [
  [/^(|principal|agent principal|main|claude|moka|maya)$/, { name: 'Moka', role: 'cheffe d’équipe', hue: 'orange' }],
  [/explor/, { name: 'Filou', role: 'explorateur', hue: 'teal' }],
  [/relec|review/, { name: 'Réglisse', role: 'relecteur', hue: 'violet' }],
  [/test|qualite|\bqa\b/, { name: 'Griffe', role: 'testeur', hue: 'pink' }],
  [/integr/, { name: 'Sacha', role: 'intégrateur', hue: 'indigo' }],
  [/redact|writer|documentation/, { name: 'Zoé', role: 'rédacteur', hue: 'amber' }],
];
// Des noms de chats, comme leurs portraits (src/ui/catface.ts).
const NAMES = ['Caramel', 'Noisette', 'Pixel', 'Plume', 'Gribouille', 'Chaussette', 'Praline', 'Biscotte', 'Olive', 'Pompon', 'Sushi', 'Cannelle'];
const HUES = ['blue', 'green', 'amber', 'orange', 'violet', 'pink', 'teal', 'indigo'];
const flat = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
/** Prénom, rôle et couleur d'un agent d'après son nom (agent principal : « principal » ou vide ; sous-agent : son type).
 *  Déterministe : un nom inconnu reçoit toujours le même prénom, par hachage stable du nom. */
export function persona(nom: string): { name: string; role: string; hue: string } {
  const n = flat(nom), known = FIXED.find(([re]) => re.test(n));
  if (known) return { ...known[1] };
  let h = 5381; for (const c of n) h = (Math.imul(h, 33) + (c.codePointAt(0) ?? 0)) >>> 0;
  return { name: NAMES[h % NAMES.length] ?? 'Caramel', role: nom.trim(), hue: HUES[(h >>> 8) % HUES.length] ?? 'blue' };
}
/** Sous-agent sans rôle propre : type vide, « general-purpose », « claude », « fork »… `persona` y verrait l'agent principal
 *  (d'où « Moka a confié une tâche à Moka », puis Moka qui se répondait) : ceux-là sont des renforts, jamais Moka. */
const GENERIC = /^(|claude|general[- ]purpose|general|generaliste|fork|agent|default|principal|agent principal|main|moka|maya)$/;
const generic = (type: string): boolean => GENERIC.test(flat(type));
/** Clé des renforts dans `Crew.byBase` (les autres y sont rangés par prénom de rôle). */
const HELP = '~';
/** Le k-ième renfort du fil : un prénom et une couleur à lui, dans l'ordre des départs. */
const helper = (k: number): Persona => ({ name: NAMES[k % NAMES.length] ?? 'Caramel', role: 'renfort', hue: HUES[(k + 1) % HUES.length] ?? 'blue' });

// ---------- État (rattaché à un projet : remis à zéro quand on en monte un autre) ----------
interface Tok { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Detail { actions: Action[]; tokens?: Tok; subagents?: SubAgent[]; live?: boolean; worktree?: string; models?: string[]; files?: string[]; lines?: { add: number; del: number }; message?: string }
interface Thread { id: string; s: Session; group: 'work' | 'mine' | 'recent'; act: number }
interface Who extends Persona { id: string; base: string; model?: string; me?: boolean }
const TICK = 2500, TICK_WORK = 1200, SEEN = 'studio.salon.seen', MORE = 8, TEAM_OFF = 'studio.salon.teamOff';
const ms = (iso?: string): number => Date.parse(iso || '') || 0;
const seen: Record<string, number> = (() => { try { return JSON.parse(localStorage.getItem(SEEN) || '{}') as Record<string, number>; } catch { return {}; } })();
let firstUse = !Object.keys(seen).length;
const keepSeen = (): void => { try { localStorage.setItem(SEEN, JSON.stringify(seen)); } catch { /* plein */ } };

interface State { pid: string; sessions: Session[]; runs: AgentRun[]; queued: Queued[]; trees: Worktree[]; treesRead: boolean; loaded: boolean; detail: Map<string, Detail>; board: Map<string, BoardMsg[]> }
const blank = (pid: string): State => ({ pid, sessions: [], runs: [], queued: [], trees: [], treesRead: false, loaded: false, detail: new Map(), board: new Map() });
let S: State = blank('');

// ---------- Cache ----------
// Le Salon s'affiche tout de suite avec ce qu'il a lu la dernière fois, puis se met à jour en arrière-plan :
//   - en mémoire, l'état de chaque projet visité reste tel quel (changer d'onglet ou de projet ne relit rien d'avance) ;
//   - sur disque (localStorage, une clé par projet, CACHE_PROJECTS projets au plus), un instantané allégé : la liste
//     des fils, les lancements, les copies et les CACHE_THREADS derniers fils lus, sans les étapes techniques.
// Écrit au plus toutes les 5 s, et quand la fenêtre passe en arrière-plan. Trop gros : on retire des fils jusqu'à passer.
const CACHE = 'studio.salon.cache', CACHE_PROJECTS = 6, CACHE_THREADS = 8, CACHE_BYTES = 1_200_000, CACHE_ACTIONS = 250;
const states = new Map<string, State>();
interface Snap { at: number; sessions: Session[]; runs: AgentRun[]; queued: Queued[]; trees: Worktree[]; detail: [string, Detail][]; board: [string, BoardMsg[]][] }
/** Ce que le Salon montre d'un fil : messages, passations, tests lancés et dernière action (pour « lit app.ts »). */
const keep = (a: Action, i: number, all: Action[]): boolean => !a.kind.startsWith('tool:') || a.kind === 'tool:Agent' || a.kind === 'tool:Task' || (a.kind === 'tool:Bash' && TESTS.test(a.text)) || i === all.length - 1;
function slim(d: Detail): Detail {
  const actions = d.actions.filter(keep).slice(-CACHE_ACTIONS).map(a => ({ at: a.at, kind: a.kind, text: a.text.slice(0, 20000), ...(a.to ? { to: a.to } : {}), ...(a.body ? { body: a.body.slice(0, 4000) } : {}) }));
  return { ...d, actions, subagents: d.subagents?.map(x => ({ ...x, report: x.report?.slice(0, 8000), prompt: x.prompt?.slice(0, 4000) })) };
}
function fromDisk(pid: string): State | null {
  try {
    const o = JSON.parse(localStorage.getItem(`${CACHE}.${pid}`) || 'null') as Snap | null;
    if (!o || !Array.isArray(o.sessions)) return null;
    return { pid, sessions: o.sessions, runs: o.runs ?? [], queued: o.queued ?? [], trees: o.trees ?? [], treesRead: true, loaded: true, detail: new Map(o.detail ?? []), board: new Map(o.board ?? []) };
  } catch { return null; }
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function toDisk(): void {
  clearTimeout(saveTimer); saveTimer = undefined;
  const st = S; if (!st.pid || !st.loaded) return;
  const recent = threads().map(t => t.id).filter(id => st.detail.has(id)).slice(0, CACHE_THREADS);
  const wts = new Set(recent.map(id => st.detail.get(id)?.worktree).filter(Boolean));
  for (let n = recent.length; n >= 0; n--) {
    const ids = recent.slice(0, n);
    const snap: Snap = { at: Date.now(), sessions: st.sessions, runs: st.runs, queued: st.queued, trees: st.trees,
      detail: ids.map(id => [id, slim(st.detail.get(id) as Detail)]), board: [...st.board].filter(([w]) => wts.has(w) && ids.some(id => st.detail.get(id)?.worktree === w)) };
    const json = JSON.stringify(snap);
    if (json.length > CACHE_BYTES && n > 0) continue;
    try {
      localStorage.setItem(`${CACHE}.${st.pid}`, json);
      // Les projets les plus récents en dernier ; au-delà de CACHE_PROJECTS, le plus ancien est oublié.
      const list = (JSON.parse(localStorage.getItem(CACHE) || '[]') as string[]).filter(x => x !== st.pid).concat(st.pid);
      for (const old of list.splice(0, Math.max(0, list.length - CACHE_PROJECTS))) localStorage.removeItem(`${CACHE}.${old}`);
      localStorage.setItem(CACHE, JSON.stringify(list));
      return;
    } catch { if (n === 0) return; /* plein : un fil de moins */ }
  }
}
const saveSoon = (): void => { saveTimer ??= setTimeout(toDisk, 5000); };
addEventListener('pagehide', toDisk);
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) toDisk(); });

// ---------- Fil choisi et brouillons (retenus d'une visite à l'autre) ----------
/** Fil choisi, par projet : absent = automatique (celui qui travaille, sinon celui qui t'attend), '' = nouvelle consigne. */
const CHOSEN = 'studio.salon.chosen';
const chosen = new Map<string, string>((() => { try { return Object.entries(JSON.parse(localStorage.getItem(CHOSEN) || '{}') as Record<string, string>); } catch { return []; } })());
function choose(pid: string, id: string): void {
  chosen.set(pid, id);
  // Un lancement pas encore devenu conversation (`run:`) ne survit pas à l'app : on ne le retient pas.
  if (!id.startsWith('run:')) try { localStorage.setItem(CHOSEN, JSON.stringify(Object.fromEntries(chosen))); } catch { /* plein */ }
}
/** Retour au choix automatique du fil (celui au travail, sinon le plus récent). */
function unchoose(pid: string): void {
  chosen.delete(pid);
  try { localStorage.setItem(CHOSEN, JSON.stringify(Object.fromEntries(chosen))); } catch { /* plein */ }
}
/** Brouillon du champ, par fil (`<projet>/<fil>`, fil vide = nouvelle consigne) : dans drafts.ts, comme ceux de Claude Code. */
const DRAFT = 'salon:';
const drafts = {
  get: (key: string): string => saved.draft(DRAFT + key)?.text ?? '',
  mode: (key: string): string => saved.draft(DRAFT + key)?.mode ?? 'edit',
  set: (key: string, text: string): void => { if (key) saved.saveDraft(DRAFT + key, { text, notes: [], mode: root?.querySelector<HTMLSelectElement>('.sl-comp select[name=mode]')?.value === 'read' ? 'read' : 'edit', tests: false }); },
  delete: (key: string): void => saved.dropDraft(DRAFT + key),
};
let root: HTMLElement | null = null, p: Project | null = null, timer: ReturnType<typeof setTimeout> | undefined;
let listing = false, busy = false, refreshing = false, moreOpen = false, shown = '', quotaHooked = false;
/** Filtre et recherche de la liste des fils (gardés d'un projet à l'autre, le temps de la session). */
type Filt = 'all' | 'work' | 'mine' | 'done' | 'codex' | 'arch';
let filt: Filt = 'all', query = '';
/** Dernière lecture de chaque source (ms) : chacune a son rythme, aucune n'attend l'autre. */
let last = { sessions: 0, trees: 0, detail: 0, board: 0 };
const fetching = new Set<string>();
let openTech: (session: string) => void = () => undefined;
/** Fiche ouverte : 'main' (l'agent principal) ou l'id d'un sous-agent ; '' = aucune. */
let prof = '', profAt: { box: DOMRect; side: DOMRect | null } | null = null;

/** Monte l'état du projet : celui gardé en mémoire, sinon l'instantané du disque, sinon rien (première visite). */
function reset(pid: string): void {
  if (S.pid && S.pid !== pid) toDisk();
  S = states.get(pid) ?? fromDisk(pid) ?? blank(pid); states.set(pid, S);
  moreOpen = false; shown = ''; last = { sessions: 0, trees: 0, detail: 0, board: 0 }; prof = '';
}

// ---------- Lecture ----------
function threads(): Thread[] {
  const known = new Set(S.sessions.map(s => s.id));
  // Un agent qui vient d'être lancé : affiché tout de suite d'après son lancement, avant que le Mac ait lu ses journaux.
  const fresh = S.runs.filter(r => !known.has(r.session || `run:${r.run}`) && (live(r) || Date.now() - ms(r.finished || r.started) < 36e5))
    .map((r): Session => ({ id: r.session || `run:${r.run}`, title: r.prompt, firstPrompt: r.prompt, branch: '', worktree: r.worktree, started: r.started, updated: r.finished || r.started, active: r.finished || r.started, live: live(r), models: [], prompts: 1, lastPrompt: r.prompt, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: {}, files: [] }));
  return [...S.sessions, ...fresh].map((s): Thread => {
    const mine = S.runs.filter(r => r.session === s.id || `run:${r.run}` === s.id), last = mine.reduce<AgentRun | undefined>((a, r) => !a || ms(r.started) > ms(a.started) ? r : a, undefined);
    const act = ms(s.active || s.updated), w = s.worktree ? S.trees.find(t => t.name === s.worktree) : undefined;
    const group = mine.some(live) || s.live || awake(s.id) ? 'work' : last?.status === 'error' || (w && copyStage(w) === 'review') || (act > (seen[s.id] ?? 0) && Date.now() - act < 3 * 864e5) ? 'mine' : 'recent';
    return { id: s.id, s, group, act };
  }).sort((a, b) => b.act - a.act);
}
function curId(th = threads()): string {
  const c = chosen.get(S.pid);
  // Un fil retenu qui n'existe plus (conversation effacée) : retour au choix automatique.
  if (c !== undefined && (!c || c.startsWith('run:') || !S.loaded || th.some(t => t.id === c))) return c;
  const vis = th.filter(t => t.group === 'work' || !archived.isArchived(S.pid, t.id));
  return (vis.find(t => t.group === 'work') ?? vis.find(t => t.group === 'mine') ?? vis[0])?.id ?? '';
}
async function loadSessions(pid: string): Promise<void> {
  const r = await bridge.call('project', 'sessions', { project: pid }, 20000);
  if (pid !== S.pid || !r.ok) return;
  // Conversations Codex (OpenAI) : à part dans la réponse (`codex`), seul le Salon les montre.
  S.sessions = [...(r.found ? (r.sessions as Session[] | undefined) ?? [] : []), ...((r.codex as Session[] | undefined) ?? [])];
  // Première ouverture : l'existant compte comme lu, sinon « À toi » serait rempli d'anciennes conversations.
  if (firstUse) { for (const x of S.sessions) if (!x.live) seen[x.id] = ms(x.active || x.updated); keepSeen(); firstUse = false; }
  S.loaded = true;
}
async function loadDetail(pid: string, id: string): Promise<void> {
  const d = await bridge.call('project', 'session', { project: pid, session: id }, 20000);
  if (pid !== S.pid) return;
  S.detail.set(id, d.ok ? { ...(d as unknown as Partial<Detail>), actions: (d.actions as Action[] | undefined) ?? [] } : { actions: [], message: d.message ?? 'Conversation introuvable.' });
}
async function loadTrees(pid: string): Promise<void> {
  const r = await bridge.call('agent', 'worktrees', { project: pid }, 30000);
  if (pid === S.pid && r.ok) { S.trees = (r.worktrees as Worktree[] | undefined) ?? []; S.treesRead = true; }
}
async function loadBoard(pid: string, wt: string): Promise<void> {
  const r = await bridge.call('agent', 'board', { project: pid, worktree: wt }, 10000);
  if (pid === S.pid && r.ok && Array.isArray(r.messages)) S.board.set(wt, r.messages as BoardMsg[]);
}
async function refresh(): Promise<void> {
  if (!root?.isConnected || !p) { stop(); return; }
  if (document.hidden || refreshing) return; // fenêtre cachée ou tour précédent pas fini : on saute, le suivant rattrape tout
  refreshing = true;
  try { await refreshOnce(p.id); } finally { refreshing = false; }
}
/** Lit une source sans faire attendre les autres ni l'affichage : une seule lecture à la fois par clé, puis le Salon se repeint. */
function inBackground(key: string, load: () => Promise<void>): void {
  if (fetching.has(key)) return;
  fetching.add(key);
  void load().catch(() => undefined).finally(() => { fetching.delete(key); if (root?.isConnected) paint(); });
}
/** Ouvre un fil sans attendre le tour de relecture : sa conversation est lue tout de suite (ou déjà là, par le survol). */
function fetchThread(pid: string, id: string): void {
  if (!id || id.startsWith('run:') || pid !== S.pid) return;
  inBackground(`d:${id}`, () => loadDetail(pid, id));
}
async function refreshOnce(pid: string): Promise<void> {
  const now = Date.now(), id0 = curId(), work0 = threads().find(t => t.id === id0)?.group === 'work';
  // Rien n'attend rien : la liste des fils, les copies et le tableau sont lus à côté, chacun à son rythme ; seuls les
  // lancements et la conversation ouverte (lus ensemble) précèdent l'affichage.
  if (!listing && (now - last.sessions > 30e3 || !S.loaded)) { listing = true; last.sessions = now; void loadSessions(pid).finally(() => { listing = false; if (root?.isConnected) paint(); }); }
  if (now - last.trees > 15e3 || !S.treesRead) { last.trees = now; inBackground(`t:${pid}`, () => loadTrees(pid)); }
  const real = (id: string): boolean => !!id && !id.startsWith('run:');
  const wantDetail = real(id0) && !fetching.has(`d:${id0}`) && (!S.detail.has(id0) || work0 || now < fastUntil || now - last.detail > 10e3);
  if (wantDetail) last.detail = now;
  const [l] = await Promise.all([bridge.call('agent', 'list', { project: pid }, 10000), wantDetail ? loadDetail(pid, id0) : undefined]);
  if (pid !== S.pid || !root?.isConnected) return;
  if (l.ok) { S.runs = (l.runs as AgentRun[] | undefined) ?? []; S.queued = (l.queued as Queued[] | undefined) ?? []; }
  // La consigne qui vient de partir n'avait pas encore de conversation : on la suit dès que le Mac l'a créée.
  const c = chosen.get(pid);
  if (c?.startsWith('run:')) { const r = S.runs.find(x => `run:${x.run}` === c); if (r?.session) { choose(pid, r.session); shown = `${pid}/${r.session}`; fetchThread(pid, r.session); } }
  const id = curId(), wt = real(id) ? S.detail.get(id)?.worktree : undefined;
  if (wt && (!S.board.has(wt) || now - last.board > (work0 ? 2400 : 8e3))) { last.board = now; inBackground(`b:${wt}`, () => loadBoard(pid, wt)); }
  saveSoon();
  paint();
}
/** Arrête la relecture périodique (appelé quand on quitte l'onglet ; elle s'arrête aussi seule si le Salon n'est plus à l'écran). */
export function stop(): void { clearTimeout(timer); timer = undefined; clearTimeout(fastTimer); fastTimer = undefined; if (techTimer !== undefined) { clearInterval(techTimer); techTimer = undefined; } if (saveTimer) toDisk(); }
/** Relecture en boucle : plus serrée quand le fil ouvert travaille (ses messages arrivent en une seconde). */
function start(): void {
  stop(); last = { sessions: 0, trees: 0, detail: 0, board: 0 };
  const loop = (): void => {
    if (!root?.isConnected || !p) { stop(); return; }
    void refresh();
    const id = curId(), work = !!id && threads().some(t => t.id === id && t.group === 'work');
    timer = setTimeout(loop, work ? TICK_WORK : TICK);
  };
  loop();
}

// ---------- Les gens du fil ----------
/** Famille du modèle en un mot : « opus », « sonnet », « haiku » ; sinon le nom court. */
const family = (m: string | undefined): string => m ? (/(opus|sonnet|haiku)/i.exec(m)?.[1]?.toLowerCase() ?? modelName(m)) : '';
interface Crew { main: Who; me: Who; subs: Map<string, Who>; byBase: Map<string, string[]>; raw: SubAgent[] }
function crewOf(subs: SubAgent[], models: string[], codex = false): Crew {
  // Un fil Codex n'a pas d'équipe Studio : l'agent s'appelle Codex et garde le nom de son modèle (gpt-5-codex…).
  const main: Who = codex ? { ...persona('principal'), name: 'Codex', role: 'OpenAI', id: 'main', base: 'Codex', model: models[models.length - 1] ?? '' }
    : { ...persona('principal'), id: 'main', base: 'Moka', model: family(models[models.length - 1]) };
  const me: Who = { name: 'Toi', role: '', hue: 'gray', id: '', base: 'Toi', me: true };
  const by = new Map<string, Who>(), count = new Map<string, number>(), byBase = new Map<string, string[]>();
  // Plusieurs agents du même rôle : « Filou », « Filou 2 », dans l'ordre où ils sont partis.
  count.set(main.name, 1); // personne d'autre ne s'appelle comme l'agent principal
  for (const s of [...subs].sort((a, b) => ms(a.started) - ms(b.started))) {
    const g = generic(s.type), key = g ? HELP : persona(s.type).name, ps = g ? helper(byBase.get(HELP)?.length ?? 0) : persona(s.type), n = (count.get(ps.name) ?? 0) + 1;
    count.set(ps.name, n); byBase.set(key, [...(byBase.get(key) ?? []), s.id]);
    by.set(s.id, { ...ps, name: n > 1 ? `${ps.name} ${n}` : ps.name, id: s.id, base: ps.name });
  }
  return { main, me, subs: by, byBase, raw: subs };
}
const initials = (w: Who): string => w.me ? 'T' : w.name.replace(/\s+/g, '').slice(0, 2).replace(/^./, c => c.toUpperCase());
/** Pastille d'un agent ; celle d'un agent du fil ouvre sa fiche (`data-sl="who"`). */
/** Le chat d'un agent (même prénom = même chat), dans l'humeur donnée ; moi, je garde mon initiale. */
const cat = (w: Who, mood: catface.Mood = 'idle', look = false): string => w.me ? esc(initials(w)) : catface.face(w.name, mood, { look });
/** Rond d'un agent sans geste (pile de l'en-tête, panneau, passations). `cls` : `mini`, `big`, `cf-live` (le chat bouge en boucle). */
const face = (w: Who, mood: catface.Mood = 'idle', cls = ''): string => `<i class="sl-av${cls ? ` ${cls}` : ''}" style="--c:var(--c-${w.hue})" aria-hidden="true">${cat(w, mood, cls.includes('big'))}</i>`;
const avatar = (w: Who, big = false, mood: catface.Mood = 'idle', live = false): string => w.id && !w.me
  ? `<button type="button" class="sl-av${big ? ' big' : ''}${live ? ' cf-live' : ''}" style="--c:var(--c-${w.hue})" data-sl="who" data-who="${esc(w.id)}" title="Voir la fiche de ${esc(w.name)}" aria-label="Fiche de ${esc(w.name)}">${cat(w, mood, big)}</button>`
  : face(w, mood, `${big ? 'big' : ''}${live ? ' cf-live' : ''}`.trim());
/** Prénom cliquable (ouvre la fiche), sinon en gras. */
const nameBtn = (w: Who, cls = ''): string => w.id && !w.me
  ? `<button type="button" class="sl-who${cls ? ` ${cls}` : ''}" style="--c:var(--c-${w.hue})" data-sl="who" data-who="${esc(w.id)}">${esc(w.name)}</button>`
  : `<b${cls ? ` class="${cls}"` : ''}>${esc(w.name)}</b>`;
const hm = (at: number): string => {
  const d = new Date(at), today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('fr-FR', today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const oneLine = (s: string, n = 90): string => { const t = s.replace(/[#>*`_]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Le dernier paragraphe de l'agent contient une question : il attend une réponse. */
const asks = (t: string): boolean => (t.trim().split(/\n{2,}/).pop() ?? '').includes('?');
const TESTS = /\b(npm (run )?test|npm run (typecheck|e2e)|vitest|jest|pytest|go test|cargo test|swift test|xcodebuild test|phpunit|rspec)\b/;
const VERB: Record<string, string> = { Read: 'lit', Grep: 'cherche dans', Glob: 'cherche', Edit: 'modifie', MultiEdit: 'modifie', Write: 'écrit', NotebookEdit: 'modifie', Bash: 'lance une commande', Agent: 'confie une tâche', Task: 'confie une tâche', WebSearch: 'cherche sur le web', WebFetch: 'lit une page' };
/** Ce que fait un agent, en clair : « lit app.ts » (jamais la commande ni le chemin complet). */
function doing(kind: string, text: string): string {
  const k = kind.replace(/^tool:/, ''), v = VERB[k]; if (!v) return '';
  return /^(Read|Edit|MultiEdit|Write|NotebookEdit)$/.test(k) ? `${v} ${text.split('/').pop()?.trim() ?? ''}`.trim() : v;
}

// ---------- Le fil de discussion ----------
const mention = (w: Who): string => w.id && !w.me
  ? `<button type="button" class="sl-to" style="--c:var(--c-${w.hue})" data-sl="who" data-who="${esc(w.id)}">@${esc(w.name)}</button>`
  : `<span class="sl-to" style="--c:var(--c-${w.hue})">@${esc(w.name)}</span>`;
/** Insère la mention au début du premier paragraphe d'un message rendu. */
const withTo = (html: string, to: Who | null): string => !to ? html : /<p[\s>]/.test(html) ? html.replace(/<p(\s[^>]*)?>/, m => `${m}${mention(to)} `) : `<p>${mention(to)}</p>${html}`;
/** Texte brut comparable : casse et espaces normalisés. */
const norm = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();
function msgHTML(w: Who, at: number, body: string, o: { cls?: string; tag?: string; mood?: catface.Mood } = {}): string {
  return `<article class="sl-msg${w.me ? ' me' : ''}${o.cls ? ` ${o.cls}` : ''}">${avatar(w, false, o.mood)}<div class="sl-bd"><header>${nameBtn(w)}${w.role ? `<span class="sl-role">${esc(w.role)}</span>` : ''}${w.model ? `<em class="sl-model" title="Modèle">${esc(w.model)}</em>` : ''}${o.tag ? `<em class="sl-tag">${o.tag}</em>` : ''}<time>${esc(at ? hm(at) : '')}</time></header>${body}</div></article>`;
}
const noteHTML = (html: string, at: number, brief = ''): string => brief
  ? `<details class="sl-note"><summary><span>${html}</span><time>${esc(hm(at))}</time>${icon('chevron')}</summary><div class="sl-brief">${esc(brief)}</div></details>`
  : `<p class="sl-note"><span>${html}</span><time>${esc(hm(at))}</time></p>`;
const plain = (t: string): string => `<p class="sl-plain">${esc(t)}</p>`;
/** Markdown d'un paragraphe, gardé en mémoire : le fil est recalculé à chaque relecture (toutes les secondes quand
 *  l'équipe travaille), le texte déjà rendu ne l'est pas une seconde fois. */
const rendered = new Map<string, string>();
function rich(t: string): string {
  let h = rendered.get(t);
  if (h === undefined) { h = answerHTML(t); if (rendered.size > 1500) rendered.clear(); rendered.set(t, h); }
  return h;
}
const md = (t: string): string => `<div class="md">${rich(t)}</div>`;

// ---------- Parler comme dans une discussion ----------
/** Paragraphes d'un message (un bloc de code reste entier ; un titre et une liste restent avec ce qui les suit). */
function chunks(t: string): string[] {
  const out: string[] = []; let cur = '', fence = false;
  for (const line of t.replace(/\r/g, '').split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && !line.trim()) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur.trim()) out.push(cur.trim());
  const merged: string[] = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && (/^#{1,6}\s/.test(prev) && !prev.includes('\n') || /^\s*([-*•]|\d+[.)])\s/.test(c) && /^\s*([-*•]|\d+[.)])\s/m.test(prev))) merged[merged.length - 1] = `${prev}\n\n${c}`;
    else merged.push(c);
  }
  return merged;
}
const SHORT = 480, LEAD = 320;
const bubble = (x: string, i: number): string => `<div class="sl-bub md" style="--i:${i}">${rich(x)}</div>`;
/** Un message d'agent en bulles courtes, une par paragraphe. Un pavé ne montre que son début (et sa question finale,
 *  s'il en pose une) : le reste se déplie sous « Lire la suite ». */
function talk(t: string): string {
  const { text, shots } = captures(t), pics = shots.length ? `<div class="sl-shots">${attach.galleryHTML(shots)}</div>` : '';
  return bubbles(text) + pics;
}
/** Captures d'écran citées par un agent (`![légende](/…/.git/studio-images/…)`, voir `AgentImages.captureNote` côté Mac) :
 *  retirées du texte et montrées en vignettes sous le message, toujours visibles (jamais sous « Lire la suite »). */
const SHOT_RE = /!\[[^\]\n]*\]\(<?(\/[^)\s>]*\/\.git\/studio-images\/[^)\s>]+\.(?:png|jpe?g|webp|gif))>?\)/gi;
function captures(t: string): { text: string; shots: string[] } {
  if (!t.includes('studio-images/')) return { text: t, shots: [] };
  const shots: string[] = [];
  const text = t.replace(SHOT_RE, (_m, path: string) => { if (!shots.includes(path) && shots.length < 12) shots.push(path); return ''; });
  return { text: text.replace(/\n{3,}/g, '\n\n'), shots };
}
function bubbles(t: string): string {
  const c = chunks(t); if (!c.length) return '';
  if (c.reduce((n, x) => n + x.length, 0) <= SHORT && c.length <= 4) return c.map(bubble).join('');
  const head: string[] = []; let n = 0;
  for (const x of c) { if (head.length && (n + x.length > LEAD || head.length >= 2)) break; head.push(x); n += x.length; }
  const rest = c.slice(head.length), last = rest[rest.length - 1];
  const tail = rest.length > 1 && last && last.length < 400 && asks(last) ? [rest.pop() as string] : [];
  const words = rest.join(' ').split(/\s+/).length;
  return head.map(bubble).join('')
    + (rest.length ? `<details class="sl-fold sl-rest"><summary>Lire la suite · ${words} mots${icon('chevron')}</summary>${rest.map(bubble).join('')}</details>` : '')
    + tail.map((x, i) => bubble(x, head.length + i)).join('');
}
/** Messages envoyés d'ici, montrés tout de suite, jusqu'à ce que le Mac les ait dans la conversation (ou 3 min). */
const pend = new Map<string, { text: string; at: number; sent?: boolean; pics?: number }[]>();
/** Nouveau fil en cours de création : la consigne et « Moka écrit… » s'affichent avant que le Mac ait répondu. */
let opening: { pid: string; text: string; at: number; pics?: number } | null = null;
/** Envoi récent par fil : l'agent paraît au travail dès l'envoi, sans attendre que le Mac le dise (45 s au plus). */
const woke = new Map<string, number>();
function awake(id: string): boolean {
  const at = woke.get(id); if (!at) return false;
  // L'agent a déjà répondu après l'envoi, ou rien n'est venu à temps : l'état du Mac reprend la main.
  if (Date.now() - at > 45e3 || (S.detail.get(id)?.actions ?? []).some(a => a.kind !== 'prompt' && ms(a.at) > at + 1000)) { woke.delete(id); return false; }
  return true;
}
/** Juste après un envoi, le fil est relu toutes les 0,9 s pendant 20 s (au lieu de 2,5 s) : la réponse apparaît dès qu'elle existe. */
let fastUntil = 0, fastTimer: ReturnType<typeof setTimeout> | undefined;
function hurry(): void {
  fastUntil = Date.now() + 20e3; if (fastTimer) return;
  const go = (): void => { fastTimer = undefined; if (Date.now() > fastUntil || !root?.isConnected) return; void refresh(); fastTimer = setTimeout(go, 900); };
  fastTimer = setTimeout(go, 400);
}
const PEND_TTL = 3 * 6e4;

/** Membre du fil d'après un nom du tableau (« Agent 2 · explorateur », « explorateur ») : jamais un agent d'un autre groupe. */
function crewMember(crew: Crew, name: string): Who | null {
  const n = name.replace(/^Agent \d+ · /, '').trim();
  if (/^Agent \d+$/.test(n) || !n) return null;
  // Par son rôle, sinon par son fichier du tableau (« schemas.md »), que la consigne reçue de l'agent principal nomme.
  const id = (generic(n) ? undefined : crew.byBase.get(persona(n).name)?.[0])
    ?? crew.raw.find(s => flat(s.prompt ?? '').includes(`${flat(n)}.md`))?.id;
  return id ? crew.subs.get(id) ?? null : null;
}

interface Item { at: number; key: string; html: string; who: string }
/** Tout ce qui se dit dans le fil, du plus ancien au plus récent ; `ask` : la dernière chose écrite est une réponse de l'agent qui pose une question. */
function itemsOf(d: Detail, crew: Crew, board: BoardMsg[]): { items: Item[]; ask: boolean } {
  const out: Item[] = [], seq = new Map<string, number>(), nth = new Map<string, number>();
  const add = (at: number, k: string, html: string, who = ''): void => { const key = `${k}|${at}`, n = seq.get(key) ?? 0; seq.set(key, n + 1); out.push({ at, key: n ? `${key}|${n}` : key, html, who }); };
  let lastTests = 0, lastText = -1;
  const spoken: string[] = [];
  d.actions.forEach((a, i) => {
    const at = ms(a.at);
    if (a.kind === 'prompt') { add(at, 'me', msgHTML(crew.me, at, plain(a.text) + attach.galleryHTML(a.images)), 'me'); return; }
    if (a.kind === 'tool:Agent' || a.kind === 'tool:Task') {
      // Passation : « Moka a confié … à Filou » ; la consigne complète se déplie. Le n-ième envoi d'un rôle est le n-ième agent de ce rôle.
      if (!a.body && !a.to) return;
      const g = generic(a.to || ''), key = g ? HELP : persona(a.to || '').name, k = nth.get(key) ?? 0; nth.set(key, k + 1);
      const ps = g ? helper(k) : persona(a.to || '');
      const w = crew.subs.get(crew.byBase.get(key)?.[k] ?? '') ?? { ...ps, id: '', base: ps.name };
      const what = a.text ? ` « ${esc(oneLine(a.text, 70))} »` : ' une tâche';
      add(at, 'delegate', noteHTML(`${face(crew.main, 'idle', 'mini')}${nameBtn(crew.main)} a confié${what} à ${face(w, 'idle', 'mini')}${nameBtn(w, 'sl-nm')}`, at, a.body ?? ''));
      return;
    }
    if (a.kind.startsWith('tool:')) {
      // Un seul événement lisible : les tests ont été lancés (pas la commande).
      if (a.kind === 'tool:Bash' && TESTS.test(a.text) && at - lastTests > 90e3) { lastTests = at; add(at, 'tests', noteHTML('Les tests sont lancés', at)); }
      return;
    }
    lastText = i; spoken.push(norm(a.text));
    add(at, 'ai', msgHTML(crew.main, at, talk(a.text), { cls: 'ai' }), 'main');
  });
  // Comptes rendus des sous-agents : un message de leur part à l'agent principal, replié s'il est long.
  for (const s of d.subagents ?? []) {
    const w = crew.subs.get(s.id); if (s.live || !s.report || !w) continue;
    spoken.push(norm(s.report));
    const at = ms(s.updated), long = s.report.length > 280 || s.report.split('\n').length > 6;
    add(at, 'report', msgHTML(w, at, long
      ? `<div class="sl-bub"><p class="sl-gist">${mention(crew.main)} ${esc(oneLine(s.report, 120))}</p></div><details class="sl-fold"><summary>Lire le compte rendu${icon('chevron')}</summary>${md(s.report)}</details>`
      : withTo(talk(s.report), crew.main), { mood: 'done' }), s.id);
  }
  // Tableau d'équipe : seulement l'utilisateur, l'agent principal et les sous-agents de CE fil.
  for (const e of exchanges([], [], board)) {
    const w = e.from === 'Toi' ? crew.me : e.from === 'principal' ? crew.main : crewMember(crew, e.from);
    if (!w || !e.text.trim() || (norm(e.text).length > 0 && spoken.some(x => x.includes(norm(e.text).slice(0, 60))))) continue; // déjà dit (compte rendu, message)
    const dest = e.to === 'principal' ? crew.main : e.to && e.to !== 'Toi' ? crewMember(crew, e.to) : null, to = dest && dest.id !== w.id ? dest : null;
    add(e.at, 'board', msgHTML(w, e.at, w.me ? plain(e.text) : withTo(talk(e.text), to)), w.me ? 'me' : w.id);
  }
  out.sort((a, b) => a.at - b.at);
  // Plusieurs messages de suite du même agent : un seul en-tête, comme dans une messagerie.
  out.forEach((x, i) => { const prev = out[i - 1]; if (prev && x.who && prev.who === x.who && x.at - prev.at < 5 * 6e4) x.html = x.html.replace('class="sl-msg', 'class="sl-msg cont'); });
  return { items: out, ask: lastText >= 0 && lastText === d.actions.length - 1 && asks(d.actions[lastText]?.text ?? '') };
}

/** Carte « résultat » d'après l'état de la copie de l'agent : à publier, PR ouverte, fusionné. */
function resultHTML(t: Thread, d: Detail): string {
  const wt = d.worktree || t.s.worktree, w = wt ? S.trees.find(x => x.name === wt) : undefined;
  if (!w || t.group === 'work') return '';
  const st = copyStage(w), n = (d.files ?? t.s.files).length, lines = d.lines ?? t.s.lines;
  const title = w.subject || (t.s.firstPrompt ? oneLine(t.s.firstPrompt, 80) : '') || 'Le travail de l’équipe';
  const meta = [n ? `${n} fichier${n > 1 ? 's' : ''}` : '', lines && (lines.add || lines.del) ? `+${lines.add} −${lines.del}` : '', w.branch].filter(Boolean).map(esc).join(' · ');
  const a = esc(w.name);
  if (st === 'review') return `<div class="sl-card res"><span class="sl-pill" style="--c:var(--c-green)">prêt à publier</span><div class="sl-card-t"><b>${esc(title)}</b>${meta ? `<small>${meta}</small>` : ''}</div><div class="sl-card-a"><button class="btn" data-sl="review" data-wt="${a}">Relire</button><button class="btn btn-primary" data-sl="publish" data-wt="${a}">${icon('upload')}Publier la PR</button></div></div>`;
  if (st === 'pr') return `<div class="sl-card res"><span class="sl-pill" style="--c:var(--c-blue)">PR ouverte</span><div class="sl-card-t"><b>${esc(title)}</b><small>En attente de fusion${meta ? ` · ${meta}` : ''}</small></div><div class="sl-card-a"><button class="btn" data-sl="pr" data-wt="${a}">${icon('pr')}Voir la PR</button></div></div>`;
  // Fusionné : la carte suit la livraison en direct (vérifications sur la branche principale, release), voir `flux.deliveryHTML`.
  if (st === 'merged') {
    const live = flux.deliveryHTML({ repo: p?.stack[0]?.name ?? '', repos: p?.stack.map(x => x.name), branch: w.pr?.branch ?? w.history?.find(h => h.merged)?.branch ?? w.branch, title, meta, pr: w.pr ? { number: w.pr.number, url: w.pr.url } : undefined });
    if (live) return live;
  }
  if (st === 'merged') return `<div class="sl-card res"><span class="sl-pill" style="--c:var(--c-violet)">fusionné</span><div class="sl-card-t"><b>${esc(title)}</b><small>Livré dans la branche principale</small></div></div>`;
  return '';
}

/** « Moka écrit… » avec trois points qui sautillent ; les sous-agents au travail sont nommés. */
function typing(crew: Crew, d: Detail | undefined): string {
  const on = (d?.subagents ?? []).filter(s => s.live).map(s => crew.subs.get(s.id)?.name).filter((x): x is string => !!x);
  const who = on.length ? `${on.length > 1 ? `${on.slice(0, -1).join(', ')} et ${on[on.length - 1]}` : on[0]} ${on.length > 1 ? 'travaillent' : 'travaille'}` : `${crew.main.name} écrit`;
  const cats = (d?.subagents ?? []).filter(s => s.live).map(s => crew.subs.get(s.id)).filter((x): x is Who => !!x).slice(0, 3);
  return `<div class="sl-typing cf-live"><span class="sl-stack">${(cats.length ? cats : [crew.main]).map(w => avatar(w, false, 'work')).join('')}</span><span class="sl-dots" aria-hidden="true"><i></i><i></i><i></i></span><small>${esc(who)}…</small></div>`;
}
/** Messages partis d'ici que le Mac n'a pas encore rendus (`known` : textes déjà présents dans la conversation). */
function pending(id: string, known: { text: string; at?: string }[], crew: Crew): Block[] {
  // Un message rendu par le Mac n'en solde qu'un, et jamais un envoi plus récent que lui (« Oui, vas-y » deux fois de suite).
  const ks = known.map(x => ({ n: norm(x.text), at: ms(x.at), used: false }));
  const list = (pend.get(id) ?? []).filter(x => {
    if (Date.now() - x.at >= PEND_TTL) return false;
    const t = norm(x.text), k = ks.find(y => !y.used && y.n === t && (!y.at || y.at >= x.at - 15e3));
    if (k) k.used = true;
    return !k;
  });
  if (list.length) pend.set(id, list); else pend.delete(id);
  return list.map(x => ({ key: `me|p|${x.at}`, html: msgHTML(crew.me, x.at, plain(x.text) + picsNote(x.pics), x.sent ? { cls: 'sent', tag: `${icon('check')}envoyé` } : { cls: 'sending', tag: 'envoi…' }) }));
}
/** « 2 images jointes » sous un message pas encore rendu par le Mac (ses vignettes viennent avec la conversation). */
const picsNote = (n = 0): string => n ? `<p class="sl-pics">+ ${n} image${n > 1 ? 's' : ''} jointe${n > 1 ? 's' : ''}</p>` : '';
/** Réponses d'un clic quand l'agent pose une question. */
const QUICK = ['Oui, vas-y', 'Non, attends', 'Explique-moi'];
function blocksOf(t: Thread, d: Detail | undefined, crew: Crew): { blocks: Block[]; ask: boolean } {
  const id = t.id, blocks: Block[] = [], work = t.group === 'work';
  if (!d) {
    const run = S.runs.find(r => `run:${r.run}` === id || r.session === id);
    // Même clé que le message affiché à l'envoi : il reste en place au lieu de rejouer son entrée.
    const p0 = run && pend.get(id)?.find(x => norm(x.text) === norm(run.prompt));
    if (run) blocks.push({ key: p0 ? `me|p|${p0.at}` : 'first', html: msgHTML(crew.me, ms(run.started), plain(run.prompt)) });
    blocks.push(...pending(id, run ? [{ text: run.prompt }] : [], crew));
    blocks.push(work || !run ? { key: 'working', html: typing(crew, d) } : { key: 'wait', html: '<p class="sl-wait"><span class="spin"></span>Lecture de la conversation…</p>' });
    return { blocks, ask: false };
  }
  const { items, ask } = itemsOf(d, crew, d.worktree ? S.board.get(d.worktree) ?? [] : []);
  for (const i of items) blocks.push({ key: i.key, html: i.html });
  if (!items.length) blocks.push({ key: 'none', html: `<p class="sl-wait">${esc(d.message ?? 'Rien n’a encore été dit dans ce fil.')}</p>` });
  // La dernière réponse de l'agent pose une question : elle est mise en avant, avec un geste pour répondre.
  if (ask && !work) {
    let i = blocks.length - 1; while (i >= 0 && !blocks[i]?.key.startsWith('ai|')) i--;
    const b = blocks[i];
    if (b) blocks[i] = { key: b.key, html: b.html.replace('class="sl-msg', 'class="sl-msg ask cf-live').replace('cf cf-idle', 'cf cf-ask').replace('</div></article>', `<div class="sl-ask"><span>${icon('sparkle')}${esc(crew.main.name)} attend ta réponse</span><span class="sl-quick">${QUICK.map(q => `<button type="button" class="btn btn-ghost" data-sl="quick" data-text="${esc(q)}">${esc(q)}</button>`).join('')}</span><button class="btn" data-sl="reply">Répondre…</button></div></div></article>`) };
  }
  const queued = S.queued.filter(x => x.session === id);
  for (const q of queued)
    blocks.push({ key: `q|${q.id}`, html: msgHTML(crew.me, ms(q.at), plain(q.text) + attach.galleryHTML(q.images), { cls: 'queued', tag: `${icon('history')}en attente` }) });
  blocks.push(...pending(id, [...d.actions.filter(a => a.kind === 'prompt').slice(-5), ...queued], crew));
  if (work) blocks.push({ key: 'working', html: typing(crew, d) });
  const res = resultHTML(t, d);
  if (res) blocks.push({ key: 'result', html: res });
  return { blocks, ask };
}

// ---------- Pièces de la page ----------
/** Un fil au travail n'est jamais caché, même archivé. */
const isArch = (t: Thread): boolean => t.group !== 'work' && archived.isArchived(S.pid, t.id);
/** Conversation OpenAI Codex : lue sur ce Mac, reprise dans le Terminal ou l'app Codex (pas de réponse depuis Studio). */
const isCodex = (t: Thread | undefined): boolean => t?.s.engine === 'codex';
const OLD_DAYS = 7;
const oldOnes = (th: Thread[]): Thread[] => th.filter(t => t.group === 'recent' && !isArch(t) && Date.now() - t.act > OLD_DAYS * 864e5);
const FILTS: [Filt, string, (t: Thread) => boolean][] = [
  ['all', 'Tous', t => !isArch(t)], ['work', 'En cours', t => t.group === 'work'], ['mine', 'À toi', t => t.group === 'mine' && !isArch(t)],
  ['done', 'Terminés', t => t.group === 'recent' && !isArch(t)], ['codex', 'Codex', t => isCodex(t) && !isArch(t)], ['arch', 'Archivés', isArch],
];
const matches = (t: Thread, q: string): boolean => !q || fold([nameOf(t.s), t.s.firstPrompt ?? '', t.s.lastPrompt, t.s.branch, t.s.worktree, isCodex(t) ? `codex ${t.s.sub ?? ''}` : ''].join(' ')).includes(q);
function filtHTML(th: Thread[]): string {
  return FILTS.map(([k, l, f]) => { const n = th.filter(f).length; return k !== 'all' && k !== filt && !n ? '' : `<button type="button" class="sl-chip${k === filt ? ' on' : ''}" data-sl="filt" data-f="${k}" aria-pressed="${k === filt}">${l}${k === 'all' ? '' : `<span>${n}</span>`}</button>`; }).join('');
}
function listHTML(th: Thread[], id: string): string {
  if (!S.loaded && !th.length) return '<p class="sl-empty-s"><span class="spin"></span>Lecture des fils…</p>';
  const arch = filt === 'arch';
  const row = (t: Thread): string => `<div class="sl-row${t.id === id ? ' cur' : ''}" data-id="${esc(t.id)}"><button type="button" class="sl-pick" data-sl="pick" data-id="${esc(t.id)}"${t.id === id ? ' aria-current="true"' : ''} title="${esc(nameOf(t.s))}"><i class="sl-dot ${t.group}" aria-hidden="true"></i><span class="sl-row-t">${esc(nameOf(t.s))}</span>${isCodex(t) ? `<span class="sl-tag" title="${esc(`Codex · ${t.s.sub ?? ''}`)}">Codex</span>` : ''}<time>${esc(rel(t.act))}</time></button>${t.group === 'work' || t.id.startsWith('run:') ? '' : arch
    ? `<button type="button" class="sl-x" data-sl="unarch" data-id="${esc(t.id)}" title="Remettre dans la liste" aria-label="Remettre dans la liste">${icon('restore')}</button>`
    : `<button type="button" class="sl-x" data-sl="arch" data-id="${esc(t.id)}" title="Archiver (rien n’est effacé)" aria-label="Archiver ce fil">${icon('inbox')}</button>`}</div>`;
  const grp = (title: string, list: Thread[], extra = ''): string => list.length ? `<section class="sl-grp"><h4>${title}<span>${list.length}</span></h4>${list.map(row).join('')}${extra}</section>` : '';
  const q = fold(query.trim()), f = FILTS.find(x => x[0] === filt)?.[2] ?? FILTS[0][2], shownTh = th.filter(t => f(t) && matches(t, q));
  const old = oldOnes(th).length;
  const foot = arch ? (shownTh.length > 1 ? `<div class="sl-foot"><button type="button" class="sl-more" data-sl="unarch-all">Tout remettre dans la liste</button></div>` : '')
    : `<div class="sl-foot">${old && !q ? `<button type="button" class="sl-more" data-sl="tidy" title="Les fils terminés depuis plus de ${OLD_DAYS} jours passent dans « Archivés »">${icon('inbox')}<span>Archiver les fils de plus de ${OLD_DAYS} jours (${old})</span></button>` : ''}<button type="button" class="sl-more" data-sl="clean" title="Choisir des conversations terminées à supprimer pour de bon">${icon('trash')}<span>Supprimer des fils…</span></button></div>`;
  if (!shownTh.length) return `<p class="sl-empty-s">${q ? 'Aucun fil ne correspond.' : arch ? 'Aucun fil archivé.' : 'Aucun fil pour l’instant.'}</p>${q || arch ? '' : foot}`;
  // Codex : un groupe par sous-projet (dépôt ou sous-dossier où le fil a tourné), comme dans l'app Codex.
  if (filt === 'codex' && !q) { const subs = [...new Set(shownTh.map(t => t.s.sub || 'Projet'))]; return subs.map(n => grp(esc(n), shownTh.filter(t => (t.s.sub || 'Projet') === n))).join('') + foot; }
  // Recherche ou filtre : une liste à plat, du plus récent au plus ancien.
  if (q || filt !== 'all') return grp(q ? 'Résultats' : FILTS.find(x => x[0] === filt)?.[1] ?? '', shownTh) + foot;
  const rec = shownTh.filter(t => t.group === 'recent');
  const more = rec.length > MORE ? `<button type="button" class="sl-more" data-sl="more">${moreOpen ? 'Moins' : `${rec.length - MORE} de plus`}</button>` : '';
  return grp('En cours', shownTh.filter(t => t.group === 'work')) + grp('À toi', shownTh.filter(t => t.group === 'mine')) + grp('Récentes', moreOpen ? rec : rec.slice(0, MORE), more) + foot;
}
type Mood = 'work' | 'ask' | 'ready' | 'done';
const MOOD: Record<Mood, [string, string]> = { work: ['au travail', 'amber'], ask: ['attend ta réponse', 'orange'], ready: ['prêt à publier', 'green'], done: ['terminé', 'gray'] };
function moodOf(t: Thread, ask: boolean): Mood {
  if (t.group === 'work') return 'work';
  if (ask) return 'ask';
  const w = t.s.worktree ? S.trees.find(x => x.name === t.s.worktree) : undefined;
  return w && copyStage(w) === 'review' ? 'ready' : 'done';
}
function headHTML(t: Thread, crew: Crew, ask: boolean, n: number): string {
  const [label, c] = MOOD[moodOf(t, ask)], min = Math.max(0, Math.round(((t.group === 'work' ? Date.now() : ms(t.s.updated)) - ms(t.s.started)) / 6e4));
  const run = S.runs.find(r => live(r) && (r.session === t.id || `run:${r.run}` === t.id));
  const faces = [crew.main, ...crew.subs.values()].slice(0, 5).map(w => face(w)).join('');
  if (isCodex(t)) return `<h2>${esc(nameOf(t.s))}</h2><span class="sl-pill" style="--c:var(--c-${c})">${label}</span><span class="sl-meta">Codex${t.s.sub ? ` · ${esc(t.s.sub)}` : ''}${t.s.origin ? ` · ${esc(t.s.origin)}` : ''}${min ? ` · ${min} min` : ''}</span><button type="button" class="btn" data-sl="codex" data-app="terminal" data-id="${esc(t.id)}" title="Ouvre le Terminal dans le dossier du fil et lance codex resume">${icon('terminal')}<span>Reprendre dans le Terminal</span></button><button type="button" class="btn btn-ghost" data-sl="codex" data-app="app" data-id="${esc(t.id)}" title="Ouvrir l’app Codex">${icon('share')}<span>App Codex</span></button>`;
  return `<h2>${esc(nameOf(t.s))}</h2><span class="sl-pill" style="--c:var(--c-${c})">${label}</span><span class="sl-meta">${n} agent${n > 1 ? 's' : ''}${min ? ` · ${min} min` : ''}</span>${run ? `<button type="button" class="btn btn-ghost" data-sl="stop" data-run="${esc(run.run)}" title="Arrêter l’équipe">${icon('stop')}<span>Arrêter</span></button>` : ''}<button type="button" class="btn btn-ghost sl-nowbtn" data-sl="now" aria-pressed="false" title="Afficher ou masquer l’équipe"><span class="sl-stack">${faces}</span><span>Équipe</span></button>${t.id.startsWith('run:') ? '' : `<button type="button" class="btn" data-sl="tech" data-id="${esc(t.id)}" title="Voir les étapes dans l’onglet Claude Code">${icon('terminal')}<span>Vue technique</span></button>`}`;
}
// ---------- Consommation de tokens du fil ----------
// Le journal de la session ne compte que l'agent principal ; chaque sous-agent a le sien (`tok`, app Mac récente,
// sinon ses seuls tokens écrits). Lus = entrée + écriture en cache (comme l'onglet Claude Code), à part les relectures du cache.
const NO_TOK: Tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const mainTok = (t: Thread, d: Detail | undefined): Tok => ({ ...NO_TOK, ...t.s.tokens, ...d?.tokens });
const subTok = (s: SubAgent): Tok => s.tok ? { ...NO_TOK, ...s.tok } : { ...NO_TOK, output: s.tokens || 0 };
const read = (k: Tok): number => k.input + k.cacheWrite;
const tokTip = (k: Tok): string => `${usage.fmt(k.output)} ${tr('tokens écrits')} · ${usage.fmt(read(k))} ${tr('lus')} · ${usage.fmt(k.cacheRead)} ${tr('relus du cache')}`;
/** Détail par agent replié, ouvert ou non d'un rendu à l'autre (le Salon repeint toutes les secondes ou presque). */
let useOpen = false;
function useHTML(t: Thread, d: Detail | undefined, crew: Crew): string {
  const rows: [string, Tok][] = [[crew.main.name, mainTok(t, d)], ...(d?.subagents ?? []).map((s): [string, Tok] => [crew.subs.get(s.id)?.name ?? s.title, subTok(s)])];
  const tot = rows.reduce((a, [, k]) => ({ input: a.input + k.input, output: a.output + k.output, cacheRead: a.cacheRead + k.cacheRead, cacheWrite: a.cacheWrite + k.cacheWrite }), NO_TOK);
  if (!tot.output && !read(tot)) return '';
  const line = (name: string, k: Tok, cls = ''): string => `<div class="sl-use-row${cls}" title="${esc(tokTip(k))}"><span>${esc(name)}</span><b>${usage.fmt(k.output)}</b><span>${usage.fmt(read(k))}</span></div>`;
  const head = `<div class="sl-use-row hd"><span></span><b>écrits</b><span>lus</span></div>`;
  const detail = head + (rows.length > 1 ? rows.map(([n, k]) => line(n, k)).join('') + line('Total', tot, ' tot') : line(rows[0]?.[0] ?? '', tot));
  return `<details class="sl-use" data-sl-use${useOpen ? ' open' : ''}><summary title="${esc(tokTip(tot))}">${icon('chevron')}<span>Ce fil</span><b>${usage.fmt(tot.output)} écrits</b></summary>${detail}</details>`;
}
/** Remise à zéro d'une limite, en clair : « dans 2 h 10 », « dans 3 j ». */
function resetIn(at?: number): string {
  if (!at) return '';
  const m = Math.max(0, Math.round((at - Date.now()) / 6e4));
  return m >= 2880 ? `dans ${Math.round(m / 1440)} j` : m >= 60 ? `dans ${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}` : `dans ${m} min`;
}
/** Fin de la colonne Équipe : tokens du fil (détail par agent), puis les limites de l'abonnement (5 h, semaine…). */
function consHTML(t: Thread, d: Detail | undefined, crew: Crew): string {
  const src = quota.sources().find(x => x.id === 'claudecode');
  const meters = (src?.meters ?? []).map(m => m.pct !== null
    ? `<div class="sl-quota" title="${esc(m.resetsAt ? `Remise à zéro ${resetIn(m.resetsAt)}` : m.label)}"><span>${esc(m.label)}</span><i class="sl-bar${m.pct >= 90 ? ' hot' : m.pct >= 70 ? ' warm' : ''}"><i style="width:${m.pct}%"></i></i><b>${m.pct} %</b>${m.resetsAt ? `<small>${esc(resetIn(m.resetsAt))}</small>` : ''}</div>`
    : m.value ? `<div class="sl-quota"><span>${esc(m.label)}</span><b>${esc(m.value)}</b></div>` : '').join('');
  const off = src?.note === 'limits-off' && !src.meters.some(m => m.pct !== null)
    ? `<button type="button" class="btn btn-ghost sl-lim" data-sl="limits" title="Lit tes limites d’abonnement depuis l’app Mac">${icon('cpu')}<span>Afficher les limites (5 h, semaine)</span></button>` : '';
  const use = useHTML(t, d, crew);
  return use || meters || off ? `<section class="sl-cons" aria-label="Consommation"><h4>Consommation</h4>${use}${meters}${off}</section>` : '';
}
function nowHTML(t: Thread, d: Detail | undefined, crew: Crew, ask: boolean): string {
  const work = t.group === 'work', lastTool = [...(d?.actions ?? [])].reverse().find(a => a.kind.startsWith('tool:') && doing(a.kind, a.text));
  const line = work && lastTool ? doing(lastTool.kind, lastTool.text) : !work && d?.lines ? `+${d.lines.add} −${d.lines.del}` : '';
  const mem = (w: Who, state: string, cls: string, last: string, mood: catface.Mood): string => `<button type="button" class="sl-mem ${cls}${prof === w.id ? ' cur' : ''}" data-sl="who" data-who="${esc(w.id)}" title="Voir la fiche de ${esc(w.name)}">${face(w, mood, cls ? 'cf-live' : '')}<div><b>${esc(w.name)}${w.model ? `<em class="sl-model">${esc(w.model)}</em>` : ''}</b><small class="sl-st">${esc(state)}</small>${last ? `<small class="sl-last">${esc(last)}</small>` : ''}</div></button>`;
  const subs = [...(d?.subagents ?? [])].sort((a, b) => Number(b.live) - Number(a.live) || ms(b.updated) - ms(a.updated));
  const rows = [mem(crew.main, work ? 'travaille' : ask ? 'attend ta réponse' : 'a fini', work ? 'on' : ask ? 'ask' : '', line, work ? 'work' : ask ? 'ask' : 'done'), ...subs.map(s => {
    const w = crew.subs.get(s.id); if (!w) return '';
    const l = s.live ? (s.last?.kind.startsWith('tool:') ? doing(s.last.kind, s.last.text) || 'réfléchit' : 'réfléchit') : s.files?.length ? `${s.files.length} fichier${s.files.length > 1 ? 's' : ''} touché${s.files.length > 1 ? 's' : ''}` : '';
    return mem(w, s.live ? 'travaille' : 'a fini', s.live ? 'on' : '', l, s.live ? 'work' : 'sleep');
  })].join('');
  // Codex : les réglages de sous-agents sont ceux des agents Studio (Claude Code), sans effet sur un fil Codex.
  if (isCodex(t)) return `<h4>Équipe</h4>${rows}`;
  return `<h4>Équipe</h4>${rows}<button type="button" class="btn btn-ghost sl-set" data-sl="team" title="${esc(subagents.HINT)}">${icon('gear')}<span>${esc(subagents.label(S.pid))}</span></button>`;
}
// ---------- Vue Technique de la colonne (même colonne que « En ce moment », autre lecture des mêmes données) ----------
// Sobre et typographique, avec les styles `.lv-*` de css/pulse.css (suivi en direct de l'onglet Claude Code) : ce que
// l'agent fait maintenant (verbe + cible en chasse fixe), un chrono, ses dernières actions, ses derniers fichiers +/−.
// Rien de nouveau n'est lu : actions de la conversation ouverte et sous-agents viennent de `S.detail`.
const TOOL_VERB: Record<string, string> = { Read: 'Lit', Grep: 'Cherche', Glob: 'Cherche', LS: 'Liste', WebFetch: 'Consulte', WebSearch: 'Cherche', Edit: 'Modifie', MultiEdit: 'Modifie', NotebookEdit: 'Modifie', Write: 'Écrit', Bash: 'Lance', BashOutput: 'Lit la sortie', Task: 'Délègue', Agent: 'Délègue' };
const FILE_TOOL = /^(Read|Edit|MultiEdit|Write|NotebookEdit)$/, EDIT_TOOL = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
const amount = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const shortPath = (f: string): string => f.trim().split('/').filter(Boolean).slice(-2).join('/') || f;
/** Cible d'une action : chemin raccourci pour un fichier, première ligne de la commande sinon. */
const targetOf = (kind: string, text: string): string => FILE_TOOL.test(kind.slice(5)) ? shortPath(text) : oneLine(kind === 'tool:Bash' ? noCd(text) : text, 120);
/** Commande sans son « cd <dossier> && » ou « cd <dossier>; » de tête : l'agent la répète à chaque appel, elle masquait la vraie commande. */
const noCd = (c: string): string => c.replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, '') || c;
const gain = (add: number, del: number): string => `<span class="st-lines"><b class="a">+${add.toLocaleString('fr-FR')}</b> <b class="d">−${del.toLocaleString('fr-FR')}</b></span>`;
/** Chrono : le texte est posé par `tickClocks` (après chaque rendu, puis chaque seconde) ; `t1` = 0 tant que ça travaille. */
const clockHTML = (t0: number, t1: number): string => t0 ? `<time class="lv-clock" data-t0="${t0}" data-t1="${t1}"${t1 ? '' : ' data-live'}></time>` : '';
const clockText = (s: number): string => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
/** Étape en cours : verbe + cible. */
function stepHTML(working: boolean, last: { kind: string; text: string } | undefined, idle: string): string {
  const tool = last?.kind.startsWith('tool:') ? last.kind.slice(5) : '';
  const verb = working ? (tool ? TOOL_VERB[tool] ?? 'Travaille' : last?.kind === 'text' ? 'Répond' : 'Prépare') : idle;
  const tg = working && last && tool ? targetOf(last.kind, last.text) : '';
  return `<span class="lv-now"><i class="lv-dot"></i><b>${esc(verb)}</b>${tg ? `<code title="${esc(tg)}">${esc(tg)}</code>` : ''}</span>`;
}
function techHTML(t: Thread, d: Detail | undefined, crew: Crew): string {
  if (!d) return skelHTML('tech');
  const work = t.group === 'work', acts = d.actions, lp = acts.map(a => a.kind).lastIndexOf('prompt'), last = acts[acts.length - 1];
  const t0 = ms(acts[lp]?.at) || ms(t.s.started), t1 = work ? 0 : ms(last?.at) || t0;
  // Dernières actions (outil + cible), les plus récentes d'abord ; celle en cours est déjà dite dans l'étape.
  const tools = acts.filter(a => a.kind.startsWith('tool:') && a.text), recent = tools.slice(work ? -7 : -6, work ? -1 : undefined).reverse();
  const list = recent.map(a => `<div class="st-act"><span>${esc(a.kind.slice(5))}</span><code title="${esc(a.text)}">${esc(targetOf(a.kind, a.text))}</code></div>`).join('');
  // Fichiers touchés : les plus récents d'abord, lignes +/− cumulées.
  const per = new Map<string, { add: number; del: number; at: number }>();
  for (const a of acts) {
    if (!EDIT_TOOL.test(a.kind.slice(5)) || !a.text) continue;
    const f = per.get(a.text) ?? { add: 0, del: 0, at: 0 };
    f.add += amount(a.add); f.del += amount(a.del); f.at = Math.max(f.at, ms(a.at)); per.set(a.text, f);
  }
  const rows = [...per].sort((a, b) => b[1].at - a[1].at), shownRows = rows.slice(0, 5);
  const files = shownRows.map(([f, v]) => `<div class="lv-file"><code title="${esc(f)}">${esc(shortPath(f))}</code>${gain(v.add, v.del)}</div>`).join('')
    + (rows.length > shownRows.length ? `<p class="lv-more">et ${rows.length - shownRows.length} autre${rows.length - shownRows.length > 1 ? 's' : ''}</p>` : '');
  const total = d.lines && (d.lines.add || d.lines.del) ? gain(d.lines.add, d.lines.del) : '';
  const main = `<section class="lv st-agent" data-state="${work ? 'work' : acts.length ? 'done' : 'idle'}"><h5 class="st-who">${esc(crew.main.name)}${total ? ` ${total}` : ''}</h5>
    <div class="lv-head">${stepHTML(work, last, acts.length ? 'Terminé' : 'Prêt')}${clockHTML(t0, t1)}</div>${list || files ? `<div class="lv-rest">${list ? `<div class="st-acts">${list}</div>` : ''}${files ? `<div class="lv-files">${files}</div>` : ''}</div>` : ''}</section>`;
  // Sous-agents : ceux qui travaillent d'abord, une ligne chacun (étape, chrono, fichiers).
  const subs = [...(d.subagents ?? [])].sort((a, b) => Number(b.live) - Number(a.live) || ms(b.updated) - ms(a.updated));
  const subRows = subs.slice(0, 6).map(s => {
    const w = crew.subs.get(s.id); if (!w) return '';
    const s0 = ms(s.started), s1 = s.live ? 0 : ms(s.updated) || s0, fl = (s.files ?? []).slice(0, 3).map(f => `<div class="lv-file"><code title="${esc(f.path)}">${esc(shortPath(f.path))}</code>${gain(amount(f.add), amount(f.del))}</div>`).join('');
    return `<section class="lv st-agent" data-state="${s.live ? 'work' : 'done'}"><h5 class="st-who">${esc(w.name)}</h5>
      <div class="lv-head">${stepHTML(s.live, s.last, 'Terminé')}${clockHTML(s0, s1)}</div>${fl ? `<div class="lv-rest"><div class="lv-files">${fl}</div></div>` : ''}</section>`;
  }).join('');
  return main + subRows + (subs.length > 6 ? `<p class="lv-more">et ${subs.length - 6} autre${subs.length > 7 ? 's' : ''}</p>` : '');
}
/** Squelette de la colonne : la place est tenue (avatars, lignes) le temps que le fil démarre ou que sa lecture arrive. */
const skelHTML = (k: 'team' | 'tech'): string => k === 'team'
  ? `<div class="sl-skel" aria-busy="true" aria-label="Chargement">${[72, 54].map((w, i) => `<div class="sl-skel-mem" style="--i:${i}"><i class="sl-skel-av"></i><div><i style="width:${w}%"></i><i style="width:${w - 18}%"></i></div></div>`).join('')}</div>`
  : `<div class="sl-skel" aria-busy="true" aria-label="Chargement">${[64, 88, 46].map((w, i) => `<i style="width:${w}%;--i:${i}"></i>`).join('')}</div>`;
/** Colonne de droite : Équipe en haut, Technique dessous (30 % de la hauteur, défile seule). */
/** Colonne de droite : Équipe, Technique, puis la consommation en pied, toujours visible (chaque section défile seule). */
const colHTML = (team: string, tech: string, cons = ''): string => `<section class="sl-team" aria-label="Équipe">${team}</section><section class="sl-tech" aria-label="Technique"><h4>Technique</h4>${tech}</section>${cons}`;
// Seul le chrono tourne, une fois par seconde : et seulement colonne visible, fenêtre au premier plan, agent au travail.
let techTimer: ReturnType<typeof setInterval> | undefined;
function tickClocks(): void {
  if (!root) return;
  const now = Date.now();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-sl-now] time[data-t0]'))) {
    const t0 = Number(el.dataset.t0), t1 = Number(el.dataset.t1) || now, txt = clockText(Math.max(0, Math.round((t1 - t0) / 1000)));
    if (el.textContent !== txt) el.textContent = txt;
  }
}
function syncClock(): void {
  const on = root !== null && root.isConnected && teamShown(root) && !document.hidden && !!root.querySelector('[data-sl-now] time[data-live]');
  if (on && techTimer === undefined) techTimer = setInterval(() => { if (root?.isConnected) tickClocks(); else syncClock(); }, 1000);
  else if (!on && techTimer !== undefined) { clearInterval(techTimer); techTimer = undefined; }
}
document.addEventListener('visibilitychange', () => { syncClock(); if (!document.hidden) tickClocks(); });
/** Modèle prévu pour un sous-agent : celui que lui donne l'équipe du projet, sinon celui de l'équipe, sinon celui de l'agent. */
function subModel(s: SubAgent): string {
  const t = saved.team(S.pid), m = t.members.find(x => x.name === s.type)?.model || t.model;
  return m ? family(m) : '';
}
const plural = (n: number, w: string): string => `${n} ${w}${n > 1 ? 's' : ''}`;
/** Fiche d'un agent du fil : qui il est, sur quel modèle, ce qu'on lui a confié, ce qu'il fait et ce qu'il a rendu. */
function profHTML(t: Thread, d: Detail | undefined, crew: Crew, ask: boolean): string {
  const main = prof === 'main', s = main ? undefined : d?.subagents?.find(x => x.id === prof), w = main ? crew.main : crew.subs.get(prof);
  if (!w || (!main && !s)) return '';
  const work = t.group === 'work', on = main ? work : !!s?.live;
  const state = main ? (work ? 'travaille' : ask ? 'attend ta réponse' : 'a fini') : on ? 'travaille' : 'a fini';
  const last = main ? [...(d?.actions ?? [])].reverse().find(a => a.kind.startsWith('tool:') && doing(a.kind, a.text)) : s?.last;
  const now = on && last ? doing(last.kind, last.text) || 'réfléchit' : '';
  const tune = main ? saved.ofSession(t.id) : null;
  const model = main ? w.model || (tune?.model && tune.model !== AUTO ? family(tune.model) : '') : s ? subModel(s) || `comme ${crew.main.name}` : '';
  const files = main ? (d?.files ?? t.s.files) : (s?.files ?? []).map(f => f.path);
  const lines = main ? d?.lines ?? t.s.lines : s?.lines;
  const started = ms(main ? t.s.started : s?.started), steps = main ? 0 : s?.steps ?? 0;
  const mission = (main ? t.s.firstPrompt : s?.prompt) ?? '';
  const tok = main ? mainTok(t, d) : s ? subTok(s) : NO_TOK;
  const facts = [model ? `<span><small>Modèle</small><b>${esc(model)}</b></span>` : '', started ? `<span><small>${main ? 'Fil ouvert' : 'Parti'}</small><b>${esc(hm(started))}</b></span>` : '',
    steps ? `<span><small>Étapes</small><b>${steps}</b></span>` : '', files.length ? `<span><small>Fichiers</small><b>${files.length}${lines && (lines.add || lines.del) ? ` <i class="sl-add">+${lines.add}</i> <i class="sl-del">−${lines.del}</i>` : ''}</b></span>` : '',
    tok.output || read(tok) ? `<span title="${esc(tokTip(tok))}"><small>Tokens écrits</small><b>${usage.fmt(tok.output)}</b></span>` : '',
    main && crew.subs.size ? `<span><small>Équipe</small><b>${plural(crew.subs.size, 'agent')}</b></span>` : ''].join('');
  const fl = files.slice(0, 6).map(f => `<code title="${esc(f)}">${esc(f.split('/').pop() ?? f)}</code>`).join('') + (files.length > 6 ? `<small>+${files.length - 6}</small>` : '');
  const helpers = main ? [...crew.subs.values()].map(x => `<button type="button" class="sl-chip" style="--c:var(--c-${x.hue})" data-sl="who" data-who="${esc(x.id)}">${esc(x.name)}</button>`).join('') : '';
  return `<header>${avatar({ ...w, id: '' }, true, on ? 'work' : main && ask ? 'ask' : main ? 'done' : 'sleep', true)}<div><b>${esc(w.name)}</b><small>${esc(w.role || 'agent')}</small></div><button type="button" class="sl-x" data-sl="unprof" aria-label="Fermer">${icon('x')}</button></header>
    <p class="sl-pf-st${on ? ' on' : main && ask ? ' ask' : ''}"><i class="sl-dot${on ? ' work' : main && ask ? ' mine' : ''}"></i>${esc(state)}${now ? ` · ${esc(now)}` : ''}</p>
    ${facts ? `<div class="sl-pf-facts">${facts}</div>` : ''}
    ${mission ? `<details class="sl-pf-mis"><summary><small>${main ? 'Ta consigne' : `Confié par ${esc(crew.main.name)}`}</small><span>${esc(oneLine(mission, 140))}</span></summary><div class="sl-brief">${esc(mission)}</div></details>` : ''}
    ${fl ? `<div class="sl-pf-files">${fl}</div>` : ''}
    ${helpers ? `<div class="sl-pf-team"><small>Travaille avec</small>${helpers}</div>` : ''}
    ${s?.report && !s.live ? `<p class="sl-pf-rep"><small>Compte rendu</small>${esc(oneLine(s.report, 160))}</p>` : ''}
    <div class="sl-pf-a"><button type="button" class="btn" data-sl="mention" data-name="${esc(w.name)}">@ Écrire à ${esc(w.name)}</button>${s?.report && !s.live ? `<button type="button" class="btn btn-ghost" data-sl="toreport" data-who="${esc(prof)}">Lire</button>` : ''}${main && !t.id.startsWith('run:') ? `<button type="button" class="btn btn-ghost" data-sl="tech" data-id="${esc(t.id)}">${icon('terminal')}Étapes</button>` : `<button type="button" class="btn btn-ghost" data-sl="team">${icon('gear')}Équipe</button>`}</div>`;
}
/** Place la fiche sous (ou au-dessus de) l'élément cliqué, dans le cadre du Salon (positions lues au clic). */
function placeProf(box: HTMLElement): void {
  if (!root || !profAt) return;
  const r = root.getBoundingClientRect(), a = profAt.box, side = profAt.side, w = box.offsetWidth, h = box.offsetHeight;
  // Depuis le panneau Équipe : la fiche s'ouvre à sa gauche, à hauteur de la ligne cliquée.
  if (side) { box.style.left = `${Math.max(8, side.left - r.left - w - 8)}px`; box.style.top = `${Math.max(8, Math.min(a.top - r.top, r.height - h - 8))}px`; return; }
  const left = Math.max(8, Math.min(a.left - r.left, r.width - w - 8));
  let top = a.bottom - r.top + 6; if (top + h > r.height - 8) top = Math.max(8, a.top - r.top - h - 6);
  box.style.left = `${left}px`; box.style.top = `${top}px`;
}
function closeProf(): void {
  prof = ''; profAt = null;
  const box = root?.querySelector<HTMLElement>('[data-sl-prof]'); if (box) { box.hidden = true; box.replaceChildren(); }
  root?.querySelectorAll('.sl-mem.cur').forEach(x => x.classList.remove('cur'));
}
const SUGGEST: [string, string, 'edit' | 'read'][] = [['Corriger un bug', 'Corrige ce bug : ', 'edit'], ['Ajouter une fonction', 'Ajoute ', 'edit'], ['Relire le travail récent', 'Relis les derniers changements et signale ce qui cloche.', 'read'], ['M’expliquer le code', 'Explique-moi comment fonctionne ', 'read']];
const emptyHTML = (name: string, first: boolean): string => `<div class="sl-empty">${avatar({ ...persona('principal'), id: '', base: 'Moka' }, true, 'idle', true)}<h3>${first ? `Un salon pour ${esc(name)}` : 'Nouveau fil'}</h3><p>Dis ce que tu veux faire : ${esc(persona('principal').name)} prend la consigne, répartit le travail et te prévient quand c’est prêt.</p><div class="sl-sugg">${SUGGEST.map(([l, t, m]) => `<button type="button" class="sl-chip" data-sl="suggest" data-text="${esc(t)}" data-mode="${m}">${esc(l)}</button>`).join('')}</div><p class="sl-faint">Les fils de ${esc(name)} restent ici : rien ne se mélange avec les autres projets.</p></div>`;

// ---------- Rendu ----------
/** Mouvement coupé (réglage de l'app ou du système) : défilement direct. */
const calm = (): boolean => document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const grow = (ta: HTMLTextAreaElement): void => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 200)}px`; };
/** Le bouton d'envoi s'allume dès qu'il y a quelque chose à envoyer. */
const ready = (): void => { const f = root?.querySelector('.sl-comp'); f?.classList.toggle('sl-ready', !!root?.querySelector('textarea')?.value.trim() || attach.count(f as Element) > 0); };
/** Place de chaque fil dans la liste, avant qu'elle soit redessinée. */
const rowTops = (list: HTMLElement): Map<string, number> => new Map(Array.from(list.querySelectorAll<HTMLElement>('.sl-row'), x => [x.dataset.id ?? '', x.getBoundingClientRect().top]));
/** Liste redessinée : un fil qui change de place y glisse (il remonte quand il se remet au travail), un nouveau apparaît. */
function glide(list: HTMLElement, tops: Map<string, number>): void {
  if (calm() || !tops.size) return;
  const k = document.documentElement.dataset.motion === 'subtle' ? .7 : 1;
  for (const x of list.querySelectorAll<HTMLElement>('.sl-row')) {
    const was = tops.get(x.dataset.id ?? ''), dy = was === undefined ? 0 : was - x.getBoundingClientRect().top;
    if (was === undefined) x.animate([{ opacity: 0, translate: '-8px 0' }, { opacity: 1, translate: '0 0' }], { duration: 240 * k, easing: 'cubic-bezier(.2,.8,.2,1)' });
    else if (Math.abs(dy) > 1) x.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: 320 * k, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
/** Fin du dernier défilement doux vers le bas du fil (performance.now()). */
let glideEnd = 0;
function paint(): void {
  if (!root || !p) return;
  const th = threads(), id = curId(th), cur = th.find(t => t.id === id), d = id ? S.detail.get(id) : undefined;
  const feed = need('[data-sl-feed]', root), ta = need<HTMLTextAreaElement>('textarea', root), key = `${p.id}/${id}`;
  // Un fil lu n'est plus « à toi » (sauf s'il y a une copie à publier, voir `threads`).
  if (cur && cur.group !== 'work' && (seen[cur.id] ?? 0) < cur.act) { seen[cur.id] = cur.act; keepSeen(); }
  // Autre fil : le brouillon du précédent est gardé, celui-ci est repris, le fil repart du bas.
  const switched = key !== shown;
  if (switched) {
    if (shown) drafts.set(shown, ta.value);
    ta.value = drafts.get(key); grow(ta); shown = key; feed.replaceChildren(); closeProf(); setTune(id);
    const form = need<HTMLFormElement>('.sl-comp', root); form.dataset.atKey = `salon:${key}`; attach.sync(form); // les images jointes restent à leur fil
    const m = sel('mode'); if (m && ta.value) m.value = drafts.mode(key);
    // Le fil entier entre d'un bloc (pas message par message : ce n'est pas du neuf).
    feed.classList.remove('sl-enter'); void feed.offsetWidth; feed.classList.add('sl-enter');
  }
  const list = need('[data-sl-list]', root), tops = rowTops(list);
  if (paintIfChanged(list, listHTML(th, id))) glide(list, tops);
  paintIfChanged(need('[data-sl-filt]', root), filtHTML(th));
  const nb = need('[data-sl-n]', root), nt = String(th.filter(t => !isArch(t)).length); if (nb.textContent !== nt) nb.textContent = nt;
  let ask = false, crew: Crew | null = null, blocks: Block[];
  if (cur) { crew = crewOf(d?.subagents ?? [], d?.models ?? cur.s.models, isCodex(cur)); const r = blocksOf(cur, d, crew); blocks = r.blocks; ask = r.ask; }
  else if (opening?.pid === p.id) { const c0 = crewOf([], []); blocks = [{ key: `me|p|${opening.at}`, html: msgHTML(c0.me, opening.at, plain(opening.text) + picsNote(opening.pics), { cls: 'sending', tag: 'envoi…' }) }, { key: 'working', html: typing(c0, undefined) }]; }
  else blocks = [{ key: 'empty', html: emptyHTML(p.name, !th.length) }];
  // Un défilement doux vers le bas encore en route compte comme « en bas » : un bloc arrivé entre-temps (carte de livraison) le suit.
  const end = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60 || performance.now() < glideEnd;
  const before = switched ? null : new Set(Array.from(feed.children, x => (x as HTMLElement).dataset.k));
  const changed = syncFeed(feed, blocks);
  attach.hydrate(feed, p.id);
  // Seuls les blocs vraiment nouveaux s'animent (un bloc redessiné garde sa place sans rejouer son entrée).
  // Un message « envoi… » remplacé par sa version écrite par le Mac n'est pas du neuf : il ne rejoue pas son entrée.
  const now = new Set(Array.from(feed.children, x => (x as HTMLElement).dataset.k));
  let fresh = 0, confirmed = before ? [...before].filter(k => k?.startsWith('me|p|') && !now.has(k)).length : 0;
  if (before) for (const x of Array.from(feed.children) as HTMLElement[]) if (!before.has(x.dataset.k)) {
    if (confirmed && x.classList.contains('me')) { confirmed--; continue; }
    x.classList.add('sl-new', 'cf-hop'); fresh++;
  }
  if (switched) feed.scrollTop = feed.scrollHeight;
  else if (changed && end) { feed.scrollTo({ top: feed.scrollHeight, behavior: calm() ? 'auto' : 'smooth' }); glideEnd = performance.now() + 700; }
  else if (fresh && !end) need('[data-sl-down]', root).hidden = false;
  if (switched) need('[data-sl-down]', root).hidden = true;
  const head = need('[data-sl-head]', root);
  paintIfChanged(head, cur && crew ? headHTML(cur, crew, ask, 1 + (d?.subagents?.length ?? 0)) : '');
  head.querySelector('[data-sl="now"]')?.setAttribute('aria-pressed', String(teamShown(root)));
  // Colonne de droite : Équipe puis Technique. Squelette tant que le fil démarre ; quand le vrai contenu
  // remplace le squelette, il entre une fois en fondu (pas à chaque mise à jour).
  const col = need<HTMLElement>('[data-sl-now]', root), skel = !(cur && crew), wasSkel = col.dataset.skel === '1';
  const colH = cur && crew ? colHTML(nowHTML(cur, d, crew, ask), techHTML(cur, d, crew), consHTML(cur, d, crew)) : opening?.pid === p.id ? colHTML(skelHTML('team'), skelHTML('tech')) : '';
  if (paintIfChanged(col, colH) && wasSkel && !skel && !calm()) { col.classList.remove('sl-reveal'); void col.offsetWidth; col.classList.add('sl-reveal'); }
  col.dataset.skel = skel ? '1' : '';
  if (cur && crew) tickClocks();
  syncClock();
  // La fiche ouverte suit l'état de l'agent ; elle se ferme si l'agent n'est plus dans le fil.
  const pb = need<HTMLElement>('[data-sl-prof]', root), ph2 = prof && cur && crew ? profHTML(cur, d, crew, ask) : '';
  if (!ph2) { if (prof) closeProf(); } else { const first = pb.hidden; if (paintIfChanged(pb, ph2) || first) { pb.hidden = false; placeProf(pb); } }
  root.classList.toggle('sl-solo', !cur && opening?.pid !== p.id);
  // Fil Codex : pas de champ (Studio ne parle qu'à Claude Code), une ligne qui dit où le reprendre.
  const cx = isCodex(cur); need<HTMLFormElement>('.sl-comp', root).hidden = cx; need('[data-sl-codex]', root).hidden = !cx;
  // Le champ : seul son habillage change, jamais le texte.
  const isNew = !cur, ph = isNew ? 'Dis à l’équipe ce que tu veux faire…' : `Écris à ${crew?.main.name ?? 'Moka'}…`;
  if (ta.placeholder !== tr(ph)) ta.placeholder = ph;
  need('[data-sl-mode]', root).hidden = !isNew;
  showAuto(); ready();
  const hint = need('[data-sl-hint]', root), ht = !isNew && cur?.group === 'work' ? 'Ton message part en attente : l’agent le lit à la fin de son tour.' : '';
  if (hint.textContent !== tr(ht)) hint.textContent = ht;
}

// ---------- Modèle et effort ----------
/** Réglage du fil : celui de la conversation s'il a été choisi sur cet appareil, sinon le dernier choisi. */
const tuneFor = (id: string): saved.Choice => (id && !id.startsWith('run:') ? saved.ofSession(id) : null) ?? saved.defaults();
const sel = (n: string): HTMLSelectElement | null => root?.querySelector<HTMLSelectElement>(`.sl-comp select[name=${n}]`) ?? null;
function setTune(id: string): void {
  const c = tuneFor(id), m = sel('model'), e = sel('effort');
  if (m) m.innerHTML = models(c.model);
  if (e) e.value = EFFORTS.some(x => x[0] === c.effort) ? c.effort : '';
}
/** Liste des modèles du champ, « Auto » en un mot (la place est comptée). */
const models = (cur: string): string => modelOptions(cur, false).replace('>Auto (selon la consigne)<', '>Auto<');
const picked = (): saved.Choice => ({ model: sel('model')?.value ?? '', effort: sel('effort')?.value ?? '' });
/** « Auto » n'est jamais envoyé : remplacé par le modèle (et l'effort) qui suffit à ce message. */
function resolved(text: string, isReply: boolean): saved.Choice {
  const c = picked(); if (c.model !== AUTO) return c;
  const a = pickFor(text, { read: sel('mode')?.value === 'read', reply: isReply });
  return { model: a.model, effort: c.effort || a.effort };
}
function showAuto(): void {
  const box = root?.querySelector<HTMLElement>('[data-sl-auto]'), text = root?.querySelector('textarea')?.value.trim() ?? ''; if (!box) return;
  const on = picked().model === AUTO && !!text, id = curId();
  let t = ''; if (on) { const a = pickFor(text, { read: sel('mode')?.value === 'read', reply: !!id }), l = autoLabel(a); t = `${l.model}${picked().effort ? '' : ` · ${l.effort}`}`; box.title = `Auto : ${a.why}`; }
  if (box.textContent !== tr(t)) box.textContent = t;
  box.hidden = !on;
}

/** Envoi : le texte s'envole du champ vers le fil (un fantôme qui monte et s'efface), le champ jette un halo,
 *  la flèche du bouton part vers le haut et revient par le bas. Rien si le mouvement est coupé. */
function fly(form: HTMLElement, ta: HTMLTextAreaElement, text: string, btn: HTMLElement): void {
  if (!root || calm()) return;
  const ease = 'cubic-bezier(.2,.8,.2,1)';
  btn.animate([{ scale: '1' }, { scale: '.9', offset: .3 }, { scale: '1' }], { duration: 260, easing: ease });
  btn.querySelector('svg')?.animate([{ translate: '0 0', opacity: 1 }, { translate: '0 -12px', opacity: 0, offset: .4 }, { translate: '0 10px', opacity: 0, offset: .41 }, { translate: '0 0', opacity: 1 }], { duration: 560, easing: ease });
  form.animate([{ boxShadow: '0 0 0 0 var(--accent-soft)' }, { boxShadow: '0 0 0 8px transparent' }], { duration: 520, easing: 'ease-out' });
  if (!text) return;
  const r = root.getBoundingClientRect(), a = ta.getBoundingClientRect(), g = document.createElement('div');
  g.className = 'sl-fly'; g.setAttribute('aria-hidden', 'true'); g.textContent = text.length > 180 ? `${text.slice(0, 180)}…` : text;
  g.style.cssText = `left:${a.left - r.left}px;top:${a.top - r.top}px;width:${a.width}px`;
  root.append(g);
  const end = (): void => g.remove();
  g.animate([{ opacity: 1, translate: '0 0', scale: '1' }, { opacity: .9, translate: '0 -18px', scale: '.98', offset: .35 }, { opacity: 0, translate: '0 -64px', scale: '.94' }], { duration: 460, easing: ease }).finished.then(end, end);
}
async function send(quick = ''): Promise<void> {
  if (!root || !p || busy) return;
  const form = need<HTMLFormElement>('.sl-comp', root), n = quick ? 0 : attach.count(form);
  if (n) { const why = attach.blocked(form); if (why) { toast(why); return; } }
  const ta = need<HTMLTextAreaElement>('textarea', root), text = quick || ta.value.trim() || (n ? attach.DEFAULT_PROMPT : ''); if (!text) return;
  const id = curId(), btn = need<HTMLButtonElement>('[data-sl-send]', root), pid = p.id, key = `${pid}/${id}`;
  if (id.startsWith('run:')) { toast('L’équipe démarre : réessaie dans un instant.'); return; }
  // Seule la création d'un fil bloque l'envoi suivant ; dans un fil existant, on peut enchaîner les messages.
  if (!id) { busy = true; btn.disabled = true; }
  // Le champ est vidé tout de suite : pendant l'attente, l'utilisateur peut changer de fil sans que rien ne soit écrasé.
  // Les images partent avec le texte : retirées du champ tout de suite, rendues au fil si l'envoi échoue.
  const pics = n ? attach.take(form) : null, images = pics ? pics.pics.map(({ name, type, data }) => ({ name, type, data })) : [];
  fly(form, ta, quick ? '' : ta.value.trim(), btn);
  if (!quick) { ta.value = ''; drafts.delete(key); grow(ta); showAuto(); ready(); }
  // Réponse d'un clic : trop courte pour juger, « Auto » n'est pas résolu et la conversation garde son modèle.
  const c = picked(), tune = { ...(quick && c.model === AUTO ? { model: '', effort: c.effort } : resolved(text, !!id)), voice: 'chat' as const };
  // Le message s'affiche aussitôt dans le fil (« envoi… »), sans attendre que le Mac l'ait écrit dans la conversation.
  const mine: { text: string; at: number; sent?: boolean; pics?: number } = { text, at: Date.now(), ...(n ? { pics: n } : {}) };
  if (id) { pend.set(id, [...(pend.get(id) ?? []), mine]); woke.set(id, mine.at); }
  else opening = { pid, ...mine };
  paint(); hurry();
  let ok = false;
  try {
    if (!id) {
      const r = await startAgent(p, text, need<HTMLSelectElement>('[name=mode]', root).value === 'read' ? 'read' : 'edit', undefined, images, tune);
      if (!r.ok) toast(r.message);
      else if (!r.images) toast(attach.OLD_APP);
      else {
        ok = true; const nid = r.session || (r.run ? `run:${r.run}` : '');
        choose(pid, nid); pend.set(nid, [{ ...mine, sent: true }]); woke.set(nid, mine.at); if (r.session) saved.setSession(r.session, c);
        // Toujours sur ce projet et sur « nouveau fil » : le fil créé prend la place sans fondu ni rejouer le message.
        if (shown === key) shown = `${pid}/${nid}`;
      }
    } else { ok = await reply({ project: pid, session: id }, text, false, images, tune); if (ok) mine.sent = true; }
  } finally {
    if (!id) { busy = false; btn.disabled = false; opening = null; }
    if (pics) { if (ok) attach.release(pics); else { attach.putBack(pics); ready(); } }
    if (!ok && id) woke.delete(id);
    if (!ok && id) { const l = (pend.get(id) ?? []).filter(x => x !== mine); if (l.length) pend.set(id, l); else pend.delete(id); }
    if (!ok && !quick) {
      // Échec : le texte revient, mais seulement si le champ est encore celui de ce fil et qu'il est vide.
      const cur = root?.isConnected ? root.querySelector('textarea') : null;
      if (cur && shown === key && !cur.value) { cur.value = text; drafts.set(key, text); grow(cur); ready(); }
      else if (!drafts.get(key)) drafts.set(key, text);
    }
  }
  if (root?.isConnected) void refresh();
}
async function gesture(act: string, wt: string, b: HTMLButtonElement): Promise<void> {
  if (!p) return;
  const pid = p.id; b.disabled = true;
  try { await copyAct(p, act === 'publish' ? 'push' : act, wt); } finally { if (b.isConnected) b.disabled = false; }
  await loadTrees(pid); if (root?.isConnected) paint();
}

// ---------- Panneau Équipe ----------
/** Écran large : la colonne de droite se masque (réglage retenu). Écran étroit : elle s'ouvre par-dessus la discussion. */
const narrow = (): boolean => matchMedia('(max-width: 1099px)').matches;
const teamShown = (r: HTMLElement): boolean => narrow() ? r.classList.contains('sl-now-open') : !r.classList.contains('sl-now-off');
function toggleTeam(r: HTMLElement): void {
  if (narrow()) r.classList.toggle('sl-now-open');
  else { const off = r.classList.toggle('sl-now-off'); try { localStorage.setItem(TEAM_OFF, off ? '1' : ''); } catch { /* plein */ } }
  paint();
}

function bind(r: HTMLElement): void {
  r.addEventListener('click', e => {
    const el = target(e), t = el.closest<HTMLElement>('[data-sl]');
    // Un clic ailleurs ferme la fiche ouverte, et le panneau Équipe posé par-dessus la discussion (écran étroit).
    if (prof && !el.closest('[data-sl-prof], [data-sl="who"]')) closeProf();
    if (r.classList.contains('sl-now-open') && !el.closest('[data-sl-now], [data-sl="now"], [data-sl-prof]')) { r.classList.remove('sl-now-open'); paint(); }
    if (p && flux.onDeliveryClick(e, () => void go(p?.id ?? '', 'flux'))) return;
    if (!t || !p) return;
    const act = t.dataset.sl, pid = p.id;
    if (act === 'who') {
      e.preventDefault(); // dans un <summary>, n'ouvre pas la passation
      const w = t.dataset.who ?? '';
      // La place de l'élément cliqué est prise tout de suite : le rendu qui suit peut le remplacer.
      if (prof === w) closeProf(); else { prof = w; profAt = { box: t.getBoundingClientRect(), side: t.closest('[data-sl-now]')?.getBoundingClientRect() ?? null }; const pb = need<HTMLElement>('[data-sl-prof]', r); pb.hidden = true; paint(); }
      return;
    }
    if (act === 'unprof') { closeProf(); return; }
    if (act === 'down') { const f = need('[data-sl-feed]', r); f.scrollTo({ top: f.scrollHeight, behavior: calm() ? 'auto' : 'smooth' }); t.hidden = true; return; }
    if (act === 'mention') {
      const ta = need<HTMLTextAreaElement>('textarea', r), at = `@${t.dataset.name ?? ''} `;
      if (!ta.value.startsWith(at)) ta.value = at + ta.value;
      closeProf(); grow(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); drafts.set(shown, ta.value); ready(); showAuto(); return;
    }
    if (act === 'toreport') {
      const id = t.dataset.who ?? ''; closeProf();
      const msg = [...r.querySelectorAll<HTMLElement>('[data-sl-feed] > [data-k^="report|"]')].find(x => x.querySelector(`[data-who="${CSS.escape(id)}"]`));
      msg?.querySelector('details')?.setAttribute('open', '');
      msg?.scrollIntoView({ block: 'center', behavior: 'smooth' }); msg?.classList.add('sl-flash'); setTimeout(() => msg?.classList.remove('sl-flash'), 1200);
      return;
    }
    if (act === 'team') { closeProf(); void subagents.edit(pid).then(ok => { if (ok && root?.isConnected) paint(); }); return; }
    if (act === 'quick') { void send(t.dataset.text ?? ''); return; }
    if (act === 'suggest') {
      // Jamais par-dessus ce qui est déjà tapé : la suggestion ne remplit qu'un champ vide.
      const ta = need<HTMLTextAreaElement>('textarea', r), m = sel('mode'); if (ta.value.trim()) { ta.focus(); return; }
      ta.value = t.dataset.text ?? ''; if (m) m.value = t.dataset.mode ?? 'edit';
      grow(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); drafts.set(shown, ta.value); ready(); showAuto(); return;
    }
    if (act === 'pick') { const id = t.dataset.id ?? ''; choose(pid, id); paint(); fetchThread(pid, id); void refresh(); }
    else if (act === 'new') { choose(pid, ''); paint(); need('textarea', r).focus(); }
    else if (act === 'more') { moreOpen = !moreOpen; paint(); }
    else if (act === 'filt') { filt = (t.dataset.f ?? 'all') as Filt; moreOpen = false; paint(); }
    else if (act === 'arch' || act === 'unarch') {
      const id = t.dataset.id ?? '';
      if (act === 'arch') { archived.archive(pid, [id]); toast('Fil archivé', { label: 'Annuler', run: () => archived.restore(pid, [id]) }); }
      else { archived.restore(pid, [id]); toast('Fil remis dans la liste'); }
      // Le fil ouvert vient d'être archivé : on passe au suivant (choix automatique).
      if (act === 'arch' && chosen.get(pid) === id) unchoose(pid);
      paint();
    }
    else if (act === 'unarch-all') { archived.restore(pid, threads().filter(isArch).map(x => x.id)); filt = 'all'; toast('Fils remis dans la liste'); paint(); }
    else if (act === 'tidy') {
      const ids = oldOnes(threads()).map(x => x.id);
      archived.archive(pid, ids); if (ids.includes(chosen.get(pid) ?? '')) unchoose(pid); paint();
      toast(`${ids.length} fil${ids.length > 1 ? 's' : ''} archivé${ids.length > 1 ? 's' : ''}`, { label: 'Annuler', run: () => archived.restore(pid, ids) });
    }
    else if (act === 'clean') cleanUp(p);
    else if (act === 'limits') { t.setAttribute('disabled', ''); void quota.limits('enable').then(paint); }
    else if (act === 'tech') openTech(t.dataset.id ?? '');
    else if (act === 'codex') { t.setAttribute('disabled', ''); void bridge.call('project', 'codexOpen', { project: pid, session: t.dataset.id ?? '', app: t.dataset.app ?? 'terminal' }, 15000).then(x => { t.removeAttribute('disabled'); if (!x.ok) toast(x.message ?? 'Reprise impossible.'); }); }
    else if (act === 'reply') need('textarea', r).focus();
    else if (act === 'now') toggleTeam(r);
    else if (act === 'stop') void bridge.call('agent', 'stop', { run: t.dataset.run ?? '' }, 10000).then(x => { toast(x.ok ? 'Équipe arrêtée' : x.message ?? 'Arrêt impossible.'); void refresh(); });
    else if (act === 'publish' || act === 'review' || act === 'pr') void gesture(act, t.dataset.wt ?? '', t as HTMLButtonElement);
  });
  r.addEventListener('submit', e => { e.preventDefault(); void send(); });
  // Survol d'un fil pas encore lu : sa conversation est lue d'avance, le clic l'affiche sans attente.
  r.addEventListener('pointerover', e => {
    const row = target(e).closest<HTMLElement>('.sl-row[data-id]'), id = row?.dataset.id ?? '';
    if (p && id && !S.detail.has(id)) fetchThread(p.id, id);
  });
  // Clic droit sur un fil : le même menu que dans la barre latérale (renommer, archiver, publier, supprimer…).
  r.addEventListener('contextmenu', e => {
    const row = target(e).closest<HTMLElement>('.sl-row[data-id]'), id = row?.dataset.id ?? '';
    if (!p || !id || id.startsWith('run:')) return;
    e.preventDefault(); const pid = p.id;
    sideMenu({ x: e.clientX, y: e.clientY }, p, id, '', () => { choose(pid, id); paint(); fetchThread(pid, id); });
  });
  r.addEventListener('input', e => { const q = target(e); if (q instanceof HTMLInputElement && q.matches('[data-sl-q]')) { query = q.value; paint(); return; } });
  r.addEventListener('input', e => { const t = target(e); if (t instanceof HTMLTextAreaElement) { grow(t); showAuto(); ready(); if (p) drafts.set(shown || `${p.id}/${curId()}`, t.value); } });
  // Revenu en bas du fil à la main : l'invitation « Nouveaux messages » n'a plus lieu d'être.
  r.addEventListener('scroll', e => {
    const f = target(e); if (!f.matches('[data-sl-feed]') || f.scrollHeight - f.scrollTop - f.clientHeight >= 60) return;
    const b = r.querySelector<HTMLElement>('[data-sl-down]'); if (b && !b.hidden) b.hidden = true;
  }, true);
  r.addEventListener('change', e => {
    const t = target(e); if (!(t instanceof HTMLSelectElement) || !t.closest('.sl-comp')) return;
    if (t.name === 'model' || t.name === 'effort') { const id = curId(); if (id && !id.startsWith('run:')) saved.setSession(id, picked()); else saved.setDefaults(picked()); }
    showAuto();
  });
  r.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (prof || r.classList.contains('sl-now-open'))) { e.preventDefault(); closeProf(); r.classList.remove('sl-now-open'); paint(); return; }
    if (target(e) instanceof HTMLTextAreaElement && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
    const q = target(e);
    if (q instanceof HTMLInputElement && q.matches('[data-sl-q]')) {
      if (e.key === 'Escape' && q.value) { e.preventDefault(); e.stopPropagation(); q.value = ''; query = ''; paint(); }
      // Entrée : ouvre le premier fil trouvé.
      else if (e.key === 'Enter') { e.preventDefault(); r.querySelector<HTMLElement>('[data-sl-list] .sl-pick')?.click(); }
    }
  });
  // Raccourcis du Salon, hors des champs : « / » cherche, ⌥N nouveau fil, ⌥↑ / ⌥↓ fil précédent ou suivant.
  document.addEventListener('keydown', e => {
    if (!r.isConnected || !p || e.metaKey || e.ctrlKey) return;
    const el = e.target as HTMLElement | null, typing = !!el?.closest('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing && !e.altKey) { e.preventDefault(); r.querySelector<HTMLInputElement>('[data-sl-q]')?.focus(); return; }
    if (!e.altKey) return;
    if (e.code === 'KeyN') { e.preventDefault(); choose(p.id, ''); paint(); need('textarea', r).focus(); return; }
    if (typing || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const rows = [...r.querySelectorAll<HTMLElement>('[data-sl-list] .sl-pick')], i = rows.findIndex(x => x.getAttribute('aria-current') === 'true');
    const next = rows[e.key === 'ArrowUp' ? Math.max(0, i - 1) : Math.min(rows.length - 1, i + 1)];
    if (next) { e.preventDefault(); next.click(); next.scrollIntoView({ block: 'nearest' }); }
  });
}

/** Navigation vers un onglet de projet, fournie par la fiche projet (`init`) : le Salon n'a pas accès à la coquille de l'app. */
let go: (pid: string, tab: string) => Promise<void> = () => Promise.resolve();
/** À appeler une fois au démarrage (page.ts) avec `(pid, tab) => app.setView({ type: 'projets', project: pid, tab })`. */
export function init(open: (pid: string, tab: string) => Promise<void>): void { go = open; flux.onDelivery(() => { if (root?.isConnected) paint(); }); }
/** Ouvre le fil `session` du projet `pid` dans le Salon : le choisit (retenu dans `studio.salon.chosen`), puis ouvre l'onglet salon. */
/** Fil choisi dans le Salon du projet (barre latérale). */
export const chosenThread = (pid: string): string => chosen.get(pid) ?? '';
export function openThread(pid: string, session: string): void {
  choose(pid, session);
  if (root?.isConnected && p?.id === pid) { paint(); fetchThread(pid, session); void refresh(); } // Salon déjà à l'écran : il suit tout de suite
  void go(pid, 'salon');
}

/** Monte le Salon du projet `proj` dans `box`. `o.openTech` ouvre une conversation dans l'onglet Claude Code. */
export function mount(box: HTMLElement, proj: Project, o: { openTech: (session: string) => void }): void {
  stop();
  if (S.pid !== proj.id) reset(proj.id);
  p = proj; root = box; openTech = o.openTech; shown = '';
  box.innerHTML = `<aside class="sl-side" aria-label="Fils du projet"><div class="sl-side-h"><b>Fils <span class="sl-n" data-sl-n></span></b><button type="button" class="btn" data-sl="new" title="Nouveau fil (⌥N)">${icon('plus')}<span>Nouveau fil</span></button></div><label class="sl-q">${icon('search')}<input type="search" data-sl-q placeholder="Chercher un fil…" aria-label="Chercher un fil" value="${esc(query)}"><kbd aria-hidden="true">/</kbd></label><div class="sl-filt" data-sl-filt role="toolbar" aria-label="Filtrer les fils"></div><div class="sl-list" data-sl-list></div></aside>
    <section class="sl-center"><header class="sl-head" data-sl-head></header><div class="sl-feed" data-sl-feed role="log" aria-live="polite" aria-label="Discussion"></div><button type="button" class="sl-down" data-sl="down" data-sl-down hidden>Nouveaux messages ${icon('chevron')}</button>
      <form class="sl-comp" autocomplete="off"><div class="sl-drop" aria-hidden="true">${icon('upload')}<span>Dépose tes images ici</span></div><textarea rows="1" aria-label="Ton message" placeholder="Dis à l’équipe ce que tu veux faire…"></textarea>${attach.stripHTML()}
        <div class="sl-comp-row"><label class="sl-mode" data-sl-mode hidden><select name="mode" aria-label="Mode"><option value="edit">Modifier</option><option value="read">Analyser</option></select></label><select name="model" aria-label="Modèle" title="Modèle de l’agent principal. Auto : le plus économe qui suffit au message">${models(tuneFor('').model)}</select><select name="effort" aria-label="Niveau d’effort" title="Plus l’effort est élevé, plus l’agent réfléchit, et plus il consomme">${EFFORTS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select><span class="sl-auto" data-sl-auto hidden></span><span class="sl-hint" data-sl-hint></span><span class="sl-keys" aria-hidden="true"><span><kbd>↵</kbd> <span>envoyer</span></span><span><kbd>⇧</kbd><kbd>↵</kbd> <span>nouvelle ligne</span></span></span>${attach.buttonHTML()}<button type="submit" class="btn btn-primary sl-send" data-sl-send><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg><span>Envoyer</span></button></div></form><p class="sl-codex" data-sl-codex hidden>${icon('terminal')}<span>Conversation Codex : reprends-la dans le Terminal ou dans l’app Codex.</span></p></section>
    <aside class="sl-now" data-sl-now aria-label="En ce moment"></aside><div class="sl-prof" data-sl-prof role="dialog" aria-label="Fiche de l’agent" hidden></div>`;
  box.classList.add('sl-box', 'sl-solo');
  let off = false; try { off = localStorage.getItem(TEAM_OFF) === '1'; } catch { /* défaut */ }
  box.classList.toggle('sl-now-off', off); box.classList.remove('sl-now-open'); prof = ''; profAt = null;
  if (!box.dataset.slBound) {
    box.dataset.slBound = '1'; bind(box);
    box.addEventListener('toggle', e => { const el = e.target; if (el instanceof HTMLDetailsElement && el.matches('[data-sl-use]')) useOpen = el.open; }, true);
  }
  attach.bind(box); // coller, déposer ou choisir des images : par fil (`data-at-key`, posé par paint)
  // La jauge se met à jour seule ; l'abonnement n'est pris qu'une fois (il repeint le Salon monté à ce moment-là).
  if (!quotaHooked) { quotaHooked = true; quota.onChange(() => { if (root?.isConnected) paint(); }); archived.onChange(() => { if (root?.isConnected) paint(); }); }
  catface.init();
  paint(); start();
}
