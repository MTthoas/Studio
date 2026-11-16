// Graphe d'un workflow GitHub Actions (onglet Flux d'un projet), en direct : les jobs d'une exécution et leurs
// dépendances (`needs` lus dans le fichier du workflow, au commit de l'exécution), l'état et la durée de chacun, l'attente
// d'un runner, les étapes d'un clic. En dessous, l'historique : la durée des 20 dernières exécutions (une barre chacune,
// couleur = état), la réussite, la durée médiane. Cliquer une barre affiche son exécution dans le graphe.
import * as github from '../../integrations/github/api.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, rel, errMsg } from '../../ui/kit.ts';

type NodeState = 'success' | 'failure' | 'running' | 'queued' | 'skipped' | 'cancelled' | 'waiting';
interface GNode { id: string; key: string; label: string; level: number; job?: github.Job; state: NodeState; needs: string[] }

const W = 212, H = 58, GX = 56, GY = 12, PAD = 14;
/** Workflows dépliés (dépôt|nom) ; le premier du dépôt l'est par défaut. Exécution choisie dans l'historique. */
const open = new Map<string, boolean>(), chosen = new Map<string, number>();
const known = new Map<string, { repo: string; wf: github.Workflow }>();
/** Dernier rendu de chaque panneau : remis tout de suite quand le flux se redessine (pas de clignotement). */
const lastHtml = new Map<string, string>();
const selJob = new Map<string, number>();
let pollTimer: ReturnType<typeof setTimeout> | undefined;

const keyOf = (repo: string, wf: string) => `${repo}|${wf}`;
export const isOpen = (repo: string, wf: string, first: boolean): boolean => open.get(keyOf(repo, wf)) ?? first;

const STATE: Record<NodeState, [string, string, string]> = {
  success: ['green', 'check', 'réussi'], failure: ['red', 'x', 'en échec'], running: ['amber', '', 'en cours'], queued: ['amber', 'hourglass', 'en attente d’un runner'],
  skipped: ['gray', '', 'ignoré'], cancelled: ['gray', 'stop', 'annulé'], waiting: ['gray', '', 'à venir'],
};
const jobState = (j?: github.Job): NodeState => !j ? 'waiting' : j.status === 'in_progress' ? 'running' : j.status !== 'completed' ? 'queued'
  : j.conclusion === 'success' ? 'success' : j.conclusion === 'skipped' ? 'skipped' : j.conclusion === 'cancelled' ? 'cancelled' : 'failure';
const dur = (s: number) => { s = Math.max(0, Math.round(s)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`; };
const secs = (a?: string | null, b?: string | null) => a ? ((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000 : 0;

/** Bouton de la ligne d'un workflow, qui déplie son graphe. */
export function toggleHTML(repo: string, w: github.Workflow, first: boolean): string {
  known.set(keyOf(repo, w.name), { repo, wf: w });
  const on = isOpen(repo, w.name, first);
  return `<button class="icon-btn ci-toggle${on ? ' on' : ''}" data-ci-toggle="${esc(keyOf(repo, w.name))}" aria-expanded="${on}" title="${on ? 'Masquer le graphe' : 'Graphe des jobs et historique'}" aria-label="Graphe des jobs">${icon('graph')}</button>`;
}
/** Emplacement du panneau sous la ligne (rempli par `hydrate`). */
export function panelHTML(repo: string, w: github.Workflow, first: boolean): string {
  if (!isOpen(repo, w.name, first)) return '';
  const k = keyOf(repo, w.name);
  return `<div class="ci-panel" data-ci="${esc(k)}">${lastHtml.get(k) ?? '<p class="ci-wait"><span class="spin"></span>Lecture des jobs…</p>'}</div>`;
}

/** Remplit les panneaux présents dans `box`, et les suit tant qu'une exécution affichée tourne. */
export async function hydrate(box: HTMLElement): Promise<void> {
  clearTimeout(pollTimer);
  const slots = [...box.querySelectorAll<HTMLElement>('.ci-panel')];
  const live = await Promise.all(slots.map(s => paint(s)));
  if (live.some(Boolean)) pollTimer = setTimeout(() => { if (box.isConnected && !document.hidden) void hydrate(box); else if (box.isConnected) document.addEventListener('visibilitychange', () => void hydrate(box), { once: true }); }, 5000);
}

async function paint(slot: HTMLElement, fresh = true): Promise<boolean> {
  const k = slot.dataset.ci ?? '', hit = known.get(k); if (!hit) return false;
  const { repo, wf } = hit, runs = wf.runs, pick = chosen.get(k), run = runs.find(r => r.id === pick) ?? runs[runs.length - 1];
  if (!run) { slot.innerHTML = '<p class="ci-wait">Aucune exécution.</p>'; return false; }
  try {
    const [jobs, decl] = await Promise.all([github.runJobs(repo, run.id, { fresh }), github.workflowJobs(repo, run.path || wf.last.path, run.sha || wf.last.sha)]);
    if (!slot.isConnected) return false;
    const html = `${headHTML(repo, wf, run, jobs)}${graphHTML(k, decl, jobs)}${stepsHTML(k, jobs)}${historyHTML(k, wf, run.id, jobs)}`;
    lastHtml.set(k, html);
    if (slot.innerHTML !== html) slot.innerHTML = html;
    return run.state === 'pending' || jobs.some(j => j.status !== 'completed');
  } catch (e) { slot.innerHTML = `<p class="ci-wait">${esc(errMsg(e))}</p>`; return false; }
}

function headHTML(repo: string, wf: github.Workflow, run: github.RunPoint, jobs: github.Job[]): string {
  const first = jobs.reduce<string | null>((a, j) => !a || j.created_at < a ? j.created_at : a, null);
  const lastEnd = jobs.every(j => j.completed_at) ? jobs.reduce<string | null>((a, j) => !a || (j.completed_at ?? '') > a ? j.completed_at : a, null) : null;
  const total = run.seconds ?? (first ? secs(first, lastEnd) : 0);
  const [c, ic, l] = STATE[run.state === 'pending' ? 'running' : run.state === 'success' ? 'success' : run.conclusion === 'cancelled' ? 'cancelled' : 'failure'];
  return `<header class="ci-head"><span class="ci-badge" style="--c:var(--c-${c})">${ic ? icon(ic) : '<span class="ci-ring"></span>'}${l}</span>
    <strong>${esc(wf.name)}${run.number ? ` #${run.number}` : ''}</strong><code>${esc(run.branch)}</code><span class="ci-meta">${esc(rel(Date.parse(run.at)))}${total ? ` · ${dur(total)}` : ''}</span>
    <a class="link-btn" href="${esc(run.url)}" target="_blank" rel="noopener">Ouvrir sur GitHub</a></header>`;
}

/** Nœuds : un par job déclaré (un par variante de matrice une fois lancés) ; colonnes = profondeur dans les `needs`. */
function nodes(decl: github.WfJob[], jobs: github.Job[]): GNode[] {
  const used = new Set<number>(), out: GNode[] = [];
  const level = new Map<string, number>();
  const depth = (k: string, seen = new Set<string>()): number => {
    if (level.has(k)) return level.get(k) ?? 0;
    if (seen.has(k)) return 0; seen.add(k);
    const d = decl.find(x => x.key === k), v = d && d.needs.length ? 1 + Math.max(...d.needs.map(n => depth(n, seen))) : 0;
    level.set(k, v); return v;
  };
  for (const d of decl) {
    const stem = d.name.split('${{')[0]?.trim() || d.key;
    const mine = jobs.filter(j => !used.has(j.id) && (j.name === d.name || j.name === d.key || j.name.startsWith(`${stem} (`) || (stem !== d.name && j.name.startsWith(stem))));
    mine.forEach(j => used.add(j.id));
    const lv = depth(d.key);
    if (!mine.length) out.push({ id: `k:${d.key}`, key: d.key, label: d.name.includes('${{') ? stem : d.name, level: lv, state: 'waiting', needs: d.needs });
    for (const j of mine) out.push({ id: `j:${j.id}`, key: d.key, label: j.name, level: lv, job: j, state: jobState(j), needs: d.needs });
  }
  // Jobs que le fichier ne décrit pas (workflow réutilisé, fichier illisible) : à la suite, dans l'ordre de départ.
  for (const j of jobs.filter(x => !used.has(x.id)).sort((a, b) => a.created_at.localeCompare(b.created_at)))
    out.push({ id: `j:${j.id}`, key: `#${j.id}`, label: j.name, level: decl.length ? 0 : out.length, job: j, state: jobState(j), needs: [] });
  return out;
}

function graphHTML(k: string, decl: github.WfJob[], jobs: github.Job[]): string {
  const list = nodes(decl, jobs);
  if (!list.length) return '<p class="ci-wait">Pas encore de job.</p>';
  const cols = Math.max(...list.map(n => n.level)) + 1, rows = new Map<number, GNode[]>();
  for (const n of list) { const r = rows.get(n.level) ?? []; r.push(n); rows.set(n.level, r); }
  const maxRows = Math.max(...[...rows.values()].map(r => r.length));
  const width = PAD * 2 + cols * W + (cols - 1) * GX, height = PAD * 2 + maxRows * H + (maxRows - 1) * GY;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [lv, r] of rows) {
    const off = (maxRows - r.length) * (H + GY) / 2; // colonne centrée verticalement
    r.forEach((n, i) => pos.set(n.id, { x: PAD + lv * (W + GX), y: PAD + off + i * (H + GY) }));
  }
  const edges: string[] = [];
  for (const n of list) for (const need of n.needs) for (const src of list.filter(x => x.key === need)) {
    const a = pos.get(src.id), b = pos.get(n.id); if (!a || !b) continue;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
    const flow = n.state === 'running' || n.state === 'queued' ? ' flow' : '', done = src.state === 'success' ? ' done' : src.state === 'failure' ? ' bad' : '';
    edges.push(`<path class="ci-edge${done}${flow}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`);
  }
  const sel = selJob.get(k);
  const box = (n: GNode) => {
    const p = pos.get(n.id) ?? { x: 0, y: 0 }, [c, ic, l] = STATE[n.state], j = n.job;
    const steps = j?.steps ?? [], doneSteps = steps.filter(s => s.status === 'completed').length;
    const meta = n.state === 'queued' ? `${l} · ${dur(secs(j?.created_at))}`
      : n.state === 'running' ? `${dur(secs(j?.started_at))}${steps.length ? ` · étape ${Math.min(doneSteps + 1, steps.length)}/${steps.length}` : ''}`
      : j?.started_at && j.completed_at && n.state !== 'skipped' ? `${dur(secs(j.started_at, j.completed_at))}${secs(j.created_at, j.started_at) > 20 ? ` · attente ${dur(secs(j.created_at, j.started_at))}` : ''}` : l;
    return `<button type="button" class="ci-node st-${n.state}${j && j.id === sel ? ' sel' : ''}" style="left:${p.x}px;top:${p.y}px;width:${W}px;height:${H}px;--c:var(--c-${c})" ${j ? `data-ci-job="${j.id}" data-ci-k="${esc(k)}"` : 'disabled'} title="${esc(`${n.label} : ${l}`)}">
      <span class="ci-ic">${n.state === 'running' ? '<span class="ci-ring"></span>' : ic ? icon(ic) : ''}</span><span class="ci-txt"><b>${esc(n.label)}</b><em>${esc(meta)}</em></span></button>`;
  };
  return `<div class="ci-graph" role="group" aria-label="Jobs de l’exécution"><div class="ci-canvas" style="width:${width}px;height:${height}px"><svg width="${width}" height="${height}" aria-hidden="true">${edges.join('')}</svg>${list.map(box).join('')}</div></div>`;
}

function stepsHTML(k: string, jobs: github.Job[]): string {
  const j = jobs.find(x => x.id === selJob.get(k)); if (!j) return '';
  return `<div class="ci-steps"><header><strong>${esc(j.name)}</strong>${j.runner_name ? `<span class="ci-meta">${icon('server')}${esc(j.runner_name)}</span>` : j.labels.length ? `<span class="ci-meta">${icon('server')}${esc(j.labels.join(', '))}</span>` : ''}<a class="link-btn" href="${esc(j.html_url)}" target="_blank" rel="noopener">Logs sur GitHub</a></header>
    <ol>${j.steps.map(s => { const st = s.status !== 'completed' ? (s.status === 'in_progress' ? 'running' : 'waiting') : jobState({ ...j, status: 'completed', conclusion: s.conclusion }); const [c, ic, l] = STATE[st];
      return `<li style="--c:var(--c-${c})"><span class="ci-ic">${st === 'running' ? '<span class="ci-ring"></span>' : ic ? icon(ic) : ''}</span><span>${esc(s.name)}</span><em>${s.started_at && st !== 'waiting' && st !== 'skipped' ? dur(secs(s.started_at, s.completed_at)) : l}</em></li>`; }).join('')}</ol></div>`;
}

function historyHTML(k: string, wf: github.Workflow, cur: number, jobs: github.Job[]): string {
  const runs = wf.runs, done = runs.filter(r => r.seconds !== null);
  if (!runs.length) return '';
  const ok = runs.filter(r => r.state === 'success').length, finished = runs.filter(r => r.state !== 'pending').length;
  const sorted = done.map(r => r.seconds ?? 0).sort((a, b) => a - b), med = sorted.length ? sorted[Math.floor(sorted.length / 2)] ?? 0 : 0;
  const wait = jobs.reduce((m, j) => Math.max(m, j.started_at ? secs(j.created_at, j.started_at) : j.status !== 'completed' ? secs(j.created_at) : 0), 0);
  const max = Math.max(60, ...done.map(r => r.seconds ?? 0)), BW = 14, GAP = 2, HH = 64, width = runs.length * (BW + GAP);
  const bars = runs.map((r, i) => {
    const h = r.seconds === null ? 6 : Math.max(4, Math.round((r.seconds / max) * HH)), y = HH - h;
    const c = r.state === 'success' ? 'green' : r.state === 'failure' ? (r.conclusion === 'cancelled' ? 'gray' : 'red') : 'amber';
    const tip = `#${r.number || ''} · ${r.branch} · ${r.seconds === null ? 'en cours' : dur(r.seconds)} · ${r.state === 'success' ? 'réussie' : r.state === 'pending' ? 'en cours' : r.conclusion === 'cancelled' ? 'annulée' : 'en échec'} · ${rel(Date.parse(r.at))}`;
    return `<g class="ci-bar${r.id === cur ? ' sel' : ''}" data-ci-run="${r.id}" data-ci-k="${esc(k)}" tabindex="0" role="button" aria-label="${esc(tip)}"><title>${esc(tip)}</title><rect class="hit" x="${i * (BW + GAP)}" y="0" width="${BW + GAP}" height="${HH}"/><path d="M${i * (BW + GAP)} ${HH} V${y + 3} q0 -3 3 -3 h${BW - 6} q3 0 3 3 V${HH} Z" style="fill:var(--c-${c})"/></g>`;
  }).join('');
  const stat = (v: string, l: string) => `<div class="ci-stat"><b>${v}</b><span>${l}</span></div>`;
  return `<div class="ci-hist"><div class="ci-stats">${stat(finished ? `${Math.round(ok / finished * 100)} %` : '—', `réussite (${ok}/${finished})`)}${stat(med ? dur(med) : '—', 'durée médiane')}${stat(wait > 1 ? dur(wait) : '—', 'plus longue attente d’un runner (exécution affichée)')}</div>
    <figure class="ci-chart"><figcaption>Durée des ${runs.length} dernières exécutions <span>· clique une barre pour l’afficher · max ${dur(max)}</span></figcaption><svg width="${width}" height="${HH + 1}" viewBox="0 0 ${width} ${HH + 1}" role="list">${bars}<line class="ci-base" x1="0" x2="${width}" y1="${HH + 0.5}" y2="${HH + 0.5}"/></svg></figure></div>`;
}

/** Clics du panneau (à brancher sur la boîte du flux). Renvoie vrai si le clic était pour lui. */
export function onClick(e: Event, box: HTMLElement): boolean {
  const t = e.target as Element;
  const tg = t.closest<HTMLElement>('[data-ci-toggle]');
  if (tg) {
    const k = tg.dataset.ciToggle ?? '', on = tg.getAttribute('aria-expanded') !== 'true';
    open.set(k, on);
    const row = tg.closest('.fx-act'), next = row?.nextElementSibling;
    if (!on) { if (next?.classList.contains('ci-panel')) next.remove(); }
    else if (row) { row.insertAdjacentHTML('afterend', `<div class="ci-panel" data-ci="${esc(k)}">${lastHtml.get(k) ?? '<p class="ci-wait"><span class="spin"></span>Lecture des jobs…</p>'}</div>`); void hydrate(box); }
    tg.setAttribute('aria-expanded', String(on)); tg.classList.toggle('on', on);
    return true;
  }
  const bar = t.closest<SVGGElement>('[data-ci-run]');
  if (bar) { const k = bar.dataset.ciK ?? ''; chosen.set(k, Number(bar.dataset.ciRun)); selJob.delete(k); repaint(box, k); return true; }
  const node = t.closest<HTMLElement>('[data-ci-job]');
  if (node) { const k = node.dataset.ciK ?? '', id = Number(node.dataset.ciJob); if (selJob.get(k) === id) selJob.delete(k); else selJob.set(k, id); repaint(box, k, false); return true; }
  return false;
}
export function onKey(e: KeyboardEvent, box: HTMLElement): void {
  if ((e.key === 'Enter' || e.key === ' ') && (e.target as Element).closest('[data-ci-run]')) { e.preventDefault(); onClick(e, box); }
}
function repaint(box: HTMLElement, k: string, fresh = true): void {
  const slot = [...box.querySelectorAll<HTMLElement>('.ci-panel')].find(s => s.dataset.ci === k);
  if (slot) void paint(slot, fresh).then(live => { if (live) void hydrate(box); });
}
