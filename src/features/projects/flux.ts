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
  const head = it.pr
    ? `<a class="fx-pr" href="${esc(it.pr.url)}" target="_blank" rel="noopener">${esc(it.pr.title)}</a>`
    : `<span class="fx-pr fx-nopr">${esc(it.branch)}</span>`;
  return `<article class="fx-card">${head}
    <div class="fx-branch">${it.pr ? `<span class="pj-num">#${it.pr.number}</span>` : ''}${icon('pr')}<code>${esc(it.branch)}</code>${local && !it.pr && it.stage === 'branche' && !local.upstream ? '<em class="pj-badge">locale</em>' : ''}</div>
    <footer>${it.ci !== 'none' ? `<span class="fx-ci" style="--c:var(--c-${CI[it.ci][0]})"><i class="pj-ci"></i>${CI[it.ci][1]}</span>` : ''}
      ${REVIEW[it.review] ? `<em class="pj-badge ${it.review}">${REVIEW[it.review]}</em>` : ''}${it.pr?.draft ? '<em class="pj-badge">brouillon</em>' : ''}
      ${local && (local.ahead || local.behind) ? `<span class="fx-ab">${local.ahead ? `↑${local.ahead}` : ''}${local.behind ? ` ↓${local.behind}` : ''}</span>` : ''}
      ${it.release ? `<a class="pj-badge approved" href="${esc(it.release.url)}" target="_blank" rel="noopener">${esc(it.release.tag)}</a>` : ''}
      <span class="fx-when">${it.pr?.author ? avatar(it.pr.author) : ''}<time>${esc(when)}</time></span></footer></article>`;
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
      if (i === 0) for (const b of locals) if (b.name && b.name !== f.base && !items.some(x => x.branch === b.name)) items.push({ branch: b.name, stage: 'branche', updated: b.date, ci: 'none', review: 'none' });
      const visible = items.filter(x => x.stage !== 'fermee');
      const by = COLS.map(([key, label, tone, stages]) => {
        const all = visible.filter(x => stages.includes(x.stage));
        return { key, label, tone, all, cards: all.slice(0, key === 'merged' || key === 'released' ? 6 : 30) };
      });
      const cols = by.filter(c => c.cards.length);
      // Le parcours se lit d'un coup d'œil : une étape par colonne, son compte ; les étapes vides restent grises (et n'ont pas de colonne).
      const pipe = `<ol class="fx-pipe" aria-label="Parcours des branches">${by.map(c => `<li class="${c.all.length ? 'on' : ''}" style="--c:var(--c-${c.tone})"><i></i><span>${c.label}</span><em>${c.all.length}</em></li>`).join('')}</ol>`;
      return `<section class="fx-repo"><header class="fx-head">${model.roleTag(role)}<strong>${esc(f.repo)}</strong>
          <span class="fx-base" style="--c:var(--c-${CI[f.baseCi][0]})" title="Branche principale"><i class="pj-ci"></i><code>${esc(f.base)}</code>${CI[f.baseCi][1]}</span>
          <span class="fx-rels">${f.releases.slice(0, 3).map(r => `<a class="pj-badge approved" href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(new Date(r.at).toLocaleString('fr-FR'))}">${esc(r.tag)}</a>`).join('')}<a class="icon-btn" href="https://github.com/${esc(f.repo)}" target="_blank" rel="noopener" title="Ouvrir sur GitHub" aria-label="Ouvrir sur GitHub">${icon('github')}</a></span></header>
        ${pipe}
        ${cols.length ? `<div class="kb fx-board">${cols.map(c => `<section class="kb-col" data-col="${c.key}"><header class="kb-head"><i class="kb-dot" style="--c:var(--c-${c.tone})"></i><span>${c.label}</span><em class="kb-count">${c.all.length}</em></header>
            <div class="kb-cards">${c.cards.map(x => card(x, i === 0 ? byName.get(x.branch) : undefined)).join('')}</div></section>`).join('')}</div>` : '<p class="fx-none">Aucune branche en cours : tout est fusionné.</p>'}
        ${actionsHTML(f)}</section>`;
    } catch (e) { return `<p class="nf-empty">${esc(repo)} : ${esc(errMsg(e))}</p>`; }
  }));
  return { html: out.join(''), live };
}

// ---------- Livraison d'une branche fusionnée, montrée dans le fil du Salon ----------
// Après la fusion : les workflows partis sur la branche principale (déploiement, tests), en direct, et la release qui la contient.
// Lecture partagée par dépôt, relue toutes les 8 s tant qu'une exécution tourne, sinon toutes les minutes ; `onDelivery` repeint le fil.
const ships = new Map<string, { at: number; busy: boolean; flow?: github.Flow; live?: boolean }>();
let onShip: () => void = () => undefined;
export function onDelivery(fn: () => void): void { onShip = fn; }
function shipFlow(repo: string): github.Flow | undefined {
  let s = ships.get(repo); if (!s) ships.set(repo, s = { at: 0, busy: false });
  const me = s;
  if (!me.busy && Date.now() - me.at > (me.live ? 8e3 : 60e3)) {
    me.busy = true;
    github.flow(repo, { fresh: me.at > 0 }).then(f => { me.flow = f; }, () => undefined)
      .finally(() => { me.busy = false; me.at = Date.now(); onShip(); });
  }
  return me.flow;
}

export interface Delivery { repo: string; branch: string; title: string; meta: string; pr?: { number: number; url: string } }
/** Carte « livré » du Salon : fusion → vérifications sur la branche principale → publication. '' tant que GitHub
 *  n'a pas répondu ou n'est pas connecté (le Salon garde alors sa carte simple). */
export function deliveryHTML(d: Delivery): string {
  if (!github.connected() || !d.repo) return '';
  const f = shipFlow(d.repo); if (!f) return '';
  const it = f.items.find(x => x.branch === d.branch), merged = it?.pr?.mergedAt ? Date.parse(it.pr.mergedAt) : 0;
  const pr = it?.pr ? { number: it.pr.number, url: it.pr.url } : d.pr;
  // Pour chaque workflow, la première exécution partie sur la branche principale après la fusion (celle de la fusion).
  const runs = merged ? f.actions.map(w => ({ w, r: w.runs.find(r => r.branch === f.base && Date.parse(r.at) >= merged - 30e3) })).filter((x): x is { w: github.Workflow; r: github.RunPoint } => !!x.r) : [];
  const live = runs.some(x => x.r.state === 'pending'), bad = runs.filter(x => x.r.state === 'failure').length, ok = runs.filter(x => x.r.state === 'success').length;
  const s = ships.get(d.repo); if (s) s.live = live;
  const release = it?.release ?? (merged ? [...f.releases].reverse().find(r => Date.parse(r.at) >= merged) : undefined);
  const checks: [string, string, string] = !runs.length ? ['gray', 'Pas de vérification', ''] : live ? ['amber', 'Vérifications en cours', `${ok}/${runs.length}`] : bad ? ['red', bad > 1 ? `${bad} vérifications en échec` : 'Une vérification en échec', ''] : ['green', 'Vérifications vertes', `${runs.length}`];
  const step = (hue: string, label: string, sub: string, state: string) => `<li class="${state}" style="--c:var(--c-${hue})"><i></i><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</li>`;
  const steps = step('violet', `Fusionnée dans <code>${esc(f.base)}</code>`, merged ? esc(rel(merged)) : '', 'done')
    + step(checks[0], checks[1], checks[2], live ? 'live' : runs.length ? (bad ? 'bad' : 'done') : 'off')
    + (f.releases.length ? step('teal', release ? `Publiée <b>${esc(release.tag)}</b>` : 'Pas encore publiée', '', release ? 'done' : 'off') : '');
  const rows = runs.slice(0, 5).map(({ w, r }) => {
    const [hue, txt] = r.state === 'pending' ? ['amber', 'en cours'] : RUN_ST[r.conclusion ?? ''] ?? (r.state === 'success' ? ['green', 'réussie'] : ['red', 'en échec']);
    const again = r.state === 'failure' && r.id > 0 ? `<button type="button" class="btn btn-ghost fx-rerun" data-fx-ship-rerun="${r.id}" data-repo="${esc(f.repo)}" data-failed="${FAILED_JOBS.has(r.conclusion ?? '') ? '1' : ''}">${icon('refresh')}Relancer</button>` : '';
    return `<div class="fx-ship-run${r.state === 'pending' ? ' live' : ''}" style="--c:var(--c-${hue})"><i class="pj-ci"></i><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(w.name)}</a><span class="fx-act-st">${txt}</span><time>${esc(took(r.seconds))}</time>${again}</div>`;
  }).join('');
  return `<div class="sl-card fx-ship${live ? ' live' : ''}">
    <header><span class="sl-pill" style="--c:var(--c-violet)">${live ? 'en livraison' : bad ? 'à vérifier' : 'livré'}</span><div class="sl-card-t"><b>${esc(d.title)}</b>${d.meta ? `<small>${d.meta}</small>` : ''}</div>
      <div class="sl-card-a">${pr ? `<a class="btn btn-ghost" href="${esc(pr.url)}" target="_blank" rel="noopener">${icon('pr')}#${pr.number}</a>` : ''}<button type="button" class="btn" data-fx-ship-open>${icon('bolt')}Flux</button></div></header>
    <ol class="fx-ship-steps">${steps}</ol>${rows ? `<div class="fx-ship-runs">${rows}</div>` : ''}</div>`;
}
/** Clics de la carte de livraison (relancer une vérification) ; `true` si le clic la concernait. */
export function onDeliveryClick(e: Event, open: () => void): boolean {
  const el = e.target as HTMLElement;
  if (el.closest('[data-fx-ship-open]')) { open(); return true; }
  const b = el.closest<HTMLButtonElement>('[data-fx-ship-rerun]'); if (!b) return false;
  if (b.disabled) return true;
  b.disabled = true;
  const repo = b.dataset.repo ?? '';
  github.rerun(repo, Number(b.dataset.fxShipRerun), { failedOnly: b.dataset.failed === '1' })
    .then(() => { toast('Vérification relancée'); const s = ships.get(repo); if (s) { s.at = Date.now() - 6e3; s.live = true; } })
    .catch(err => { b.disabled = false; toast(errMsg(err)); });
  return true;
}
