// Tableau de bord en direct d'une session Claude Code, au-dessus de son fil : étape en cours, chronomètre,
// compteurs qui montent, ruban des actions et fichiers modifiés. Il se met à jour en place (jamais redessiné en
// entier) pour que les animations jouent entre deux relectures du Mac (toutes les 3 s), et le chrono bat chaque seconde.
import { esc } from '../../lib/markdown.ts';
import { icon, need } from '../../ui/kit.ts';
import * as usage from '../../integrations/usage.ts';

export interface PulseAction { at: string; kind: string; text: string; add?: number | string; del?: number | string }
export interface PulseInput {
  actions: PulseAction[]; tools: Record<string, number>; files: string[];
  tokens: { output: number }; lines?: { add: number; del: number }; started: string; working: boolean;
  short: (path: string) => string;
}

type Cat = 'explore' | 'edit' | 'run' | 'task' | 'answer' | 'other';
const CAT: Record<string, Cat> = {
  Read: 'explore', Glob: 'explore', Grep: 'explore', LS: 'explore', NotebookRead: 'explore', WebFetch: 'explore', WebSearch: 'explore',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'run', BashOutput: 'run', KillShell: 'run', KillBash: 'run',
  Task: 'task', Agent: 'task',
};
const catOf = (a: PulseAction): Cat => a.kind === 'text' ? 'answer' : a.kind.startsWith('tool:') ? CAT[a.kind.slice(5)] ?? 'other' : 'other';
const STEPS: [Cat, string, string][] = [['explore', 'Explore', 'search'], ['edit', 'Modifie', 'pencil'], ['run', 'Vérifie', 'terminal'], ['answer', 'Répond', 'sparkle']];
const VERB: Record<Cat, string> = { explore: 'Lit', edit: 'Modifie', run: 'Lance', task: 'Délègue', answer: 'Répond', other: 'Prépare' };
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const ms = (iso: string) => Date.parse(iso) || 0;
const sum = (tools: Record<string, number>, names: string[]) => names.reduce((a, n) => a + (tools[n] ?? 0), 0);
const clockOf = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const STATS: [key: string, label: string, ic: string, fmt?: (n: number) => string][] = [
  ['add', 'lignes ajoutées', 'plus'], ['del', 'lignes retirées', 'trash'], ['edited', 'fichiers modifiés', 'pencil'],
  ['read', 'lectures et recherches', 'search'], ['run', 'commandes', 'terminal'], ['tok', 'tokens écrits', 'bolt', n => usage.fmt(n)],
];

function skeleton(): string {
  return `<section class="pl" data-state="idle" aria-label="Travail de Claude en direct">
    <header class="pl-head"><span class="pl-orb" aria-hidden="true"><i></i></span><strong data-pl-phase></strong><span class="pl-now" data-pl-now></span>
      <span class="pl-rate" data-pl-rate></span><time class="pl-clock" data-pl-clock>0:00</time></header>
    <ol class="pl-steps">${STEPS.map(([c, l, ic]) => `<li data-step="${c}">${icon(ic)}<span>${l}</span></li>`).join('')}</ol>
    <div class="pl-stats">${STATS.map(([k, l, ic]) => `<div class="pl-stat" data-stat="${k}">${icon(ic)}<b data-v="0">0</b><span>${l}</span></div>`).join('')}</div>
    <div class="pl-ribbon" data-pl-ribbon aria-hidden="true"></div>
    <div class="pl-files" data-pl-files></div>
    <div class="pl-burst" aria-hidden="true">${Array.from({ length: 14 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
  </section>`;
}

/** Fait monter un compteur jusqu'à sa nouvelle valeur, avec un petit saut quand il augmente. */
function count(el: HTMLElement, to: number, fmt: (n: number) => string): void {
  const from = Number(el.dataset.v) || 0; el.dataset.v = String(to);
  if (from === to) { el.textContent = fmt(to); return; }
  const card = el.closest<HTMLElement>('.pl-stat');
  if (to > from && card) { card.classList.remove('bump'); void card.offsetWidth; card.classList.add('bump'); }
  if (calm() || !el.isConnected) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 700;
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (k < 1 && el.dataset.v === String(to)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const clocks = new WeakMap<HTMLElement, ReturnType<typeof setInterval>>();
/** Ce qui était affiché au tour d'avant : ce qui est nouveau s'anime, le reste non. */
const drawnMarks = new WeakMap<HTMLElement, Set<string>>(), drawnFiles = new WeakMap<HTMLElement, Map<string, string>>();

/** Pose ou met à jour le tableau de bord dans `box`. */
export function paintPulse(box: HTMLElement, d: PulseInput): void {
  if (!box.querySelector('.pl')) box.innerHTML = skeleton();
  const root = need('.pl', box), q = (s: string) => need(s, root);
  const acts = d.actions, lastPrompt = acts.map(a => a.kind).lastIndexOf('prompt');
  const turn = acts.slice(lastPrompt + 1), last = turn[turn.length - 1];
  const before = root.dataset.state;
  const state = d.working ? 'work' : acts.length ? 'done' : 'idle';
  root.dataset.state = state;
  // Fin d'un tour suivi en direct : la petite fête, une fois.
  if (before === 'work' && state === 'done' && !calm()) { root.classList.remove('win'); void root.offsetWidth; root.classList.add('win'); }

  // Étape en cours et celles déjà franchies dans ce tour.
  const cur: Cat = d.working ? (last ? catOf(last) : 'explore') : 'answer';
  const seen = new Set(turn.map(catOf));
  root.querySelectorAll<HTMLElement>('.pl-steps li').forEach(li => {
    const c = li.dataset.step as Cat;
    li.classList.toggle('on', d.working && (c === cur || (cur === 'task' || cur === 'other') && c === 'explore' && !seen.has('edit')));
    li.classList.toggle('done', !d.working ? seen.has(c) || c === 'answer' : seen.has(c) && c !== cur);
  });
  q('[data-pl-phase]').textContent = d.working ? `${VERB[cur]}…` : state === 'done' ? 'Terminé' : 'Prêt';
  const now = d.working && last && last.kind.startsWith('tool:') ? d.short(last.text) : '';
  const nowEl = q('[data-pl-now]');
  if (nowEl.dataset.t !== now) { nowEl.dataset.t = now; nowEl.innerHTML = now ? `<span>${esc(now)}</span>` : ''; }
  const minute = acts.filter(a => a.kind.startsWith('tool:') && Date.now() - ms(a.at) < 60000).length;
  q('[data-pl-rate]').innerHTML = d.working && minute ? `${icon('bolt')}${minute} action${minute > 1 ? 's' : ''}/min` : '';

  // Chronomètre du tour : bat chaque seconde tant que Claude travaille.
  const clockEl = q('[data-pl-clock]');
  const t0 = ms(acts[lastPrompt]?.at ?? '') || ms(d.started), t1 = d.working ? 0 : ms(last?.at ?? '') || t0;
  const tickClock = () => { if (t0) clockEl.textContent = clockOf(Math.max(0, Math.round(((t1 || Date.now()) - t0) / 1000))); };
  tickClock();
  clearInterval(clocks.get(root));
  if (d.working) clocks.set(root, setInterval(() => { if (!root.isConnected) { clearInterval(clocks.get(root)); return; } tickClock(); }, 1000));

  // Compteurs : toute la session.
  const lines = d.lines ?? acts.reduce((a, x) => ({ add: a.add + num(x.add), del: a.del + num(x.del) }), { add: 0, del: 0 });
  const vals: Record<string, number> = {
    add: lines.add, del: lines.del, edited: d.files.length,
    read: sum(d.tools, ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']), run: sum(d.tools, ['Bash', 'BashOutput']), tok: d.tokens.output,
  };
  for (const [k, , , fmt] of STATS) count(q(`[data-stat="${k}"] b`), vals[k] ?? 0, fmt ?? (n => n.toLocaleString('fr-FR')));

  // Ruban : une marque par action, colorée par sorte ; les nouvelles poussent, la dernière bat.
  const ribbon = q('[data-pl-ribbon]'), marks = acts.slice(-72);
  const keys = `${d.working ? 1 : 0}|` + marks.map(a => `${a.at}|${a.kind}`).join(',');
  if (ribbon.dataset.k !== keys) {
    const had = drawnMarks.get(ribbon);
    ribbon.dataset.k = keys; drawnMarks.set(ribbon, new Set(marks.map(a => `${a.at}|${a.kind}`)));
    ribbon.innerHTML = marks.map((a, i) => {
      const c = a.kind === 'prompt' ? 'prompt' : catOf(a), size = Math.min(1, 0.35 + (num(a.add) + num(a.del)) / 60);
      const fresh = !!had && !had.has(`${a.at}|${a.kind}`);
      return `<i class="k-${c}${fresh ? ' new' : ''}${d.working && i === marks.length - 1 ? ' last' : ''}" style="--h:${a.kind.startsWith('tool:') ? size : c === 'prompt' ? 1 : 0.55}" title="${esc(a.kind === 'prompt' ? 'Ta demande' : a.kind === 'text' ? 'Réponse' : `${a.kind.slice(5)} ${d.short(a.text)}`)}"></i>`;
    }).join('');
  }

  // Fichiers modifiés : lignes ajoutées et retirées, barre à l'échelle du plus gros ; ceux qui viennent de bouger s'allument.
  const per = new Map<string, { add: number; del: number; n: number; at: number }>();
  for (const a of acts) {
    if (catOf(a) !== 'edit' || !a.text) continue;
    const f = per.get(a.text) ?? { add: 0, del: 0, n: 0, at: 0 };
    f.add += num(a.add); f.del += num(a.del); f.n++; f.at = Math.max(f.at, ms(a.at)); per.set(a.text, f);
  }
  const rows = [...per].sort((a, b) => b[1].at - a[1].at).slice(0, 8), max = Math.max(1, ...rows.map(([, f]) => f.add + f.del));
  const filesEl = q('[data-pl-files]'), fk = rows.map(([p, f]) => `${p}:${f.add}:${f.del}`).join('|');
  if (filesEl.dataset.k !== fk) {
    const prev = drawnFiles.get(filesEl);
    filesEl.dataset.k = fk; drawnFiles.set(filesEl, new Map(rows.map(([p, f]) => [p, `${f.add}:${f.del}`])));
    filesEl.innerHTML = rows.length ? rows.map(([p, f]) => {
      const hot = !!prev && prev.get(p) !== `${f.add}:${f.del}`;
      return `<div class="pl-file${hot ? ' hot' : ''}"><code title="${esc(p)}">${esc(d.short(p))}</code><span class="pl-bar"><i class="a" style="--w:${(f.add / max) * 100}%"></i><i class="d" style="--w:${(f.del / max) * 100}%"></i></span><span class="pl-delta"><b class="a">+${f.add}</b><b class="d">−${f.del}</b></span></div>`;
    }).join('') : '';
  }
}
