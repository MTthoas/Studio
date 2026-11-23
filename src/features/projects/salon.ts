// Salon d'un projet : l'équipe d'agents du projet vue comme une discussion, pas comme un terminal.
// Ce n'est PAS un nouveau protocole : ce sont les mêmes données que l'onglet Claude Code, l'Espace agents et le fil
// « Échanges » (conversations du Mac, sous-agents, tableau d'équipe, copie du travail), présentées autrement.
//   - un Salon PAR PROJET : rien ne vient d'un autre projet (tous les caches sont rattachés à l'id du projet monté) ;
//   - les agents ne se parlent qu'au sein d'UNE consigne : l'agent principal (Maya) et ses sous-agents ; les messages
//     du tableau venus d'autres agents d'un groupe (« Agent 2 ») sont ignorés ici ;
//   - les agents portent des prénoms (`persona`), déterministes : le même sous-agent a toujours le même prénom ;
//   - pas de détail technique (outils, fichiers lus, commandes) : « Vue technique » ouvre l'onglet Claude Code.
// Disposition : à gauche les fils, au centre la discussion et le champ, à droite « En ce moment ». Relecture toutes les
// 2,5 s tant que le Salon est à l'écran (la liste des fils, plus lente, toutes les 30 s) ; le fil est mis à jour bloc par
// bloc (syncFeed) et le champ n'est jamais redessiné : texte tapé, défilement et blocs dépliés restent en place.
// Styles : css/salon.css (préfixe `sl-`). Tout ce qui vient du Mac passe par `esc()`.
import * as bridge from '../../integrations/remote.ts';
import * as quota from '../../integrations/quota.ts';
import { syncFeed, nameOf, live, copyStage, copyAct, answerHTML, modelName } from './sessions.ts';
import { exchanges } from './team.ts';
import { startAgent, reply } from '../workspace.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, need, rel, toast, target, paintIfChanged } from '../../ui/kit.ts';
import type { Block, Session, Action, AgentRun, Queued, Worktree, SubAgent } from './sessions.ts';
import type { BoardMsg } from './team.ts';
import type { Project } from './model.ts';

// ---------- Les prénoms ----------
export interface Persona { name: string; role: string; hue: string }
const FIXED: [RegExp, Persona][] = [
  [/^(|principal|agent principal|main|claude|maya)$/, { name: 'Maya', role: 'cheffe d’équipe', hue: 'orange' }],
  [/explor/, { name: 'Léo', role: 'explorateur', hue: 'teal' }],
  [/relec|review/, { name: 'Iris', role: 'relecteur', hue: 'violet' }],
  [/test|qualite|\bqa\b/, { name: 'Noé', role: 'testeur', hue: 'pink' }],
  [/integr/, { name: 'Sacha', role: 'intégrateur', hue: 'indigo' }],
  [/redact|writer|documentation/, { name: 'Zoé', role: 'rédacteur', hue: 'amber' }],
];
const NAMES = ['Alex', 'Camille', 'Hugo', 'Inès', 'Jade', 'Lou', 'Mia', 'Nils', 'Théo', 'Yanis', 'Eva', 'Sam'];
const HUES = ['blue', 'green', 'amber', 'orange', 'violet', 'pink', 'teal', 'indigo'];
const flat = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
/** Prénom, rôle et couleur d'un agent d'après son nom (agent principal : « principal » ou vide ; sous-agent : son type).
 *  Déterministe : un nom inconnu reçoit toujours le même prénom, par hachage stable du nom. */
export function persona(nom: string): { name: string; role: string; hue: string } {
  const n = flat(nom), known = FIXED.find(([re]) => re.test(n));
  if (known) return { ...known[1] };
  let h = 5381; for (const c of n) h = (Math.imul(h, 33) + (c.codePointAt(0) ?? 0)) >>> 0;
  return { name: NAMES[h % NAMES.length] ?? 'Alex', role: nom.trim(), hue: HUES[(h >>> 8) % HUES.length] ?? 'blue' };
}

// ---------- État (rattaché à un projet : remis à zéro quand on en monte un autre) ----------
interface Detail { actions: Action[]; subagents?: SubAgent[]; live?: boolean; worktree?: string; models?: string[]; files?: string[]; lines?: { add: number; del: number }; message?: string }
interface Thread { id: string; s: Session; group: 'work' | 'mine' | 'recent'; act: number }
interface Who extends Persona { id: string; base: string; model?: string; me?: boolean }
const TICK = 2500, SEEN = 'studio.salon.seen', MORE = 8;
const ms = (iso?: string): number => Date.parse(iso || '') || 0;
const seen: Record<string, number> = (() => { try { return JSON.parse(localStorage.getItem(SEEN) || '{}') as Record<string, number>; } catch { return {}; } })();
let firstUse = !Object.keys(seen).length;
const keepSeen = (): void => { try { localStorage.setItem(SEEN, JSON.stringify(seen)); } catch { /* plein */ } };

const S = { pid: '', sessions: [] as Session[], runs: [] as AgentRun[], queued: [] as Queued[], trees: [] as Worktree[], treesRead: false, loaded: false,
  detail: new Map<string, Detail>(), board: new Map<string, BoardMsg[]>() };
/** Fil choisi, par projet : absent = automatique (celui qui travaille, sinon celui qui t'attend), '' = nouvelle consigne. */
const chosen = new Map<string, string>();
const drafts = new Map<string, string>();
let root: HTMLElement | null = null, p: Project | null = null, timer: ReturnType<typeof setInterval> | undefined;
let tick = 0, listing = false, busy = false, refreshing = false, moreOpen = false, shown = '', quotaHooked = false;
let openTech: (session: string) => void = () => undefined;

function reset(pid: string): void {
  S.pid = pid; S.sessions = []; S.runs = []; S.queued = []; S.trees = []; S.treesRead = false; S.loaded = false; S.detail.clear(); S.board.clear();
  moreOpen = false; shown = ''; tick = 0;
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
    const group = mine.some(live) || s.live ? 'work' : last?.status === 'error' || (w && copyStage(w) === 'review') || (act > (seen[s.id] ?? 0) && Date.now() - act < 3 * 864e5) ? 'mine' : 'recent';
    return { id: s.id, s, group, act };
  }).sort((a, b) => b.act - a.act);
}
function curId(th = threads()): string {
  const c = chosen.get(S.pid);
  if (c !== undefined) return c;
  return (th.find(t => t.group === 'work') ?? th.find(t => t.group === 'mine') ?? th[0])?.id ?? '';
}
async function loadSessions(pid: string): Promise<void> {
  const r = await bridge.call('project', 'sessions', { project: pid }, 20000);
  if (pid !== S.pid || !r.ok) return;
  S.sessions = r.found ? (r.sessions as Session[] | undefined) ?? [] : [];
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
async function refreshOnce(pid: string): Promise<void> {
  const l = await bridge.call('agent', 'list', { project: pid }, 10000);
  if (pid !== S.pid || !root?.isConnected) return;
  if (l.ok) { S.runs = (l.runs as AgentRun[] | undefined) ?? []; S.queued = (l.queued as Queued[] | undefined) ?? []; }
  // La consigne qui vient de partir n'avait pas encore de conversation : on la suit dès que le Mac l'a créée.
  const c = chosen.get(pid);
  if (c?.startsWith('run:')) { const r = S.runs.find(x => `run:${x.run}` === c); if (r?.session) { chosen.set(pid, r.session); shown = `${pid}/${r.session}`; } }
  if (!listing && (tick % 12 === 0 || !S.loaded)) { listing = true; void loadSessions(pid).finally(() => { listing = false; if (root?.isConnected) paint(); }); }
  if (tick % 6 === 0 || !S.treesRead) await loadTrees(pid);
  const id = curId();
  if (id && !id.startsWith('run:')) {
    const work = threads().find(t => t.id === id)?.group === 'work';
    if (!S.detail.has(id) || work || tick % 4 === 0) await loadDetail(pid, id);
    const wt = S.detail.get(id)?.worktree;
    if (wt && (!S.board.has(wt) || tick % 2 === 0)) await loadBoard(pid, wt);
  }
  tick++;
  if (pid === S.pid && root?.isConnected) paint();
}
/** Arrête la relecture périodique (appelé quand on quitte l'onglet ; elle s'arrête aussi seule si le Salon n'est plus à l'écran). */
export function stop(): void { clearInterval(timer); timer = undefined; }
const start = (): void => { stop(); tick = 0; void refresh(); timer = setInterval(() => void refresh(), TICK); };

// ---------- Les gens du fil ----------
/** Famille du modèle en un mot : « opus », « sonnet », « haiku » ; sinon le nom court. */
const family = (m: string | undefined): string => m ? (/(opus|sonnet|haiku)/i.exec(m)?.[1]?.toLowerCase() ?? modelName(m)) : '';
interface Crew { main: Who; me: Who; subs: Map<string, Who>; byBase: Map<string, string[]> }
function crewOf(subs: SubAgent[], models: string[]): Crew {
  const main: Who = { ...persona('principal'), id: '', base: 'Maya', model: family(models[models.length - 1]) };
  const me: Who = { name: 'Toi', role: '', hue: 'gray', id: '', base: 'Toi', me: true };
  const by = new Map<string, Who>(), count = new Map<string, number>(), byBase = new Map<string, string[]>();
  // Plusieurs agents du même rôle : « Léo », « Léo 2 », dans l'ordre où ils sont partis.
  for (const s of [...subs].sort((a, b) => ms(a.started) - ms(b.started))) {
    const ps = persona(s.type || s.title), n = (count.get(ps.name) ?? 0) + 1;
    count.set(ps.name, n); byBase.set(ps.name, [...(byBase.get(ps.name) ?? []), s.id]);
    by.set(s.id, { ...ps, name: n > 1 ? `${ps.name} ${n}` : ps.name, id: s.id, base: ps.name });
  }
  return { main, me, subs: by, byBase };
}
const initials = (w: Who): string => w.me ? 'T' : w.name.replace(/\s+/g, '').slice(0, 2).replace(/^./, c => c.toUpperCase());
const avatar = (w: Who, big = false): string => `<i class="sl-av${big ? ' big' : ''}" style="--c:var(--c-${w.hue})" aria-hidden="true">${esc(initials(w))}</i>`;
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
const mention = (w: Who): string => `<span class="sl-to" style="--c:var(--c-${w.hue})">@${esc(w.name)}</span>`;
/** Insère la mention au début du premier paragraphe d'un message rendu. */
const withTo = (html: string, to: Who | null): string => !to ? html : /<p[\s>]/.test(html) ? html.replace(/<p(\s[^>]*)?>/, m => `${m}${mention(to)} `) : `<p>${mention(to)}</p>${html}`;
/** Texte brut comparable : casse et espaces normalisés. */
const norm = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();
function msgHTML(w: Who, at: number, body: string, o: { cls?: string; tag?: string } = {}): string {
  return `<article class="sl-msg${w.me ? ' me' : ''}${o.cls ? ` ${o.cls}` : ''}">${avatar(w)}<div class="sl-bd"><header><b>${esc(w.name)}</b>${w.role ? `<span class="sl-role">${esc(w.role)}</span>` : ''}${w.model ? `<em class="sl-model" title="Modèle">${esc(w.model)}</em>` : ''}${o.tag ? `<em class="sl-tag">${o.tag}</em>` : ''}<time>${esc(at ? hm(at) : '')}</time></header>${body}</div></article>`;
}
const noteHTML = (html: string, at: number, brief = ''): string => brief
  ? `<details class="sl-note"><summary><span>${html}</span><time>${esc(hm(at))}</time>${icon('chevron')}</summary><div class="sl-brief">${esc(brief)}</div></details>`
  : `<p class="sl-note"><span>${html}</span><time>${esc(hm(at))}</time></p>`;
const plain = (t: string): string => `<p class="sl-plain">${esc(t)}</p>`;
const md = (t: string): string => `<div class="md">${answerHTML(t)}</div>`;

/** Membre du fil d'après un nom du tableau (« Agent 2 · explorateur », « explorateur ») : jamais un agent d'un autre groupe. */
function crewMember(crew: Crew, name: string): Who | null {
  const n = name.replace(/^Agent \d+ · /, '');
  if (/^Agent \d+$/.test(n)) return null;
  const id = crew.byBase.get(persona(n).name)?.[0];
  return id ? crew.subs.get(id) ?? null : null;
}

interface Item { at: number; key: string; html: string }
/** Tout ce qui se dit dans le fil, du plus ancien au plus récent ; `ask` : la dernière chose écrite est une réponse de l'agent qui pose une question. */
function itemsOf(d: Detail, crew: Crew, board: BoardMsg[]): { items: Item[]; ask: boolean } {
  const out: Item[] = [], seq = new Map<string, number>(), nth = new Map<string, number>();
  const add = (at: number, k: string, html: string): void => { const key = `${k}|${at}`, n = seq.get(key) ?? 0; seq.set(key, n + 1); out.push({ at, key: n ? `${key}|${n}` : key, html }); };
  let lastTests = 0, lastText = -1;
  const spoken: string[] = [];
  d.actions.forEach((a, i) => {
    const at = ms(a.at);
    if (a.kind === 'prompt') { add(at, 'me', msgHTML(crew.me, at, plain(a.text))); return; }
    if (a.kind === 'tool:Agent' || a.kind === 'tool:Task') {
      // Passation : « Maya a confié … à Léo » ; la consigne complète se déplie. Le n-ième envoi d'un rôle est le n-ième agent de ce rôle.
      if (!a.body && !a.to) return;
      const ps = persona(a.to || ''), k = nth.get(ps.name) ?? 0; nth.set(ps.name, k + 1);
      const w = crew.subs.get(crew.byBase.get(ps.name)?.[k] ?? '') ?? { ...ps, id: '', base: ps.name };
      const what = a.text ? ` « ${esc(oneLine(a.text, 70))} »` : ' une tâche';
      add(at, 'delegate', noteHTML(`<b>${esc(crew.main.name)}</b> a confié${what} à <b class="sl-nm" style="--c:var(--c-${w.hue})">${esc(w.name)}</b>`, at, a.body ?? ''));
      return;
    }
    if (a.kind.startsWith('tool:')) {
      // Un seul événement lisible : les tests ont été lancés (pas la commande).
      if (a.kind === 'tool:Bash' && TESTS.test(a.text) && at - lastTests > 90e3) { lastTests = at; add(at, 'tests', noteHTML('Les tests sont lancés', at)); }
      return;
    }
    lastText = i; spoken.push(norm(a.text));
    add(at, 'ai', msgHTML(crew.main, at, md(a.text), { cls: 'ai' }));
  });
  // Comptes rendus des sous-agents : un message de leur part à l'agent principal, replié s'il est long.
  for (const s of d.subagents ?? []) {
    const w = crew.subs.get(s.id); if (s.live || !s.report || !w) continue;
    spoken.push(norm(s.report));
    const at = ms(s.updated), long = s.report.length > 280 || s.report.split('\n').length > 6;
    add(at, 'report', msgHTML(w, at, long
      ? `<p class="sl-gist">${mention(crew.main)} ${esc(oneLine(s.report, 120))}</p><details class="sl-fold"><summary>Lire le compte rendu${icon('chevron')}</summary>${md(s.report)}</details>`
      : withTo(md(s.report), crew.main)));
  }
  // Tableau d'équipe : seulement l'utilisateur, l'agent principal et les sous-agents de CE fil.
  for (const e of exchanges([], [], board)) {
    const w = e.from === 'Toi' ? crew.me : e.from === 'principal' ? crew.main : crewMember(crew, e.from);
    if (!w || !e.text.trim() || (norm(e.text).length > 0 && spoken.some(x => x.includes(norm(e.text).slice(0, 60))))) continue; // déjà dit (compte rendu, message)
    const to = e.to === 'principal' ? crew.main : e.to && e.to !== 'Toi' ? crewMember(crew, e.to) : null;
    add(e.at, 'board', msgHTML(w, e.at, w.me ? plain(e.text) : withTo(md(e.text), to)));
  }
  out.sort((a, b) => a.at - b.at);
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
  if (st === 'merged') return `<div class="sl-card res"><span class="sl-pill" style="--c:var(--c-violet)">fusionné</span><div class="sl-card-t"><b>${esc(title)}</b><small>Livré dans la branche principale</small></div></div>`;
  return '';
}

function blocksOf(t: Thread, d: Detail | undefined, crew: Crew): { blocks: Block[]; ask: boolean } {
  const id = t.id, blocks: Block[] = [], work = t.group === 'work';
  if (!d) {
    const run = S.runs.find(r => `run:${r.run}` === id || r.session === id);
    if (run) blocks.push({ key: 'first', html: msgHTML(crew.me, ms(run.started), plain(run.prompt)) });
    blocks.push({ key: 'wait', html: `<p class="sl-wait"><span class="spin"></span>${work ? `${esc(crew.main.name)} prend la consigne…` : 'Lecture de la conversation…'}</p>` });
    return { blocks, ask: false };
  }
  const { items, ask } = itemsOf(d, crew, d.worktree ? S.board.get(d.worktree) ?? [] : []);
  for (const i of items) blocks.push({ key: i.key, html: i.html });
  if (!items.length) blocks.push({ key: 'none', html: `<p class="sl-wait">${esc(d.message ?? 'Rien n’a encore été dit dans ce fil.')}</p>` });
  // La dernière réponse de l'agent pose une question : elle est mise en avant, avec un geste pour répondre.
  if (ask && !work) {
    let i = blocks.length - 1; while (i >= 0 && !blocks[i]?.key.startsWith('ai|')) i--;
    const b = blocks[i];
    if (b) blocks[i] = { key: b.key, html: b.html.replace('class="sl-msg', 'class="sl-msg ask').replace('</div></article>', `<div class="sl-ask"><span>${icon('sparkle')}${esc(crew.main.name)} attend ta réponse</span><button class="btn" data-sl="reply">Répondre</button></div></div></article>`) };
  }
  for (const q of S.queued.filter(x => x.session === id))
    blocks.push({ key: `q|${q.id}`, html: msgHTML(crew.me, ms(q.at), plain(q.text), { cls: 'queued', tag: `${icon('history')}en attente` }) });
  if (work) blocks.push({ key: 'working', html: `<p class="sl-wait"><span class="spin"></span>${esc(crew.main.name)} travaille…</p>` });
  const res = resultHTML(t, d);
  if (res) blocks.push({ key: 'result', html: res });
  return { blocks, ask };
}

// ---------- Pièces de la page ----------
function listHTML(th: Thread[], id: string): string {
  if (!S.loaded && !th.length) return '<p class="sl-empty-s"><span class="spin"></span>Lecture des fils…</p>';
  const row = (t: Thread): string => `<button type="button" class="sl-row${t.id === id ? ' cur' : ''}" data-sl="pick" data-id="${esc(t.id)}"${t.id === id ? ' aria-current="true"' : ''}><i class="sl-dot ${t.group}" aria-hidden="true"></i><span class="sl-row-t">${esc(nameOf(t.s))}</span><time>${esc(rel(t.act))}</time></button>`;
  const grp = (title: string, list: Thread[], extra = ''): string => list.length ? `<section class="sl-grp"><h4>${title}<span>${list.length}</span></h4>${list.map(row).join('')}${extra}</section>` : '';
  const rec = th.filter(t => t.group === 'recent');
  const more = rec.length > MORE ? `<button type="button" class="sl-more" data-sl="more">${moreOpen ? 'Moins' : `${rec.length - MORE} de plus`}</button>` : '';
  return grp('En cours', th.filter(t => t.group === 'work')) + grp('À toi', th.filter(t => t.group === 'mine')) + grp('Récentes', moreOpen ? rec : rec.slice(0, MORE), more)
    || '<p class="sl-empty-s">Aucun fil pour l’instant.</p>';
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
  const faces = [crew.main, ...crew.subs.values()].slice(0, 5).map(w => `<span title="${esc(w.name)}">${avatar(w)}</span>`).join('');
  return `<h2>${esc(nameOf(t.s))}</h2><span class="sl-pill" style="--c:var(--c-${c})">${label}</span><span class="sl-meta">${n} agent${n > 1 ? 's' : ''}${min ? ` · ${min} min` : ''}</span><span class="sl-stack">${faces}</span>${run ? `<button type="button" class="btn btn-ghost" data-sl="stop" data-run="${esc(run.run)}" title="Arrêter l’équipe">${icon('stop')}<span>Arrêter</span></button>` : ''}<button type="button" class="btn btn-ghost sl-nowbtn" data-sl="now" aria-pressed="false">Équipe</button>${t.id.startsWith('run:') ? '' : `<button type="button" class="btn" data-sl="tech" data-id="${esc(t.id)}" title="Voir les étapes dans l’onglet Claude Code">${icon('terminal')}<span>Vue technique</span></button>`}`;
}
function nowHTML(t: Thread, d: Detail | undefined, crew: Crew, ask: boolean): string {
  const work = t.group === 'work', lastTool = [...(d?.actions ?? [])].reverse().find(a => a.kind.startsWith('tool:') && doing(a.kind, a.text));
  const line = work && lastTool ? doing(lastTool.kind, lastTool.text) : !work && d?.lines ? `+${d.lines.add} −${d.lines.del}` : '';
  const mem = (w: Who, state: string, cls: string, last: string): string => `<div class="sl-mem ${cls}">${avatar(w)}<div><b>${esc(w.name)}${w.model ? `<em class="sl-model">${esc(w.model)}</em>` : ''}</b><small class="sl-st">${esc(state)}</small>${last ? `<small class="sl-last">${esc(last)}</small>` : ''}</div></div>`;
  const subs = [...(d?.subagents ?? [])].sort((a, b) => Number(b.live) - Number(a.live) || ms(b.updated) - ms(a.updated));
  const rows = [mem(crew.main, work ? 'travaille' : ask ? 'attend ta réponse' : 'a fini', work ? 'on' : ask ? 'ask' : '', line), ...subs.map(s => {
    const w = crew.subs.get(s.id); if (!w) return '';
    const l = s.live ? (s.last?.kind.startsWith('tool:') ? doing(s.last.kind, s.last.text) || 'réfléchit' : 'réfléchit') : s.files?.length ? `${s.files.length} fichier${s.files.length > 1 ? 's' : ''} touché${s.files.length > 1 ? 's' : ''}` : '';
    return mem(w, s.live ? 'travaille' : 'a fini', s.live ? 'on' : '', l);
  })].join('');
  const q = quota.fiveHour(), pct = Math.max(0, Math.min(100, Math.round(q.pct)));
  const gauge = q.known ? `<div class="sl-quota" title="Fenêtre d’usage de 5 h"><span>5 h</span><i class="sl-bar"><i style="width:${pct}%"></i></i><b>${pct} %</b></div>` : '';
  return `<h4>En ce moment</h4>${rows}${gauge}`;
}
const emptyHTML = (name: string, first: boolean): string => `<div class="sl-empty">${avatar({ ...persona('principal'), id: '', base: 'Maya' }, true)}<h3>${first ? `Un salon pour ${esc(name)}` : 'Nouveau fil'}</h3><p>Dis ce que tu veux faire : ${esc(persona('principal').name)} prend la consigne, répartit le travail et te prévient quand c’est prêt.</p><p class="sl-faint">Les fils de ${esc(name)} restent ici : rien ne se mélange avec les autres projets.</p></div>`;

// ---------- Rendu ----------
const grow = (ta: HTMLTextAreaElement): void => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 200)}px`; };
function paint(): void {
  if (!root || !p) return;
  const th = threads(), id = curId(th), cur = th.find(t => t.id === id), d = id ? S.detail.get(id) : undefined;
  const feed = need('[data-sl-feed]', root), ta = need<HTMLTextAreaElement>('textarea', root), key = `${p.id}/${id}`;
  // Un fil lu n'est plus « à toi » (sauf s'il y a une copie à publier, voir `threads`).
  if (cur && cur.group !== 'work' && (seen[cur.id] ?? 0) < cur.act) { seen[cur.id] = cur.act; keepSeen(); }
  // Autre fil : le brouillon du précédent est gardé, celui-ci est repris, le fil repart du bas.
  const switched = key !== shown;
  if (switched) { if (shown) drafts.set(shown, ta.value); ta.value = drafts.get(key) ?? ''; grow(ta); shown = key; feed.replaceChildren(); }
  paintIfChanged(need('[data-sl-list]', root), listHTML(th, id));
  let ask = false, crew: Crew | null = null, blocks: Block[];
  if (cur) { crew = crewOf(d?.subagents ?? [], d?.models ?? cur.s.models); const r = blocksOf(cur, d, crew); blocks = r.blocks; ask = r.ask; }
  else blocks = [{ key: 'empty', html: emptyHTML(p.name, !th.length) }];
  const end = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60, changed = syncFeed(feed, blocks);
  if (switched || (changed && end)) feed.scrollTop = feed.scrollHeight;
  const head = need('[data-sl-head]', root), pressed = root.classList.contains('sl-now-open');
  paintIfChanged(head, cur && crew ? headHTML(cur, crew, ask, 1 + (d?.subagents?.length ?? 0)) : '');
  head.querySelector('[data-sl="now"]')?.setAttribute('aria-pressed', String(pressed));
  paintIfChanged(need('[data-sl-now]', root), cur && crew ? nowHTML(cur, d, crew, ask) : '');
  root.classList.toggle('sl-solo', !cur);
  // Le champ : seul son habillage change, jamais le texte.
  const isNew = !cur, ph = isNew ? 'Dis à l’équipe ce que tu veux faire…' : `Écris à ${crew?.main.name ?? 'Maya'}…`;
  if (ta.placeholder !== ph) ta.placeholder = ph;
  need('[data-sl-mode]', root).hidden = !isNew;
  const hint = need('[data-sl-hint]', root), ht = !isNew && cur?.group === 'work' ? 'Ton message part en attente : l’agent le lit à la fin de son tour.' : '';
  if (hint.textContent !== ht) hint.textContent = ht;
}

async function send(): Promise<void> {
  if (!root || !p || busy) return;
  const ta = need<HTMLTextAreaElement>('textarea', root), text = ta.value.trim(); if (!text) return;
  const id = curId(), btn = need<HTMLButtonElement>('[data-sl-send]', root), pid = p.id, key = `${pid}/${id}`;
  if (id.startsWith('run:')) { toast('L’équipe démarre : réessaie dans un instant.'); return; }
  busy = true; btn.disabled = true;
  // Le champ est vidé tout de suite : pendant l'attente, l'utilisateur peut changer de fil sans que rien ne soit écrasé.
  ta.value = ''; drafts.delete(key); grow(ta);
  let ok = false;
  try {
    if (!id) {
      const r = await startAgent(p, text, need<HTMLSelectElement>('[name=mode]', root).value === 'read' ? 'read' : 'edit');
      if (!r.ok) toast(r.message);
      else { ok = true; chosen.set(pid, r.session || (r.run ? `run:${r.run}` : '')); }
    } else ok = await reply({ project: pid, session: id }, text);
  } finally {
    busy = false; btn.disabled = false;
    if (!ok) {
      // Échec : le texte revient, mais seulement si le champ est encore celui de ce fil et qu'il est vide.
      const cur = root?.isConnected ? root.querySelector('textarea') : null;
      if (cur && shown === key && !cur.value) { cur.value = text; drafts.set(key, text); grow(cur); }
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

function bind(r: HTMLElement): void {
  r.addEventListener('click', e => {
    const t = target(e).closest<HTMLElement>('[data-sl]'); if (!t || !p) return;
    const act = t.dataset.sl, pid = p.id;
    if (act === 'pick') { chosen.set(pid, t.dataset.id ?? ''); paint(); void refresh(); }
    else if (act === 'new') { chosen.set(pid, ''); paint(); need('textarea', r).focus(); }
    else if (act === 'more') { moreOpen = !moreOpen; paint(); }
    else if (act === 'tech') openTech(t.dataset.id ?? '');
    else if (act === 'reply') need('textarea', r).focus();
    else if (act === 'now') { t.setAttribute('aria-pressed', String(r.classList.toggle('sl-now-open'))); }
    else if (act === 'stop') void bridge.call('agent', 'stop', { run: t.dataset.run ?? '' }, 10000).then(x => { toast(x.ok ? 'Équipe arrêtée' : x.message ?? 'Arrêt impossible.'); void refresh(); });
    else if (act === 'publish' || act === 'review' || act === 'pr') void gesture(act, t.dataset.wt ?? '', t as HTMLButtonElement);
  });
  r.addEventListener('submit', e => { e.preventDefault(); void send(); });
  r.addEventListener('input', e => { const t = target(e); if (t instanceof HTMLTextAreaElement) { grow(t); if (p) drafts.set(shown || `${p.id}/${curId()}`, t.value); } });
  r.addEventListener('keydown', e => {
    if (target(e) instanceof HTMLTextAreaElement && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
  });
}

/** Monte le Salon du projet `proj` dans `box`. `o.openTech` ouvre une conversation dans l'onglet Claude Code. */
export function mount(box: HTMLElement, proj: Project, o: { openTech: (session: string) => void }): void {
  stop();
  if (S.pid !== proj.id) reset(proj.id);
  p = proj; root = box; openTech = o.openTech; shown = '';
  box.innerHTML = `<aside class="sl-side" aria-label="Fils du projet"><div class="sl-side-h"><b>Fils</b><button type="button" class="btn" data-sl="new">${icon('plus')}<span>Nouveau fil</span></button></div><div class="sl-list" data-sl-list></div></aside>
    <section class="sl-center"><header class="sl-head" data-sl-head></header><div class="sl-feed" data-sl-feed role="log" aria-live="polite" aria-label="Discussion"></div>
      <form class="sl-comp" autocomplete="off"><textarea rows="1" aria-label="Ton message" placeholder="Dis à l’équipe ce que tu veux faire…"></textarea>
        <div class="sl-comp-row"><label class="sl-mode" data-sl-mode hidden><select name="mode" aria-label="Mode"><option value="edit">Modifier</option><option value="read">Analyser</option></select></label><span class="sl-hint" data-sl-hint></span><button type="submit" class="btn btn-primary" data-sl-send>Envoyer</button></div></form></section>
    <aside class="sl-now" data-sl-now aria-label="En ce moment"></aside>`;
  box.classList.add('sl-box', 'sl-solo');
  if (!box.dataset.slBound) { box.dataset.slBound = '1'; bind(box); }
  // La jauge se met à jour seule ; l'abonnement n'est pris qu'une fois (il repeint le Salon monté à ce moment-là).
  if (!quotaHooked) { quotaHooked = true; quota.onChange(() => { if (root?.isConnected) paint(); }); }
  paint(); start();
}
