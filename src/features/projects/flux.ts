// Onglet « Flux » d'un projet : le parcours de chaque branche, façon gitflow.
//   branche de travail → PR (CI, revue) → prête → fusionnée dans la branche principale → publiée (Release)
// Les données viennent de GitHub ; les branches qui n'existent que sur le Mac sont ajoutées par l'app.
import * as github from '../../integrations/github/api.ts';
import * as native from '../../core/native.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, rel, errMsg, avatar, toast } from '../../ui/kit.ts';
import * as chart from '../../ui/chart.ts';
import * as ci from './ci.ts';
import * as model from './model.ts';
import type { Project } from './model.ts';

interface LocalBranch { name: string; date: string; upstream: string; ahead: number; behind: number }
const COLS: [string, string, string, github.Stage[]][] = [
  ['work', 'En cours', 'gray', ['branche']],
  ['pr', 'PR ouverte', 'blue', ['pr', 'ci', 'revue']],
  ['ready', 'Prête à fusionner', 'green', ['prete']],
  ['merged', 'Fusionnée', 'violet', ['fusionnee']],
  ['released', 'Publiée', 'teal', ['publiee']],
];
const CI: Record<github.CiState, [string, string]> = { success: ['green', 'CI verte'], failure: ['red', 'CI en échec'], pending: ['amber', 'CI en cours'], none: ['gray', 'pas de CI'] };
const REVIEW: Record<github.ReviewState, string> = { approved: 'approuvée', changes: 'modifications demandées', pending: 'revue demandée', none: '' };

function card(it: github.FlowItem, local?: LocalBranch): string {
  const when = it.updated ? rel(Date.parse(it.updated)) : local?.date ? rel(Date.parse(local.date)) : '';
  return `<article class="fx-card">
    <div class="fx-branch">${icon('pr')}<code>${esc(it.branch)}</code>${local && !it.pr && it.stage === 'branche' && !local.upstream ? '<em class="pj-badge">locale</em>' : ''}</div>
    ${it.pr ? `<a class="fx-pr" href="${esc(it.pr.url)}" target="_blank" rel="noopener"><span class="pj-num">#${it.pr.number}</span>${esc(it.pr.title)}</a>` : ''}
    <footer>${it.ci !== 'none' ? `<span class="fx-ci"><i class="pj-ci" style="--c:var(--c-${CI[it.ci][0]})"></i>${CI[it.ci][1]}</span>` : ''}
      ${REVIEW[it.review] ? `<em class="pj-badge ${it.review}">${REVIEW[it.review]}</em>` : ''}${it.pr?.draft ? '<em class="pj-badge">brouillon</em>' : ''}
      ${local && (local.ahead || local.behind) ? `<span class="fx-ab">${local.ahead ? `↑${local.ahead}` : ''}${local.behind ? ` ↓${local.behind}` : ''}</span>` : ''}
      ${it.release ? `<a class="pj-badge approved" href="${esc(it.release.url)}" target="_blank" rel="noopener">${esc(it.release.tag)}</a>` : ''}
      ${it.pr?.author ? avatar(it.pr.author) : ''}<time>${esc(when)}</time></footer></article>`;
}

// ---------- GitHub Actions : un workflow par ligne, sa dernière exécution et la bande des précédentes ----------
const RUN_ST: Record<string, [string, string]> = { success: ['green', 'réussie'], failure: ['red', 'en échec'], cancelled: ['gray', 'annulée'], skipped: ['gray', 'ignorée'], timed_out: ['red', 'délai dépassé'], action_required: ['amber', 'à valider'], neutral: ['gray', 'neutre'], startup_failure: ['red', 'échec au démarrage'], stale: ['gray', 'périmée'] };
const EVENT: Record<string, string> = { push: 'push', pull_request: 'PR', pull_request_target: 'PR', schedule: 'planifiée', workflow_dispatch: 'manuelle', release: 'release', merge_group: 'file de fusion' };
const runLabel = (a: github.ActionRun): [string, string] => a.status === 'in_progress' ? ['amber', 'en cours'] : a.status !== 'completed' ? ['amber', 'en attente'] : RUN_ST[a.conclusion ?? ''] ?? ['gray', a.conclusion ?? 'terminée'];
const took = (s: number | null) => s === null ? '' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')}` : ''}`;
// Relançable : une exécution terminée sans succès (échec, annulée, délai dépassé…).
const FAILED_JOBS = new Set(['failure', 'timed_out', 'startup_failure']);
const canRerun = (a: github.ActionRun) => a.status === 'completed' && a.id > 0 && !['success', 'skipped', 'neutral'].includes(a.conclusion ?? '');
function actionsHTML(f: github.Flow): string {
  if (!f.actions.length) return '';
  return `<div class="fx-acts"><header class="fx-acts-head">${icon('bolt')}<span>Actions</span><em class="kb-count">${f.actions.length}</em><a class="link-btn" href="https://github.com/${esc(f.repo)}/actions" target="_blank" rel="noopener">Tout voir sur GitHub</a></header>
    ${f.actions.map((w, wi) => {
      const [hue, txt] = runLabel(w.last), live = w.last.state === 'pending', d = took(w.last.seconds);
      return `<div class="fx-act${live ? ' live' : ''}" style="--c:var(--c-${hue})"><i class="pj-ci"></i>
        <a class="fx-act-name" href="${esc(w.last.url)}" target="_blank" rel="noopener" title="${esc(w.last.title)}">${esc(w.name)}</a>
        <span class="fx-act-st">${txt}</span><code title="Branche">${esc(w.last.branch)}</code><span class="fx-act-ev">${EVENT[w.last.event] ? `<em class="pj-badge">${EVENT[w.last.event]}</em>` : ''}</span>
        ${chart.strip(w.runs)}<time>${esc(rel(Date.parse(w.last.at)))}${d ? ` · ${d}` : ''}</time>
        ${canRerun(w.last) ? `<button class="btn btn-ghost fx-rerun" data-fx-rerun="${w.last.id}" data-repo="${esc(f.repo)}" data-failed="${FAILED_JOBS.has(w.last.conclusion ?? '') ? '1' : ''}" title="${FAILED_JOBS.has(w.last.conclusion ?? '') ? 'Relancer les jobs en échec' : 'Relancer l’exécution'} (même commit)">${icon('refresh')}Relancer</button>` : '<span></span>'}${ci.toggleHTML(f.repo, w, wi === 0)}</div>${ci.panelHTML(f.repo, w, wi === 0)}`;
    }).join('')}</div>`;
}

/** Rend le flux dans `box`, puis le relit toutes les 30 s tant qu'une exécution est en cours et que l'onglet est affiché.
 *  Chaque appel remplace le précédent (`gen`) : après une relance, une seule boucle de suivi tourne. */
const gen = new WeakMap<HTMLElement, number>(), bound = new WeakSet<HTMLElement>();
export async function mount(box: HTMLElement, p: Project, fresh = false): Promise<void> {
  const me = (gen.get(box) ?? 0) + 1; gen.set(box, me);
  if (!bound.has(box)) {
    bound.add(box);
    box.addEventListener('keydown', e => ci.onKey(e, box));
    box.addEventListener('click', e => {
      if (ci.onClick(e, box)) return;
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-fx-rerun]'); if (!b || b.disabled) return;
      b.disabled = true;
      github.rerun(b.dataset.repo ?? '', Number(b.dataset.fxRerun), { failedOnly: b.dataset.failed === '1' })
        // GitHub met un instant à repasser l'exécution « en attente » : relue trop tôt, elle paraîtrait encore terminée.
        .then(() => { toast('Exécution relancée'); return new Promise(ok => setTimeout(ok, 2500)); })
        .then(() => box.isConnected ? mount(box, p, true) : undefined)
        .catch(err => { b.disabled = false; toast(errMsg(err)); });
    });
  }
  for (; ; fresh = true) {
    let live = false;
    try { const r = await render(p, fresh); if (gen.get(box) !== me) return; box.innerHTML = r.html; live = r.live; void ci.hydrate(box); }
    catch (e) { if (gen.get(box) === me) box.innerHTML = `<p class="nf-empty">${esc(errMsg(e))}</p>`; return; }
    if (!live) return;
    await new Promise(ok => setTimeout(ok, 30e3));
    if (!box.isConnected || gen.get(box) !== me) return;
    if (document.hidden) await new Promise<void>(ok => document.addEventListener('visibilitychange', () => ok(), { once: true }));
    if (!box.isConnected) return;
  }
}

async function render(p: Project, fresh: boolean): Promise<{ html: string; live: boolean }> {
  if (!p.repos.length) return { html: '<p class="hm-empty">Associe un dépôt GitHub au projet (onglet Code ou note du projet) pour suivre son flux.</p>', live: false };
  if (!github.connected()) return { html: `<p class="hm-empty">Connecte GitHub pour suivre le flux des branches. <button class="link-btn" data-open-conn="github">Connecter</button></p>`, live: false };
  const locals: LocalBranch[] = native.available() ? (((await native.call('project', 'branches', { project: p.id }, 20000)).branches as LocalBranch[] | undefined) ?? []) : [];
  let live = false;
  const out = await Promise.all(p.stack.map(async ({ name: repo, role }, i) => {
    try {
      const f = await github.flow(repo, { fresh });
      if (f.actions.some(w => w.last.state === 'pending')) live = true;
      const byName = new Map(locals.map(b => [b.name, b]));
      const items = [...f.items];
      if (i === 0) for (const b of locals) if (b.name !== f.base && !items.some(x => x.branch === b.name)) items.push({ branch: b.name, stage: 'branche', updated: b.date, ci: 'none', review: 'none' });
      const visible = items.filter(x => x.stage !== 'fermee');
      return `<div class="fx-repo"><div class="fx-head">${model.roleTag(role)}<strong>${icon('github')}${esc(f.repo)}</strong>
          <span class="fx-base"><code>${esc(f.base)}</code><i class="pj-ci" style="--c:var(--c-${CI[f.baseCi][0]})"></i>${CI[f.baseCi][1]}</span>
          ${f.releases.length ? `<span class="fx-rels">${f.releases.slice(0, 3).map(r => `<a class="pj-badge approved" href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(new Date(r.at).toLocaleString('fr-FR'))}">${esc(r.tag)}</a>`).join('')}</span>` : ''}</div>
        ${actionsHTML(f)}
        <div class="kb fx-board">${COLS.map(([key, label, tone, stages]) => {
          const cards = visible.filter(x => stages.includes(x.stage)).slice(0, key === 'merged' || key === 'released' ? 6 : 30);
          return `<section class="kb-col" data-col="${key}"><header class="kb-head"><i class="kb-dot" style="--c:var(--c-${tone})"></i><span>${label}</span><em class="kb-count">${cards.length}</em></header>
            <div class="kb-cards">${cards.map(x => card(x, i === 0 ? byName.get(x.branch) : undefined)).join('') || '<p class="kb-empty">—</p>'}</div></section>`;
        }).join('')}</div></div>`;
    } catch (e) { return `<p class="nf-empty">${esc(repo)} : ${esc(errMsg(e))}</p>`; }
  }));
  return { html: `<p class="fx-legend">${icon('pr')}Branche de travail → PR (CI verte, revue) → fusion dans la branche principale → Release publiée automatiquement.</p>${out.join('')}`, live };
}
