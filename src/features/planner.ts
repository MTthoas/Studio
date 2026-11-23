// Planification : une file d'attente de consignes pour les agents Claude Code (pas les automatisations de Studio).
// Une consigne part (a) à une date et une heure, (b) de façon récurrente (« jours ouvrés 18h »), (c) à la réouverture de la
// fenêtre de 5 h de l'abonnement, ou (d) tout de suite s'il reste du quota, sinon dès la réouverture. Règle de réserve :
// en journée, une consigne planifiée ne part pas si elle entamerait la part de la fenêtre qu'on s'est gardée.
// Tout tourne sur CE Mac, tant que Studio est ouvert (minuteur de `init`), et se range par appareil dans localStorage.
// Garde-fous : le job est marqué AVANT l'appel au pont (jamais deux lancements pour un même créneau), au plus N agents par
// passe, un lancement après l'autre, aucun réessai en boucle, aucun rattrapage d'un créneau récurrent manqué. Le store est
// relu depuis localStorage avant chaque passe et avant chaque marquage : deux fenêtres ne lancent jamais le même créneau.
import * as bridge from '../integrations/remote.ts';
import * as quota from '../integrations/quota.ts';
import { lastSlot } from '../integrations/ai.ts';
import * as projects from './projects/model.ts';
import { startAgent } from './workspace.ts';
import { esc } from '../lib/markdown.ts';
import { $, icon, modal, need, toast, target, paintIfChanged, menu, confirmBox } from '../ui/kit.ts';
import type { Project } from './projects/model.ts';

export type When = { type: 'now' } | { type: 'window' } | { type: 'at'; at: number } | { type: 'cron'; spec: string };
export interface Job {
  id: string; project: string; prompt: string; mode: 'edit' | 'read'; when: When;
  /** attente = dans la file (ou récurrent actif) ; lancé = parti ; échec = le pont a refusé (voir `error`). */
  state: 'attente' | 'lancé' | 'échec';
  /** Interrupteur : en pause, un job récurrent ne rattrape rien. */
  enabled: boolean;
  created: number;
  /** Dernière exécution (ms), conversation et message d'échec éventuels. */
  last?: number; session?: string; run?: string; error?: string;
  /** Récurrent : dernier créneau consommé, et date de création/reprise (rien avant n'est rattrapé). */
  lastSlot?: number; seen?: number;
  /** « À la réouverture » alors que la fenêtre est ouverte : attend la fin de la fenêtre en cours (ms). */
  after?: number;
}
export interface Rules { reserve: boolean; pct: number; from: number; to: number; perPass: number }
export interface NewJob { project: string; prompt: string; mode?: 'edit' | 'read'; when?: When }
interface Store { jobs: Job[]; rules: Rules }

const KEY = 'studio.planner', PASS = 60e3, FIRST = 8e3, DONE_MAX = 20, MIN_GAP = 15 * 60e3, LATE = 12 * 3600e3;
const DEFAULT_RULES: Rules = { reserve: true, pct: 30, from: 9, to: 19, perPass: 2 };
const clampN = (v: unknown, lo: number, hi: number, d: number): number => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

function load(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<Store> | null;
    const r: Partial<Rules> = v?.rules ?? {};
    return {
      // Une récurrente n'est jamais « échec » : elle garde son dernier message et repart au créneau suivant.
      jobs: Array.isArray(v?.jobs) ? (v?.jobs ?? []).filter((j: Job) => j && typeof j.id === 'string' && j.when).map((j: Job) => (j.when.type === 'cron' && j.state !== 'attente' ? { ...j, state: 'attente' as const } : j)) : [],
      rules: { reserve: r.reserve ?? true, pct: clampN(r.pct, 0, 90, 30), from: clampN(r.from, 0, 23, 9), to: clampN(r.to, 1, 24, 19), perPass: clampN(r.perPass, 1, 10, 2) },
    };
  } catch { return { jobs: [], rules: { ...DEFAULT_RULES } }; }
}
let store = load();
const listeners: (() => void)[] = [];
/** Appelle `fn` à chaque changement du store (ajout, lancement, suppression, modification, autre fenêtre). */
export function onChange(fn: () => void): void { listeners.push(fn); }
const notify = (): void => { for (const f of listeners) { try { f(); } catch { /* un écouteur ne casse pas les autres */ } } };
const save = (): void => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* plein */ } notify(); };
/** Relit localStorage : un autre onglet ou une autre fenêtre a pu changer la file. À appeler avant toute lecture qui décide. */
const reload = (): void => { store = load(); };
const fresh = (id: string): Job | undefined => { reload(); return store.jobs.find(j => j.id === id); };
// Autre fenêtre : on recharge et on repeint (l'événement `storage` ne part que dans les AUTRES fenêtres).
if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (e.key === KEY || e.key === null) { reload(); notify(); paint(); } });
const uid = (): string => `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------- Plannings ----------
/** Prochain créneau d'un planning en français, après `now` : `lastSlot` ne regarde qu'en arrière, on cherche donc par
 *  dichotomie le premier instant où son dernier créneau passé change (il ne fait que croître). Null si non compris. */
const slotOf = (spec: string, now = new Date()): Date | null => { const d = lastSlot(spec, now); return d && Number.isFinite(+d) ? d : null; };
export function nextSlot(spec: string, now = new Date()): Date | null {
  const cur = slotOf(spec, now);
  if (!cur) return null;
  let lo = now.getTime(), hi = lo + 9 * 864e5;
  const top = slotOf(spec, new Date(hi));
  if (!top || +top <= +cur) return null;
  while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2), s = slotOf(spec, new Date(mid)); if (s && +s > +cur) hi = mid; else lo = mid; }
  return slotOf(spec, new Date(hi));
}
/** Pourquoi un planning récurrent est refusé (null = accepté) : incompris, ou plus fréquent que toutes les 15 minutes. */
export function cronError(spec: string): string | null {
  const cur = slotOf(spec), next = cur ? nextSlot(spec) : null;
  if (!cur || !next) return 'Je ne comprends pas ce planning. Exemples : « jours ouvrés 9h », « vendredi 17h », « toutes les 2h », « tous les jours 02:00 ».';
  if (+next - +cur < MIN_GAP) return 'Trop fréquent : une récurrente doit être espacée d’au moins 15 minutes.';
  return null;
}

const hm = (t: number): string => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
/** « aujourd’hui 18:00 », « demain 02:00 », « lun. 24 nov. 18:00 ». */
function day(t: number): string {
  const d = new Date(t), now = new Date(), t0 = new Date(now); t0.setHours(0, 0, 0, 0);
  const n = Math.floor((new Date(d).setHours(0, 0, 0, 0) - +t0) / 864e5);
  if (n === 0) return `aujourd’hui ${hm(t)}`;
  if (n === 1) return `demain ${hm(t)}`;
  if (n === -1) return `hier ${hm(t)}`;
  return `${d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} ${hm(t)}`;
}

// ---------- Quota ----------
interface Win { known: boolean; pct: number; resetsAt: number | null; exhausted: boolean; via: 'abonnement' | 'agents' | 'aucun' }
/** Signal de repli : le dernier `quota` vu par les agents (secondes, `rejected` = limite atteinte), quand les limites ne sont pas lues. */
let agentSignal: { at: number; resetsAt: number | null; exhausted: boolean } | null = null;
function windowNow(): Win {
  const q = quota.fiveHour();
  if (q.known) return { ...q, via: 'abonnement' };
  const a = agentSignal && Date.now() - agentSignal.at < 10 * 60e3 ? agentSignal : null;
  if (a) return { known: false, pct: 0, resetsAt: a.resetsAt, exhausted: a.exhausted && !!a.resetsAt && a.resetsAt > Date.now(), via: 'agents' };
  return { known: false, pct: 0, resetsAt: null, exhausted: false, via: 'aucun' };
}
async function readAgentSignal(): Promise<void> {
  if (quota.fiveHour().known) { agentSignal = null; return; }
  const pids = [...new Set(store.jobs.filter(j => j.state === 'attente' && j.enabled).map(j => j.project))].slice(0, 4);
  let best: { at: number; resetsAt: number | null; exhausted: boolean } | null = null;
  for (const pid of pids) {
    const r = await bridge.call('agent', 'list', { project: pid }, 10000);
    if (!r.ok) continue;
    for (const run of (r.runs as { started?: string; quota?: { status?: string; resetsAt?: number; rateLimitType?: string } | null }[] | undefined) ?? []) {
      const q = run.quota; if (!q?.status) continue;
      const at = Date.parse(run.started || '') || 0;
      if (!best || at > best.at) best = { at, resetsAt: q.resetsAt ? q.resetsAt * 1000 : null, exhausted: q.status === 'rejected' };
    }
  }
  agentSignal = best && Date.now() - best.at < 6 * 3600e3 ? { ...best, at: Date.now() } : null;
}

/** Heure (0-24) comprise dans la plage de réserve, qui peut passer minuit (22 → 6). */
const inReserve = (r: Rules, d = new Date()): boolean => { const h = d.getHours() + d.getMinutes() / 60; return r.from <= r.to ? h >= r.from && h < r.to : h >= r.from || h < r.to; };

/** Pourquoi une consigne n'est pas partie à cet instant (null = elle peut partir). `now` part toujours si la fenêtre est ouverte. */
function blocker(j: Job, w: Win): string | null {
  if (w.exhausted) return `attend la réouverture${w.resetsAt ? ` à ${hm(w.resetsAt)}` : ''}`;
  if (j.when.type === 'window' && j.after && Date.now() < j.after) return `attend la réouverture à ${hm(j.after)}`;
  if (j.when.type !== 'now' && store.rules.reserve && w.known && inReserve(store.rules) && w.pct > 100 - store.rules.pct) return `réserve de journée : ${Math.round(w.pct)} % utilisés, je te garde les ${store.rules.pct} derniers %`;
  return null;
}
/** Créneau dû d'un job (ms), 0 sinon. Les jobs « maintenant » et « réouverture » sont dus tout de suite ; la fenêtre les retient. */
function dueSlot(j: Job): number {
  if (!j.enabled || j.state !== 'attente') return 0;
  if (j.when.type === 'now' || j.when.type === 'window') return j.created;
  if (j.when.type === 'at') return j.when.at <= Date.now() ? j.when.at : 0;
  const s = slotOf(j.when.spec);
  return s && +s > Math.max(j.lastSlot ?? 0, j.seen ?? j.created) && !cronError(j.when.spec) ? +s : 0;
}

// ---------- Lancement ----------
/** Le lancement d'avant (même job) tourne-t-il encore ? null = on n'a pas pu le savoir (le créneau n'est alors pas consommé). */
async function stillRunning(j: Job): Promise<boolean | null> {
  if (!j.run && !j.session) return false;
  const r = await bridge.call('agent', 'list', { project: j.project }, 10000);
  if (!r.ok) return null;
  const runs = (r.runs as { run?: string; session?: string; status?: string }[] | undefined) ?? [];
  return runs.some(x => ((j.run && x.run === j.run) || (j.session && x.session === j.session)) && (x.status === 'running' || x.status === 'starting'));
}
/** Lance l'agent d'un job déjà marqué. Le résultat est écrit sur la version à jour du job (relue), jamais sur une copie périmée. */
async function startJob(j: Job): Promise<boolean> {
  const id = j.id, cron = j.when.type === 'cron', p = projects.byId(j.project);
  // Corps identique à celui de l'onglet Claude Code : `startAgent` (workspace.ts) ne dépend d'aucune vue, on l'appelle tel quel.
  let r: { ok: boolean; message?: string; session?: string; run?: string };
  if (!p) r = { ok: false, message: 'Le projet n’existe plus.' };
  else { try { r = await startAgent(p, j.prompt, j.mode); } catch (e) { r = { ok: false, message: e instanceof Error ? e.message : String(e) }; } }
  const f = fresh(id); if (!f) return !!r.ok;
  // Une récurrente garde l'état « attente » même en échec : elle repartira au créneau suivant (le raté n'est pas rejoué).
  if (r.ok) { f.session = r.session ?? ''; f.run = r.run ?? ''; f.error = undefined; if (!cron) f.state = 'lancé'; }
  else { f.error = r.message ?? 'Lancement impossible.'; if (!cron) f.state = 'échec'; }
  save();
  return !!r.ok;
}

let passing = false;
/** Une passe : lit la fenêtre, puis lance (un par un, au plus `perPass`) ce qui est dû et n'est pas retenu. */
async function pass(): Promise<void> {
  if (passing || !bridge.local()) return;
  passing = true;
  try {
    reload();
    if (!store.jobs.some(j => j.state === 'attente' && j.enabled)) return;
    try { await quota.refresh(); } catch { /* sans effet : on retombe sur le signal des agents */ }
    await readAgentSignal();
    const w = windowNow();
    // « À la réouverture » demandée fenêtre ouverte : elle attend la fin de la fenêtre en cours, si on la connaît.
    reload();
    let touched = false;
    for (const j of store.jobs) if (j.when.type === 'window' && j.state === 'attente' && j.after === undefined) { j.after = !w.exhausted && w.resetsAt && w.resetsAt > Date.now() ? w.resetsAt : 0; touched = true; }
    if (touched) save();
    let n = 0;
    for (const id of store.jobs.map(j => j.id)) {
      if (n >= store.rules.perPass) break;
      let j = fresh(id); if (!j) continue;
      const slot = dueSlot(j); if (!slot) continue;
      // Consigne datée restée en retard (Studio fermé) : elle ne part pas n'importe quand, elle passe en échec.
      if (j.when.type === 'at' && Date.now() - j.when.at > LATE) { j.state = 'échec'; j.error = 'Heure passée pendant que Studio était fermé'; save(); continue; }
      if (blocker(j, w)) continue;
      // Récurrente : si l'exécution précédente tourne encore, on saute ce créneau (sans le rattraper).
      const busy = j.when.type === 'cron' ? await stillRunning(j) : false;
      if (busy === null) continue;
      // Marquage atomique : relire, vérifier que le créneau est encore dû, marquer, écrire (rien d'asynchrone entre les quatre).
      j = fresh(id); if (!j || dueSlot(j) !== slot) continue;
      if (busy) { j.lastSlot = slot; save(); continue; }
      j.last = Date.now();
      if (j.when.type === 'cron') j.lastSlot = slot; else j.state = 'lancé';
      save();
      n++;
      const ok = await startJob(j);
      const err = fresh(id)?.error;
      if (!ok && err) toast(`Consigne planifiée non lancée : ${err}`);
    }
    if (n) paint();
  } finally { passing = false; }
}

// ---------- API ----------
let started = false;
export function init(): void {
  if (started || !bridge.local()) return;
  started = true;
  setTimeout(() => { void pass(); setInterval(() => void pass(), PASS); }, FIRST);
}
/** Consignes en attente dans la file (les récurrentes n'y comptent pas). */
export const pending = (): number => store.jobs.filter(j => j.state === 'attente' && j.enabled && j.when.type !== 'cron').length;
export function add(job: NewJob): Job {
  reload();
  const when = job.when ?? { type: 'now' as const }, now = Date.now();
  const j: Job = { id: uid(), project: job.project, prompt: job.prompt.trim(), mode: job.mode ?? 'edit', when, state: 'attente', enabled: true, created: now, ...(when.type === 'cron' ? { seen: now } : {}) };
  store.jobs.push(j); save(); paint();
  if (when.type === 'now' || when.type === 'window') void pass();
  return j;
}

// ---------- Vue ----------
let root: HTMLElement | null = null, repaint: ReturnType<typeof setInterval> | undefined, wired = false;
const openFold = new Set<string>();
export function stop(): void { clearInterval(repaint); repaint = undefined; }

const MODE = { edit: 'Modifier', read: 'Analyser' } as const;
const projName = (id: string): string => projects.byId(id)?.name ?? 'Projet supprimé';
const title = (s: string): string => { const t = s.trim().split('\n')[0] ?? ''; return t.length > 110 ? `${t.slice(0, 109)}…` : t; };

function whenLabel(j: Job): string {
  const w = j.when;
  if (w.type === 'cron') return w.spec;
  if (w.type === 'at') return day(w.at);
  return w.type === 'now' ? 'dès que possible' : 'à la réouverture';
}
function whyWaiting(j: Job, w: Win): string {
  const b = blocker(j, w);
  if (b) return b;
  if (j.when.type === 'at' && j.when.at > Date.now()) return `part ${day(j.when.at)}`;
  return 'part au prochain passage';
}

function gaugeHTML(w: Win): string {
  if (w.via === 'aucun') return `<div class="pl-gauge pl-dim">${icon('clock')}<span>Je ne connais pas ta fenêtre de 5 h : les consignes partent sans l’attendre. <a href="#" data-open-conn="ia">Réglages → IA</a></span></div>`;
  if (!w.known) return `<div class="pl-gauge pl-dim">${icon('clock')}<span>${w.exhausted ? `Les agents signalent la limite atteinte, réouverture à ${hm(w.resetsAt ?? 0)}.` : 'Aucune limite signalée par les agents.'} Pour voir ta fenêtre : <a href="#" data-open-conn="ia">Réglages → IA</a>.</span></div>`;
  const week = quota.sources().find(s => s.id === 'claudecode')?.meters.find(m => m.key === 'seven_day');
  const pct = Math.min(100, Math.max(0, Math.round(w.pct)));
  const tone = pct >= 100 ? 'red' : pct >= 100 - (store.rules.reserve ? store.rules.pct : 10) ? 'amber' : 'green';
  const sub = w.exhausted ? `épuisée · réouverture à ${hm(w.resetsAt ?? 0)}` : `${pct} % utilisés${w.resetsAt ? ` · se renouvelle à ${hm(w.resetsAt)}` : ''}`;
  return `<div class="pl-gauge"><div><b>Fenêtre de 5 h</b><div class="pl-sub">${esc(sub)}</div></div><div class="pl-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%;background:var(--c-${tone})"></i></div>${week && week.pct !== null ? `<div><b>Semaine</b><div class="pl-sub">${Math.round(week.pct)} % utilisés</div></div>` : ''}</div>`;
}

/** Frise de la journée : créneaux planifiés d'aujourd'hui et fenêtre épuisée. Vide (donc absente) s'il n'y a rien à montrer. */
function timelineHTML(w: Win): string {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const x0 = +t0, x1 = x0 + 864e5, pc = (t: number): number => Math.max(0, Math.min(100, (t - x0) / 864e5 * 100));
  const marks: { t: number; label: string; c: string }[] = [];
  for (const j of store.jobs) {
    if (!j.enabled || j.state !== 'attente') continue;
    if (j.when.type === 'at' && j.when.at >= x0 && j.when.at < x1) marks.push({ t: j.when.at, label: title(j.prompt), c: 'blue' });
    if (j.when.type === 'cron') { const s = nextSlot(j.when.spec); if (s && +s < x1) marks.push({ t: +s, label: title(j.prompt), c: 'violet' }); }
  }
  const band = w.exhausted && w.resetsAt ? { from: Date.now(), to: Math.min(w.resetsAt, x1) } : null;
  const waiting = pending();
  if (!marks.length && !band) return '';
  const now = Date.now();
  return `<div class="pl-tl" aria-label="Journée">${store.rules.reserve ? `<span class="pl-res" style="left:${store.rules.from / 24 * 100}%;width:${(store.rules.to - store.rules.from + (store.rules.to < store.rules.from ? 24 : 0)) / 24 * 100}%" title="Réserve de journée : ${store.rules.pct} % gardés"></span>` : ''}
    ${band ? `<span class="pl-win" style="left:${pc(band.from)}%;width:${pc(band.to) - pc(band.from)}%" title="Fenêtre épuisée jusqu’à ${hm(w.resetsAt ?? 0)}">fenêtre épuisée${waiting ? ` · ${waiting} en attente` : ''}</span>` : ''}
    ${marks.map(m => `<span class="pl-mk" style="left:${pc(m.t)}%;--c:var(--c-${m.c})" title="${esc(hm(m.t))} · ${esc(m.label)}"></span>`).join('')}
    <span class="pl-now" style="left:${pc(now)}%" title="Maintenant"></span></div>
    <div class="pl-hrs"><span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>24h</span></div>
    ${marks.length ? `<div class="pl-leg">${marks.sort((a, b) => a.t - b.t).slice(0, 6).map(m => `<span><i style="background:var(--c-${m.c})"></i>${hm(m.t)} ${esc(m.label)}</span>`).join('')}</div>` : ''}`;
}

function rowHTML(j: Job, i: number, w: Win, kind: 'queue' | 'cron' | 'done' | 'fail', rank = 0): string {
  const meta = [projName(j.project), MODE[j.mode]];
  let pill = '', sub = '', act = '';
  if (kind === 'queue') {
    pill = `<span class="pl-pill pl-amber">${rank}</span>`; meta.push(whyWaiting(j, w));
    act = `${rank > 1 ? '<button class="btn" data-pl="front">Passer devant</button>' : ''}<button class="btn btn-ghost pl-more" data-pl="more" aria-label="Actions" aria-haspopup="menu">${icon('more')}</button>`;
  } else if (kind === 'cron') {
    const next = j.enabled && j.when.type === 'cron' ? nextSlot(j.when.spec) : null;
    pill = `<span class="pl-pill pl-violet">${esc(j.when.type === 'cron' ? j.when.spec : '')}</span>`;
    meta.push(j.enabled ? (next ? `prochain passage : ${day(+next)}` : 'planning non compris') : 'en pause');
    if (j.enabled && j.when.type === 'cron' && next && cronError(j.when.spec)) meta.push('trop fréquent : ne part pas');
    if (j.last) meta.push(`dernière fois : ${day(j.last)}`);
    if (j.error) sub = `<small class="pl-err">Dernier lancement : ${esc(j.error)}</small>`;
    act = `<button class="pl-sw" role="switch" aria-checked="${j.enabled}" data-pl="toggle" aria-label="Activer"><i></i></button><button class="btn btn-ghost pl-more" data-pl="more" aria-label="Actions" aria-haspopup="menu">${icon('more')}</button>`;
  } else if (kind === 'fail') {
    pill = `<span class="pl-pill pl-red">échec</span>`; sub = `<small class="pl-err">${esc(j.error ?? 'Lancement impossible.')}</small>`;
    act = `<button class="btn" data-pl="retry">Réessayer</button><button class="btn btn-ghost pl-more" data-pl="more" aria-label="Actions" aria-haspopup="menu">${icon('more')}</button>`;
  } else {
    pill = `<span class="pl-pill pl-green">${icon('check')}</span>`; if (j.last) meta.push(day(j.last));
    act = `<button class="btn btn-ghost pl-more" data-pl="more" aria-label="Actions" aria-haspopup="menu">${icon('more')}</button>`;
  }
  return `<div class="pl-row${j.enabled ? '' : ' off'}" data-id="${esc(j.id)}" data-i="${i}">${pill}<div class="pl-main"><span class="pl-t">${esc(title(j.prompt))}</span><small>${esc(meta.join(' · '))}</small>${sub}</div><span class="pl-act">${act}</span></div>`;
}

const EXAMPLES: { label: string; prompt: string; when: When }[] = [
  { label: 'Chaque nuit, mettre à jour les dépendances', prompt: 'Mets à jour les dépendances, lance les tests et ouvre une PR si tout passe.', when: { type: 'cron', spec: 'chaque nuit 02:00' } },
  { label: 'Chaque soir, relire les PR ouvertes', prompt: 'Relis les PR ouvertes du projet et résume ce qui reste à faire.', when: { type: 'cron', spec: 'jours ouvrés 18h' } },
  { label: 'À la réouverture, finir une tâche en attente', prompt: '', when: { type: 'window' } },
];

function paint(): void {
  if (!root?.isConnected) { stop(); return; }
  const page = $('.pl-body', root); if (!page) return;
  if (page.contains(document.activeElement) && $('.pl-rules', page)?.contains(document.activeElement)) return;
  const w = windowNow();
  const queue = store.jobs.filter(j => j.when.type !== 'cron' && j.state === 'attente');
  const crons = store.jobs.filter(j => j.when.type === 'cron');
  const fails = store.jobs.filter(j => j.when.type !== 'cron' && j.state === 'échec');
  const done = store.jobs.filter(j => j.when.type !== 'cron' && j.state === 'lancé').sort((a, b) => (b.last ?? 0) - (a.last ?? 0)).slice(0, DONE_MAX);
  const idx = (j: Job): number => store.jobs.indexOf(j);
  const empty = !store.jobs.length;
  const group = (name: string, hint: string, rows: string): string => rows ? `<div class="pl-grp">${name}${hint ? `<span>${esc(hint)}</span>` : ''}</div>${rows}` : '';
  const r = store.rules;
  const hours = (v: number, max: number): string => Array.from({ length: max + 1 }, (_, h) => `<option value="${h}"${h === v ? ' selected' : ''}>${String(h).padStart(2, '0')} h</option>`).join('');
  const rules = `<details class="pl-rules" data-fold="rules"${openFold.has('rules') ? ' open' : ''}><summary>Règles</summary><div class="pl-rules-in">
    <label class="pl-chk"><input type="checkbox" data-r="reserve"${r.reserve ? ' checked' : ''}> En journée, garde-moi <input class="field pl-n" type="number" min="0" max="90" step="5" value="${r.pct}" data-r="pct" aria-label="Pourcentage gardé"> % de la fenêtre de 5 h</label>
    <label class="pl-chk">de <select class="field pl-h" data-r="from" aria-label="Début de la journée">${hours(r.from, 23)}</select> à <select class="field pl-h" data-r="to" aria-label="Fin de la journée">${hours(r.to, 24).replace('value="0"', 'value="0" hidden')}</select></label>
    <label class="pl-chk">Au plus <input class="field pl-n" type="number" min="1" max="10" value="${r.perPass}" data-r="perPass" aria-label="Agents par passe"> agent(s) planifié(s) lancé(s) par minute</label>
    <small class="pl-dim">La réserve ne retient que les consignes planifiées, jamais « Maintenant ». Elle a besoin de lire ta fenêtre de 5 h.</small></div></details>`;
  const body = empty
    ? `<div class="pl-empty"><h3>Rien de planifié</h3><p>Confie une consigne à un agent pour plus tard : une heure, un rythme, ou la réouverture de ta fenêtre de 5 h.</p><div class="pl-ex">${EXAMPLES.map((e, i) => `<button class="btn" data-pl="ex" data-ex="${i}">${esc(e.label)}</button>`).join('')}</div></div>`
    : `${timelineHTML(w)}
      ${group('En attente', w.exhausted && w.resetsAt ? `repart à ${hm(w.resetsAt)}` : '', queue.map((j, k) => rowHTML(j, idx(j), w, 'queue', k + 1)).join(''))}
      ${group('Récurrentes', '', crons.map(j => rowHTML(j, idx(j), w, 'cron')).join(''))}
      ${group('En échec', '', fails.map(j => rowHTML(j, idx(j), w, 'fail')).join(''))}
      ${done.length ? `<details class="pl-done" data-fold="done"${openFold.has('done') ? ' open' : ''}><summary>Faites <span>${done.length}</span></summary>${done.map(j => rowHTML(j, idx(j), w, 'done')).join('')}</details>` : ''}`;
  // Le corps est remplacé en entier : on garde le défilement (la marque « maintenant » bouge toutes les 30 s).
  const top = page.scrollTop;
  if (paintIfChanged(page, `${gaugeHTML(w)}${body}${rules}`)) page.scrollTop = top;
}

// ---------- Formulaire ----------
function toLocal(t: number): string { const d = new Date(t - new Date(t).getTimezoneOffset() * 6e4); return d.toISOString().slice(0, 16); }
function form(init: { job?: Job; project?: string; prompt?: string; when?: When } = {}): void {
  const list = projects.projects();
  if (!list.length) { toast('Crée d’abord un projet.'); return; }
  const j = init.job, when: When = j?.when ?? init.when ?? { type: 'now' };
  const pid = j?.project ?? init.project ?? list[0]?.id ?? '';
  const radio = (v: When['type'], label: string): string => `<label class="pl-opt"><input type="radio" name="when" value="${v}"${when.type === v ? ' checked' : ''}> ${label}</label>`;
  const m = modal({ cls: 'pl-form', html: `<div class="pl-fh"><b>${j ? 'Modifier la consigne' : 'Planifier une consigne'}</b><span class="pl-dim">pour un agent Claude Code, dans sa propre copie du dépôt</span></div>
    <div class="pl-fb">
      <label>Projet<select class="field" data-f="project">${list.map((p: Project) => `<option value="${esc(p.id)}"${p.id === pid ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>Consigne<textarea class="field" rows="4" data-f="prompt" placeholder="Ce que l’agent doit faire…" autofocus>${esc(j?.prompt ?? init.prompt ?? '')}</textarea></label>
      <div class="pl-line"><span>Mode</span><select class="field" data-f="mode"><option value="edit"${(j?.mode ?? 'edit') === 'edit' ? ' selected' : ''}>Modifier</option><option value="read"${j?.mode === 'read' ? ' selected' : ''}>Analyser</option></select></div>
      <fieldset class="pl-when"><legend>Quand</legend>
        ${radio('now', 'Maintenant <small>(sinon dès la réouverture)</small>')}${radio('window', 'À la réouverture de la fenêtre de 5 h')}
        ${radio('at', 'Date et heure')}<input class="field" type="datetime-local" data-f="at" value="${when.type === 'at' ? toLocal(when.at) : toLocal(Date.now() + 36e5)}">
        ${radio('cron', 'Récurrent')}<input class="field" type="text" data-f="spec" placeholder="jours ouvrés 18h · chaque nuit 02:00 · toutes les 2h" value="${esc(when.type === 'cron' ? when.spec : '')}"><small class="pl-prev" data-prev></small>
      </fieldset>
    </div>
    <div class="cap-foot"><span class="ask-status"></span><span class="ask-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-primary" data-go>${j ? 'Enregistrer' : 'Planifier'}</button></span></div>` });
  const q = <T extends HTMLElement>(s: string): T => need<T>(s, m.node);
  const kind = (): When['type'] => (m.node.querySelector<HTMLInputElement>('input[name=when]:checked')?.value ?? 'now') as When['type'];
  const preview = (): void => {
    const k = kind(), spec = q<HTMLInputElement>('[data-f=spec]').value.trim(), out = q('[data-prev]');
    q('[data-f=at]').toggleAttribute('disabled', k !== 'at'); q('[data-f=spec]').toggleAttribute('disabled', k !== 'cron');
    if (k !== 'cron') { out.textContent = ''; return; }
    const n = spec ? nextSlot(spec) : null, bad = spec ? cronError(spec) : null;
    out.textContent = !spec ? '' : bad ?? (n ? `prochain passage : ${day(+n)}` : '');
  };
  m.node.addEventListener('input', preview); m.node.addEventListener('change', preview); preview();
  q('[data-x]').onclick = () => m.close();
  q('[data-go]').onclick = () => {
    const prompt = q<HTMLTextAreaElement>('[data-f=prompt]').value.trim(), project = q<HTMLSelectElement>('[data-f=project]').value, mode = q<HTMLSelectElement>('[data-f=mode]').value === 'read' ? 'read' : 'edit';
    const k = kind(); let w: When = { type: 'now' };
    if (!prompt) { toast('Écris la consigne.'); return; }
    if (k === 'window') w = { type: 'window' };
    if (k === 'at') { const t = Date.parse(q<HTMLInputElement>('[data-f=at]').value); if (!t) { toast('Choisis une date et une heure.'); return; } w = { type: 'at', at: t }; }
    if (k === 'cron') { const spec = q<HTMLInputElement>('[data-f=spec]').value.trim(); const bad = cronError(spec); if (bad) { q('[data-prev]').textContent = bad; toast(bad); return; } w = { type: 'cron', spec }; }
    m.close();
    if (!j) { const nj = add({ project, prompt, mode, when: w }); if (nj.when.type === 'now' || nj.when.type === 'window') toast('Consigne ajoutée à la file'); return; }
    const f = j && fresh(j.id); if (!f) { toast('Cette consigne n’existe plus.'); return; }
    Object.assign(f, { project, prompt, mode, when: w, state: 'attente', enabled: true, error: undefined, after: undefined, ...(w.type === 'cron' ? { seen: Date.now() } : {}) });
    save(); paint();
  };
}

// ---------- Gestes ----------
const jobOf = (el: HTMLElement): Job | undefined => fresh(el.closest<HTMLElement>('.pl-row')?.dataset.id ?? '');
async function runNow(id: string): Promise<void> {
  // Geste explicite : ni fenêtre, ni réserve, ni plafond par passe.
  const j = fresh(id); if (!j) return;
  j.last = Date.now(); if (j.when.type !== 'cron') j.state = 'lancé'; save(); paint();
  const ok = await startJob(j);
  toast(ok ? 'Agent lancé' : `Lancement impossible : ${fresh(id)?.error ?? ''}`); paint();
}
function rowMenu(btn: HTMLElement, j: Job): void {
  menu(btn, [
    { label: 'Lancer maintenant', icon: 'bolt', run: () => runNow(j.id) },
    { label: 'Modifier', icon: 'pencil', run: () => form({ job: j }) },
    '-',
    { label: 'Supprimer', icon: 'trash', danger: true, run: async () => { if (await confirmBox({ title: 'Supprimer cette consigne ?', text: title(j.prompt), ok: 'Supprimer', danger: true })) { reload(); store.jobs = store.jobs.filter(x => x.id !== j.id); save(); paint(); } } },
  ]);
}

export function mount(main: HTMLElement, toolbarLeft: string): void {
  stop();
  if (!bridge.local()) {
    main.innerHTML = `<header class="toolbar">${toolbarLeft}<div class="crumb"><span>Planification</span></div></header><div class="empty"><div class="empty-card">${icon('clock')}<h3>La planification tourne sur ton Mac</h3><p>Les agents partent depuis l’app Studio pour Mac, tant qu’elle est ouverte.</p></div></div>`;
    return;
  }
  // Tout est dans `.pl-root` : les écouteurs disparaissent avec la vue (#main, lui, sert à toutes les vues).
  main.innerHTML = `<div class="pl-root"><header class="toolbar">${toolbarLeft}<div class="crumb"><span>Planification</span></div><div class="tb-side tb-right"><button class="btn btn-primary" data-pl="new">${icon('plus')}<span>Planifier une consigne</span></button></div></header><div class="pl-body"></div></div>`;
  root = need('.pl-root', main);
  const page = root;
  page.addEventListener('click', e => {
    const t = target(e), a = t.closest<HTMLElement>('[data-pl]'); if (!a) return;
    const k = a.dataset.pl, j = jobOf(a);
    if (k === 'new') form();
    else if (k === 'ex') { const x = EXAMPLES[Number(a.dataset.ex)]; if (x) form({ prompt: x.prompt, when: x.when }); }
    else if (k === 'front' && j) { store.jobs = [j, ...store.jobs.filter(x => x.id !== j.id)]; save(); paint(); }
    else if (k === 'toggle' && j) { j.enabled = !j.enabled; if (j.enabled) j.seen = Date.now(); save(); paint(); }
    else if (k === 'retry' && j) { j.state = 'attente'; j.error = undefined; j.created = Date.now(); if (j.when.type === 'at') j.when = { type: 'at', at: Date.now() }; save(); paint(); void pass(); }
    else if (k === 'more' && j) rowMenu(a, j);
  });
  page.addEventListener('change', e => {
    const t = target(e) as HTMLInputElement, k = t.dataset.r; if (!k) return;
    reload(); const r = store.rules;
    if (k === 'reserve') r.reserve = t.checked;
    else if (k === 'pct') r.pct = clampN(t.value, 0, 90, 30);
    else if (k === 'from') r.from = clampN(t.value, 0, 23, 9);
    else if (k === 'to') r.to = clampN(t.value, 1, 24, 19);
    else if (k === 'perPass') r.perPass = clampN(t.value, 1, 10, 2);
    save(); paint();
  });
  // Le panneau « Règles » et les « Faites » gardent leur état d'ouverture d'un rendu à l'autre (`toggle` ne remonte pas : capture).
  page.addEventListener('toggle', e => {
    const d = target(e), f = d.dataset.fold; if (!f) return;
    if ((d as HTMLDetailsElement).open) openFold.add(f); else openFold.delete(f);
  }, true);
  if (!wired) { wired = true; quota.onChange(() => paint()); }
  paint(); void quota.refresh();
  repaint = setInterval(paint, 30e3);
}
