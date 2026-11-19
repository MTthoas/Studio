// Suivi en direct d'une session Claude Code, au-dessus de son fil : une bande d'état sobre, façon terminal.
// Une ligne pour l'étape en cours (verbe + cible), le temps écoulé, des compteurs discrets, une frise fine des
// dernières actions et les fichiers touchés. Mise à jour en place (relecture du Mac toutes les 3 s) : le contenu
// n'est réécrit que s'il change (paintIfChanged), et seul le chrono bat chaque seconde.
import { esc } from '../../lib/markdown.ts';
import { need, paintIfChanged } from '../../ui/kit.ts';
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
/** Verbe de l'étape, par outil quand on le connaît, sinon par famille. */
const TOOL_VERB: Record<string, string> = { Read: 'Lit', Grep: 'Cherche', Glob: 'Cherche', LS: 'Liste', WebFetch: 'Consulte', WebSearch: 'Cherche', Edit: 'Modifie', MultiEdit: 'Modifie', NotebookEdit: 'Modifie', Write: 'Écrit', Bash: 'Lance', BashOutput: 'Lit la sortie', Task: 'Délègue', Agent: 'Délègue' };
const VERB: Record<Cat, string> = { explore: 'Lit', edit: 'Modifie', run: 'Lance', task: 'Délègue', answer: 'Répond', other: 'Prépare' };
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const ms = (iso: string) => Date.parse(iso) || 0;
const clockOf = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const fr = (n: number) => n.toLocaleString('fr-FR');

function skeleton(): string {
  return `<section class="lv" data-state="idle" aria-label="Travail de Claude en direct">
    <div class="lv-head"><span class="lv-now"></span><time class="lv-clock">0:00</time></div>
    <div class="lv-rest"></div>
  </section>`;
}

const clocks = new WeakMap<HTMLElement, ReturnType<typeof setInterval>>();

/** Pose ou met à jour le suivi dans `box`. */
export function paintPulse(box: HTMLElement, d: PulseInput): void {
  if (!box.querySelector('.lv')) box.innerHTML = skeleton();
  const root = need('.lv', box);
  const acts = d.actions, lastPrompt = acts.map(a => a.kind).lastIndexOf('prompt');
  const turn = acts.slice(lastPrompt + 1), last = turn[turn.length - 1];
  const state = d.working ? 'work' : acts.length ? 'done' : 'idle';
  root.dataset.state = state;

  // Étape en cours : verbe + cible (chemin ou commande, en chasse fixe).
  const tool = last?.kind.startsWith('tool:') ? last.kind.slice(5) : '';
  const verb = d.working ? (tool ? TOOL_VERB[tool] ?? VERB[catOf(last as PulseAction)] : last ? VERB[catOf(last)] : 'Prépare') : state === 'done' ? 'Terminé' : 'Prêt';
  const target = d.working && tool && last ? (catOf(last) === 'edit' || tool === 'Read' ? d.short(last.text) : last.text) : '';
  paintIfChanged(need('.lv-now', root), `<i class="lv-dot"></i><b>${esc(verb)}</b>${target ? `<code title="${esc(target)}">${esc(target)}</code>` : ''}`);

  // Chronomètre du tour : bat chaque seconde tant que Claude travaille.
  const clockEl = need('.lv-clock', root);
  const t0 = ms(acts[lastPrompt]?.at ?? '') || ms(d.started), t1 = d.working ? 0 : ms(last?.at ?? '') || t0;
  const tickClock = () => { if (t0) clockEl.textContent = clockOf(Math.max(0, Math.round(((t1 || Date.now()) - t0) / 1000))); };
  tickClock();
  clearInterval(clocks.get(root));
  if (d.working) clocks.set(root, setInterval(() => { if (!root.isConnected) { clearInterval(clocks.get(root)); return; } tickClock(); }, 1000));

  // Compteurs (toute la session), seulement ceux qui ont une valeur.
  const lines = d.lines ?? acts.reduce((a, x) => ({ add: a.add + num(x.add), del: a.del + num(x.del) }), { add: 0, del: 0 });
  const n = Object.values(d.tools).reduce((a, b) => a + b, 0) || acts.filter(a => a.kind.startsWith('tool:')).length;
  const stat = (v: number, one: string, many = one + 's') => v ? `<span><b>${fr(v)}</b> ${v > 1 ? many : one}</span>` : '';
  const meta = stat(n, 'action') + stat(d.files.length, 'fichier')
    + (lines.add || lines.del ? `<span class="lv-lines"><b class="a">+${fr(lines.add)}</b> <b class="d">−${fr(lines.del)}</b></span>` : '')
    + (d.tokens.output ? `<span><b>${esc(usage.fmt(d.tokens.output))}</b> tokens</span>` : '');

  // Frise : un segment par action, neutre ; l'écriture de fichier est plus haute et plus sombre ; le dernier bat tant que ça travaille.
  const marks = acts.slice(-64);
  const tape = marks.map((a, i) => {
    const c = a.kind === 'prompt' ? 'prompt' : catOf(a), cur = d.working && i === marks.length - 1;
    const tip = a.kind === 'prompt' ? 'Ta demande' : a.kind === 'text' ? 'Réponse' : `${a.kind.slice(5)} ${d.short(a.text)}`;
    return `<i class="k-${c}${cur ? ' cur' : ''}" title="${esc(tip)}"></i>`;
  }).join('');

  // Fichiers touchés : les plus récents d'abord, chemin et lignes +/−.
  const per = new Map<string, { add: number; del: number; at: number }>();
  for (const a of acts) {
    if (catOf(a) !== 'edit' || !a.text) continue;
    const f = per.get(a.text) ?? { add: 0, del: 0, at: 0 };
    f.add += num(a.add); f.del += num(a.del); f.at = Math.max(f.at, ms(a.at)); per.set(a.text, f);
  }
  const rows = [...per].sort((a, b) => b[1].at - a[1].at), shown = rows.slice(0, 5);
  const files = shown.map(([p, f]) => `<div class="lv-file"><code title="${esc(p)}">${esc(d.short(p))}</code><span><b class="a">+${fr(f.add)}</b> <b class="d">−${fr(f.del)}</b></span></div>`).join('')
    + (rows.length > shown.length ? `<p class="lv-more">et ${rows.length - shown.length} autre${rows.length - shown.length > 1 ? 's' : ''}</p>` : '');

  paintIfChanged(need('.lv-rest', root), (meta ? `<p class="lv-meta">${meta}</p>` : '') + (tape ? `<div class="lv-tape" aria-hidden="true">${tape}</div>` : '') + (files ? `<div class="lv-files">${files}</div>` : ''));
}
