// Onglet « Claude Code » d'un projet : donner une consigne à Claude Code, suivre les agents en direct,
// relire et publier leur travail, reprendre une session. Tout s'exécute sur le Mac où se trouve le dossier
// du projet (voir native/Shared/Agents.swift pour les garde-fous).
import * as native from '../../core/native.ts';
import * as bridge from '../../integrations/remote.ts';
import * as usage from '../../integrations/usage.ts';
import * as ai from '../../integrations/ai.ts';
import * as tuning from '../../integrations/tuning.ts';
import * as github from '../../integrations/github/api.ts';
import { esc, renderMarkdown } from '../../lib/markdown.ts';
import { fold } from '../../lib/fuzzy.ts';
import { icon, rel, modal, menu, need, toast, confirmBox, errMsg, $, paintIfChanged } from '../../ui/kit.ts';
import * as review from './review.ts';
import * as store from '../../core/store.ts';
import * as model from './model.ts';
import { AUTO, pickFor as autoPick, label as autoLabel } from './autopick.ts';
import * as saved from './drafts.ts';
import * as attach from './attach.ts';
import { paintPulse } from './pulse.ts';
import * as permissions from '../permissions.ts';
import * as voice from '../voice.ts';
import { pickNotes } from './notepick.ts';
import * as subagents from './subagents.ts';
import { diffHTML, hasDiff } from './team.ts';
import * as noteseal from '../../integrations/noteseal.ts';
import * as infra from './infra.ts';
import type { Project } from './model.ts';

interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface Session { id: string; title: string; /** Titre écrit par Claude Code lui-même, s'il y en a un. */ aiTitle?: string; firstPrompt?: string; branch: string; worktree: string; started: string; updated: string; /** Dernier vrai échange (absent avec une app Mac ancienne). */ active?: string; live: boolean; models: string[]; prompts: number; lastPrompt: string; tokens: Tokens; tools: Record<string, number>; files: string[]; /** Lignes ajoutées et retirées sur la session (absent avec une app Mac ancienne). */ lines?: { add: number; del: number } }
interface Quota { status?: string; resetsAt?: number; rateLimitType?: string; isUsingOverage?: boolean }
/** `add`/`del` : lignes ajoutées et retirées par une écriture (nombre, ou texte pour les agents sur serveur). */
/** `file`, `old`, `new` : sur une écriture (Edit, Write…), le chemin et les extraits avant/après ; `to`, `body` : sur une délégation
 *  (Agent, Task), le sous-agent visé et la consigne qu'il reçoit. Absents avec une app Mac ancienne. */
export interface Action { at: string; kind: string; text: string; add?: number | string; del?: number | string; file?: string; old?: string; new?: string; to?: string; body?: string; /** Chemins des images jointes à cette consigne (absent avec une app Mac ancienne). */ images?: string[] }
export interface AgentRun { machine?: string; host?: string; run: string; mode: string; prompt: string; status: string; session: string; worktree: string; started: string; finished: string; result: string; lastText: string; turns: number; denials: string[]; quota?: Quota | null; /** Notes et tâches envoyées au projet par ce tour (features/projects/items.ts). */ items?: { tasks?: number; notes?: number } }
export interface Worktree {
  name: string; branch: string; /** Commit de la copie (absent avec une app Mac ancienne). */ head?: string; changes: number; ahead: number; behind?: number; pushed: boolean; conflicts?: string[];
  /** Titre du dernier commit de la copie, si elle en a un. */ subject?: string;
  /** La branche distante est exactement la copie : rien de nouveau à pousser. */ upToDate?: boolean;
  /** Le travail poussé est déjà fusionné dans la branche principale. */ merged?: boolean;
  /** Branches déjà livrées par cette copie (une discussion peut en livrer plusieurs), les plus récentes d'abord. */
  history?: { branch: string; subject: string; merged: boolean }[];
  /** Dernière PR de la branche sur GitHub, si on la connaît (ajoutée par la page, voir `withPulls`). */
  pr?: github.BranchPull;
  /** Copies sœurs du même nom dans les autres dépôts du projet (site, API…), créées pour le même agent. */
  sisters?: Sister[];
}
interface Sister { repo: string; branch: string; head?: string; changes: number; ahead: number; pushed: boolean; upToDate?: boolean; merged?: boolean; conflicts?: string[] }
/** Tâche de l'orchestrateur (Orchestrator.swift) : publication ou mise à jour d'une copie. */
interface Job { job: string; kind: 'publish' | 'sync'; worktree: string; status: 'running' | 'done' | 'error' | 'blocked'; step: string; log: string[]; conflicts: string[]; branch: string; message: string; /** Une branche par dépôt modifié (absent avec une app Mac ancienne). */ pushed?: { repo: string; branch: string }[] }
/** La copie a du travail à publier (changements en cours, ou commits ni poussés ni fusionnés). */
const hasWork = (c: Pick<Worktree, 'changes' | 'ahead' | 'merged' | 'upToDate'>) => c.changes > 0 || (c.ahead > 0 && !c.merged && !c.upToDate);

let selected: string | null = null, timer: ReturnType<typeof setInterval> | undefined, tick = 0;
/** Message secondaire : écrit pendant que l'agent travaillait, remis à la fin de son tour (voir Agents.swift). */
export interface Queued { id: string; session: string; text: string; at: string; images?: string[] }
let runs: AgentRun[] = [], trees: Worktree[] = [], jobs: Job[] = [], queued: Queued[] = [];
/** La liste des copies a été lue au moins une fois (sinon une copie absente n'est pas forcément supprimée). */
let treesRead = false;
/** Projet auquel appartiennent `trees` : les autres projets n'ont pas d'état de copie connu. */
let treesFor = '';
const ms = (iso: string) => Date.parse(iso) || 0;
const short = (path: string, root: string | null) => path.includes('/.claude/worktrees/') ? path.replace(/^.*\/\.claude\/worktrees\/[^/]+\//, '') : root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path.replace(/^\/Users\/[^/]+/, '~');
export const modelName = (m: string) => m.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-/g, ' ');
export const live = (r: AgentRun) => r.status === 'running' || r.status === 'starting';
export const elapsed = (r: AgentRun) => { const s = Math.max(0, Math.round(((r.finished ? ms(r.finished) : Date.now()) - ms(r.started)) / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)} h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`; };
export const STATUS: Record<string, [string, string]> = { starting: ['amber', 'Démarrage'], running: ['amber', 'En cours'], done: ['green', 'Terminé'], error: ['red', 'Erreur'], stopped: ['gray', 'Arrêté'] };
const pill = (s: string) => { const [c, l] = STATUS[s] ?? ['gray', s]; return `<span class="ag-pill${s === 'running' || s === 'starting' ? ' live' : ''}" style="--c:var(--c-${c})">${l}</span>`; };

// ---------- Conversation ouverte, et ce qu'en montrent la barre latérale et le fil d'Ariane ----------
/** Onglet affiché (pour le redessiner d'ailleurs : fil d'Ariane, suppression). */
let cur: { box: HTMLElement; p: Project } | null = null;
/** Projet de la conversation sélectionnée, et son nom une fois connu. */
let selFor = '', selTitle = '';
/** Dernières sessions lues, par projet. Gardées d'une ouverture à l'autre (`at: 0` : à relire), pour que la barre
 *  latérale et la liste s'affichent tout de suite, avant la réponse du Mac qui relit tous les journaux. */
const known = new Map<string, { list: Session[]; at: number }>();
const SESSIONS = 'studio.cc.sessions';
try {
  const v = JSON.parse(localStorage.getItem(SESSIONS) || '{}') as unknown;
  if (v && typeof v === 'object' && !Array.isArray(v))
    for (const [k, l] of Object.entries(v as Record<string, unknown>))
      if (Array.isArray(l)) known.set(k, { list: (l as Session[]).filter(s => s && typeof s.id === 'string' && s.tokens).map(s => ({ ...s, live: false })), at: 0 });
} catch { /* cache illisible : on relira */ }
function saveKnown(): void {
  const out = Object.fromEntries([...known].slice(-12).map(([k, v]) => [k, v.list.slice(0, 12)]));
  try { localStorage.setItem(SESSIONS, JSON.stringify(out)); } catch { /* stockage plein */ }
}
/** Dernier échange d'abord : la conversation la plus récente est toujours en tête. */
const byActivity = (list: Session[]): Session[] => [...list].sort((a, b) => ms(b.active || b.updated) - ms(a.active || a.updated));

// Sous-agents : les tâches que Claude délègue pendant une conversation ont chacune leur propre fil (voir Sessions.swift).
// On en ouvre un depuis sa conversation, on passe de l'un à l'autre, et on peut l'épingler dans la barre latérale.
/** `prompt`, `last`, `files`, `lines`, `report` : absents avec une app Mac ancienne ; `report` seulement une fois le sous-agent fini. */
export interface SubAgent { id: string; title: string; type: string; started: string; updated: string; live: boolean; tokens: number; steps: number; prompt?: string; last?: { at: string; kind: string; text: string }; files?: { path: string; add: number; del: number }[]; lines?: { add: number; del: number }; report?: string }
/** Sous-agent ouvert dans la conversation sélectionnée, et son nom une fois connu. */
let sub: string | null = null, subTitle = '';
/** Derniers sous-agents lus, par conversation. */
const subsOf = new Map<string, SubAgent[]>();
/** Sous-agents épinglés dans la barre latérale : projet, conversation, sous-agent, et son nom au moment de l'épingler. */
interface Pin { p: string; s: string; a: string; t: string }
const PINS = 'studio.cc.subpins';
let pins: Pin[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(PINS) || '[]') as unknown;
    return Array.isArray(v) ? (v as Partial<Pin>[]).filter(x => x && typeof x.p === 'string' && typeof x.s === 'string' && typeof x.a === 'string').map(x => ({ p: x.p ?? '', s: x.s ?? '', a: x.a ?? '', t: typeof x.t === 'string' ? x.t : '' })) : [];
  } catch { return []; }
})();
function savePins(): void {
  pins = pins.slice(-40);
  try { localStorage.setItem(PINS, JSON.stringify(pins)); } catch { /* stockage plein */ }
}
const pinned = (session: string, agent: string): boolean => pins.some(x => x.s === session && x.a === agent);
const subName = (session: string, agent: string): string => subsOf.get(session)?.find(x => x.id === agent)?.title || pins.find(x => x.s === session && x.a === agent)?.t || 'Sous-agent';
/** Retient les sous-agents d'une conversation ; le nom de ceux qui sont épinglés suit celui lu sur le Mac. */
function noteSubs(session: string, list: unknown): void {
  const subs = Array.isArray(list) ? list as SubAgent[] : [];
  subsOf.set(session, subs);
  let renamed = false;
  for (const x of pins) {
    const a = x.s === session ? subs.find(y => y.id === x.a) : undefined;
    if (a && a.title !== x.t) { x.t = a.title; renamed = true; }
  }
  if (renamed) savePins();
}
/** Ferme les sous-agents des conversations qu'on ne regarde plus : leur liste n'est plus tenue à jour une fois
 *  la conversation quittée (un point « en cours » y resterait allumé pour rien). Les épinglés gardent leur nom. */
function closeSubs(keep: string | null): void {
  for (const k of [...subsOf.keys()]) if (k !== keep) subsOf.delete(k);
}
/** Fil (conversation, ou conversation/sous-agent) vu au repos au dernier passage : il est relu moins souvent. */
let calm = '';
function togglePin(pid: string, session: string, agent: string): void {
  const had = pinned(session, agent), t = subName(session, agent);
  pins = pins.filter(x => !(x.s === session && x.a === agent));
  if (!had) pins.push({ p: pid, s: session, a: agent, t });
  savePins(); notify();
  toast(had ? 'Retiré de la barre latérale' : 'Épinglé dans la barre latérale, sous sa conversation');
}

let listener: (() => void) | null = null, lastSig = '';
/** Prévient l'application quand la liste des conversations, leurs noms ou la sélection changent. */
export const onChange = (f: () => void): void => { listener = f; };
function notify(): void {
  const sig = JSON.stringify([selFor, selected, selTitle, sub, subTitle, pins, (selected ? subsOf.get(selected) ?? [] : []).filter(a => a.live).map(a => a.id),
    [...known].map(([k, v]) => [k, v.list.slice(0, 8).map(s => [s.id, nameOf(s), s.live, k === treesFor ? sessionStage(s) : ''])]), runs.filter(live).map(r => r.session)]);
  if (sig === lastSig) return;
  lastSig = sig; listener?.();
}
/** Conversation ouverte dans ce projet, s'il y en a une, et le sous-agent qu'on y regarde. */
export function current(pid: string): { id: string; title: string; sub?: { id: string; title: string } } | null {
  if (!selected || selFor !== pid) return null;
  const s = known.get(pid)?.list.find(x => x.id === selected);
  return { id: selected, title: selTitle || (s ? nameOf(s) : 'Conversation'), ...(sub ? { sub: { id: sub, title: subTitle || subName(selected, sub) } } : {}) };
}
export interface SideSub { id: string; title: string; live: boolean; sel: boolean }
/** Conversations récentes d'un projet, pour la barre latérale, chacune avec ses sous-agents épinglés (et celui qui est ouvert). */
export function sideSessions(pid: string): { id: string; title: string; live: boolean; sel: boolean; subs: SideSub[]; stage: { cls: string; label: string } | null }[] {
  const list = known.get(pid)?.list ?? [], sel = selFor === pid ? selected : null, mine = pins.filter(x => x.p === pid);
  const subs = (sid: string): SideSub[] => {
    const ids = mine.filter(x => x.s === sid).map(x => x.a);
    if (sid === sel && sub && !ids.includes(sub)) ids.push(sub);
    return ids.map(a => ({ id: a, title: sid === sel && a === sub && subTitle ? subTitle : subName(sid, a), live: !!subsOf.get(sid)?.find(x => x.id === a)?.live, sel: sid === sel && a === sub }));
  };
  // Seulement les agents au travail et les PR en attente (plus la conversation ouverte, pour garder sa surbrillance).
  return list.map(s => ({ id: s.id, title: s.id === sel && selTitle ? selTitle : nameOf(s), live: s.live || runs.some(r => r.session === s.id && live(r)), sel: s.id === sel, subs: subs(s.id), stage: sideStage(pid, s) }))
    .filter(s => s.live || s.sel || s.stage?.cls === 'st-pr');
}
/** État de la copie d'une conversation, pour teinter son point dans la barre latérale (seulement pour le projet dont les copies sont connues). */
function sideStage(pid: string, s: Session): { cls: string; label: string } | null {
  const st = pid === treesFor ? sessionStage(s) : '';
  return st && st !== 'idle' ? { cls: `st-${st}`, label: STAGES[st].l } : null;
}
async function loadList(p: Project): Promise<Session[] | null> {
  const r = await bridge.call('project', 'sessions', { project: p.id }, 20000);
  if (!r.ok) return null;
  const list = byActivity(r.found ? (r.sessions as Session[] | undefined) ?? [] : []);
  known.set(p.id, { list, at: Date.now() });
  saveKnown();
  quota = (r.quota as Quota | null | undefined) ?? runs.find(x => x.quota)?.quota ?? null;
  notify();
  return list;
}
/** Lit les conversations du projet si on ne les connaît pas encore (pour la barre latérale, hors de l'onglet Claude Code). */
export function preload(p: Project): void {
  if (!bridge.where() || Date.now() - (known.get(p.id)?.at ?? 0) < 30000) return;
  void loadList(p);
}

// ---------- Nom des conversations ----------
// Comme sur les sites d'IA : un nom court qui résume toute la conversation, rédigé par l'IA branchée dans Studio et
// remis à jour quand la conversation avance. Sans IA, on garde le titre de Claude Code, sinon la première demande.
const TITLES = 'studio.cc.titles';
/** Nom donné par Studio, et nombre de demandes de la conversation à ce moment-là. */
interface Named { t: string; n: number }
let titles: Record<string, Named> = (() => { try { const v = JSON.parse(localStorage.getItem(TITLES) || '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, Named> : {}; } catch { return {}; } })();
function saveTitles(): void {
  titles = Object.fromEntries(Object.entries(titles).slice(-300));
  try { localStorage.setItem(TITLES, JSON.stringify(titles)); } catch { /* stockage plein */ }
}
/** Première ligne d'un texte, nettoyée et coupée à un mot près. */
function neat(text: string, max = 60): string {
  const c = (text.split('\n').map(x => x.trim()).find(Boolean) ?? '').replace(/[#*`>"«»]/g, '').replace(/\s+/g, ' ').trim();
  if (c.length <= max) return c;
  const cut = c.slice(0, max), sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '')}…`;
}
type Nameable = Pick<Session, 'id' | 'title' | 'aiTitle' | 'firstPrompt' | 'prompts'>;
export const nameOf = (s: Nameable): string => titles[s.id]?.t || s.aiTitle || (s.firstPrompt ? neat(s.firstPrompt) : '') || neat(s.title) || 'Conversation';

// La consigne du nom, le modèle utilisé et la fréquence se règlent dans Réglages → Consignes et contexte (tuning.ts).
let naming = false;
const nameFailed = new Map<string, number>();
/** Faut-il (re)nommer cette conversation ? Oui si elle n'a pas de nom, ou si elle a avancé depuis et que l'agent a fini
 *  de répondre. Par défaut, seulement quand elle a doublé (2, 4, 8… demandes) : chaque nom est un appel à l'IA. */
function wantsName(s: Nameable, working: boolean): boolean {
  if (!s.id || s.aiTitle || !s.prompts || !ai.ready()) return false;
  const have = titles[s.id], mode = tuning.text('small.rename');
  if (have && (mode === 'once' || working || s.prompts < (mode === 'each' ? have.n + 1 : Math.max(have.n + 1, have.n * 2)))) return false;
  return Date.now() - (nameFailed.get(s.id) ?? 0) > 3e5;
}
/** Demande un nom à l'IA, d'après les demandes de l'utilisateur et la dernière réponse. Une conversation à la fois. */
async function nameSession(p: Project, s: Nameable, actions?: Action[]): Promise<void> {
  if (naming) return;
  naming = true;
  try {
    if (!actions) { const d = await bridge.call('project', 'session', { project: p.id, session: s.id }, 20000); actions = d.ok ? (d.actions as Action[] | undefined) ?? [] : []; }
    // Les notes jointes et les contextes IA ajoutés à une consigne ne font pas partie de la demande.
    const asks = actions.filter(a => a.kind === 'prompt').map(a => (a.text.split(/\n---\n(?:Notes du projet|Contextes IA du projet)/)[0] ?? '').trim().slice(0, 400)).filter(Boolean);
    const first = (s.firstPrompt ?? '').replace(/…$/, '').slice(0, 400);
    if (first && !asks.some(a => a.startsWith(first.slice(0, 120)))) asks.unshift(first);
    if (!asks.length) { nameFailed.set(s.id, Date.now()); return; }
    const picked = asks.length > 7 ? [...asks.slice(0, 2), ...asks.slice(-5)] : asks;
    const last = [...actions].reverse().find(a => a.kind === 'text')?.text.slice(0, 600) ?? '', have = titles[s.id];
    const user = `Demandes de l’utilisateur, dans l’ordre :\n${picked.map((a, i) => `${i + 1}. ${a}`).join('\n')}${last ? `\n\nDernière réponse de l’agent (extrait) :\n${last}` : ''}${have ? `\n\nNom actuel : ${have.t}\nGarde-le tel quel s’il résume toujours la conversation ; sinon adapte-le.` : ''}`;
    const t = neat((await ai.complete(tuning.text('small.title'), user, { light: tuning.on('small.names') })).replace(/^(nom|titre)\s*:\s*/i, ''), 70).replace(/[.\s]+$/, '');
    if (!t) { nameFailed.set(s.id, Date.now()); return; }
    delete titles[s.id]; titles[s.id] = { t, n: s.prompts }; saveTitles();
    if (s.id === selected) selTitle = t;
    notify();
  } catch { nameFailed.set(s.id, Date.now()); }
  finally { naming = false; }
}

// ---------- Notes jointes ----------
// Une note du projet peut servir de contexte ou de cahier des charges : son contenu est ajouté à la consigne.
// Les notes chiffrées ou marquées #privé ne sont jamais envoyées.
let pending: { project: string; notes: string[]; prompt: string; fan: string } | null = null;
const titleOf = (id: string) => store.get(id)?.title.trim() || 'Sans titre';
const chip = (id: string) => `<span class="ag-note" data-note-id="${esc(id)}">${icon('notes')}${esc(titleOf(id))}<button type="button" data-ag-unnote="${esc(id)}" aria-label="Retirer la note">×</button></span>`;
/** Pastilles des notes jointes, puis le bouton qui ouvre leur choix (notepick.ts). */
const ctxHTML = (ids: string[]): string => `${ids.map(chip).join('')}<button type="button" class="ag-addnote" data-ag-note>${icon('plus')}${ids.length ? 'Notes…' : 'Joindre des notes'}</button>`;
/** Remplace les notes jointes d'un formulaire : pastilles, brouillon et libellé du bouton suivent. */
function setNotes(f: HTMLFormElement, ids: string[]): void {
  f.dataset.notes = ids.join(',');
  const ctx = f.querySelector('.ag-ctx'); if (ctx) ctx.innerHTML = ctxHTML(ids);
  keepDraft(f); showFan(f); showSet(f);
}
/** Ouvre l'onglet Claude Code du projet avec des notes déjà jointes et, éventuellement, une consigne.
 *  `fan: 'notes'` : le formulaire est réglé sur « Un agent par note » (rien n'est lancé sans le clic sur Lancer). */
export function handoff(p: Project, { notes = [] as string[], prompt = '', fan = '' } = {}): void { pending = { project: p.id, notes, prompt, fan }; selected = null; sub = null; }
// ---------- Abonnement : ce qu'il reste ----------
// Bandeau au pied de la consigne : part restante de la session de 5 heures et de la semaine, comme « /usage » dans
// Claude Code. Les chiffres viennent du Mac (voir ClaudeUsage.swift), si l'utilisateur a accepté leur lecture.
// À défaut, on affiche l'état de la limite que Claude Code note lui-même quand elle approche ou est atteinte.
const LIMS: Record<string, [string, string]> = { five_hour: ['Session 5 h', 'Session de 5 heures'], seven_day: ['Semaine', 'Semaine, tous les modèles'], seven_day_opus: ['Semaine · Opus', 'Semaine, modèle Opus'], seven_day_sonnet: ['Semaine · Sonnet', 'Semaine, modèle Sonnet'], extra: ['Crédit supp.', 'Crédit supplémentaire'] };
let limits: ai.CcLimits | null = null, limitsAt = 0, limitsBusy = false, limitsWait = false, quota: Quota | null = null;

/** Délai avant une réinitialisation : « dans 2 h 14 », ou le jour et l'heure au-delà d'une journée. */
function resetIn(sec: number): string {
  const d = sec * 1000 - Date.now();
  if (d < 6e4) return 'dans un instant';
  if (d < 36e5) return `dans ${Math.ceil(d / 6e4)} min`;
  if (d < 864e5) { const m = Math.round(d / 6e4); return `dans ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; }
  return new Date(sec * 1000).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
}
const resetAt = (sec: number) => new Date(sec * 1000).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function limsHTML(): string {
  const l = limits, here = bridge.local();
  // Claude Code n'écrit l'état de la limite que lorsqu'elle approche : passé l'heure de réinitialisation, il est périmé.
  const q = quota?.status && !(quota.resetsAt && quota.resetsAt * 1000 <= Date.now()) ? quota : null;
  const refresh = `<button type="button" class="icon-btn" data-ag-lim="refresh" title="Actualiser" aria-label="Actualiser l’utilisation de l’abonnement">${icon('refresh')}</button>`;
  if (limitsWait) return '<em><span class="spin"></span>Lecture de ton abonnement…</em>';
  if (l?.enabled && l.ready && l.windows?.length) {
    return l.windows.map(w => {
      const [label, full] = LIMS[w.key] ?? [w.key, w.key];
      const used = Math.round(w.pct), left = Math.max(0, 100 - used), tone = used >= 90 ? ' err' : used >= 70 ? ' warn' : '';
      const reset = w.resetsAt && w.resetsAt * 1000 > Date.now() ? w.resetsAt : 0;
      return `<span class="ag-lim${tone}" title="${esc(`${full} : ${used} % utilisés${reset ? ` · se réinitialise ${resetAt(reset)}` : ''}`)}"><span>${esc(label)}</span><span class="bar ag-lim-bar"><i style="width:${left}%"></i></span><strong>${left} %</strong><em>restant${left > 1 ? 's' : ''}${reset ? ` · réinit. ${esc(resetIn(reset))}` : ''}</em></span>`;
    }).join('') + (q?.isUsingOverage && !l.windows.some(w => w.key === 'extra') ? '<em>crédit supplémentaire en cours d’utilisation</em>' : '') + refresh;
  }
  let out = '';
  if (q && q.status !== 'allowed') {
    const kind = LIMS[q.rateLimitType ?? '']?.[1] ?? 'Limite d’utilisation';
    out += `<span class="ag-lim ${q.status === 'rejected' ? 'err' : 'warn'}"><i class="ag-lim-dot"></i><strong>${esc(kind)} : ${q.status === 'rejected' ? 'limite atteinte' : 'limite bientôt atteinte'}</strong>${q.resetsAt ? `<em>réinit. ${esc(resetIn(q.resetsAt))}</em>` : ''}${q.isUsingOverage ? '<em>· crédit supplémentaire en cours d’utilisation</em>' : ''}</span>`;
  }
  if (!l) return out;
  if (!l.enabled) return out + (here ? `<button type="button" class="link-btn" data-ag-lim="on">Afficher ce qu’il reste de mon abonnement</button>` : '<em>Pour voir ici ce qu’il reste de ton abonnement, active la lecture des limites sur le Mac (Réglages → Intelligence artificielle).</em>');
  return out + `<em>${esc(l.message ?? 'Utilisation de l’abonnement illisible pour l’instant.')}</em>${here ? refresh : ''}`;
}
/** Redessine le bandeau de toutes les consignes affichées, seulement s'il a changé. */
function paintLimits(): void {
  const html = limsHTML();
  document.querySelectorAll<HTMLElement>('.ag-lims').forEach(x => { if (drawn.get(x) !== html) { x.innerHTML = html; drawn.set(x, html); const f = x.closest<HTMLFormElement>('form'); if (f) showSet(f); } });
}
/** Lit l'utilisation de l'abonnement, au plus une fois par minute. `op` : 'enable' (accord donné) ou 'refresh' (sans cache), sur le Mac seulement. */
async function loadLimits(op = ''): Promise<void> {
  if (limitsBusy || !bridge.where() || (!op && Date.now() - limitsAt < 55000)) return;
  const here = bridge.local();
  limitsBusy = true; limitsAt = Date.now();
  if (op) { limitsWait = true; paintLimits(); }
  try {
    const r = await bridge.call('claude', 'limits', here ? { op } : {}, here ? 180000 : 30000);
    if (r.ok) { limits = r as unknown as ai.CcLimits; if (here) ai.cc.limits = limits; }
  } finally { limitsBusy = false; limitsWait = false; paintLimits(); }
}
async function limitsAction(op: string): Promise<void> {
  if (op === 'refresh') { await loadLimits('refresh'); return; }
  if (op !== 'on' || !bridge.local()) return;
  if (await confirmBox({ title: 'Afficher ce qu’il reste de ton abonnement ?', text: 'Anthropic ne donne l’utilisation qu’au compte connecté : Studio lira la connexion de Claude Code dans le trousseau de ce Mac (macOS te demandera ton accord) et interrogera api.anthropic.com, rien d’autre. Tu peux revenir en arrière dans Réglages → Intelligence artificielle.', ok: 'Afficher' })) await loadLimits('enable');
}

// ---------- Consigne ----------
const HINT_BUSY = '<span class="spin"></span>Claude travaille. « Mettre en attente » : il lit ta suite à la fin de son tour. « Intervenir » : son tour est coupé, il te lit tout de suite puis reprend.';
const SEND_IDLE = `${icon('play')}Envoyer<kbd>⌘↩</kbd>`, SEND_BUSY = `${icon('history')}Mettre en attente<kbd>⌘↩</kbd>`;
/** Zone de réponse d'une conversation : pendant que son agent travaille, on peut l'arrêter, ou lui écrire
 *  des messages secondaires qu'il lira ensemble à la fin de son tour. */
function syncStop(box: HTMLElement): void {
  const f = $('.ag-continue', box); if (!f) return;
  const run = runs.find(r => r.session === selected && live(r)), state = run ? run.run : '';
  if (f.dataset.busy === state) return;
  f.dataset.busy = state;
  const stopBtn = $<HTMLButtonElement>('.ag-stop', f), send = $<HTMLButtonElement>('button.btn-primary', f), hint = $('[data-hint]', f);
  if (stopBtn) { stopBtn.hidden = !run; stopBtn.dataset.run = state; }
  const cutBtn = $<HTMLButtonElement>('.ag-cut', f); if (cutBtn) cutBtn.hidden = !run;
  if (send && !send.disabled) send.innerHTML = run ? SEND_BUSY : SEND_IDLE;
  if (hint) hint.innerHTML = run ? HINT_BUSY : '';
  attach.sync(f);
}

const TIP_EDIT = 'Modifier : copie isolée du dépôt, ton dossier reste intact', TIP_READ = 'Analyser : lecture seule, Claude analyse et propose sans rien modifier';

// Réglages de la consigne (commandes, modèle, effort, agents, sous-agents, notes, abonnement) : repliés derrière un bouton,
// l'état replié ou déplié est retenu sur cet appareil. Les champs restent dans la page, seul leur conteneur est caché.
const SET_KEY = 'studio.cc.settings';
const setOpen = (): boolean => { try { return localStorage.getItem(SET_KEY) === '1'; } catch { return false; } };
const setBtn = (): string => `<button type="button" class="btn btn-ghost ag-setbtn" data-ag-set-toggle aria-expanded="${setOpen()}" title="Commandes, modèle, effort, nombre d’agents, sous-agents, notes jointes, abonnement">${icon('gear')}<span data-set-label>Réglages</span></button>`;
/** Le bouton « Réglages » résume ce qui s'écarte du défaut (modèle, effort, agents, commandes, machine, notes). */
function showSet(f: HTMLFormElement): void {
  const lab = f.querySelector<HTMLElement>('[data-set-label]'), btn = f.querySelector<HTMLElement>('[data-ag-set-toggle]'); if (!lab || !btn) return;
  const pick = (n: string) => { const s = f.querySelector<HTMLSelectElement>(`select[name=${n}]`); return s && !s.hidden && s.value ? s.selectedOptions[0]?.textContent?.trim() ?? '' : ''; };
  const tests = f.querySelector<HTMLInputElement>('[name=tests]'), notes = (f.dataset.notes || '').split(',').filter(Boolean).length;
  const parts = [pick('model').replace(/ \(selon la consigne\)$/, ''), pick('effort').replace(/^Effort /, 'effort '), pick('fan'), tests?.checked ? 'commandes' : '',
    (f.elements.namedItem('machine') as HTMLSelectElement | null)?.value !== 'mac' ? pick('machine') : '', notes ? `${notes} note${notes > 1 ? 's' : ''}` : ''].filter(Boolean);
  // Une limite d'abonnement atteinte ou proche ne doit pas rester cachée dans le panneau replié : le bouton la dit.
  const lim = f.querySelector('.ag-lims .ag-lim.err') ? 'limite atteinte' : f.querySelector('.ag-lims .ag-lim.warn') ? 'limite bientôt atteinte' : '';
  if (lim) parts.unshift(lim);
  const text = parts.join(' · ');
  lab.textContent = text || 'Réglages'; btn.classList.toggle('on', !!text);
  btn.classList.toggle('err', lim === 'limite atteinte'); btn.classList.toggle('warn', lim === 'limite bientôt atteinte');
}
function toggleSet(f: HTMLFormElement): void {
  const panel = f.querySelector<HTMLElement>('[data-ag-set]'); if (!panel) return;
  const open = panel.hasAttribute('hidden');
  try { localStorage.setItem(SET_KEY, open ? '1' : '0'); } catch { /* stockage refusé : l'état ne sera pas repris */ }
  // Tous les formulaires affichés suivent : le réglage est le même partout.
  document.querySelectorAll<HTMLFormElement>('.ag-compose').forEach(x => {
    x.querySelector('[data-ag-set]')?.toggleAttribute('hidden', !open); x.classList.toggle('set-open', open);
    x.querySelector('[data-ag-set-toggle]')?.setAttribute('aria-expanded', String(open));
  });
}

// Modèle et niveau d'effort : choisis à chaque consigne, retenus pour la suivante. Une conversation garde les siens
// (ceux de son lancement, ou ceux qu'on lui donne en lui répondant). Voir drafts.ts.
const EFFORTS: [string, string][] = [['', 'Effort par défaut'], ['low', 'Effort faible'], ['medium', 'Effort moyen'], ['high', 'Effort élevé'], ['xhigh', 'Effort très élevé'], ['max', 'Effort maximal']];
/** Valeur de l'entrée « Autre modèle… » (jamais envoyée : elle ouvre la saisie d'un identifiant). */
const OTHER = '+';
function modelOptions(cur: string): string {
  const list: [string, string][] = [[AUTO, 'Auto (selon la consigne)'], ...ai.CC_MODELS.map(([v, l]): [string, string] => [v, v ? l : 'Modèle par défaut'])];
  for (const v of [...saved.extraModels(), cur]) if (v && !list.some(x => x[0] === v)) list.push([v, modelName(v)]);
  return list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('') + `<option value="${OTHER}">Autre modèle…</option>`;
}
/** Bouton « Sous-agents » de la consigne : dit le réglage en cours et ouvre sa fenêtre (subagents.ts). */
const subHTML = (pid: string): string => `<button type="button" class="btn ag-sub" data-ag-sub="${esc(pid)}" title="${esc(subagents.HINT)}">${icon('bot')}<span>${esc(subagents.label(pid))}</span></button>`;
const tuneHTML = (c: saved.Choice): string => `<select class="field" name="model" aria-label="Modèle" title="Modèle utilisé par Claude Code. Auto : le plus économe qui suffit à la consigne en cours" data-prev="${esc(c.model)}">${modelOptions(c.model)}</select><select class="field" name="effort" aria-label="Niveau d’effort" title="Niveau d’effort : plus il est élevé, plus Claude réfléchit, et plus il consomme">${EFFORTS.map(([v, l]) => `<option value="${v}"${v === c.effort ? ' selected' : ''}>${l}</option>`).join('')}</select><span class="ag-auto" data-auto hidden></span>`;
/** Modèle et effort réellement envoyés : « Auto » est remplacé d'après la consigne ; un effort choisi à la main est gardé. */
const autoOf = (f: HTMLFormElement) => autoPick(f.querySelector('textarea')?.value ?? '', {
  read: f.querySelector<HTMLInputElement>('[name=mode]:checked')?.value === 'read', reply: !!f.dataset.session });
function resolveChoice(f: HTMLFormElement, c: saved.Choice): saved.Choice {
  if (c.model !== AUTO) return c;
  const a = autoOf(f);
  return { model: a.model, effort: c.effort || a.effort };
}
/** Affiche, à côté de la liste, ce que « Auto » retient pour la consigne en cours. */
function showAuto(f: HTMLFormElement): void {
  const box = f.querySelector<HTMLElement>('[data-auto]'), sel = f.querySelector<HTMLSelectElement>('select[name=model]'); if (!box || !sel) return;
  box.hidden = sel.value !== AUTO || !(f.querySelector('textarea')?.value.trim());
  if (box.hidden) return;
  const hand = !!f.querySelector<HTMLSelectElement>('select[name=effort]')?.value, a = autoOf(f), l = autoLabel(a);
  box.innerHTML = `${icon('sparkle')}<b>${esc(l.model)}</b>${hand ? '' : ` · ${esc(l.effort)}`}`;
  box.title = `Choisi automatiquement : ${a.why}${hand ? ' · effort choisi à la main' : ''}`;
}
// Plusieurs agents d'un coup : la consigne se répartit en une par note jointe, ou une par ligne ; chaque agent
// travaille en parallèle dans sa propre copie isolée. Le Mac en accepte FAN_MAX à la fois (maxRunning, Agents.swift).
const FAN_MAX = 8, LAUNCH = `${icon('play')}Lancer<kbd>⌘↩</kbd>`;
/** Une consigne par ligne non vide ; puces, numéros et cases à cocher de tête retirés. */
const fanLines = (t: string): string[] => t.split('\n').map(l => l.replace(/^\s*(?:[-*+•]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').trim()).filter(Boolean);
const fanOf = (f: HTMLFormElement): string => f.querySelector<HTMLSelectElement>('select[name=fan]')?.value ?? '';
/** Nombre d'agents écrit en tête de la consigne : « 3× … », « x3 … », « 3 agents : … ». La consigne revient sans ce
 *  préfixe ; `n` vaut 1 sans préfixe. Annoncé dans le texte d'exemple du champ (COUNT_HINT). */
export function agentCount(text: string): { n: number; text: string } {
  const m = text.match(/^\s*(?:(\d{1,2})\s*[x×]|[x×]\s*(\d{1,2})|(\d{1,2})\s+agents?\b\s*[:,-]?)\s+/i);
  const n = m ? Number(m[1] ?? m[2] ?? m[3]) : 1;
  return m && n >= 1 ? { n, text: text.slice(m[0].length).trim() } : { n: 1, text: text.trim() };
}
/** Groupe d'agents : nom de la copie mère (`studio-<sujet>-<date>-<id>`), et groupe + numéro d'une copie `<groupe>-aN`. */
export function newGroup(text: string): string {
  const slug = fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'agents';
  const d = new Date(), pad = (n: number) => String(n).padStart(2, '0');
  return `studio-${slug}-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${Math.random().toString(36).slice(2, 5).replace(/[^a-z0-9]/g, 'x')}`;
}
/** Agents déjà rapatriés dans leur branche mère (le Mac le sait aussi : refaire la fusion ne change rien). */
const MERGED = 'studio.cc.mergedkids';
const mergedKids = new Set<string>((() => { try { const v = JSON.parse(localStorage.getItem(MERGED) || '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } })());
const keepMerged = (wt: string) => { mergedKids.add(wt); try { localStorage.setItem(MERGED, JSON.stringify([...mergedKids].slice(-200))); } catch { /* plein */ } };
export const groupOfCopy = (name: string): { group: string; slot: number } | null => { const m = name.match(/^(studio-[a-z0-9-]+?)-a([1-8])$/); return m ? { group: m[1] ?? '', slot: Number(m[2]) } : null; };
export const COUNT_HINT = 'Commence par « 3× » pour lancer 3 agents en parallèle.';
/** Le bouton annonce le nombre d'agents qui partiront. */
function showFan(f: HTMLFormElement): void {
  const btn = f.querySelector<HTMLButtonElement>('.ag-send'); if (!btn || btn.disabled || !f.querySelector('select[name=fan]')) return;
  const fan = fanOf(f), n = fan === 'notes' ? (f.dataset.notes || '').split(',').filter(Boolean).length : fan === 'lines' ? fanLines(f.querySelector('textarea')?.value ?? '').length : agentCount(f.querySelector('textarea')?.value ?? '').n;
  btn.innerHTML = n > 1 ? `${icon('play')}Lancer ${n} agents<kbd>⌘↩</kbd>` : LAUNCH;
  attach.sync(f);
}
/** Le champ suit la hauteur du texte, sans limite. */
function grow(ta: HTMLTextAreaElement): void { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; }
/** Demande l'identifiant d'un modèle absent de la liste ; il y reste ensuite proposé. `null` si l'utilisateur renonce. */
function askModel(): Promise<string | null> {
  return new Promise<string | null>(res => {
    let out: string | null = null;
    const m = modal({ title: 'Autre modèle', cls: 'small', onClose: () => res(out), html: `<form>
      <label class="pj-field"><span>Identifiant ou alias du modèle</span><input class="field" name="id" placeholder="claude-opus-5-5" spellcheck="false" autocomplete="off" autocapitalize="off" required></label>
      <p class="modal-hint">Tel que l’accepte <code>claude --model</code>. Il reste ensuite proposé dans la liste, sur cet appareil.</p>
      <p class="lock-err"></p>
      <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Ajouter</button></div></form>` });
    need('[data-x]', m.node).onclick = m.close;
    need<HTMLFormElement>('form', m.node).onsubmit = e => {
      e.preventDefault();
      const v = need<HTMLInputElement>('[name=id]', m.node).value.trim().toLowerCase();
      if (!saved.MODEL_RE.test(v)) { need('.lock-err', m.node).textContent = 'Identifiant invalide : minuscules, chiffres, points et tirets (ex. claude-opus-5-5).'; return; }
      saved.addModel(v); out = v; m.close();
    };
  });
}
/** Suite d'un changement de modèle ou d'effort : saisie d'un autre modèle au besoin, puis le choix est retenu. */
async function tune(f: HTMLFormElement, t: HTMLSelectElement): Promise<void> {
  if (t.name === 'model' && t.value === OTHER) {
    const id = await askModel(), next = id ?? t.dataset.prev ?? '';
    // Le nouveau modèle est proposé dans tous les formulaires affichés ; sans saisie, la liste revient au choix d'avant.
    document.querySelectorAll<HTMLSelectElement>('.ag-compose select[name=model]').forEach(s => { s.innerHTML = modelOptions(s === t ? next : s.value === OTHER ? '' : s.value); });
    if (!f.isConnected) return;
  }
  const pick = (n: string) => f.querySelector<HTMLSelectElement>(`select[name=${n}]`)?.value ?? '';
  const c = { model: pick('model'), effort: pick('effort') };
  if (t.name === 'model') t.dataset.prev = c.model;
  if (f.dataset.session) saved.setSession(f.dataset.session, c); else saved.setDefaults(c);
}

/** Retient ce qui est écrit dans le formulaire, pour le retrouver après avoir navigué ailleurs (voir drafts.ts). */
function keepDraft(f: HTMLFormElement): void {
  const key = f.dataset.draft; if (!key) return;
  saved.saveDraft(key, { text: f.querySelector('textarea')?.value ?? '', notes: (f.dataset.notes || '').split(',').filter(Boolean),
    mode: f.querySelector<HTMLInputElement>('[name=mode]:checked')?.value ?? 'edit', tests: !!f.querySelector<HTMLInputElement>('[name=tests]')?.checked, fan: fanOf(f) });
}

// ---------- Où travailler : le Mac ou un serveur du projet ----------

/** Dernière machine choisie par projet (`mac`, `server`, `server:<id>`), reprise à chaque nouveau formulaire. */
const MACHINE_KEY = 'studio.cc.machine';
function lastMachine(pid: string): string { try { return (JSON.parse(localStorage.getItem(MACHINE_KEY) ?? '{}') as Record<string, string>)[pid] ?? 'mac'; } catch { return 'mac'; } }
function keepMachine(pid: string, v: string): void {
  try { const all = JSON.parse(localStorage.getItem(MACHINE_KEY) ?? '{}') as Record<string, string>; all[pid] = v; localStorage.setItem(MACHINE_KEY, JSON.stringify(all)); } catch { /* stockage plein ou refusé : le choix ne sera pas repris */ }
}
const machineValue = (s: infra.ServerItem): string => s.id ? `server:${s.id}` : 'server';
function machineOptions(p: Project): string {
  const list = infra.knownServers(p.id), want = lastMachine(p.id), sel = list.some(s => machineValue(s) === want) ? want : 'mac';
  return `<option value="mac"${sel === 'mac' ? ' selected' : ''}>Sur le Mac</option>`
    + list.map(s => `<option value="${esc(machineValue(s))}"${machineValue(s) === sel ? ' selected' : ''}>Sur ${esc(s.name || s.dest || s.host)}</option>`).join('');
}
/** Choix de machine d'un nouvel agent : caché tant que le projet n'a aucun serveur (rempli ensuite par `fillMachines`). */
function machineHTML(p: Project): string {
  return `<select class="field ag-machine" name="machine" aria-label="Où travailler" title="Où l’agent travaille : sur ce Mac, ou sur un serveur du projet (onglet Serveur), dans une copie isolée du dépôt distant"${infra.knownServers(p.id).length ? '' : ' hidden'}>${machineOptions(p)}</select>`;
}
/** Sur un serveur, ni « Commandes » (réglage du Mac) ni l'abonnement lu sur le Mac : on les masque. */
function showMachine(f: HTMLFormElement): void {
  const v = (f.elements.namedItem('machine') as HTMLSelectElement | null)?.value ?? 'mac', far = v.startsWith('server');
  f.classList.toggle('on-server', far);
  f.querySelectorAll<HTMLElement>('[data-mac-only]').forEach(el => { el.hidden = far; });
  attach.sync(f);
}
/** Lit les serveurs du projet et met à jour le choix de machine des formulaires de lancement de `root`. */
async function fillMachines(root: HTMLElement, p: Project): Promise<void> {
  const r = await infra.list(p).catch(() => null);
  if (!r?.ok || !root.isConnected) return;
  root.querySelectorAll<HTMLFormElement>('.ag-compose:not(.ag-continue)').forEach(f => {
    const mc = f.elements.namedItem('machine') as HTMLSelectElement | null;
    if (!mc || mc.dataset.fixed !== undefined) return;
    const was = mc.value, html = machineOptions(p);
    if (mc.innerHTML !== html) mc.innerHTML = html;
    if (was && [...mc.options].some(o => o.value === was)) mc.value = was;
    mc.hidden = r.servers.length === 0;
    showMachine(f);
  });
}

/** `server` : identifiant du serveur du projet visé quand `machine` vaut 'server' ("" : le premier). */
export function composerHTML(p: Project, { session = '', compact = false, machine = '', server = '' } = {}): string {
  // Un agent lancé sur un serveur utilise la connexion Claude du serveur, pas l'abonnement lu sur le Mac.
  // Serveur repris du dernier lancement : « Commandes » et l'abonnement du Mac sont masqués dès le rendu.
  const far = !session && machine !== 'server' && infra.knownServers(p.id).some(s => machineValue(s) === lastMachine(p.id)), macOnly = far ? ' hidden' : '';
  const lims = machine === 'server' ? '' : `<div class="ag-lims" data-mac-only${macOnly} aria-label="Utilisation de l’abonnement Claude">${limsHTML()}</div>`;
  // Chaque formulaire a son brouillon : un par conversation, un pour la nouvelle consigne, un pour celle de l'aperçu, un pour le serveur.
  const key = `${p.id}|${session ? `s:${session}` : machine === 'server' ? 'server' : compact ? 'quick' : 'new'}`, d = saved.draft(key);
  if (session) return `<form class="ag-compose ag-continue${setOpen() ? ' set-open' : ''}" data-draft="${esc(key)}" data-session="${esc(session)}"${machine ? ` data-machine="${esc(machine)}"` : ''}><textarea name="prompt" rows="2" placeholder="Réponds à Claude : précise, corrige, tranche, demande la suite…" aria-label="Répondre dans la session">${esc(d?.text ?? '')}</textarea>${attach.stripHTML()}
    <div class="ag-opts"><div class="ag-tools">${setBtn()}<span class="ag-hint" data-hint></span></div><span class="ag-go">${attach.buttonHTML()}${voice.micHTML('Répondre à voix haute')}<button type="button" class="btn btn-danger ag-stop" data-ag="stop" hidden>${icon('stop')}Arrêter</button><button type="button" class="btn ag-cut" data-ag-cut hidden title="Coupe le tour en cours : Claude lit ton message tout de suite, puis reprend là où il en était (⌘⇧↩)">${icon('bolt')}Intervenir</button><button class="btn btn-primary ag-send">${SEND_IDLE}</button></span></div>
    <div class="ag-set" data-ag-set${setOpen() ? '' : ' hidden'}><div class="ag-set-row">${tuneHTML(saved.ofSession(session) ?? { model: '', effort: '' })}${subHTML(p.id)}</div>${lims}</div></form>`;
  const pre = pending?.project === p.id ? pending : null; if (pre && !compact) pending = null;
  // Une note ou une tâche confiée à Claude s'ajoute au brouillon en cours, sans l'effacer.
  const hand = pre && !compact ? pre : null;
  const notes = compact ? [] : [...new Set([...(hand?.notes ?? []), ...(d?.notes ?? [])])].filter(id => store.get(id));
  const mine = d?.text ?? '', given = hand?.prompt ?? '';
  const text = given && mine.trim() && !mine.includes(given) ? `${mine.trimEnd()}\n\n${given}` : given || mine;
  const read = d?.mode === 'read', inRead = permissions.commandsInRead(), tests = (!read || inRead) && !!d?.tests;
  const fan = compact ? '' : hand?.fan || d?.fan || '';
  if (hand) saved.saveDraft(key, { text, notes, mode: read ? 'read' : 'edit', tests, fan });
  return `<form class="ag-compose${compact ? ' compact' : ''}${far ? ' on-server' : ''}${setOpen() ? ' set-open' : ''}" data-draft="${esc(key)}" data-notes="${esc(notes.join(','))}"><textarea name="prompt" rows="${compact ? 1 : 3}" placeholder="Que doit faire Claude Code dans ${esc(p.name)} ? Ex. « Ajoute des tests au parseur de dates ». ${COUNT_HINT}" aria-label="Consigne pour Claude Code">${esc(text)}</textarea>${attach.stripHTML()}
    <div class="ag-ctx">${ctxHTML(notes)}</div>
    <div class="ag-opts"><div class="ag-tools">
      <div class="ag-seg" role="radiogroup" aria-label="Mode" title="${read ? TIP_READ : TIP_EDIT}"><label><input type="radio" name="mode" value="edit"${read ? '' : ' checked'}><span>${icon('pencil')}Modifier</span></label><label><input type="radio" name="mode" value="read"${read ? ' checked' : ''}><span>${icon('search')}Analyser</span></label></div>
      ${setBtn()}</div>
      <span class="ag-go">${attach.buttonHTML()}${voice.micHTML('Dicter la consigne')}<button class="btn btn-primary ag-send">${LAUNCH}</button></span></div>
    <div class="ag-set" data-ag-set${setOpen() ? '' : ' hidden'}><div class="ag-set-row">
      ${bridge.local() && machine !== 'server' ? `<label class="ag-check" data-mac-only${macOnly} title="Autorise les commandes réglées dans Réglages → Autorisations (par défaut npm test et npm run …) : le code du projet peut alors s’exécuter"><input type="checkbox" name="tests"${tests ? ' checked' : ''}${read && !inRead ? ' disabled' : ''}>Commandes</label>` : ''}
      ${machine === 'server' ? `<select class="field" name="machine" aria-label="Où travailler" data-fixed><option value="${server ? `server:${esc(server)}` : 'server'}" selected>Sur le serveur</option></select>` : machineHTML(p)}
      ${tuneHTML(saved.defaults())}
      ${compact ? '' : `<select class="field" name="fan" aria-label="Nombre d’agents" title="Plusieurs agents en parallèle, chacun dans sa copie isolée : un par note jointe, ou un par ligne de la consigne (${FAN_MAX} à la fois au plus)">${[['', 'Un agent'], ['notes', 'Un agent par note'], ['lines', 'Un agent par ligne']].map(([v, l]) => `<option value="${v}"${v === fan ? ' selected' : ''}>${l}</option>`).join('')}</select>`}
      ${compact ? '' : subHTML(p.id)}</div>${lims}</div></form>`;
}

/** Branche les formulaires de consigne présents dans `root` (lancement, reprise, raccourci ⌘↩). */
export function bindComposer(root: HTMLElement, p: Project, onStarted: (r: AgentRun) => void): void {
  void loadLimits();
  permissions.preload();
  attach.bind(root);
  // Formulaires fraîchement rendus (brouillon repris) : hauteur du texte et choix « Auto » à jour.
  requestAnimationFrame(() => root.querySelectorAll<HTMLFormElement>('.ag-compose').forEach(f => { const ta = f.querySelector('textarea'); if (ta) grow(ta); showAuto(f); showFan(f); showMachine(f); showSet(f); }));
  if (bridge.where() && root.querySelector('.ag-compose:not(.ag-continue) select[name=machine]:not([data-fixed])')) void fillMachines(root, p);
  if (root.dataset.agBound) return;
  root.dataset.agBound = '1';
  root.addEventListener('input', e => {
    const t = e.target as HTMLElement, f = t.closest<HTMLFormElement>('.ag-compose');
    if (f && t.tagName === 'TEXTAREA') { grow(t as HTMLTextAreaElement); keepDraft(f); showAuto(f); showFan(f); }
  });
  root.addEventListener('focusin', e => { const t = e.target as HTMLElement; if (t.tagName === 'TEXTAREA' && t.closest('.ag-compose')) grow(t as HTMLTextAreaElement); });
  root.addEventListener('change', e => {
    const t = e.target as HTMLInputElement, f = t.closest<HTMLFormElement>('.ag-compose'); if (!f) return;
    showSet(f);
    if (t.name === 'model' || t.name === 'effort') { void tune(f, t as unknown as HTMLSelectElement).then(() => showAuto(f)); return; }
    if (t.name === 'mode') showAuto(f);
    if (t.name === 'machine' && (t as unknown as HTMLSelectElement).dataset.fixed === undefined) { keepMachine(p.id, t.value); showMachine(f); }
    if (t.name === 'tests') { keepDraft(f); return; }
    if (t.name === 'fan') { keepDraft(f); showFan(f); return; }
    if (t.name !== 'mode') return;
    const seg = $('.ag-seg', f), tests = $<HTMLInputElement>('[name=tests]', f);
    if (seg) seg.title = t.value === 'edit' ? TIP_EDIT : TIP_READ;
    attach.sync(f);
    if (tests) { tests.disabled = t.value !== 'edit' && !permissions.commandsInRead(); if (tests.disabled) tests.checked = false; }
    keepDraft(f);
  });
  root.addEventListener('click', e => {
    const t = e.target as HTMLElement, f = t.closest<HTMLFormElement>('.ag-compose'); if (!f) return;
    const mic = t.closest<HTMLElement>('[data-vc-mic]');
    if (mic) { const ta = need<HTMLTextAreaElement>('textarea', f); voice.dictate(ta, mic, () => { keepDraft(f); grow(ta); showAuto(f); }); return; }
    if (t.closest('[data-ag-set-toggle]')) { toggleSet(f); return; }
    const lim = t.closest<HTMLElement>('[data-ag-lim]');
    if (lim) { void limitsAction(lim.dataset.agLim ?? ''); return; }
    // « Intervenir » : même envoi que le bouton principal, mais le tour en cours est coupé (voir `interrupt`, Agents.swift).
    if (t.closest('[data-ag-cut]')) { f.dataset.cut = '1'; f.requestSubmit(); return; }
    // Sous-agents : l'équipe est celle du projet, donc tous les boutons de ce projet suivent.
    if (t.closest('[data-ag-sub]')) {
      void subagents.edit(p.id).then(ok => { if (ok) document.querySelectorAll<HTMLElement>(`[data-ag-sub="${CSS.escape(p.id)}"] span`).forEach(x => { x.textContent = subagents.label(p.id); }); });
      return;
    }
    const ids = () => (f.dataset.notes || '').split(',').filter(Boolean);
    const un = t.closest<HTMLElement>('[data-ag-unnote]');
    if (un) { setNotes(f, ids().filter(x => x !== un.dataset.agUnnote)); return; }
    if (!t.closest('[data-ag-note]')) return;
    void pickNotes(p, ids()).then(next => { if (next && f.isConnected) setNotes(f, next); });
  });
  root.addEventListener('keydown', e => {
    if (!(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) return;
    const f = (e.target as HTMLElement).closest<HTMLFormElement>('form.ag-compose'); if (!f) return;
    e.preventDefault();
    // ⌘⇧↩ pendant que Claude travaille : intervenir au lieu de mettre en attente.
    const cutBtn = f.querySelector<HTMLElement>('[data-ag-cut]');
    if (e.shiftKey && cutBtn && !cutBtn.hidden) f.dataset.cut = '1';
    f.requestSubmit();
  });
  root.addEventListener('submit', async e => {
    const f = (e.target as HTMLElement).closest<HTMLFormElement>('.ag-compose'); if (!f) return;
    e.preventDefault(); e.stopPropagation();
    const cut = f.dataset.cut === '1'; delete f.dataset.cut;
    if (f.querySelector<HTMLButtonElement>('button.btn-primary')?.disabled) return; // envoi déjà parti
    if (f.querySelector('.vc-mic.live')) voice.cancel(); // sinon la dictée réécrirait le champ vidé après l'envoi
    const ta = need<HTMLTextAreaElement>('textarea', f), noteIds = (f.dataset.notes || '').split(',').filter(Boolean);
    const pics = attach.count(f);
    if (!ta.value.trim() && !noteIds.length && !pics) { ta.focus(); return; }
    if (pics) { const why = attach.blocked(f); if (why) { toast(why); return; } }
    // Des images sans un mot : consigne par défaut, pour que l'agent aille les lire.
    const text = ta.value.trim() || (pics ? attach.DEFAULT_PROMPT : '');
    // Répartition : une consigne par note jointe, ou par ligne ; sinon une seule (toujours une seule quand on répond).
    const fan = f.dataset.session ? '' : fanOf(f), lines = fan === 'lines' ? fanLines(text) : [];
    // « 3× … » en tête : le même travail confié à plusieurs agents (pas quand on répond, ni avec une autre répartition).
    const counted = f.dataset.session || fan ? { n: 1, text } : agentCount(text);
    const units: { text: string; notes: string[] }[] = fan === 'notes' && noteIds.length > 1 ? noteIds.map(id => ({ text, notes: [id] }))
      : lines.length > 1 ? lines.map(l => ({ text: l, notes: noteIds }))
      : counted.n > 1 ? Array.from({ length: counted.n }, () => ({ text: counted.text, notes: noteIds })) : [{ text, notes: noteIds }];
    const many = units.length > 1;
    if (units.length > FAN_MAX) { toast(`${units.length} agents demandés : ${FAN_MAX} à la fois au plus. Réduis la liste, ou lance-la en plusieurs fois.`); return; }
    if (many && !await confirmBox({ title: `Lancer ${units.length} agents ?`, text: `Ils travaillent en parallèle, chacun dans sa propre copie isolée du dépôt, avec ${fan === 'notes' ? 'une des notes jointes' : fan === 'lines' ? 'une ligne de la consigne' : 'la même consigne'}. Ils consomment ton abonnement Claude en même temps.`, ok: `Lancer ${units.length} agents` })) return;
    // Le contenu des notes ne passe plus dans la consigne : il part scellé (noteseal.ts), le Mac ne le déchiffre qu'au lancement de Claude.
    // Nouvelle conversation seulement : les contextes IA du projet (#contexte-ia) partent scellés avec elles.
    const built = await Promise.all(units.map(u => noteseal.seal(u.text, u.notes, f.dataset.session ? null : p))), refused = [...new Set(built.flatMap(b => b.refused))];
    if (refused.length) toast(ai.notesAllowed() ? `Non jointe${refused.length > 1 ? 's' : ''} (verrouillée, privée ou trop longue) : ${refused.join(', ')}` : `Notes fermées à l’IA (Réglages → IA) : non jointes, ${refused.join(', ')}`);
    // Une consigne vide dont aucune note n'a pu être jointe ne dit plus rien à l'agent : on ne la lance pas.
    if (built.some((b, k) => !b.sealed && !(units[k]?.text ?? '').trim())) return;
    const btn = need<HTMLButtonElement>('button.btn-primary', f), label = btn.innerHTML;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null);
    // Modèle et effort : envoyés aussi quand on répond, pour que la conversation garde (ou change) les siens.
    const picked: saved.Choice = { model: val('model')?.value ?? '', effort: val('effort')?.value ?? '' };
    if (picked.model === OTHER) picked.model = '';
    // Tous les dépôts du projet : le Mac ouvre à l'agent ceux dont il trouve un clone (copie sœur dans chacun).
    // « Auto » n'est jamais envoyé : remplacé par le modèle (et l'effort) qui suffit à cette consigne.
    const body: Record<string, unknown> = { project: p.id, ...resolveChoice(f, picked), repos: p.stack };
    if (f.dataset.session) { body.session = f.dataset.session; if (f.dataset.machine) body.machine = f.dataset.machine; if (cut) body.interrupt = true; }
    else { body.mode = f.querySelector<HTMLInputElement>('[name=mode]:checked')?.value ?? 'edit'; body.tests = !!val('tests')?.checked && !f.classList.contains('on-server'); const mc = val('machine'); if (mc && !mc.hidden) { const [m, s] = mc.value.split(':'); body.machine = m; if (s) body.server = s; } }
    btn.disabled = true;
    // Un lancement après l'autre : chaque appel revient dès que la session est créée, l'agent continue seul.
    const images = attach.payload(f);
    let last: Awaited<ReturnType<typeof bridge.call>> | null = null, started = 0, fail = '', unsealed = false, oldApp = false;
    const made: string[] = [];
    // Plusieurs agents qui modifient : une branche mère commune, une sous-branche par agent (rapatriées ensuite dans la mère).
    const group = many && body.mode === 'edit' && body.machine !== 'server' ? newGroup(counted.text || text) : '';
    for (const b of built) {
      btn.innerHTML = many ? `<span class="spin"></span>Agent ${started + 1}/${built.length}…` : '<span class="spin"></span>Envoi…';
      // Sous-agents : l'équipe du projet part avec chaque consigne, reprise comprise (l'outil se donne à chaque tour) ;
      // avec « auto », les spécialistes utiles à cette consigne y sont d'abord ajoutés.
      const team = subagents.body(p.id, units[started]?.text ?? b.text, String(body.mode ?? 'edit'));
      for (const n of subagents.lastCreated()) if (!made.includes(n)) made.push(n);
      // `sealedV` : un Mac ancien ignore `sealed` et ne répond pas `sealed: true` ; l'agent n'aurait alors pas les notes.
      const one = await bridge.call('agent', 'start', { ...body, prompt: b.text, ...(team ? { subagents: team } : {}), ...(b.sealed ? { sealed: b.sealed, sealedV: 1 } : {}), ...(group ? { group, slot: started + 1, of: built.length } : {}), ...(images.length ? { images } : {}) }, images.length ? 120000 : 60000);
      if (!one.ok) { fail = one.message ?? 'Lancement impossible.'; break; }
      if (b.sealed && one.sealed !== true) unsealed = true;
      if (!attach.confirmed(one, images.length)) oldApp = true;
      started++; last = one;
      // La conversation lancée garde le modèle et l'effort de sa première consigne : ils sont proposés pour la suite.
      if (!f.dataset.session && typeof one.session === 'string' && one.session) saved.setSession(one.session, picked);
    }
    btn.disabled = false; btn.innerHTML = label; delete f.dataset.busy;
    if (made.length) toast(`Sous-agents créés dans le projet : ${made.join(', ')}`);
    if (unsealed) toast('Les notes liées n’ont pas été lues par l’agent : mets à jour l’app Studio pour Mac.');
    if (oldApp) toast(attach.OLD_APP);
    // En cas d'échec, le texte reste dans le formulaire et dans son brouillon.
    const r = last;
    if (!r) { toast(fail); return; }
    if (started < built.length) {
      // Lancement groupé interrompu (limite d'agents, le plus souvent) : ce qui n'est pas parti reste dans le formulaire.
      if (fan === 'notes') setNotes(f, noteIds.slice(started)); else { ta.value = lines.slice(started).join('\n'); grow(ta); keepDraft(f); }
      showAuto(f); showFan(f);
      toast(`${started} agent${started > 1 ? 's' : ''} sur ${built.length} au travail. ${fail} Le reste attend dans la consigne.`);
      onStarted({ ...(r as unknown as AgentRun), session: '' });
      return;
    }
    ta.value = ''; grow(ta); showAuto(f); f.dataset.notes = ''; f.querySelectorAll('.ag-note').forEach(x => x.remove()); attach.clear(f); showFan(f);
    if (f.dataset.draft) saved.dropDraft(f.dataset.draft);
    // L'agent travaille encore : le message attend la fin de son tour (il apparaît dans le fil, « en attente »).
    if (typeof r.queued === 'number') {
      toast(r.queued > 1 ? `${r.queued} messages en attente : Claude les lira ensemble à la fin de son tour` : 'Message en attente : Claude le lira à la fin de son tour');
      if (cur) void paint(cur.box, cur.p);
      return;
    }
    // Plusieurs agents : on reste sur la liste, où chacun a sa carte.
    if (many) { toast(`${built.length} agents au travail, chacun dans sa copie`); onStarted({ ...(r as unknown as AgentRun), session: '' }); return; }
    toast(cut ? 'Tour interrompu : Claude lit ton message' : f.dataset.session ? 'Session reprise' : 'Claude Code est au travail');
    onStarted(r as unknown as AgentRun);
  });
}

// ---------- Vues ----------
// Cartes d'agents terminés retirées de la liste par l'utilisateur (la conversation, elle, reste dans « Sessions »).
const HIDDEN = 'studio.cc.hiddenruns';
let hiddenRuns: string[] = (() => { try { const v = JSON.parse(localStorage.getItem(HIDDEN) || '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } })();
function hideRuns(ids: string[]): void {
  hiddenRuns = [...new Set([...hiddenRuns, ...ids])].slice(-200);
  try { localStorage.setItem(HIDDEN, JSON.stringify(hiddenRuns)); } catch { /* stockage plein */ }
}

// ---------- Où en est le travail d'un agent ----------
/** Étapes du travail d'un agent, dans l'ordre : il écrit, il faut publier, la PR attend, c'est fusionné. */
type Stage = 'work' | 'review' | 'pr' | 'merged' | 'idle';
const STAGE_ORDER: Stage[] = ['work', 'review', 'pr', 'merged', 'idle'];
const STAGES: Record<Stage, { c: string; ic: string; l: string; g: string; d: string }> = {
  work: { c: 'amber', ic: 'bolt', l: 'Au travail', g: 'Au travail', d: 'l’agent modifie encore sa copie' },
  review: { c: 'orange', ic: 'upload', l: 'À publier', g: 'À relire et publier', d: 'terminé, pas encore poussé sur GitHub' },
  pr: { c: 'blue', ic: 'pr', l: 'PR ouverte', g: 'Poussées, PR en attente', d: 'sur GitHub, en attente de fusion' },
  merged: { c: 'violet', ic: 'check', l: 'Fusionné', g: 'Fusionnées', d: 'livré dans la branche principale' },
  idle: { c: 'gray', ic: 'pencil', l: 'Sans changement', g: 'Sans changement', d: 'rien de nouveau dans la copie' },
};
function stageOf(w: Worktree, working = runs.some(r => r.worktree === w.name && live(r))): Stage {
  if (working) return 'work';
  // Les copies sœurs comptent comme la copie : du travail dans un seul dépôt suffit à la rendre « à publier ».
  const sis = w.sisters ?? [];
  if (hasWork(w) || sis.some(hasWork)) return 'review';
  if ((w.pushed && !w.merged) || sis.some(s => s.pushed && !s.merged)) return 'pr';
  if (w.merged || sis.some(s => s.merged)) return 'merged';
  // Copie repartie sur une nouvelle branche après une livraison : elle garde l'état de sa dernière branche.
  const last = w.history?.[0];
  return last ? (last.merged ? 'merged' : 'pr') : 'idle';
}
/** Étape d'une copie au repos, sans l'état module (pour l'Espace agents, qui lit les copies de tous les projets). */
export const copyStage = (w: Worktree): Stage => stageOf(w, false);
function sessionStage(s: Pick<Session, 'id' | 'worktree'>): Stage | '' {
  if (runs.some(r => r.session === s.id && live(r))) return 'work';
  const w = s.worktree ? trees.find(t => t.name === s.worktree) : undefined;
  return w ? stageOf(w) : '';
}
const stageVar = (st: Stage) => `--c:var(--c-${STAGES[st].c})`;
const stageBadge = (st: Stage) => `<span class="ag-stage st-${st}" style="${stageVar(st)}">${icon(STAGES[st].ic)}${STAGES[st].l}</span>`;

/** Ce que le tour a ajouté au projet (notes et tâches, Réglages → Autorisations). */
function sentHTML(r: AgentRun): string {
  const t = r.items?.tasks ?? 0, n = r.items?.notes ?? 0;
  if (live(r) || (!t && !n)) return '';
  const what = [t ? `${t} tâche${t > 1 ? 's' : ''}` : '', n ? `${n} note${n > 1 ? 's' : ''}` : ''].filter(Boolean).join(' et ');
  return `<p class="ag-sent">${icon('check')}${esc(what)} ajoutée${t + n > 1 ? 's' : ''} au projet</p>`;
}

function runCard(r: AgentRun): string {
  // Agent terminé dans une copie : on montre où en est son travail (à publier, PR, fusionné) plutôt qu'un simple « Terminé ».
  const w = !live(r) && r.status === 'done' && r.worktree ? trees.find(t => t.name === r.worktree) : undefined;
  const st: Stage | '' = live(r) ? 'work' : w ? stageOf(w) : '';
  // Une ligne : état, consigne, durée, actions. Le reste (dernier message, mode, copie, étapes) est dans l'infobulle.
  const more = [r.mode === 'edit' ? 'Modifier' : 'Analyser', r.machine === 'server' ? `sur ${r.host ?? 'le serveur'}` : '', r.turns ? `${r.turns} étape${r.turns > 1 ? 's' : ''}` : '', r.worktree ?? ''].filter(Boolean).join(' · ');
  const said = live(r) ? r.lastText : r.result ? r.result.replace(/[#*`>]/g, '').slice(0, 220) : '';
  return `<article class="ag-run${live(r) ? ' live' : ''}${st ? ` st-${st}` : ''}"><div class="ag-run-row">${w && st && st !== 'idle' ? stageBadge(st) : pill(r.status)}<span class="ag-run-t" title="${esc([r.prompt, said, more].filter(Boolean).join('\n'))}">${esc(r.prompt)}</span><time>${esc(elapsed(r))}</time>
    <span class="ag-run-act">${r.session ? `<button class="btn btn-ghost" data-ss="${esc(r.session)}">Suivre</button>` : ''}${live(r) ? `<button class="btn btn-ghost" data-ag="stop" data-run="${esc(r.run)}">Arrêter</button>` : `<button class="icon-btn ag-hide" data-ag="hide-run" data-run="${esc(r.run)}" title="Retirer de la liste (la conversation reste dans Sessions)" aria-label="Retirer cet agent de la liste">${icon('x')}</button>`}</span></div>
    ${sentHTML(r)}
    ${r.denials.length ? `<p class="ag-denied" title="${esc(r.denials.join('\n'))}">${icon('shield')}${r.denials.length} action${r.denials.length > 1 ? 's' : ''} refusée${r.denials.length > 1 ? 's' : ''} par les garde-fous${bridge.local() ? ' · <button type="button" class="link-btn" data-open-conn="autorisations">Régler les autorisations</button>' : ''}</p>` : ''}</article>`;
}

/** Nom lisible d'une copie : celui de sa conversation la plus récente, sinon la consigne de l'agent, sinon son nom de dossier nettoyé. */
function treeTitle(w: Worktree, list: Session[]): string {
  const s = list.filter(x => x.worktree === w.name).sort((a, b) => ms(b.updated) - ms(a.updated))[0];
  const run = runs.find(r => r.worktree === w.name && r.prompt);
  return (s ? nameOf(s) : '') || (run ? neat(run.prompt) : '') || neat(w.name.replace(/^studio-|-\d{4}-\d{4}(-[a-z0-9]{3})?(-a[1-8])?$/g, '').replace(/-/g, ' ')) || w.name;
}

/** `badge` : la ligne est seule (fil d'une conversation), elle porte donc son étape ; dans la liste, c'est le groupe qui la dit. */
function treeRow(w: Worktree, list: Session[], badge = false, role: '' | 'mother' | number = ''): string {
  const st = stageOf(w), job = jobs.find(j => j.worktree === w.name), busy = job?.status === 'running';
  const conflicts = w.conflicts?.length ? `<span class="err"> · conflits : ${esc(w.conflicts.join(', '))}</span>` : '';
  const state = busy ? ` · <span class="spin"></span>${esc(job.step)}` : job?.status === 'error' || job?.status === 'blocked' ? `<span class="err"> · ${esc(job.step)}</span>` : conflicts;
  // Ce qui est déjà poussé ou fusionné n'est plus proposé : « Publier » ne sert qu'à du travail nouveau.
  const pending = w.pushed && !w.merged, fresh = hasWork(w) || (w.sisters ?? []).some(hasWork);
  const where = pending && !w.upToDate && fresh ? ' · déjà poussée une fois, changements à republier' : '';
  // Avec retard sur la branche principale, une copie fusionnée ou sans travail n'a rien à « mettre à jour » de visible.
  const canSync = !!w.behind && !busy && (w.changes > 0 || pending);
  const hist = w.history?.length ? `<span class="ag-hist">${w.history.map(h => `<span class="ag-hist-b${h.merged ? ' ok' : ''}" title="${esc(h.subject || h.branch)}">${icon(h.merged ? 'check' : 'pr')}<code>${esc(h.branch)}</code>${h.merged ? 'fusionnée' : 'PR en attente'}</span>`).join('')}</span>` : '';
  // Copies sœurs (autres dépôts du projet) : une pastille par dépôt, avec ce qui l'attend.
  const sisState = (s: Sister) => s.conflicts?.length ? 'conflits' : s.changes ? `${s.changes} fichier${s.changes > 1 ? 's' : ''} modifié${s.changes > 1 ? 's' : ''}` : hasWork(s) ? `${s.ahead} commit${s.ahead > 1 ? 's' : ''}` : s.merged ? 'fusionnée' : s.pushed ? 'PR en attente' : 'sans changement';
  const sis = w.sisters?.length ? `<span class="ag-hist">${w.sisters.map(s => `<span class="ag-hist-b${s.merged && !hasWork(s) ? ' ok' : ''}" title="Copie de ${esc(s.repo)}${s.branch ? ` · ${esc(s.branch)}` : ''}">${icon('folder')}<code>${esc(s.repo.split('/')[1] ?? s.repo)}</code>${esc(sisState(s))}</span>`).join('')}</span>` : '';
  const label = role === 'mother' ? 'Branche mère' : typeof role === 'number' ? `Agent ${role}` : treeTitle(w, list);
  // Agent d'un groupe : son travail se rapatrie dans la branche mère (pas tant qu'il travaille, ni s'il n'a rien fait).
  // Après une fusion, de nouveaux changements de l'agent (il a continué) se fusionnent à nouveau.
  const inMother = typeof role === 'number' && mergedKids.has(w.name) && !w.changes;
  const merge = typeof role !== 'number' || remote ? '' : inMother ? `<span class="ag-in-mother">${icon('check')}Dans la mère</span>`
    : `<button class="btn" data-ag="mergechild" data-wt="${esc(w.name)}"${(w.changes > 0 || (w.ahead > 0 && !w.merged)) && !busy && !runs.some(r => live(r) && r.worktree === w.name) ? '' : ' disabled'} title="Commiter le travail de cet agent et le fusionner dans la branche mère du groupe">${icon('pr')}Fusionner dans la mère</button>`;
  return `<div class="ag-tree st-${st}${role === 'mother' ? ' ag-mother' : typeof role === 'number' ? ' ag-child' : ''}" style="${stageVar(st)}"><span class="ag-tree-main"><span class="ag-tree-title">${badge ? stageBadge(st) : ''}<b title="${esc(w.branch || w.name)}">${esc(label)}</b></span>${w.branch && !w.branch.startsWith('worktree-') ? `<code>${esc(w.branch)}</code>` : ''}${w.subject && !badge && (w.ahead > 0 || w.pushed) ? `<strong>${esc(w.subject)}</strong>` : ''}<em>${w.changes ? `${w.changes} fichier${w.changes > 1 ? 's' : ''} modifié${w.changes > 1 ? 's' : ''}` : 'aucun changement en attente'}${w.ahead && !w.merged ? ` · ${w.ahead} commit${w.ahead > 1 ? 's' : ''}` : ''}${where}${w.behind && !w.merged && (w.changes || pending) ? ` · ${w.behind} commit${w.behind > 1 ? 's' : ''} de retard sur la branche principale` : ''}${state}</em>${sis}${hist}</span>
    <span class="ag-tree-act">${remote ? '<em class="ag-onmac">sur le Mac</em>' : `${merge}${canSync ? `<button class="btn" data-ag="sync" data-wt="${esc(w.name)}" title="Remettre la copie sur la dernière version de la branche principale ; l'agent résout les conflits éventuels">${icon('refresh')}Mettre à jour</button>` : ''}<button class="btn" data-ag="review" data-wt="${esc(w.name)}">${icon('sparkle')}Revue</button><button class="btn" data-ag="vscode" data-wt="${esc(w.name)}">${icon('code')}VS Code</button>${typeof role === 'number' ? '' : `<button class="btn" data-ag="push" data-wt="${esc(w.name)}"${fresh && !busy ? '' : ' disabled'} title="${fresh ? 'Publier le nouveau travail de l’agent' : w.merged ? 'Déjà fusionné : rien de nouveau à publier' : pending ? 'Déjà poussé : rien de nouveau à publier' : 'Rien à publier'}">${icon('upload')}Publier</button>${pending ? `<button class="btn" data-ag="pr" data-wt="${esc(w.name)}" title="Ouvrir la page de la pull request sur GitHub">${icon('github')}PR${w.pr?.state === 'open' ? ` #${w.pr.number}` : ''}</button>` : ''}${pending && !w.changes && !busy ? `<button class="btn" data-ag="newbranch" data-wt="${esc(w.name)}" title="Garder cette branche pour sa PR et repartir de la dernière version de la branche principale, sur une nouvelle branche, dans la même discussion">${icon('plus')}Nouvelle branche</button>` : ''}`}<button class="icon-btn" data-ag="discard" data-wt="${esc(w.name)}" title="Supprimer la copie" aria-label="Supprimer la copie">${icon('trash')}</button>`}</span></div>`;
}

function listHTML(list: Session[]): string {
  const running = runs.filter(live), recent = runs.filter(r => !live(r) && !hiddenRuns.includes(r.run)).slice(0, 4);
  const canClean = !remote && list.some(s => idle(s));
  const tot =list.reduce((t, s) => ({ input: t.input + s.tokens.input + s.tokens.cacheWrite, output: t.output + s.tokens.output, cacheRead: t.cacheRead + s.tokens.cacheRead }), { input: 0, output: 0, cacheRead: 0 });
  // Copies rangées par étape : ce qui demande une action d'abord, ce qui est livré ensuite.
  // Groupes d'agents (« 3× … ») : la branche mère et ses agents, ensemble, à part des autres copies.
  const families = new Map<string, Worktree[]>();
  for (const w of trees) { const g = groupOfCopy(w.name); if (g) { const l = families.get(g.group) ?? []; l.push(w); families.set(g.group, l); } }
  const inFamily = (w: Worktree) => families.has(w.name) || families.has(groupOfCopy(w.name)?.group ?? '');
  const familyHTML = [...families].map(([g, kids]) => {
    const mother = trees.find(t => t.name === g), sorted = [...kids].sort((a, b) => (groupOfCopy(a.name)?.slot ?? 0) - (groupOfCopy(b.name)?.slot ?? 0));
    const title = sorted.map(k => treeTitle(k, list)).find(Boolean) ?? g;
    const merged = mother ? mother.ahead : 0;
    return `<section class="ag-family"><h4>${icon('pr')}<b>${esc(title)}</b><span>${sorted.length} agent${sorted.length > 1 ? 's' : ''} sur la même branche mère${merged ? ` · ${merged} commit${merged > 1 ? 's' : ''} déjà dans la mère` : ' · compare-les, puis fusionne le meilleur dans la mère'}</span></h4>
      <div class="ag-trees">${mother ? treeRow(mother, list, true, 'mother') : ''}${sorted.map(k => treeRow(k, list, true, groupOfCopy(k.name)?.slot ?? 0)).join('')}</div></section>`;
  }).join('');
  const staged = trees.filter(w => !inFamily(w)).map(w => ({ w, st: stageOf(w) }));
  const count = (st: Stage) => st === 'work' ? Math.max(running.length, staged.filter(x => x.st === st).length) : staged.filter(x => x.st === st).length;
  const steps = STAGE_ORDER.filter(st => st !== 'idle').map(st => ({ st, n: count(st) })).filter(x => x.n);
  const flow = steps.length ? `<p class="ag-flow" role="list" aria-label="Où en est le travail des agents">${steps.map(({ st, n }) => `<span role="listitem" class="ag-flow-s st-${st}" title="${esc(STAGES[st].d)}"><b>${n}</b> ${esc(STAGES[st].l)}</span>`).join('')}</p>` : '';
  const groups = STAGE_ORDER.map(st => ({ st, list: staged.filter(x => x.st === st) })).filter(g => g.list.length)
    .map(({ st, list: l }) => `<section class="ag-group st-${st}" style="${stageVar(st)}"><h4 title="${esc(STAGES[st].d)}">${esc(STAGES[st].g)}<b>${l.length}</b></h4><div class="ag-trees">${l.map(x => treeRow(x.w, list)).join('')}</div></section>`).join('');
  return `${flow}
    ${running.length ? `<h3 class="ss-h">Au travail <span>${running.length}</span></h3><div class="ag-runs">${running.map(runCard).join('')}</div>` : ''}
    ${recent.length ? `<h3 class="ss-h">Terminés récemment${recent.length > 1 ? `<button class="link-btn ss-h-act" data-ag="hide-runs">Retirer les terminés</button>` : ''}</h3><div class="ag-runs">${recent.map(runCard).join('')}</div>` : ''}
    ${trees.length ? `<h3 class="ss-h" title="Travail isolé de ton dossier, rangé par étape">Copies des agents${!remote && trees.some(treeIdle) ? `<button class="link-btn ss-h-act" data-ag="clean-trees" title="Supprimer plusieurs copies d’un coup">Faire le ménage</button>` : ''}</h3><div class="ag-groups">${familyHTML}${groups}</div>` : ''}
    <h3 class="ss-h" title="Tout ce que Claude Code a fait dans ce projet">Sessions <span>${list.length}</span>${canClean ? `<button class="link-btn ss-h-act" data-ag="clean" title="Supprimer plusieurs conversations terminées d’un coup">Faire le ménage</button>` : ''}</h3>
    ${list.length ? `<p class="ss-sum">${usage.fmt(tot.output)} tokens écrits · ${usage.fmt(tot.input)} lus · ${usage.fmt(tot.cacheRead)} relus du cache</p>` : ''}
    <div class="ss-list">${list.map(s => {
      const top = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' · ');
      const st = sessionStage(s), tag = st && st !== 'idle' && st !== 'work' ? stageBadge(st) : '';
      const info = [s.worktree ? 'copie isolée' : s.branch ?? '', s.models.map(modelName).join(', '), `${s.prompts} demande${s.prompts > 1 ? 's' : ''}`, `${usage.fmt(s.tokens.output)} tokens écrits`, top].filter(Boolean).join(' · ');
      return `<div class="ss-row${s.id === selected ? ' sel' : ''}${st ? ` st-${st}` : ''}"><button class="ss-open" data-ss="${esc(s.id)}" title="${esc(info)}"><i class="ss-live${s.live ? ' on' : ''}${st && st !== 'idle' ? ` st-${st}` : ''}" title="${s.live ? 'En cours' : st && st !== 'idle' ? STAGES[st].l : 'Inactive'}"></i>
        <span class="ss-main"><span class="ss-name"><strong>${esc(nameOf(s))}</strong>${tag}</span></span>
        <time>${esc(rel(ms(s.updated)))}</time></button>${remote ? '' : `<button class="icon-btn ss-del" data-ag="delete" data-session="${esc(s.id)}" title="Supprimer la conversation" aria-label="Supprimer la conversation ${esc(nameOf(s))}">${icon('trash')}</button>`}</div>`;
    }).join('') || '<p class="hm-empty">Aucune session Claude Code dans ce dossier pour l’instant. Donne une consigne ci-dessus pour lancer la première.</p>'}</div>`;
}

// ---------- Fil d'une session ----------
type Detail = Session & { actions: Action[] };
export interface Block { key: string; html: string }
const FEED_MAX = 80; // nombre d'étapes renvoyées par le Mac (voir Sessions.swift)

/** Heure d'une étape ; avec la date si ce n'est pas aujourd'hui. */
function clock(iso: string): string {
  const t = ms(iso); if (!t) return '';
  const d = new Date(t), today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('fr-FR', today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Markdown d'une réponse de Claude, sans les blocs propres aux notes (tags, liens entre notes, cases cochables). */
const answerHTML = (text: string): string => renderMarkdown(text)
  .replace(/<a class="(?:tag|wikilink)[^>]*>(.*?)<\/a>/g, '$1')
  .replace(/<input type="checkbox"/g, '<input type="checkbox" disabled');

/** Découpe les étapes en blocs de conversation : demandes, réponses, et outils consécutifs regroupés. */
export function feedBlocks(actions: Action[], root: string | null, working: boolean, waiting: Queued[] = [], stalled = false, sidechain = false): Block[] {
  // Dans le fil d'un sous-agent, c'est Claude qui donne la consigne et le sous-agent qui répond.
  const asker = sidechain ? 'Claude' : 'Toi', answerer = sidechain ? 'Sous-agent' : 'Claude';
  const out: Block[] = [], seen = new Map<string, number>();
  const key = (a: Action, c: string) => { const k = `${c}|${a.at}`, n = seen.get(k) ?? 0; seen.set(k, n + 1); return n ? `${k}|${n}` : k; };
  const toolRow = (a: Action) => `<li><b>${esc(a.kind.slice(5))}</b><span>${esc(short(a.text, root))}</span></li>`;
  let group: Action[] = [];
  const flush = (last: boolean) => {
    const first = group[0], latest = group[group.length - 1]; if (!first || !latest) return;
    const k = key(first, 'tools');
    if (group.length === 1) out.push({ key: k, html: `<div class="ss-tools"><ul>${toolRow(first)}</ul></div>` });
    else {
      const counts = new Map<string, number>();
      for (const a of group) counts.set(a.kind.slice(5), (counts.get(a.kind.slice(5)) ?? 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${esc(n)} ${c}`).join(' · ');
      const now = last && working ? `<em>${esc(`${latest.kind.slice(5)} ${short(latest.text, root)}`)}</em>` : '';
      out.push({ key: k, html: `<details class="ss-tools"><summary>${icon('bolt')}<strong>${group.length} actions</strong><span>${top}</span>${now}${icon('chevron')}</summary><ul>${group.map(toolRow).join('')}</ul></details>` });
    }
    group = [];
  };
  if (actions.length >= FEED_MAX) out.push({ key: 'cut', html: '<p class="ss-cut">Début de la session masqué : seules les dernières étapes sont affichées.</p>' });
  for (const a of actions) {
    // Une écriture qui porte son texte (old/new) montre ce qu'elle a changé, en direct dans le fil, hors du groupe replié.
    if (a.kind.startsWith('tool:') && hasDiff(a)) { flush(false); out.push({ key: key(a, 'diff'), html: diffHTML(a, short(a.file ?? '', root)) }); continue; }
    if (a.kind.startsWith('tool:')) { group.push(a); continue; }
    flush(false);
    if (a.kind === 'prompt') out.push({ key: key(a, 'user'), html: `<div class="ss-msg user"><header><strong>${asker}</strong><time>${esc(clock(a.at))}</time></header><p>${esc(a.text)}</p>${attach.galleryHTML(a.images)}</div>` });
    else out.push({ key: key(a, 'ai'), html: `<div class="ss-msg ai"><header><strong>${answerer}</strong><time>${esc(clock(a.at))}</time><button class="icon-btn ss-copy" data-ag="copy" title="Copier la réponse" aria-label="Copier la réponse">${icon('copy')}</button></header><div class="md">${answerHTML(a.text)}</div></div>` });
  }
  flush(true);
  if (!actions.length) out.push({ key: 'empty', html: `<p class="ss-cut">${working ? 'La session démarre…' : 'Aucune étape dans cette session.'}</p>` });
  if (working) out.push({ key: 'working', html: `<div class="ss-working"><span class="spin"></span>${sidechain ? 'Le sous-agent' : 'Claude'} travaille…</div>` });
  // Messages secondaires, pas encore lus par Claude : remis ensemble à la fin de son tour.
  for (const q of waiting) out.push({ key: `queued|${q.id}`, html: `<div class="ss-msg user queued"><header><strong>Toi</strong><em class="ss-wait">${icon('history')}en attente</em><time>${esc(clock(q.at))}</time><button class="icon-btn" data-ag="unqueue" data-q="${esc(q.id)}" title="Retirer ce message" aria-label="Retirer ce message">${icon('trash')}</button></header><p>${esc(q.text)}</p>${attach.galleryHTML(q.images)}</div>` });
  // Le tour s'est fini sans eux (agent arrêté ou en erreur) : ils partent quand l'utilisateur le décide.
  if (waiting.length && stalled) out.push({ key: 'queued-send', html: `<p class="ss-cut">${waiting.length > 1 ? 'Ces messages n’ont pas été transmis' : 'Ce message n’a pas été transmis'} : l’agent s’est arrêté avant la fin de son tour. <button class="link-btn" data-ag="flush">${icon('play')}Envoyer maintenant</button></p>` });
  return out;
}

/** Met le fil à jour bloc par bloc : ce qui n'a pas changé n'est pas redessiné (sélection, blocs dépliés et défilement conservés). */
const drawn = new WeakMap<Element, string>();
export function syncFeed(feed: HTMLElement, blocks: Block[]): boolean {
  const old = new Map<string, HTMLElement>();
  for (const el of Array.from(feed.children) as HTMLElement[]) old.set(el.dataset.k ?? '', el);
  let changed = false;
  blocks.forEach((b, i) => {
    const prev = old.get(b.key);
    let el = prev;
    if (!prev || drawn.get(prev) !== b.html) {
      const t = document.createElement('template'); t.innerHTML = b.html.trim();
      el = t.content.firstElementChild as HTMLElement;
      el.dataset.k = b.key; drawn.set(el, b.html);
      if (prev?.tagName === 'DETAILS' && el.tagName === 'DETAILS') (el as HTMLDetailsElement).open = (prev as HTMLDetailsElement).open;
    }
    if (el && feed.children[i] !== el) { feed.insertBefore(el, feed.children[i] ?? null); changed = true; }
  });
  while (feed.children.length > blocks.length) { feed.lastElementChild?.remove(); changed = true; }
  return changed;
}

/** Sous-agents de la conversation : chacun ouvre son fil ; celui qui est affiché est en surbrillance. */
function subsHTML(session: string, curId = ''): string {
  const list = subsOf.get(session) ?? []; if (!list.length) return '';
  const running = list.filter(a => a.live).length, n = list.length;
  return `<h3 class="ss-h">Sous-agents <span>${n} tâche${n > 1 ? 's' : ''} déléguée${n > 1 ? 's' : ''} par Claude${running ? ` · ${running} en cours` : ''}</span></h3>
    <div class="ss-subs">${list.map(a => `<button class="ss-sub${a.id === curId ? ' sel' : ''}" data-sa="${esc(a.id)}"${a.id === curId ? ' aria-current="true"' : ''} title="${esc(a.title)}"><i class="ss-live${a.live ? ' on' : ''}"></i><span>${esc(a.title)}</span>${a.type ? `<em>${esc(a.type)}</em>` : ''}${pinned(session, a.id) ? icon('pin') : ''}</button>`).join('')}</div>`;
}
/** En-tête du fil d'un sous-agent : son nom, l'épingle, et ses voisins pour passer de l'un à l'autre. */
function subTopHTML(s: Detail, a: SubAgent): string {
  const mn = Math.max(0, Math.round((ms(s.updated) - ms(s.started)) / 6e4)), acts = Object.values(s.tools).reduce((x, y) => x + y, 0), pin = pinned(s.id, a.id);
  return `<div class="ss-dhead"><i class="ss-live${a.live ? ' on' : ''}"></i><h2>${esc(a.title)}</h2>${a.type ? `<span class="ag-mode">${icon('bolt')}${esc(a.type)}</span>` : ''}<button class="btn ss-pin${pin ? ' on' : ''}" data-ag="pin-sub" aria-pressed="${pin}" title="${pin ? 'Retirer de la barre latérale' : 'Garder ce sous-agent dans la barre latérale, sous sa conversation'}">${icon('pin')}${pin ? 'Épinglé' : 'Épingler'}</button></div>
    <p class="ss-meta">${icon('eye')}Fil d’un sous-agent, en lecture seule · ${s.models.length ? `${esc(s.models.map(modelName).join(', '))} · ` : ''}${mn} min · ${acts} action${acts > 1 ? 's' : ''} · ${usage.fmt(s.tokens.output)} tokens écrits</p>
    ${subsHTML(s.id, a.id)}`;
}

function topHTML(s: Detail, root: string | null, open: boolean): string {
  const dur = ms(s.updated) - ms(s.started), h = Math.floor(dur / 36e5), mn = Math.round(dur % 36e5 / 6e4);
  const run = runs.find(r => r.session === s.id && live(r)), tree = s.worktree ? trees.find(t => t.name === s.worktree) : undefined;
  const acts = Object.values(s.tools).reduce((a, b) => a + b, 0);
  return `<div class="ss-dhead"><i class="ss-live${s.live || run ? ' on' : ''}"></i><h2>${esc(nameOf(s))}</h2>${run ? `${pill(run.status)}<button class="btn" data-ag="stop" data-run="${esc(run.run)}">${icon('stop')}Arrêter</button>` : ''}${remote || !s.id ? '' : `<button class="icon-btn" data-ag="delete" title="Supprimer la conversation" aria-label="Supprimer la conversation">${icon('trash')}</button>`}</div>
    <p class="ss-meta">${s.worktree ? `${icon('pencil')}copie isolée <code>${esc(s.worktree)}</code> · ` : s.branch ? `${icon('pr')}${esc(s.branch)} · ` : ''}${s.models.length ? `${esc(s.models.map(modelName).join(', '))} · ` : ''}${h ? `${h} h ` : ''}${mn} min · ${s.prompts} demande${s.prompts > 1 ? 's' : ''}</p>
    ${tree ? `<div class="ag-trees ss-tree">${treeRow(tree, [s], true)}</div>` : remote ? '' : s.worktree ? (treesRead ? `<p class="ss-meta">${icon('history')}Copie isolée supprimée : réponds pour reprendre, Studio la recrée (sur sa branche si elle existe encore, sinon depuis la branche principale).</p>` : '') : `<div class="ss-actions"><button class="btn" data-pj="review-working">${icon('sparkle')}Revue des changements en cours</button><button class="btn" data-pj="vscode">${icon('code')}Ouvrir dans VS Code</button></div>`}
    ${subsHTML(s.id)}
    <details class="ss-more"${open ? ' open' : ''}><summary>${icon('chevron')}Détails<span>${usage.fmt(s.tokens.output)} tokens écrits · ${acts} action${acts > 1 ? 's' : ''}${s.files.length ? ` · ${s.files.length} fichier${s.files.length > 1 ? 's' : ''} modifié${s.files.length > 1 ? 's' : ''}` : ''}</span></summary>
      <div class="ss-totals"><div><strong>${usage.fmt(s.tokens.output)}</strong><span>tokens écrits</span></div><div><strong>${usage.fmt(s.tokens.input + s.tokens.cacheWrite)}</strong><span>tokens lus</span></div><div><strong>${usage.fmt(s.tokens.cacheRead)}</strong><span>relus du cache</span></div><div><strong>${acts}</strong><span>actions</span></div></div>
      ${s.files.length ? `<h3 class="ss-h">Fichiers modifiés <span>${s.files.length}</span></h3><div class="ss-files">${s.files.map(f => `<code>${esc(short(f, root))}</code>`).join('')}</div>` : ''}</details>`;
}

const atEnd = (feed: HTMLElement) => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;

/** Affiche une session dans `zone` ; les appels suivants ne touchent que ce qui a changé. */
function showDetail(zone: HTMLElement, raw: Partial<Session> & { actions?: Action[] }, root: string | null, agent?: SubAgent): void {
  // Une session qui vient de démarrer peut ne pas avoir encore toutes ses informations.
  const s: Detail = { id: '', title: 'Session qui démarre…', branch: '', worktree: '', started: '', updated: '', live: true, models: [], prompts: 0, lastPrompt: '', files: [], tools: {}, ...raw, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...raw.tokens }, actions: raw.actions ?? [] };
  let feed = $('.ss-feed', zone);
  const feedId = agent ? `${s.id}/${agent.id}` : s.id;
  if (!feed || feed.dataset.id !== feedId) {
    zone.innerHTML = `<div class="ss-top"></div><div class="ss-pulse"></div><div class="ss-thread"><div class="ss-feed" role="log" aria-label="Fil de la session" tabindex="0"></div><button class="ss-jump" data-ag="end" hidden>${icon('chevron')}Nouvelles étapes</button></div>`;
    const f = need('.ss-feed', zone), jump = need('.ss-jump', zone);
    f.dataset.id = feedId;
    f.addEventListener('scroll', () => { if (atEnd(f)) jump.hidden = true; }, { passive: true });
    feed = f;
  }
  const top = need('.ss-top', zone), html = agent ? subTopHTML(s, agent) : topHTML(s, root, !!$<HTMLDetailsElement>('.ss-more', top)?.open);
  if (drawn.get(top) !== html) { top.innerHTML = html; drawn.set(top, html); }
  // « En cours » : l'agent lancé depuis Studio tourne encore, ou une session du terminal vient d'agir sans avoir répondu.
  // Un sous-agent, lui, travaille tant que son journal bouge et qu'il n'a pas rendu sa réponse.
  const own = agent ? [] : runs.filter(r => r.session === s.id), last = s.actions[s.actions.length - 1];
  const working = agent ? agent.live && !!last && last.kind !== 'text' : own.length ? own.some(live) : s.live && !!last && last.kind !== 'text';
  if (agent) { subTitle = agent.title; notify(); }
  else if (s.id === selected) {
    // Une session suivie par le flux de son agent (serveur) n'a pas de compteur de demandes : on les compte dans le fil.
    const named: Nameable = { ...s, prompts: s.prompts || s.actions.filter(a => a.kind === 'prompt').length };
    selTitle = nameOf(named); notify();
    if (cur && wantsName(named, working)) void nameSession(cur.p, named, s.actions);
  }
  // Tableau de bord en direct (pulse.ts) : mis à jour en place à chaque relecture, avant le fil.
  const pulseBox = $('.ss-pulse', zone);
  if (pulseBox) paintPulse(pulseBox, { ...s, working, short: f => short(f, root) });
  const first = !feed.children.length, end = atEnd(feed);
  // Messages en attente restés en plan : le dernier tour s'est terminé autrement que normalement (arrêt, erreur).
  const latest = own.reduce<AgentRun | undefined>((a, r) => !a || ms(r.started) > ms(a.started) ? r : a, undefined);
  const stalled = !working && !!latest && !live(latest) && latest.status !== 'done';
  const drew = syncFeed(feed, feedBlocks(s.actions, root, working, agent ? [] : queued.filter(q => q.session === s.id), stalled, !!agent));
  if (cur) attach.hydrate(feed, cur.p.id);
  if (!drew) return;
  if (first || end) feed.scrollTop = feed.scrollHeight;
  else need('.ss-jump', zone).hidden = false;
}

// ---------- Actions sur les copies ----------
// ---------- Message de commit (Conventional Commits) ----------
const TYPES = 'feat|fix|chore|docs|refactor|test|perf|style|build|ci';
const COMMIT_RE = new RegExp(`^(${TYPES})(\\([\\w./-]+\\))?!?: \\S`);
/** Types proposés en un clic dans la fenêtre de publication. */
const KINDS: [string, string][] = [['feat', 'Nouvelle fonctionnalité'], ['fix', 'Correction de bug'], ['chore', 'Entretien, configuration, dépendances'], ['refactor', 'Refonte sans changement de comportement'], ['docs', 'Documentation'], ['test', 'Tests']];
/** Remplace le type d'un titre en gardant sa portée et son résumé : « feat(ui): x » → « fix(ui): x ». */
const retype = (type: string, line: string): string => { const m = line.match(new RegExp(`^(?:${TYPES})(\\([^)]*\\))?!?:\\s*(.*)$`)); return m ? `${type}${m[1] ?? ''}: ${m[2] ?? ''}` : `${type}: ${line}`; };
/** Type probable d'après la consigne et les fichiers touchés. */
function guessType(text: string, files: string[]): string {
  if (files.length && files.every(f => /\.(md|txt)$|^docs?\//i.test(f))) return 'docs';
  if (files.length && files.every(f => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.\w+$/.test(f))) return 'test';
  if (/\b(corrig|répar|repar|bug|fix|erreur|crash|plante|régression)/i.test(text)) return 'fix';
  if (/\b(refacto|nettoi|simplifi|réorganis|renomm)/i.test(text)) return 'refactor';
  if (/\b(doc|readme|documentation)\b/i.test(text)) return 'docs';
  if (/\btests?\b/i.test(text)) return 'test';
  if (/\b(dépendances?|mise à jour|mettre à jour|upgrade|bump|config|workflow|ci)\b/i.test(text)) return 'chore';
  return 'feat';
}
/** Fichiers listés par `git diff --stat`. */
const statFiles = (stat: string): string[] => stat.split('\n').map(l => l.split('|')[0]?.trim() ?? '').filter(f => f && !/files? changed/.test(f));
/** Proposition de dernier recours, sans agent ni IA : le type, puis ce qui a changé d'après les fichiers.
 *  La consigne ne sert qu'à deviner le type ; elle n'est jamais recopiée dans le message. */
function draftMessage(prompt: string, files: string[]): string {
  const type = guessType(prompt, files), verb = type === 'fix' ? 'correct' : type === 'refactor' ? 'rework' : 'update';
  // `git diff --stat` abrège les chemins longs (« .../x.ts ») et note les renommages (« a => b ») : on garde la cible.
  const paths = files.map(f => (f.split(' => ').pop() ?? f).replace(/[{}]/g, '').replace(/^\.\.\.\//, ''));
  const names = paths.map(f => f.split('/').pop() ?? f);
  const dirs = [...new Set(paths.map(f => f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''))];
  const what = !names.length ? 'project files'
    : names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
    : dirs.length === 1 && dirs[0] ? `${dirs[0]} (${names.length} files)` : `${names.length} files`;
  const line = `${type}: ${verb} ${what}`;
  return line.length > 72 ? `${type}: ${verb} ${names.length} file${names.length > 1 ? 's' : ''}` : line;
}
/** Ligne « Commit: … » que l'agent écrit à la fin de son compte rendu (il sait ce qu'il a fait, sur toute la copie). */
function agentMessage(result: string): string {
  const line = result.split('\n').reverse().map(l => l.trim().replace(/^[-*>\s]+/, '').replace(/[`*]/g, '')).find(l => /^commit\s*:/i.test(l));
  const msg = line?.replace(/^commit\s*:\s*/i, '').replace(/[.\s]+$/, '').replace(/^[A-Za-z]+/, t => t.toLowerCase()) ?? '';
  return COMMIT_RE.test(msg) ? (msg.length > 72 ? msg.slice(0, 71).trimEnd() + '…' : msg) : '';
}
/** Message de l'agent retrouvé dans le fil de sa session, sur disque : les comptes rendus des agents
 *  ne sont gardés qu'en mémoire, et disparaissent au redémarrage de Studio. */
async function sessionMessage(p: Project, wt: string): Promise<string> {
  try {
    const l = await native.call('project', 'sessions', { project: p.id }, 20000);
    const s = ((l.sessions as Session[] | undefined) ?? []).find(x => x.worktree === wt);
    if (!s) return '';
    const d = await native.call('project', 'session', { project: p.id, session: s.id }, 20000);
    if (!d.ok) return '';
    return ((d.actions as Action[] | undefined) ?? []).filter(a => a.kind === 'text').reverse().map(a => agentMessage(a.text)).find(Boolean) ?? '';
  } catch { return ''; }
}
/** Titre tiré d'une branche déjà nommée par Studio : « feat/tasks-add-parser-tests » → « feat: tasks add parser tests ». */
const subjectFromBranch = (branch: string): string => { const m = branch.match(new RegExp(`^(${TYPES})/(.+)$`)); return m ? `${m[1]}: ${m[2]!.replace(/[-_/]+/g, ' ')}` : ''; };
/** Compte rendu sans la ligne de commit (pour la description de la PR). */
const withoutCommitLine = (result: string) => result.split('\n').filter(l => !/^[-*>\s`]*commit\s*:/i.test(l.trim())).join('\n').trim();
/** Nettoie la réponse de l'IA : 1 ligne de titre conforme, et au plus 1 ligne de détail. */
function cleanMessage(raw: string, fallbackType: string): string {
  const lines = raw.replace(/```\w*/g, '').split('\n').map(l => l.trim().replace(/^["'`]+|["'`]+$/g, '')).filter(Boolean);
  let subject = lines[0] ?? '';
  if (!subject) return '';
  if (!COMMIT_RE.test(subject)) subject = `${fallbackType}: ${subject.replace(/^\w+(\(.*?\))?:\s*/, '')}`;
  subject = subject.length > 72 ? subject.slice(0, 71).trimEnd() + '…' : subject;
  const detail = lines.slice(1).find(l => !COMMIT_RE.test(l));
  return detail ? `${subject}\n\n${detail.slice(0, 160)}` : subject;
}
// La consigne du message de commit et la taille du diff envoyé se règlent dans Réglages → Consignes et contexte.
async function suggestMessage(p: Project, wt: string, run: AgentRun | undefined, forceAI = false): Promise<{ draft: string; fromAgent: boolean; ai: Promise<string> | null; files: string[] }> {
  const d = await native.call('project', 'diff', { project: p.id, scope: 'working', worktree: wt }, 30000);
  const stat = String(d.stat ?? ''), files = statFiles(stat), prompt = run?.prompt ?? wt.replace(/^studio-|-\d{4}-\d{4}$/g, '').replace(/-/g, ' ');
  // 1. le message écrit par l'agent (compte rendu le plus récent qui en contient un, sinon le fil de sa session) ;
  // 2. l'IA d'après le diff ; 3. en dernier recours, un résumé des fichiers modifiés. Jamais la consigne telle quelle.
  // Un message qui a déjà servi à une branche livrée par cette copie décrit du travail fusionné : il n'est plus proposé.
  const tree = trees.find(t => t.name === wt), shipped = new Set((tree?.history ?? []).map(h => h.subject).concat(tree?.merged && tree.subject ? [tree.subject] : []));
  const fresh = (m: string) => m && !shipped.has(m) ? m : '';
  const fromAgent = runs.filter(r => r.worktree === wt && r.result).map(r => fresh(agentMessage(r.result))).find(Boolean) || fresh(await sessionMessage(p, wt));
  const draft = fromAgent || draftMessage(prompt, files);
  if ((fromAgent && !forceAI) || !d.ok || !ai.ready() || !String(d.patch ?? '').trim()) return { draft, fromAgent: !!fromAgent, ai: null, files };
  const user = `Consigne donnée à l’agent : ${prompt}\n\n${run?.result ? `Compte rendu de l’agent :\n${run.result.slice(0, 1500)}\n\n` : ''}Commits récents du dépôt :\n${String(d.log ?? '').trim() || '(aucun)'}\n\nFichiers modifiés :\n${stat}\n\nDiff (extrait) :\n\`\`\`diff\n${String(d.patch).slice(0, tuning.num('ctx.diff'))}\n\`\`\``;
  return { draft, fromAgent: !!fromAgent, files, ai: ai.complete(tuning.text('small.commit'), user, { light: tuning.on('small.commits') }).then(t => cleanMessage(t, guessType(prompt, files))) };
}

/** Nom de branche conventionnel tiré du titre du commit : « feat(tasks): add parser tests » → feat/tasks-add-parser-tests. */
export function branchName(subject: string): string {
  const m = subject.match(new RegExp(`^(${TYPES})(?:\\(([^)]+)\\))?!?:\\s*(.*)$`));
  const type = m?.[1] ?? 'feat', words = `${m?.[2] ?? ''} ${m?.[3] ?? subject}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let slug = '';
  for (const w of words) { if ((slug + '-' + w).length > 44) break; slug = slug ? `${slug}-${w}` : w; }
  return `${type}/${slug || 'update'}`;
}

/** Page GitHub de création de la PR, déjà remplie (marche avec n'importe quel jeton, ou sans). */
const compareURL = (repo: string, base: string, branch: string, title: string, body: string) =>
  `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?quick_pull=1&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 3500))}`;
const prBody = (run: AgentRun | undefined, detail: string) => `${detail ? `${detail}\n\n` : ''}${run?.result ? `${withoutCommitLine(run.result)}\n\n` : ''}---\nPréparé par Claude Code depuis Studio.`;

/** Dépôt GitHub du dossier où travaillent les agents : son remote origin s'il fait partie du projet, sinon le principal. */
async function workRepo(p: Project): Promise<string | undefined> {
  if (p.repos.length > 1 && native.available()) {
    try { const r = await native.call('project', 'info', { project: p.id }, 10000); const hit = model.repoNamed(p, typeof r.remote === 'string' ? r.remote : null); if (hit) return hit.name; } catch { /* le principal */ }
  }
  return p.repos[0];
}

async function publish(p: Project, wt: string, root: HTMLElement | null): Promise<void> {
  // La première demande faite dans cette copie (les suivantes sont souvent « continue », « résous le conflit »…).
  const mine = runs.filter(r => r.worktree === wt), run = mine[mine.length - 1], repo = await workRepo(p);
  const canPR = !!repo && github.connected();
  // Dépôts où le travail sera publié : celui des agents et chaque copie sœur qui a du travail (même branche partout).
  const t0 = trees.find(t => t.name === wt), sisWork = (t0?.sisters ?? []).filter(hasWork).map(s => s.repo);
  const targets = [...(!t0 || hasWork(t0) || !sisWork.length ? [repo ?? ''] : []), ...sisWork].filter(Boolean);
  const m = modal({ cls: 'ag-pub', title: 'Publier le travail de l’agent', html: `
    <div class="pub-type"><span>Type</span><div class="ag-seg" role="radiogroup" aria-label="Type de changement">${KINDS.map(([k, l]) => `<label title="${esc(l)}"><input type="radio" name="ctype" value="${k}"><span>${k}</span></label>`).join('')}</div></div>
    <label class="pj-field"><span class="ag-msg-h">Message de commit<em class="ag-sug" hidden>${icon('sparkle')}proposé par l’IA</em></span><textarea class="field ag-msg" name="msg" rows="3" spellcheck="false" required></textarea></label>
    <div class="ag-sug-row"><span class="ag-sug-st"><span class="spin"></span>Lecture des changements…</span><button type="button" class="link-btn" data-resug hidden>${icon('refresh')}Reproposer</button></div>
    <label class="pj-field"><span>Branche</span><input class="field ag-branch" name="branch" spellcheck="false" autocomplete="off" required></label>
    ${repo ? `<label class="cx-check"><input type="checkbox" name="pr" checked> ${targets.length > 1 ? `Ouvrir une pull request dans chaque dépôt : ${targets.map(x => `<strong>${esc(x)}</strong>`).join(', ')}` : `Ouvrir une pull request sur <strong>${esc(targets[0] ?? repo)}</strong>`}</label>
    <label class="pj-field"><span>Titre de la PR</span><input class="field" name="title"></label>` : '<p class="modal-hint">Associe un dépôt GitHub au projet pour ouvrir une pull request.</p>'}
    <p class="modal-hint">${icon('shield')}Studio remet d’abord la copie sur la dernière version de la branche principale (l’agent résout les conflits s’il y en a), puis fait un seul commit avec ce message et pousse la branche avec tes identifiants Git habituels. Ton dossier de travail n’est pas touché.</p>
    <div class="rv-status"></div>
    <div class="modal-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-primary" data-go>${icon('upload')}Publier</button></div>` });
  const msg = need<HTMLTextAreaElement>('[name=msg]', m.node), title = m.node.querySelector<HTMLInputElement>('[name=title]');
  const sugSt = need('.ag-sug-st', m.node), sugTag = need('.ag-sug', m.node), resug = need<HTMLButtonElement>('[data-resug]', m.node);
  const branchIn = need<HTMLInputElement>('[name=branch]', m.node);
  let editedMsg = false, editedTitle = false, editedBranch = false;
  // Branche déjà poussée et pas encore fusionnée : publier la met à jour (et sa PR) ; un autre nom crée une branche à part.
  const tree = trees.find(t => t.name === wt);
  if (tree?.pushed && !tree.merged && tree.branch) {
    branchIn.value = tree.branch; editedBranch = true;
    branchIn.closest('.pj-field')?.insertAdjacentHTML('beforeend', `<em class="modal-hint">${esc(tree.branch)} est déjà poussée : publier met à jour sa PR. Un autre nom crée une nouvelle branche (qui contiendra aussi ce travail déjà poussé).</em>`);
  }
  const subject = () => msg.value.split('\n')[0]?.trim() ?? '';
  const typeOf = () => new RegExp(`^(${TYPES})`).exec(subject())?.[1] ?? '';
  const sync = () => {
    if (title && !editedTitle) title.value = subject();
    if (!editedBranch) branchIn.value = branchName(subject());
    m.node.querySelectorAll<HTMLInputElement>('[name=ctype]').forEach(r => { r.checked = r.value === typeOf(); });
  };
  // Changer de type réécrit seulement le préfixe du message (la portée et le résumé restent).
  m.node.addEventListener('change', e => {
    const t = e.target as HTMLInputElement; if (t.name !== 'ctype') return;
    const lines = msg.value.split('\n'); lines[0] = retype(t.value, lines[0] ?? ''); msg.value = lines.join('\n'); sync();
  });
  branchIn.addEventListener('input', () => { editedBranch = true; });
  msg.addEventListener('input', () => { editedMsg = true; sugTag.hidden = true; sync(); });
  title?.addEventListener('input', () => { editedTitle = true; });
  const go = need<HTMLButtonElement>('[data-go]', m.node), st = need('.rv-status', m.node);
  let drafting = false;
  const ready = () => { go.disabled = drafting && !editedMsg; };
  msg.addEventListener('input', ready);
  const propose = async (forceAI = false) => {
    resug.hidden = true; drafting = true; ready(); sugSt.innerHTML = '<span class="spin"></span>Lecture des changements…';
    try {
      const s = await suggestMessage(p, wt, run, forceAI);
      if (!m.node.isConnected) return;
      if (!editedMsg) { msg.value = s.draft; sync(); }
      if (!s.ai) {
        sugSt.textContent = s.fromAgent ? 'Message rédigé par l’agent à partir de son travail.' : ai.ready() ? 'Proposition tirée des fichiers modifiés : précise-la.' : 'Proposition tirée des fichiers modifiés : précise-la · connecte une IA pour un message rédigé d’après le diff.';
        resug.hidden = !ai.ready(); return;
      }
      sugSt.innerHTML = `<span class="spin"></span>L’IA rédige le message d’après le diff (${esc(ai.PROVIDERS[ai.config().provider])})…`;
      const text = await s.ai; if (!m.node.isConnected) return;
      if (text && !editedMsg) { msg.value = text; sugTag.hidden = false; sync(); }
      sugSt.textContent = editedMsg ? 'Tu as modifié le message : la proposition de l’IA n’a pas été appliquée.' : `${s.files.length} fichier${s.files.length > 1 ? 's' : ''} modifié${s.files.length > 1 ? 's' : ''}.`;
    } catch (e) { sugSt.innerHTML = `<span class="err">Pas de proposition de l’IA : ${esc(errMsg(e))}</span>`; }
    finally { drafting = false; ready(); }
    resug.hidden = !ai.ready();
  };
  resug.onclick = () => { editedMsg = false; void propose(true); };
  void propose();
  need('[data-x]', m.node).onclick = m.close;

  /** Suit la tâche de l'orchestrateur jusqu'à sa fin (elle continue côté Mac si la fenêtre est fermée). */
  const follow = async (id: string): Promise<Job | null> => {
    for (;;) {
      const j = await native.call('agent', 'job', { job: id }, 10000) as unknown as Job & { ok: boolean };
      if (!m.node.isConnected) return null;
      if (!j.ok) { st.innerHTML = '<p class="rv-status err">Tâche perdue.</p>'; return null; }
      st.innerHTML = `<ol class="ag-steps">${j.log.map((l, i) => `<li${i === j.log.length - 1 && j.status === 'running' ? ' class="on"' : ''}>${i === j.log.length - 1 && j.status === 'running' ? '<span class="spin"></span>' : ''}${esc(l)}</li>`).join('')}</ol>`;
      if (j.status !== 'running') return j;
      await new Promise(r => setTimeout(r, 1500));
    }
  };

  go.onclick = async () => {
    const wantPR = !!repo && !!m.node.querySelector<HTMLInputElement>('[name=pr]')?.checked;
    const message = msg.value.trim(); if (!message) { msg.focus(); return; }
    const prTitle = title?.value.trim() || subject(), detail = message.split('\n').slice(1).join('\n').trim();
    const wanted = branchIn.value.trim();
    if (!/^[a-z0-9][a-z0-9._/-]{0,89}$/.test(wanted) || wanted.includes('..') || wanted.endsWith('/')) { st.innerHTML = '<p class="rv-status err">Nom de branche invalide : minuscules, chiffres, - _ . / (ex. feat/export-pdf).</p>'; branchIn.focus(); return; }
    go.disabled = true; st.innerHTML = '<p class="rv-status"><span class="spin"></span>Démarrage…</p>';
    const started = await native.call('agent', 'publish', { project: p.id, worktree: wt, message, branch: wanted, author: await github.author() }, 30000);
    if (!started.ok) { st.innerHTML = `<p class="rv-status err">${esc(started.message ?? 'Échec.')}</p>`; go.disabled = false; return; }
    void refreshTrees(p).then(() => root ? paint(root, p) : undefined);
    const j = await follow(String(started.job));
    void refreshTrees(p).then(() => root ? paint(root, p) : undefined);
    if (!j) return;
    if (j.status === 'blocked') {
      st.insertAdjacentHTML('beforeend', `<div class="ag-prfail"><p class="err">L’agent n’a pas pu résoudre ces conflits : ${j.conflicts.map(f => `<code>${esc(f)}</code>`).join(', ')}.</p><p>Retire les marqueurs <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> dans VS Code, ou réponds à l’agent dans sa session, puis publie à nouveau.</p><div class="ag-prfail-act"><button class="btn" data-ag-open>${icon('code')}Ouvrir dans VS Code</button></div></div>`);
      st.querySelector<HTMLElement>('[data-ag-open]')!.onclick = async () => { const r = await native.call('project', 'open', { project: p.id, app: 'vscode', worktree: wt }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); };
      go.disabled = false; go.innerHTML = `${icon('upload')}Réessayer`; return;
    }
    if (j.status !== 'done') { go.disabled = false; return; }
    // Une branche par dépôt modifié (copies sœurs) ; une app Mac ancienne ne donne que celle du dépôt des agents.
    const pushed = (j.pushed?.length ? j.pushed : j.branch ? [{ repo: '', branch: j.branch }] : []).map(x => ({ repo: x.repo || repo || '', branch: x.branch }));
    // Rien n'a été poussé : le travail était déjà fusionné dans la branche principale.
    if (!pushed.length) { m.close(); toast(j.step); return; }
    const names = pushed.map(x => x.repo).filter(Boolean);
    if (!wantPR || !names.length) { m.close(); toast(`Branche ${pushed[0]!.branch} poussée${names.length > 1 ? ` dans ${names.join(', ')}` : ''}`); return; }
    st.insertAdjacentHTML('beforeend', `<p class="rv-status"><span class="spin"></span>Ouverture de ${names.length > 1 ? `${names.length} pull requests` : 'la pull request'}…</p>`);
    // Les PR de plusieurs dépôts se citent entre elles : elles se relisent et se fusionnent ensemble.
    const linked = (me: string) => names.length > 1 ? `\n\nVa avec : ${names.filter(n => n !== me).map(n => `${n}@${pushed.find(x => x.repo === n)?.branch ?? ''}`).join(', ')}` : '';
    const opened: { repo: string; number: number; url: string }[] = [], failed: string[] = [];
    let perm = !canPR;
    for (const { repo: r, branch } of pushed) {
      if (!r) continue;
      let base = 'main';
      const bodyFor = prBody(run, detail + linked(r));
      try {
        if (!canPR) throw new Error('GitHub n’est pas connecté dans Studio');
        base = (await github.project(r)).info.default_branch;
        const pr = await github.createPull(r, { head: branch, base, title: prTitle, body: bodyFor });
        opened.push({ repo: r, number: pr.number, url: pr.html_url });
      } catch (e) {
        const why = errMsg(e).replace(/\.$/, ''), status = e instanceof github.GitHubError ? e.status : 0;
        if (/already exists/i.test(why)) continue; // branche déjà proposée : sa PR vient d'être mise à jour
        // Le push vient de réussir (identifiants Git du Mac) : un 404 ici veut dire que le jeton de Studio ne voit pas ce dépôt.
        if (status === 403 || status === 404 || /not accessible/i.test(why)) perm = true;
        const text = status === 404 ? `Le dépôt ${r} existe (la branche vient d’y être poussée), mais ton jeton GitHub n’y a pas accès : un jeton à accès précis ne voit que les dépôts choisis à sa création. Ajoute ${r} dans « Repository access » du jeton sur GitHub (avec « Pull requests : lecture et écriture »), ou remplace-le dans Réglages → GitHub.`
          : status === 403 ? `Ton jeton GitHub voit ${r} mais n’a pas le droit d’y ouvrir une pull request (permission « Pull requests : lecture et écriture »).`
          : `La pull request de ${r} n’a pas pu être ouverte d’ici : ${why}.`;
        failed.push(`<p>${icon('check')}Branche <code>${esc(branch)}</code> poussée sur ${esc(r)}.</p><p class="err">${esc(text)}</p><div class="ag-prfail-act"><a class="btn btn-primary" href="${esc(compareURL(r, base, branch, prTitle, bodyFor))}" target="_blank" rel="noopener">${icon('github')}Ouvrir la PR de ${esc(r.split('/')[1] ?? r)} sur GitHub</a></div>`);
      }
    }
    if (!failed.length) {
      m.close();
      toast(opened.length ? opened.map(o => `PR #${o.number}${names.length > 1 ? ` (${o.repo.split('/')[1] ?? o.repo})` : ''}`).join(', ') + (opened.length > 1 ? ' ouvertes' : ' ouverte') : 'Branche poussée : sa pull request est à jour.');
      for (const o of opened) window.open(o.url, '_blank', 'noopener');
      return;
    }
    st.innerHTML = `<div class="ag-prfail">${opened.map(o => `<p>${icon('check')}<a href="${esc(o.url)}" target="_blank" rel="noopener">PR #${o.number}</a> ouverte sur ${esc(o.repo)}.</p>`).join('')}${failed.join('')}${perm ? '<div class="ag-prfail-act"><button class="btn" data-open-conn="github">Régler le jeton</button></div>' : ''}</div>`;
    go.hidden = true; need('[data-x]', m.node).textContent = 'Fermer';
  };
}

/** Copie déjà poussée : ouvre la page GitHub de création de sa PR, déjà remplie. */
async function openPR(p: Project, w: Worktree): Promise<void> {
  if (w.pr?.state === 'open') { window.open(w.pr.url, '_blank', 'noopener'); return; } // déjà ouverte : on y va
  const repo = await workRepo(p); if (!repo) { toast('Associe un dépôt GitHub au projet.'); return; }
  let base = 'main';
  try { if (github.connected()) base = (await github.project(repo)).info.default_branch; } catch { /* main par défaut */ }
  // Titre de la PR : celui du commit publié, à défaut le message de l'agent, à défaut le nom de la branche. Jamais la consigne.
  const run = runs.find(r => r.worktree === w.name);
  const t = w.subject || runs.filter(r => r.worktree === w.name && r.result).map(r => agentMessage(r.result)).find(Boolean) || subjectFromBranch(w.branch) || draftMessage(run?.prompt ?? '', []);
  window.open(compareURL(repo, base, w.branch, t, prBody(run, '')), '_blank', 'noopener');
}

// ---------- État des copies : le Mac (git) et GitHub (PR) ----------
/** Copies telles que le Mac les décrit ; `trees` y ajoute ce que GitHub sait des PR (`withPulls`). */
let rawTrees: Worktree[] = [];
/** Dernière PR de chaque branche du dépôt des agents, lue sur GitHub dès l'arrivée sur l'onglet : une fusion s'y voit
 *  tout de suite, sans attendre que le Mac relise le dépôt distant. */
let pulls = new Map<string, github.BranchPull>(), pullsFor = '';
/** Branches que GitHub dit fusionnées sans que le Mac le sache encore : on lui a déjà demandé de relire le dépôt distant. */
const freshAsked = new Set<string>();
/** Le Mac relit le dépôt distant en arrière-plan : on redemande l'état des copies au tour suivant. */
let treesSoon = false, treesBusy = false;
/** Dernier état connu des copies et des PR, par projet : affiché dès l'ouverture, avant la réponse du Mac. */
const TREES = 'studio.cc.trees';
const treeCache = ((): Record<string, { trees: Worktree[]; pulls: github.BranchPull[] }> => {
  try { const v = JSON.parse(localStorage.getItem(TREES) || '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, { trees: Worktree[]; pulls: github.BranchPull[] }> : {}; } catch { return {}; }
})();
function saveTrees(pid: string): void {
  delete treeCache[pid];
  treeCache[pid] = { trees: rawTrees, pulls: pid === pullsFor ? [...pulls.values()].filter(x => rawTrees.some(w => w.branch === x.branch || w.history?.some(h => h.branch === x.branch))) : [] };
  const keep = Object.fromEntries(Object.entries(treeCache).slice(-8));
  try { localStorage.setItem(TREES, JSON.stringify(keep)); } catch { /* stockage plein */ }
}
/** La PR de cette branche est fusionnée sur GitHub, et c'est bien ce que contient la copie (pas de commit local en plus). */
function ghMerged(w: Worktree): boolean {
  const pr = w.branch ? pulls.get(w.branch) : undefined;
  return pr?.state === 'merged' && (w.head ? pr.sha === w.head : w.changes === 0);
}
/** Copies du Mac complétées par GitHub (nouveaux objets : les réponses du Mac restent intactes). */
function withPulls(list: Worktree[]): Worktree[] {
  return list.map(w => {
    const merged = !!w.merged || (w.pushed && ghMerged(w));
    const history = w.history?.map(h => h.merged || pulls.get(h.branch)?.state !== 'merged' ? h : { ...h, merged: true });
    return { ...w, merged, ...(history ? { history } : {}), pr: w.branch ? pulls.get(w.branch) : undefined };
  });
}
function setTrees(pid: string, list: Worktree[]): void {
  rawTrees = list; treesFor = pid; trees = withPulls(list);
}
/** Montre tout de suite le dernier état connu d'un projet dont les copies n'ont pas encore été lues. */
function restoreTrees(pid: string): void {
  if (treesFor === pid) return;
  const c = treeCache[pid];
  pulls = new Map((c?.pulls ?? []).map(x => [x.branch, x])); pullsFor = c ? pid : '';
  treesRead = false; setTrees(pid, Array.isArray(c?.trees) ? c.trees : []);
}

async function refreshTrees(p: Project): Promise<void> {
  const fresh = rawTrees.some(w => w.pushed && !w.merged && ghMerged(w) && !freshAsked.has(w.branch));
  if (fresh) for (const w of rawTrees) if (ghMerged(w)) freshAsked.add(w.branch);
  const [r, j] = await Promise.all([bridge.call('agent', 'worktrees', { project: p.id, ...(fresh ? { fresh: true } : {}) }, 30000), bridge.call('agent', 'jobs', { project: p.id }, 10000)]);
  if (r.ok) { setTrees(p.id, r.worktrees as Worktree[]); saveTrees(p.id); } else if (treesFor !== p.id) setTrees(p.id, []);
  treesRead = r.ok; treesSoon = r.fetching === true;
  jobs = j.ok ? (j.jobs as Job[]) : [];
  notify(); // la barre latérale teinte chaque conversation selon l'état de sa copie
  // Copies dont la branche vient d'être fusionnée : elles repartent de la branche principale, on le dit une fois.
  for (const x of (r.recycled as { worktree: string; branch: string }[] | undefined) ?? []) toast(`${x.branch} est fusionnée : la copie repart de la branche principale, sur une nouvelle branche`);
}
/** Lit sur GitHub l'état des PR des branches des agents (une requête, revalidée par ETag). */
async function loadPulls(p: Project): Promise<void> {
  if (!github.active()) return;
  try {
    const repo = await workRepo(p); if (!repo) return;
    const got = await github.branchPulls(repo, { fresh: true });
    if (cur?.p.id !== p.id) return;
    pulls = got; pullsFor = p.id;
    if (treesFor === p.id) { trees = withPulls(rawTrees); saveTrees(p.id); }
    notify(); repaintList();
    // Une PR vient d'être fusionnée : le Mac relit le dépôt distant tout de suite pour remettre la copie à jour.
    if (rawTrees.some(w => w.pushed && !w.merged && ghMerged(w) && !freshAsked.has(w.branch))) void treesInBackground(p);
  } catch { /* hors ligne, jeton refusé : l'état vient du Mac seul */ }
}
/** Relit les copies sans bloquer l'affichage, puis redessine la liste. */
async function treesInBackground(p: Project): Promise<void> {
  if (treesBusy) return;
  treesBusy = true;
  try { await refreshTrees(p); } finally { treesBusy = false; }
  if (selected) calm = ''; // le fil montre l'étape de sa copie : relu au prochain tour
  repaintList();
}
/** Redessine la liste affichée (sauf si une lecture est en cours : elle la dessinera à sa fin). */
function repaintList(): void {
  if (!cur || painting || selected || !cur.box.isConnected) return;
  const zone = $('.ag-zone', cur.box), list = known.get(cur.p.id)?.list;
  if (zone && list && !$('.ag-zone > .hm-empty', cur.box)) paintIfChanged(zone, listHTML(list));
}

// ---------- Actions sur une copie (onglet Claude Code et Espace agents) ----------
/** Ce qu'on peut faire de la copie d'un agent : publier (commit, push, PR), mettre à jour, fusionner dans la mère… */
export const COPY_ACTS = new Set(['push', 'sync', 'pr', 'mergechild', 'newbranch', 'discard', 'review', 'vscode']);

/** Mène une action sur la copie `wt` du projet `p`, depuis n'importe quelle vue ; `box` : onglet Claude Code à redessiner.
 *  Rend `true` quand l'état de la copie a changé (à relire), `false` si rien n'a été fait ou si l'action suit seule son cours. */
export async function copyAct(p: Project, act: string, wt: string, box: HTMLElement | null = null): Promise<boolean> {
  // Appel venu d'une autre vue : l'état des copies et des agents est celui d'un autre projet, ou trop ancien.
  if (treesFor !== p.id || !box) { restoreTrees(p.id); await refreshTrees(p); }
  if (cur?.p.id !== p.id) { const l = await bridge.call('agent', 'list', { project: p.id }, 10000); if (l.ok) runs = l.runs as AgentRun[]; }
  if (act === 'review') { await review.review(p, 'working', wt); return false; }
  if (act === 'vscode') { const r = await native.call('project', 'open', { project: p.id, app: 'vscode', worktree: wt }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); return false; }
  if (act === 'push') { await publish(p, wt, box); return false; }
  if (act === 'pr') { const w = trees.find(x => x.name === wt); if (w) await openPR(p, w); else toast('Copie introuvable.'); return false; }
  if (act === 'sync') {
    const r = await native.call('agent', 'sync', { project: p.id, worktree: wt, author: await github.author() }, 30000);
    toast(r.ok ? 'Mise à jour de la copie lancée' : r.message ?? 'Impossible.');
    return true;
  }
  if (act === 'mergechild') {
    const g = groupOfCopy(wt);
    const r = await native.call('agent', 'mergechild', { project: p.id, worktree: wt }, 120000);
    if (r.ok) keepMerged(wt);
    toast(r.ok ? String(r.message ?? `Agent ${g?.slot ?? ''} fusionné dans la branche mère`) : r.message === 'Action inconnue.' ? 'Mets à jour l’app Studio pour Mac.' : r.message ?? 'Fusion impossible.');
    return true;
  }
  if (act === 'newbranch') {
    const w = trees.find(x => x.name === wt);
    if (!await confirmBox({ title: 'Repartir sur une nouvelle branche ?', text: `${w?.branch ? `La branche ${w.branch} reste poussée avec sa PR. ` : ''}La copie repart de la dernière version de la branche principale : la discussion avec l’agent continue, et son prochain travail sera publié sur une nouvelle branche.`, ok: 'Nouvelle branche' })) return false;
    const r = await native.call('agent', 'newbranch', { project: p.id, worktree: wt }, 60000);
    toast(r.ok ? `Nouvelle branche : ${String(r.branch)}` : r.message === 'Action inconnue.' ? 'Mets à jour l’app Studio pour Mac.' : r.message ?? 'Impossible.');
    return true;
  }
  if (act === 'discard') {
    if (!await confirmBox({ title: 'Supprimer cette copie ?', text: `${runs.some(r => live(r) && r.worktree === wt) ? 'L’agent qui y travaille sera arrêté. ' : ''}Les changements non publiés de l’agent seront perdus. Une branche déjà poussée sur GitHub reste en place.`, ok: 'Supprimer', danger: true })) return false;
    for (const r of runs.filter(x => live(x) && x.worktree === wt)) await bridge.call('agent', 'stop', { run: r.run }, 10000);
    const r = await native.call('agent', 'discard', { project: p.id, worktree: wt }, 30000);
    toast(r.ok ? 'Copie supprimée' : r.message ?? 'Impossible.');
    return true;
  }
  return false;
}

/** Bandeau de la copie d'un agent pour l'Espace agents : son étape, sa branche, et les gestes possibles
 *  (boutons `data-aw-copy`, menés par `copyAct`). `working` : l'agent travaille dans cette copie. */
export function copyStrip(w: Worktree, working: boolean): string {
  const st = stageOf(w, working), g = groupOfCopy(w.name), mac = bridge.local();
  const btn = (act: string, ic: string, label: string, title: string, wt = w.name, primary = false) =>
    `<button type="button" class="btn${primary ? ' btn-primary' : ''}" data-aw-copy="${act}" data-wt="${esc(wt)}" title="${esc(title)}"${working && act !== 'review' && act !== 'vscode' && act !== 'pr' ? ' disabled' : ''}>${icon(ic)}<span>${esc(label)}</span></button>`;
  const fresh = hasWork(w) || (w.sisters ?? []).some(hasWork), pending = w.pushed && !w.merged;
  const inMother = !!g && mergedKids.has(w.name) && !w.changes;
  const acts = !mac ? '<em class="ag-onmac">sur le Mac</em>' : [
    g ? (inMother ? btn('push', 'upload', 'Publier le groupe', 'Publier la branche mère du groupe : commit, push et pull request', g.group, true)
      : btn('mergechild', 'pr', 'Fusionner dans la mère', 'Commiter le travail de cet agent et le fusionner dans la branche mère du groupe', w.name, fresh)) : '',
    !g && fresh ? btn('push', 'upload', pending ? 'Republier' : 'Publier', 'Commit, push et pull request (Studio remet d’abord la copie à jour ; l’agent résout les conflits)', w.name, true) : '',
    !g && (pending || w.pr) ? btn('pr', 'pr', w.pr?.state === 'open' ? `PR #${w.pr.number}` : 'PR', 'Ouvrir la pull request de cette branche') : '',
    w.behind && (w.changes > 0 || pending) ? btn('sync', 'refresh', 'Mettre à jour', 'Remettre la copie sur la dernière version de la branche principale ; l’agent résout les conflits') : '',
    btn('review', 'sparkle', 'Revue', 'Relecture des changements par l’IA'),
    btn('vscode', 'code', 'VS Code', 'Ouvrir la copie dans VS Code'),
    `<button type="button" class="icon-btn" data-aw-copy="more" data-wt="${esc(w.name)}" title="Plus d’actions" aria-label="Plus d’actions sur la copie">${icon('more')}</button>`,
  ].join('');
  const what = w.conflicts?.length ? `<span class="err">conflits : ${esc(w.conflicts.join(', '))}</span>`
    : w.changes ? `${w.changes} fichier${w.changes > 1 ? 's' : ''} modifié${w.changes > 1 ? 's' : ''}` : w.ahead && !w.merged ? `${w.ahead} commit${w.ahead > 1 ? 's' : ''}` : '';
  return `<div class="aw-copy st-${st}" style="${stageVar(st)}">${stageBadge(st)}${w.branch && !w.branch.startsWith('worktree-') ? `<code title="Branche">${esc(w.branch)}</code>` : g ? `<code title="Groupe ${esc(g.group)}">agent ${g.slot}</code>` : ''}${what ? `<em>${what}</em>` : ''}<span class="aw-copy-act">${acts}</span></div>`;
}

// ---------- Montage ----------
let folderPath: string | null = null, remote = '';
/** Un seul rafraîchissement à la fois : si le Mac répond lentement, les requêtes ne s'empilent plus toutes les 3 secondes. */
let painting = false, again = false;
async function paint(box: HTMLElement, p: Project): Promise<void> {
  if (painting) return;
  painting = true;
  try { await paintOnce(box, p); } finally { painting = false; }
  // On a changé de conversation pendant la lecture : on redessine tout de suite, sans attendre le prochain tour.
  if (again) { again = false; void paint(box, p); }
}
async function paintOnce(box: HTMLElement, p: Project): Promise<void> {
  const zone = $('.ag-zone', box); if (!zone || !box.isConnected) { clearInterval(timer); return; }
  void loadLimits(); paintLimits(); // le bandeau de l'abonnement suit son propre rythme (une lecture par minute)
  // Liste : la lecture des journaux (la plus lente) part en même temps que celle des agents, et la liste gardée de la
  // dernière fois s'affiche tout de suite.
  const listing = selected ? null : loadList(p);
  const cached = known.get(p.id);
  if (!selected && cached?.list.length && $('.ag-zone > .hm-empty', box)) paintIfChanged(zone, listHTML(cached.list));
  const wasLive = new Set(runs.filter(live).map(r => r.run));
  const l = await bridge.call('agent', 'list', { project: p.id }, 10000); runs = l.ok ? (l.runs as AgentRun[]) : runs;
  if (l.ok) queued = (l.queued as Queued[] | undefined) ?? [];
  // Fin d'une discussion avec un agent : l'état de sa copie (poussée, fusionnée…) est relu tout de suite.
  const ended = runs.some(r => wasLive.has(r.run) && !live(r));
  // Relue sans être attendue (git status, fusions… sur chaque copie) : la liste ne l'attend plus pour s'afficher.
  if (tick % 4 === 0 || ended || treesSoon || (tick % 2 === 0 && jobs.some(j => j.status === 'running'))) void treesInBackground(p);
  if (tick > 0 && tick % 10 === 0) void loadPulls(p); // les PR, toutes les 30 s (304 de GitHub si rien n'a bougé)
  tick++;
  const sel = selected, sb = sub;
  if (sel) {
    syncStop(box);
    // La liste sert encore à la barre latérale : on la relit de temps en temps, sans attendre.
    if (!known.get(p.id)?.at || tick % 5 === 0) void loadList(p);
    // Fil au repos (plus rien ne s'y écrit, aucun agent n'y travaille) : relu une fois sur quatre seulement.
    const feedId = sb ? `${sel}/${sb}` : sel;
    if (calm === feedId && tick % 4 !== 0 && !runs.some(r => r.session === sel && live(r)) && $('.ss-feed', zone)?.dataset.id === feedId) return;
    if (sb) {
      // Fil d'un sous-agent de la conversation.
      const a = await bridge.call('project', 'subagent', { project: p.id, session: sel, agent: sb }, 20000);
      if (!box.isConnected || sel !== selected || sb !== sub) return;
      if (!a.ok || !a.agent) { zone.innerHTML = `<p class="hm-empty">${esc(a.message === 'Action inconnue.' || a.message === 'Action non autorisée à distance.' ? 'Mets à jour l’app Studio pour Mac pour lire les fils des sous-agents.' : a.message ?? 'Sous-agent introuvable.')}</p>`; return; }
      noteSubs(sel, a.subagents);
      showDetail(zone, { ...(a as unknown as Partial<Session> & { actions?: Action[] }), id: sel }, folderPath, a.agent as SubAgent);
      calm = (a.agent as SubAgent).live ? '' : feedId;
      return;
    }
    const d = await bridge.call('project', 'session', { project: p.id, session: sel }, 20000);
    if (!box.isConnected || sel !== selected || sb !== sub) return; // on a changé de conversation entre-temps
    if (!d.ok) {
      // Agent sur un serveur : on suit les étapes reçues de son flux.
      const r = runs.find(x => x.session === selected);
      if (r) {
        const rd = await bridge.call('agent', 'run', { run: r.run }, 10000);
        if (sel !== selected) return;
        if (rd.ok && box.isConnected) { showDetail(zone, { id: selected, title: r.prompt, worktree: r.worktree, branch: r.host ? `sur ${r.host}` : '', started: r.started, updated: r.finished || new Date(Math.floor(Date.now() / 6e4) * 6e4).toISOString(), live: live(r), actions: (rd.actions as Action[]) ?? [] }, folderPath); return; }
      }
      zone.innerHTML = `<p class="hm-empty">${esc(d.message ?? 'Session introuvable.')}</p>`; return;
    }
    noteSubs(sel, d.subagents);
    showDetail(zone, { ...(d as unknown as Partial<Session> & { actions?: Action[] }), id: selected }, folderPath); // « id » de la réponse = numéro de demande
    // Un sous-agent peut travailler longtemps sans que le journal de la conversation bouge : elle n'est alors pas au repos.
    calm = d.live || queued.some(q => q.session === sel) || (subsOf.get(sel) ?? []).some(x => x.live) ? '' : feedId;
    return;
  }
  const list = await (listing ?? loadList(p)) ?? cached?.list ?? [];
  if (!box.isConnected || selected) return;
  paintLimits();
  paintIfChanged(zone, listHTML(list)); // relue toutes les 3 s : réécrite seulement si elle change
  // Les conversations récentes sans nom en reçoivent un, une à la fois.
  const unnamed = list.slice(0, 8).find(s => wantsName(s, s.live || runs.some(r => r.session === s.id && live(r))));
  if (unnamed) void nameSession(p, unnamed);
}

function shell(box: HTMLElement, p: Project): void {
  const selRun = selected ? runs.find(r => r.session === selected) : undefined;
  box.innerHTML = (remote ? `<p class="ag-remote">${icon('devices')}Piloté à distance sur <strong>${esc(remote)}</strong> · relecture et publication depuis le Mac</p>` : '') + (selected && sub
    // Fil d'un sous-agent : en lecture seule (on répond à Claude dans la conversation, pas à ses sous-agents).
    ? `<button class="lv-back" data-sa="">${icon('back')}${esc(current(p.id)?.title ?? 'Conversation')}</button><div class="ag-zone"><p class="hm-empty">Chargement…</p></div>`
    : selected
    ? `<button class="lv-back" data-ss="">${icon('back')}Toutes les sessions</button><div class="ag-zone"><p class="hm-empty">Chargement…</p></div>${composerHTML(p, { session: selected, machine: selRun?.machine === 'server' ? 'server' : '' })}`
    : `${composerHTML(p)}<div class="ag-zone"><p class="hm-empty">Chargement…</p></div>`);
}

/** Ouvre une conversation dans l'onglet affiché (`null` : retour à la liste). */
export function open(id: string | null): void {
  selected = id; selTitle = ''; sub = null; subTitle = ''; calm = '';
  closeSubs(id);
  if (cur?.box.isConnected) { selFor = cur.p.id; shell(cur.box, cur.p); again = painting; void paint(cur.box, cur.p); }
  notify();
}
/** Ouvre le fil d'un sous-agent de la conversation affichée (`null` : retour à la conversation). */
export function openSub(agent: string | null): void {
  if (!selected) return;
  sub = agent; subTitle = ''; calm = '';
  if (cur?.box.isConnected) { shell(cur.box, cur.p); again = painting; void paint(cur.box, cur.p); }
  notify();
}

/** Conversation au repos : ni session active, ni agent de Studio qui y travaille. */
const idle = (s: Session): boolean => !s.live && !runs.some(r => r.session === s.id && live(r));

/** Supprime une conversation sur le Mac (journal à la corbeille) et l'oublie dans Studio. Renvoie '' si c'est fait, sinon la raison de l'échec. */
async function dropSession(p: Project, id: string): Promise<string> {
  const r = await native.call('project', 'deleteSession', { project: p.id, session: id }, 20000);
  if (!r.ok) return r.message === 'Action inconnue.' ? 'Mets à jour l’app Studio pour Mac pour supprimer une conversation.' : r.message ?? 'Suppression impossible.';
  delete titles[id]; saveTitles();
  saved.dropDraft(`${p.id}|s:${id}`); saved.forgetSession(id);
  if (pins.some(x => x.s === id)) { pins = pins.filter(x => x.s !== id); savePins(); }
  subsOf.delete(id); nameFailed.delete(id);
  const k = known.get(p.id); if (k) { k.list = k.list.filter(s => s.id !== id); saveKnown(); }
  runs = runs.filter(x => x.session !== id || live(x));
  return '';
}

/** Supprime une conversation (ouverte, ou choisie dans la liste) : son agent est arrêté s'il tourne, son journal part dans la corbeille du Mac. */
async function removeSession(p: Project, id: string): Promise<void> {
  const busy = runs.filter(r => r.session === id && live(r));
  const s = known.get(p.id)?.list.find(x => x.id === id), name = id === selected && selTitle ? selTitle : s ? nameOf(s) : '';
  if (!await confirmBox({ title: 'Supprimer cette conversation ?', text: `${busy.length ? 'L’agent qui y travaille sera arrêté. ' : ''}${name ? `« ${name} » disparaît` : 'Elle disparaît'} de Studio et son journal part dans la corbeille du Mac. La copie du dépôt et ses changements ne sont pas touchés.`, ok: 'Supprimer', danger: true })) return;
  for (const r of busy) await bridge.call('agent', 'stop', { run: r.run }, 10000);
  if (busy.length) await new Promise(r => setTimeout(r, 1500)); // le temps que Claude Code rende la main
  const err = await dropSession(p, id);
  if (err) { toast(err); return; }
  toast('Conversation supprimée');
  if (selected === id) open(null);
  else { notify(); if (cur?.box.isConnected) void paint(cur.box, cur.p); }
}

/** Nom choisi à la main : il n'est plus jamais remplacé par le nommage automatique (`n` hors d'atteinte, voir `wantsName`). */
function renameSession(id: string, now: string): void {
  const m = modal({ title: 'Renommer la conversation', html: `<form class="ss-rename">
    <input class="field" name="t" value="${esc(now)}" maxlength="80" spellcheck="false" autocomplete="off" autofocus required>
    <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Renommer</button></div></form>` });
  const f = need<HTMLFormElement>('form', m.body), input = need<HTMLInputElement>('input', f);
  input.select();
  need('[data-x]', f).addEventListener('click', () => m.close());
  f.addEventListener('submit', e => {
    e.preventDefault();
    const t = input.value.replace(/\s+/g, ' ').trim();
    if (!t) return;
    delete titles[id]; titles[id] = { t, n: 1e9 }; saveTitles();
    if (id === selected) selTitle = t;
    m.close(); notify();
  });
}

/** Menu d'une conversation, ou d'un de ses sous-agents, dans la barre latérale (« … » au survol ou clic droit).
 *  `go` fait la même chose qu'un clic sur la ligne. */
export function sideMenu(anchor: Element | { x: number; y: number }, p: Project, id: string, agent: string, go: () => void): void {
  if (agent) {
    menu(anchor, [
      { label: 'Ouvrir le fil', icon: 'eye', run: go },
      { label: 'Retirer de la barre latérale', icon: 'pin', run: () => togglePin(p.id, id, agent) },
    ]);
    return;
  }
  const s = known.get(p.id)?.list.find(x => x.id === id), name = id === selected && selTitle ? selTitle : s ? nameOf(s) : 'Conversation';
  const busy = runs.filter(r => r.session === id && live(r)), wt = s?.worktree || busy.find(r => r.worktree)?.worktree || '';
  const copy = (act: string) => () => void copyAct(p, act, wt).then(() => { if (cur?.box.isConnected) void paint(cur.box, cur.p); });
  menu(anchor, [
    { label: 'Ouvrir', icon: 'eye', run: go },
    { label: 'Renommer…', icon: 'pencil', run: () => renameSession(id, name) },
    { label: 'Copier l’identifiant', icon: 'copy', hint: 'claude --resume', run: () => navigator.clipboard.writeText(id).then(() => toast('Identifiant copié'), () => toast('Copie impossible.')) },
    ...(busy.length ? ['-' as const, { label: 'Arrêter l’agent', icon: 'stop', run: async () => { for (const r of busy) await bridge.call('agent', 'stop', { run: r.run }, 10000); toast('Agent arrêté'); } }] : []),
    ...(wt && !remote ? ['-' as const, { label: 'Copie de l’agent' },
      { label: 'Publier', icon: 'upload', hint: 'branche + pull request', run: copy('push') },
      { label: 'Mettre à jour', icon: 'refresh', hint: 'depuis la branche principale', run: copy('sync') },
      { label: 'Relire les changements', icon: 'eye', run: copy('review') },
      { label: 'Ouvrir dans VS Code', icon: 'code', run: copy('vscode') },
      { label: 'Supprimer la copie', icon: 'trash', danger: true, run: copy('discard') }] : []),
    ...(remote ? [] : ['-' as const, { label: 'Supprimer la conversation', icon: 'trash', danger: true, run: () => removeSession(p, id) }]),
  ]);
}

/** Ménage : choisir d'un coup les conversations au repos à supprimer (celles qui travaillent ne sont pas proposées). */
function cleanUp(p: Project): void {
  const list = (known.get(p.id)?.list ?? []).filter(idle);
  if (!list.length) { toast('Aucune conversation terminée à supprimer.'); return; }
  const week = Date.now() - 7 * 864e5;
  const m = modal({ title: 'Faire le ménage', cls: 'ss-clean', html: `
    <p class="modal-text">Coche les conversations à supprimer. Celles où un agent travaille encore ne sont pas proposées.</p>
    <div class="ss-pick-bar"><button type="button" class="link-btn" data-pick="all">Tout cocher</button><button type="button" class="link-btn" data-pick="old">Plus de 7 jours</button><button type="button" class="link-btn" data-pick="none">Tout décocher</button></div>
    <div class="ss-picks">${list.map(s => `<label class="ss-pick"><input type="checkbox" value="${esc(s.id)}"${ms(s.updated) < week ? ' data-old' : ''}><span>${esc(nameOf(s))}</span><time>${esc(rel(ms(s.updated)))}</time></label>`).join('')}</div>
    <p class="modal-hint">${icon('shield')}Leurs journaux partent dans la corbeille du Mac. Les copies du dépôt et leurs changements ne sont pas touchés.</p>
    <div class="rv-status"></div>
    <div class="modal-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-danger" data-go disabled>Supprimer</button></div>` });
  const boxes = Array.from(m.node.querySelectorAll<HTMLInputElement>('.ss-pick input')), go = need<HTMLButtonElement>('[data-go]', m.node), st = need('.rv-status', m.node);
  const picked = () => boxes.filter(b => b.checked).map(b => b.value);
  let working = false;
  const sync = () => { const n = picked().length; go.disabled = working || !n; go.textContent = n ? `Supprimer (${n})` : 'Supprimer'; };
  m.node.addEventListener('change', sync);
  m.node.querySelectorAll<HTMLElement>('[data-pick]').forEach(b => { b.onclick = () => {
    if (working) return;
    const how = b.dataset.pick;
    for (const x of boxes) x.checked = how === 'all' || (how === 'old' && x.dataset.old !== undefined);
    sync();
  }; });
  need('[data-x]', m.node).onclick = m.close;
  go.onclick = async () => {
    const ids = picked(); if (!ids.length || working) return;
    working = true; sync(); boxes.forEach(b => { b.disabled = true; });
    let done = 0, why = '';
    for (const id of ids) {
      st.innerHTML = `<span class="spin"></span>Suppression ${done + 1} sur ${ids.length}…`;
      const err = await dropSession(p, id);
      if (err) { why = err; if (/Mets à jour/.test(err)) break; continue; }
      done++;
      m.node.querySelector(`.ss-pick input[value="${id}"]`)?.closest('.ss-pick')?.remove();
    }
    const failed = ids.length - done;
    notify(); if (cur?.box.isConnected) void paint(cur.box, cur.p);
    if (done) toast(`${done} conversation${done > 1 ? 's' : ''} supprimée${done > 1 ? 's' : ''}${failed ? ` · ${failed} en échec` : ''}`);
    if (!failed) { m.close(); return; }
    // Ce qui n'a pas pu être supprimé reste coché, avec la raison.
    working = false;
    for (const b of boxes) b.disabled = false;
    st.innerHTML = `<span class="err">${esc(why)}</span>`;
    sync();
  };
}

/** Copie qu'on peut supprimer sans interrompre personne : aucun agent ni aucune publication n'y travaille. */
const treeIdle = (w: Worktree): boolean => !runs.some(r => r.worktree === w.name && live(r)) && !jobs.some(j => j.worktree === w.name && j.status === 'running');

/** Ménage des copies : en choisir plusieurs d'un coup (fusionnées et sans changement d'abord), et au besoin leurs conversations. */
function cleanTrees(p: Project): void {
  const list = trees.filter(treeIdle);
  if (!list.length) { toast('Aucune copie au repos à supprimer.'); return; }
  const sessions = known.get(p.id)?.list ?? [];
  const order = (w: Worktree) => STAGE_ORDER.indexOf(stageOf(w));
  const rows = [...list].sort((a, b) => order(b) - order(a)).map(w => {
    const st = stageOf(w), risky = w.changes > 0 || (w.ahead > 0 && !w.merged && !w.pushed);
    return `<label class="ss-pick"><input type="checkbox" value="${esc(w.name)}" data-st="${st}"${risky ? ' data-risky' : ''}><span>${esc(treeTitle(w, sessions))}${risky ? ' <em class="err">· travail non publié</em>' : ''}</span>${stageBadge(st)}</label>`;
  }).join('');
  const m = modal({ title: 'Faire le ménage dans les copies', cls: 'ss-clean', html: `
    <p class="modal-text">Coche les copies à supprimer. Celles où un agent ou une publication travaille encore ne sont pas proposées.</p>
    <div class="ss-pick-bar"><button type="button" class="link-btn" data-pick="done">Fusionnées et sans changement</button><button type="button" class="link-btn" data-pick="all">Tout cocher</button><button type="button" class="link-btn" data-pick="none">Tout décocher</button></div>
    <div class="ss-picks">${rows}</div>
    <label class="ss-pick"><input type="checkbox" data-with-sessions><span>Supprimer aussi leurs conversations (journaux à la corbeille du Mac)</span></label>
    <p class="modal-hint">${icon('shield')}Les changements non publiés des copies cochées sont perdus. Les branches déjà poussées sur GitHub restent en place.</p>
    <div class="rv-status"></div>
    <div class="modal-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-danger" data-go disabled>Supprimer</button></div>` });
  const boxes = Array.from(m.node.querySelectorAll<HTMLInputElement>('.ss-picks input')), go = need<HTMLButtonElement>('[data-go]', m.node), st = need('.rv-status', m.node);
  const withSessions = need<HTMLInputElement>('[data-with-sessions]', m.node);
  const picked = () => boxes.filter(b => b.checked && b.isConnected).map(b => b.value);
  let working = false;
  const sync = () => {
    const ids = picked(), risky = boxes.some(b => b.checked && b.dataset.risky !== undefined);
    go.disabled = working || !ids.length;
    go.textContent = ids.length ? `Supprimer (${ids.length})` : 'Supprimer';
    if (!working) st.innerHTML = risky ? `<span class="err">Certaines copies cochées ont du travail non publié : il sera perdu.</span>` : '';
  };
  m.node.addEventListener('change', sync);
  m.node.querySelectorAll<HTMLElement>('[data-pick]').forEach(b => { b.onclick = () => {
    if (working) return;
    const how = b.dataset.pick;
    for (const x of boxes) x.checked = how === 'all' || (how === 'done' && (x.dataset.st === 'merged' || x.dataset.st === 'idle'));
    sync();
  }; });
  need('[data-x]', m.node).onclick = m.close;
  go.onclick = async () => {
    const names = picked(); if (!names.length || working) return;
    working = true; sync(); boxes.forEach(b => { b.disabled = true; }); withSessions.disabled = true;
    let done = 0, why = '';
    for (const name of names) {
      st.innerHTML = `<span class="spin"></span>Suppression ${done + 1} sur ${names.length}…`;
      const r = await native.call('agent', 'discard', { project: p.id, worktree: name }, 30000);
      if (!r.ok) { why = r.message ?? 'Suppression impossible.'; continue; }
      if (withSessions.checked) for (const s of sessions.filter(x => x.worktree === name && idle(x))) { const err = await dropSession(p, s.id); if (err) why = err; }
      if (selected && sessions.some(s => s.id === selected && s.worktree === name)) { selected = null; sub = null; }
      done++;
      m.node.querySelector(`.ss-picks input[value="${name}"]`)?.closest('.ss-pick')?.remove();
    }
    const failed = names.length - done;
    await refreshTrees(p);
    notify(); if (cur?.box.isConnected) { if (!selected) shell(cur.box, cur.p); void paint(cur.box, cur.p); }
    if (done) toast(`${done} copie${done > 1 ? 's' : ''} supprimée${done > 1 ? 's' : ''}${failed ? ` · ${failed} en échec` : ''}`);
    if (!failed && !why) { m.close(); return; }
    working = false;
    for (const b of boxes) b.disabled = false;
    withSessions.disabled = false;
    st.innerHTML = `<span class="err">${esc(why)}</span>`;
    go.disabled = !picked().length;
  };
}

/** Dessine l'onglet et le garde à jour toutes les 3 secondes tant qu'il est affiché. */
export function mount(box: HTMLElement, p: Project, folder: string | null): void {
  clearInterval(timer); folderPath = folder; tick = 0;
  // La conversation sélectionnée appartient à un projet : on ne la garde pas en changeant de projet.
  if (selFor !== p.id) { selected = null; selTitle = ''; sub = null; subTitle = ''; }
  calm = ''; closeSubs(selected);
  selFor = p.id; cur = { box, p };
  const at = bridge.where();
  if (!at) { box.innerHTML = `<div class="ag-empty">${icon('terminal')}<h3>Claude Code tourne sur ton Mac</h3><p>Ouvre ce projet dans l’app Studio pour Mac. Pour le piloter d’ici, lie cet appareil au Mac (Réglages → Appareils) et autorise-le, sur le Mac, à piloter Claude Code.</p></div>`; return; }
  remote = at.kind === 'remote' ? at.name : '';
  if (remote && !folder) { void bridge.call('project', 'info', { project: p.id }, 15000).then(r => mount(box, p, typeof r.path === 'string' ? r.path : '')); box.innerHTML = '<p class="hm-empty">Connexion au Mac…</p>'; return; }
  if (!folder) { box.innerHTML = `<div class="ag-empty">${icon('folder')}<h3>Choisis le dossier mère du projet</h3><p>Claude Code travaille dans les dépôts du projet sur ce Mac, toujours dans une copie isolée quand il modifie quelque chose. Ils sont rangés dans le dossier mère ; ceux qui manquent s’y clonent depuis l’onglet Code.</p><button class="btn btn-primary" data-pj="home">Choisir le dossier mère</button></div>`; return; }
  // État des copies : le dernier connu s'affiche aussitôt ; GitHub dit tout de suite quelles PR sont fusionnées.
  restoreTrees(p.id); treesSoon = false;
  shell(box, p);
  void loadPulls(p);
  bindComposer(box, p, r => { open(r.session || selected); });
  box.onclick = async e => {
    const t = e.target as HTMLElement;
    const sa = t.closest<HTMLElement>('[data-sa]');
    if (sa) { if ((sa.dataset.sa || null) !== sub) openSub(sa.dataset.sa || null); return; }
    const row = t.closest<HTMLElement>('[data-ss]');
    if (row) { open(row.dataset.ss || null); return; }
    const b = t.closest<HTMLElement>('[data-ag]'); if (!b) return;
    calm = ''; // une action de l'utilisateur : le fil est relu tout de suite
    const wt = b.dataset.wt ?? '';
    if (b.dataset.ag === 'pin-sub') { if (selected && sub) { togglePin(p.id, selected, sub); again = painting; void paint(box, p); } return; }
    if (b.dataset.ag === 'end') { const f = $('.ss-feed', box); f?.scrollTo({ top: f.scrollHeight, behavior: 'smooth' }); b.hidden = true; return; }
    if (b.dataset.ag === 'copy') {
      const text = b.closest('.ss-msg')?.querySelector<HTMLElement>('.md')?.innerText ?? '';
      try { await navigator.clipboard.writeText(text); toast('Réponse copiée'); } catch { toast('Copie impossible.'); }
      return;
    }
    if (b.dataset.ag === 'stop') { const r = await bridge.call('agent', 'stop', { run: b.dataset.run }, 10000); toast(r.ok ? 'Agent arrêté' : r.message ?? 'Impossible.'); void paint(box, p); }
    if (b.dataset.ag === 'unqueue') {
      const r = await bridge.call('agent', 'unqueue', { project: p.id, queued: b.dataset.q }, 10000);
      if (!r.ok) toast(r.message ?? 'Impossible.');
      else queued = queued.filter(q => q.id !== b.dataset.q);
      void paint(box, p); return;
    }
    if (b.dataset.ag === 'flush' && selected) {
      // Reprise sans nouveau texte : le Mac joint tous les messages en attente de la discussion.
      const run = runs.find(r => r.session === selected);
      b.setAttribute('disabled', '');
      const r = await bridge.call('agent', 'start', { project: p.id, session: selected, prompt: '', repos: p.stack, ...(run?.machine === 'server' ? { machine: 'server' } : {}) }, 60000);
      toast(r.ok ? 'Messages transmis à Claude' : r.message ?? 'Envoi impossible.');
      void paint(box, p); return;
    }
    if (b.dataset.ag === 'delete') { const sid = b.dataset.session || selected; if (sid) await removeSession(p, sid); return; }
    if (b.dataset.ag === 'clean') { cleanUp(p); return; }
    if (b.dataset.ag === 'clean-trees') { cleanTrees(p); return; }
    if (b.dataset.ag === 'hide-run' || b.dataset.ag === 'hide-runs') {
      hideRuns(b.dataset.ag === 'hide-run' ? [b.dataset.run ?? ''].filter(Boolean) : runs.filter(r => !live(r)).map(r => r.run));
      again = painting; void paint(box, p); return;
    }
    if (COPY_ACTS.has(b.dataset.ag ?? '')) {
      if (b.dataset.ag === 'mergechild') (b as HTMLButtonElement).disabled = true;
      const changed = await copyAct(p, b.dataset.ag ?? '', wt, box);
      if (!changed) return;
      await refreshTrees(p);
      // Copie bien supprimée : on quitte sa conversation (un échec laisse tout en place).
      if (b.dataset.ag === 'discard' && selected && !trees.some(x => x.name === wt)) { selected = null; sub = null; shell(box, p); }
      void paint(box, p);
    }
  };
  void paint(box, p);
  timer = setInterval(() => { if (!document.hidden) void paint(box, p); }, 3000);
}
export const stop = (): void => { clearInterval(timer); cur = null; calm = ''; };
/** Choisit la conversation à afficher à la prochaine ouverture de l'onglet Claude Code du projet. */
export const select = (id: string | null, pid: string, agent: string | null = null): void => { selected = id; selFor = pid; selTitle = ''; sub = id ? agent : null; subTitle = ''; calm = ''; closeSubs(id); notify(); };
