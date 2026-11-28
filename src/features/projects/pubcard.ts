// Publication d'une copie DANS le fil du Salon (plus de fenêtre par-dessus) : « Publier la PR » ouvre la carte
// « prêt à publier » en formulaire (type, sujet, branche, PR par dépôt, options), puis la même carte suit la tâche
// (étapes du Mac), montre un conflit (demander à l'agent, VS Code, réessayer) et finit sur la PR ouverte.
// Le moteur est celui de la fenêtre des autres écrans (`publishPrep`/`publishRun`, sessions.ts) : seule la mise en
// forme change. Une carte par copie, en mémoire : changer de fil ou d'écran ne perd ni la saisie ni la publication.
// Le Salon se repeint toutes les 1,2 s (syncFeed remplace un bloc dont le HTML change) : la carte garde un HTML figé
// pendant la saisie (`html` n'est recalculé que sur un changement de structure, ou quand le nœud n'est plus dans la
// page), les champs écrivent l'état et les voisins (branche, titre de PR) directement dans le DOM. Styles : css/salon.css
// (préfixe `sl-pub`).
import * as ai from '../../integrations/ai.ts';
import * as bridge from '../../integrations/remote.ts';
import { esc, renderMarkdown } from '../../lib/markdown.ts';
import { icon, errMsg, toast } from '../../ui/kit.ts';
import { publishPrep, publishSuggest, publishRun, badBranch, branchName, KINDS, TYPES } from './sessions.ts';
import type { PubPrep, PubOutcome } from './sessions.ts';
import type { Project } from './model.ts';

type Phase = 'edit' | 'run' | 'blocked' | 'done';
interface Card {
  pid: string; wt: string; phase: Phase; prep: PubPrep | null;
  type: string; scope: string; subject: string; body: string; title: string; branch: string;
  edited: { msg: boolean; type: boolean; title: boolean; branch: boolean };
  /** Proposition du message : lecture, IA en cours, faite (par qui), échec. */
  sug: { st: 'read' | 'ai' | 'ok' | 'err'; text: string; ai: boolean };
  off: Set<string>; err: string; log: string[]; running: boolean; out: PubOutcome | null;
  html: string; dirty: boolean; fresh: boolean;
  /** Champ qui avait le focus quand la carte a été redessinée : repris après (`after`). */
  focus: { f: string; a: number; b: number } | null;
}
export interface CardInfo { title: string; meta: string; files: string[]; agent: string }

const cards = new Map<string, Card>();
const kOf = (pid: string, wt: string): string => `${pid}/${wt}`;
let repaint: () => void = () => undefined, reload: () => Promise<void> = async () => undefined;
/** Le Salon donne sa fonction de rendu (rappelée à chaque changement de structure) et sa relecture des copies. */
export const onChange = (f: () => void, trees: () => Promise<void>): void => { repaint = f; reload = trees; };
const touch = (c: Card): void => { c.dirty = true; repaint(); };

const HEAD = new RegExp(`^(${TYPES})(?:\\(([^)]*)\\))?!?:\\s*(.*)$`);
/** « feat(salon): sujet\n\ncorps » → type, portée, sujet, corps. */
function split(msg: string): { type: string; scope: string; subject: string; body: string } {
  const [first = '', ...rest] = msg.split('\n'), m = HEAD.exec(first.trim());
  return { type: m?.[1] ?? '', scope: m?.[2] ?? '', subject: (m ? m[3] : first).trim(), body: rest.join('\n').replace(/^\n+/, '').trimEnd() };
}
const head = (c: Card): string => c.type ? `${c.type}${c.scope ? `(${c.scope})` : ''}: ${c.subject}` : c.subject;
const message = (c: Card): string => [head(c), c.body.trim()].filter(Boolean).join('\n\n');
const repos = (c: Card): string[] => c.prep?.repo ? (c.prep.targets.length ? c.prep.targets : [c.prep.repo]) : [];

/** Ouvre la carte de publication de la copie (ou la reprend telle qu'elle était). */
export function open(p: Project, wt: string): void {
  const k = kOf(p.id, wt), had = cards.get(k);
  if (had && had.phase !== 'done') { had.focus = { f: 'subject', a: had.subject.length, b: had.subject.length }; touch(had); return; }
  const c: Card = {
    pid: p.id, wt, phase: 'edit', prep: null, type: '', scope: '', subject: '', body: '', title: '', branch: '',
    edited: { msg: false, type: false, title: false, branch: false }, sug: { st: 'read', text: 'Lecture des changements…', ai: false },
    off: new Set(), err: '', log: [], running: false, out: null, html: '', dirty: true, fresh: true, focus: { f: 'subject', a: 0, b: 0 },
  };
  cards.set(k, c); repaint();
  void publishPrep(p, wt).then(prep => {
    if (cards.get(k) !== c) return;
    c.prep = prep;
    // Branche déjà poussée et pas encore fusionnée : publier la met à jour (et sa PR).
    if (prep.pushedBranch) { c.branch = prep.pushedBranch; c.edited.branch = true; }
    touch(c); void propose(p, c, false);
  }, e => { if (cards.get(k) === c) { c.sug = { st: 'err', text: `Lecture impossible : ${errMsg(e)}`, ai: false }; touch(c); } });
}
/** Ferme la carte (sauf pendant la publication, qui continue sur le Mac) : la carte « prêt à publier » revient. */
export function close(pid: string, wt: string): void { const c = cards.get(kOf(pid, wt)); if (c && c.phase !== 'run') { cards.delete(kOf(pid, wt)); repaint(); } }

/** Message proposé : celui de l'agent, sinon tiré des fichiers, puis rédigé par l'IA d'après le diff. */
async function propose(p: Project, c: Card, forceAI: boolean): Promise<void> {
  if (!c.prep) return;
  const alive = () => cards.get(kOf(c.pid, c.wt)) === c && c.phase === 'edit';
  c.sug = { st: 'read', text: 'Lecture des changements…', ai: false }; touch(c);
  const apply = (msg: string): void => {
    if (c.edited.msg) return;
    const s = split(msg); if (!c.edited.type || !c.type) { c.type = s.type; c.scope = s.scope; }
    c.subject = s.subject; c.body = s.body; sync(c);
  };
  try {
    const s = await publishSuggest(p, c.wt, c.prep, forceAI);
    if (!alive()) return;
    apply(s.draft);
    if (!s.ai) {
      c.sug = { st: 'ok', ai: false, text: s.fromAgent ? 'rédigé par l’agent à partir de son travail' : ai.ready() ? 'tiré des fichiers modifiés : précise-le' : 'tiré des fichiers modifiés · connecte une IA pour un message rédigé d’après le diff' };
      touch(c); return;
    }
    c.sug = { st: 'ai', ai: false, text: `L’IA rédige le message d’après le diff (${ai.PROVIDERS[ai.config().provider]})…` }; touch(c);
    const text = await s.ai; if (!alive()) return;
    if (text) apply(text);
    c.sug = c.edited.msg ? { st: 'ok', ai: false, text: 'tu as modifié le message : la proposition de l’IA n’a pas été appliquée' } : { st: 'ok', ai: !!text, text: text ? 'proposé par l’IA d’après le diff' : `${s.files.length} fichier${s.files.length > 1 ? 's' : ''} modifié${s.files.length > 1 ? 's' : ''}` };
  } catch (e) { if (alive()) c.sug = { st: 'err', ai: false, text: `Pas de proposition de l’IA : ${errMsg(e)}` }; }
  touch(c);
}
/** Titre de PR et branche suivent le sujet tant qu'on ne les a pas modifiés. */
function sync(c: Card): void {
  if (!c.edited.title) c.title = head(c);
  if (!c.edited.branch) c.branch = branchName(head(c));
}

// ---------- Rendu ----------
const steps = (log: string[], running: boolean, bad = ''): string => `<ol class="sl-pub-steps">${log.map((l, i) => {
  const now = running && i === log.length - 1;
  return `<li class="${now ? 'now' : 'ok'}"><span class="m">${now ? '<span class="spin"></span>' : icon('check')}</span><span>${esc(l)}</span></li>`;
}).join('')}${bad ? `<li class="bad"><span class="m">${icon('x')}</span><span>${esc(bad)}</span></li>` : ''}</ol>`;
const pill = (text: string, c: string, spin = false): string => `<span class="sl-pill" style="--c:var(${c})">${spin ? '<span class="spin"></span>' : ''}${esc(text)}</span>`;
const row = (pl: string, title: string, meta: string, acts = ''): string => `<div class="sl-pub-row">${pl}<div class="sl-card-t"><b>${esc(title)}</b>${meta ? `<small>${meta}</small>` : ''}</div>${acts ? `<div class="sl-card-a">${acts}</div>` : ''}</div>`;
const short = (repo: string): string => repo.split('/')[1] ?? repo;

function editHTML(c: Card, info: CardInfo): string {
  const pr = c.prep, rs = repos(c), reading = !pr || c.sug.st === 'read';
  const sug = c.sug.st === 'ok' && c.sug.ai ? `<em>${icon('sparkle')}${esc(c.sug.text)}</em>`
    : c.sug.st === 'read' || c.sug.st === 'ai' ? `<span class="spin"></span><span>${esc(c.sug.text)}</span>`
    : c.sug.st === 'err' ? `<span class="err">${esc(c.sug.text)}</span>` : `<span>${esc(c.sug.text)}</span>`;
  const again = pr && ai.ready() && c.sug.st !== 'read' && c.sug.st !== 'ai' ? `<button type="button" class="link-btn" data-sl="pub-resug">${icon('refresh')}Reproposer</button>` : '';
  const prChips = !pr ? '' : !pr.repo ? `<span class="sl-pub-chip mute">Pas de dépôt GitHub associé : la branche sera seulement poussée</span>`
    : rs.map(r => { const on = !c.off.has(r); return `<button type="button" class="sl-pub-chip${on ? ' on' : ' off'}" data-sl="pub-pr" data-repo="${esc(r)}" aria-pressed="${on}"${pr.canPR ? '' : ' title="GitHub n’est pas connecté : un lien vers la PR pré-remplie sera proposé"'}>${on ? icon('check') : ''}<span>PR sur</span><code>${esc(r)}</code></button>`; }).join('');
  const brHint = pr?.pushedBranch && c.branch === pr.pushedBranch ? `<small class="sl-pub-hint">Déjà poussée : publier met à jour sa PR. Un autre nom crée une nouvelle branche.</small>` : '';
  const files = info.files.length ? `<span>Fichiers</span><div class="sl-pub-files">${info.files.slice(0, 24).map(f => `<code title="${esc(f)}">${esc(f.split('/').slice(-2).join('/'))}</code>`).join('')}${info.files.length > 24 ? `<small>+${info.files.length - 24}</small>` : ''}</div>` : '';
  const ready = !reading || c.subject.trim();
  return `<div class="sl-card sl-pub${c.fresh ? ' sl-pub-in' : ''}" data-pub="${esc(c.wt)}">
    ${row(pill('prêt à publier', '--c-green'), '', info.meta)}
    <div class="sl-pub-ed">
      <div class="sl-pub-subj"><button type="button" class="sl-pub-type" data-sl="pub-type" data-pub-type title="Changer le type">${esc(c.type ? `${c.type}${c.scope ? `(${c.scope})` : ''}` : 'type')}</button><input data-f="subject" value="${esc(c.subject)}" placeholder="${reading ? 'Lecture des changements…' : 'Ce que fait ce changement'}" aria-label="Message de commit" spellcheck="false" autocomplete="off" maxlength="120"></div>
      <div class="sl-pub-sug">${sug}${again}</div>
      <div class="sl-pub-chips"><label class="sl-pub-chip br" title="Branche poussée">${icon('pr')}<input data-f="branch" value="${esc(c.branch)}" size="${Math.max(12, c.branch.length + 1)}" spellcheck="false" autocomplete="off" aria-label="Branche"></label>${prChips}</div>
      ${brHint}${c.err ? `<p class="sl-pub-err">${esc(c.err)}</p>` : ''}
      <details class="sl-pub-more"><summary>${icon('chevron')}<span>Options : détails du commit, titre de la PR, fichiers</span></summary>
        <div class="sl-pub-grid">
          <span>Détails</span><textarea data-f="body" rows="3" placeholder="Corps du commit (facultatif)" spellcheck="false">${esc(c.body)}</textarea>
          ${pr?.repo ? `<span>Titre de la PR</span><input data-f="title" value="${esc(c.title)}" placeholder="${esc(head(c))}" spellcheck="false" autocomplete="off">` : ''}
          ${files}
        </div>
      </details>
    </div>
    <div class="sl-pub-foot"><p>${icon('shield')}<span>Remise sur main, un commit, push avec tes identifiants. Ton dossier n’est pas touché.</span></p>
      <button type="button" class="btn btn-ghost" data-sl="pub-close">Annuler</button><button type="button" class="btn btn-primary" data-sl="pub-go"${ready ? '' : ' disabled'}>${icon('upload')}Publier <kbd>⌘⏎</kbd></button></div>
  </div>`;
}

function stateHTML(c: Card, info: CardInfo): string {
  const t = head(c) || info.title, rs = repos(c), a = `data-pub="${esc(c.wt)}"`;
  if (c.phase === 'run') return `<div class="sl-card sl-pub" ${a}>${row(pill('publication', '--c-amber', true), t, `${esc(rs.length ? rs.map(short).join(' + ') : c.branch)} → main`)}<div class="sl-pub-bar"><i></i></div>${steps(c.log, c.running)}</div>`;
  const o = c.out;
  if (c.phase === 'blocked' && o?.kind === 'blocked') {
    const ask = `La publication bute sur des conflits avec la branche principale dans : ${o.conflicts.join(', ')}. Résous-les dans ta copie (retire les marqueurs <<<<<<< ======= >>>>>>> en gardant l’intention des deux côtés), puis dis-moi quand c’est prêt.`;
    return `<div class="sl-card sl-pub" ${a}>${row(pill('conflit', '--c-red'), t, 'La copie a été remise sur main, rien n’a été poussé')}${steps(o.log, false, `${o.conflicts.length} fichier${o.conflicts.length > 1 ? 's' : ''} en conflit que l’agent n’a pas pu résoudre`)}
      <div class="sl-pub-conf"><div class="sl-pub-files bad">${o.conflicts.map(f => `<code title="${esc(f)}">${esc(f)}</code>`).join('')}</div>
      <div class="sl-card-a"><button type="button" class="btn btn-primary" data-sl="quick" data-text="${esc(ask)}">${icon('compose')}Demander à ${esc(info.agent)} de résoudre</button><button type="button" class="btn" data-sl="pub-vscode">${icon('code')}Ouvrir dans VS Code</button><button type="button" class="btn btn-ghost" data-sl="pub-go">${icon('refresh')}Réessayer</button><button type="button" class="btn btn-ghost" data-sl="pub-close" title="Fermer">${icon('x')}</button></div></div></div>`;
  }
  if (!o || c.phase !== 'done') return '';
  const more = (desc: string): string => `<details class="sl-pub-more sl-pub-after"><summary>${icon('chevron')}<span>${desc ? 'Description (en anglais) et étapes' : 'Étapes'}</span></summary>${desc ? `<div class="md sl-pub-desc">${renderMarkdown(desc)}</div>` : ''}${steps(o.log, false)}</details>`;
  const shut = `<button type="button" class="btn btn-ghost" data-sl="pub-close" title="Fermer">${icon('x')}</button>`;
  if (o.kind === 'none') return `<div class="sl-card sl-pub" ${a}>${row(pill('déjà livré', '--c-violet'), t, esc(o.step || 'Rien à pousser : le travail est déjà dans la branche principale.'), shut)}</div>`;
  if (o.kind === 'pushed') {
    const b = o.branches[0]?.branch ?? c.branch, names = o.branches.map(x => x.repo).filter(Boolean);
    return `<div class="sl-card sl-pub" ${a}>${row(pill('branche poussée', '--c-green'), t, `<code>${esc(b)}</code>${names.length ? ` · ${esc(names.map(short).join(', '))}` : ''} · <span>sans pull request</span>`, `${c.prep?.repo ? `<button type="button" class="btn" data-sl="pr" data-wt="${esc(c.wt)}">${icon('github')}Ouvrir la PR sur GitHub</button>` : ''}${shut}`)}${more('')}</div>`;
  }
  if (o.kind !== 'pr') return '';
  const many = o.opened.length + o.failed.length > 1, all = o.opened.length && o.opened.every(x => x.updated);
  const links = o.opened.map(x => `<a class="btn" href="${esc(x.url)}" target="_blank" rel="noopener">${icon('pr')}${many ? `${esc(short(x.repo))} #${x.number}` : 'Voir la PR'}</a>`).join('');
  const meta = o.opened.length ? `${o.opened.map(x => many ? `${esc(short(x.repo))} #${x.number}` : `#${x.number} · ${esc(x.repo)}`).join(' · ')} · <span>${all ? 'mise à jour' : 'en attente de fusion'}</span>` : 'La branche est poussée, la PR reste à ouvrir';
  const fails = o.failed.length ? `<div class="sl-pub-conf">${o.failed.map(f => `<p>${icon('check')}<span>Poussée sur ${esc(f.repo)} :</span><code>${esc(f.branch)}</code></p><p class="err">${esc(f.text)}</p><div class="sl-card-a"><a class="btn btn-primary" href="${esc(f.url)}" target="_blank" rel="noopener">${icon('github')}Ouvrir la PR de ${esc(short(f.repo))} sur GitHub</a></div>`).join('')}${o.perm ? '<div class="sl-card-a"><button type="button" class="btn" data-open-conn="github">Régler le jeton</button></div>' : ''}</div>` : '';
  return `<div class="sl-card sl-pub" ${a}>${row(o.failed.length ? pill('PR à ouvrir', '--c-amber') : pill(all ? 'PR mise à jour' : 'PR ouverte', '--c-blue'), t, meta, links)}${fails}${more(o.desc)}</div>`;
}

/** HTML de la carte de la copie, ou '' si elle n'est pas ouverte. Figé tant que rien ne change de structure (voir l'en-tête). */
export function html(pid: string, wt: string, info: CardInfo): string {
  const c = cards.get(kOf(pid, wt)); if (!c) return '';
  const node = document.querySelector<HTMLElement>(`[data-pub="${CSS.escape(wt)}"]`);
  if (!c.dirty && c.html && node?.isConnected) return c.html;
  // Redessinée pendant la saisie : le champ en cours reprend le focus et la sélection (`after`).
  const el = document.activeElement;
  if (!c.focus && node && el instanceof HTMLElement && node.contains(el) && el.dataset.f) {
    const f = el as HTMLInputElement; c.focus = { f: el.dataset.f, a: f.selectionStart ?? 0, b: f.selectionEnd ?? 0 };
  }
  // Options dépliées : elles le restent d'un rendu à l'autre.
  const opened = !!node?.querySelector('.sl-pub-more')?.hasAttribute('open');
  c.html = c.phase === 'edit' ? editHTML(c, info) : stateHTML(c, info);
  if (opened) c.html = c.html.replace('<details class="sl-pub-more">', '<details class="sl-pub-more" open>');
  c.dirty = false;
  return c.html;
}
/** Après le rendu du fil : rend le focus au champ qui l'avait. */
export function after(feed: HTMLElement): void {
  for (const c of cards.values()) {
    if (!c.focus) continue;
    const el = feed.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-pub="${CSS.escape(c.wt)}"] [data-f="${c.focus.f}"]`);
    if (!el) continue;
    const { a, b } = c.focus; c.focus = null;
    if (el.closest('details:not([open])')) continue;
    el.focus({ preventScroll: true }); try { el.setSelectionRange(a, b); } catch { /* champ sans sélection */ }
    // Ouverture : la carte entière à l'écran, le formulaire est sous la ligne d'en-tête.
    if (c.fresh) { c.fresh = false; el.closest('.sl-pub')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
}
/** La carte de cette copie est-elle ouverte ? Fusionnée depuis : elle s'efface au profit de la carte de livraison. */
export function shown(pid: string, wt: string, merged: boolean): boolean {
  const c = cards.get(kOf(pid, wt)); if (!c) return false;
  if (merged && c.phase === 'done') { cards.delete(kOf(pid, wt)); return false; }
  return true;
}

// ---------- Gestes ----------
async function go(p: Project, c: Card): Promise<void> {
  if (!c.prep || c.phase === 'run') return;
  const card = document.querySelector<HTMLElement>(`[data-pub="${CSS.escape(c.wt)}"]`);
  if (!c.subject.trim()) { card?.querySelector<HTMLInputElement>('[data-f=subject]')?.focus(); return; }
  if (!c.type) { c.type = 'feat'; sync(c); }
  if (badBranch(c.branch.trim())) { c.err = 'Nom de branche invalide : minuscules, chiffres, - _ . / (ex. feat/export-pdf).'; c.focus = { f: 'branch', a: 0, b: c.branch.length }; touch(c); return; }
  c.err = ''; c.phase = 'run'; c.log = ['Démarrage…']; c.running = true; c.out = null; touch(c);
  const k = kOf(c.pid, c.wt), off = new Set(c.off);
  let o: PubOutcome | null = null;
  try {
    o = await publishRun(p, c.wt, c.prep, { message: message(c), branch: c.branch.trim(), title: c.title.trim() || head(c), wantPR: r => !off.has(r) }, {
      onLog: (log, running) => { c.log = log; c.running = running; touch(c); },
      alive: () => cards.get(k) === c,
      onTrees: () => void reload().then(repaint, () => undefined),
    });
  } catch (e) { o = { kind: 'error', message: errMsg(e), log: c.log }; }
  if (!o || cards.get(k) !== c) return;
  c.out = o; c.running = false;
  if (o.kind === 'error') { c.phase = 'edit'; c.err = o.message; }
  else c.phase = o.kind === 'blocked' ? 'blocked' : 'done';
  touch(c); void reload().then(repaint, () => undefined);
}

/** Clic sur un bouton `data-sl="pub-…"` de la carte ; vrai si c'en était un. */
export function click(t: HTMLElement, p: Project): boolean {
  const act = t.dataset.sl ?? ''; if (!act.startsWith('pub-')) return false;
  const wt = t.closest<HTMLElement>('[data-pub]')?.dataset.pub ?? '', c = cards.get(kOf(p.id, wt)); if (!c) return true;
  if (act === 'pub-close') close(p.id, wt);
  else if (act === 'pub-go') void go(p, c);
  else if (act === 'pub-resug') { c.edited.msg = false; c.edited.type = false; void propose(p, c, true); }
  else if (act === 'pub-type') {
    // Un clic passe au type suivant ; la portée et le sujet restent.
    const ks = KINDS.map(x => x[0]), i = ks.indexOf(c.type);
    c.type = ks[(i + 1) % ks.length] ?? 'feat'; c.edited.type = true; sync(c); touch(c);
  }
  else if (act === 'pub-pr') { const r = t.dataset.repo ?? ''; if (c.off.has(r)) c.off.delete(r); else c.off.add(r); touch(c); }
  else if (act === 'pub-vscode') void bridge.call('project', 'open', { project: p.id, app: 'vscode', worktree: wt }, 15000).then(r => { if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); });
  return true;
}
/** Saisie dans un champ de la carte : l'état suit, les champs voisins aussi (sans redessiner) ; vrai si c'en était un. */
export function input(el: HTMLElement, pid: string): boolean {
  const box = el.closest<HTMLElement>('[data-pub]'), f = el.dataset.f; if (!box || !f) return !!box;
  const c = cards.get(kOf(pid, box.dataset.pub ?? '')); if (!c) return true;
  const v = (el as HTMLInputElement).value, set = (name: string, val: string): void => { const x = box.querySelector<HTMLInputElement>(`[data-f="${name}"]`); if (x && x !== el && x.value !== val) { x.value = val; if (name === 'branch') x.size = Math.max(12, val.length + 1); } };
  if (f === 'subject') {
    c.edited.msg = true;
    // « fix(ui): … » tapé ou collé dans le sujet : le type et la portée en sont tirés.
    const m = HEAD.exec(v);
    if (m) { c.type = m[1] ?? c.type; c.scope = m[2] ?? ''; c.edited.type = true; c.subject = m[3] ?? ''; (el as HTMLInputElement).value = c.subject; const b = box.querySelector('[data-pub-type]'); if (b) b.textContent = `${c.type}${c.scope ? `(${c.scope})` : ''}`; }
    else c.subject = v;
    sync(c); set('title', c.title); set('branch', c.branch);
    const go = box.querySelector<HTMLButtonElement>('[data-sl="pub-go"]'); if (go) go.disabled = false;
  }
  else if (f === 'body') { c.body = v; c.edited.msg = true; }
  else if (f === 'title') { c.title = v; c.edited.title = !!v.trim(); if (!c.edited.title) c.title = head(c); }
  else if (f === 'branch') { c.branch = v; c.edited.branch = true; (el as HTMLInputElement).size = Math.max(12, v.length + 1); }
  // Le HTML figé n'a plus les bonnes valeurs : il sera refait si le nœud quitte la page (autre fil), pas avant.
  return true;
}
/** Touches dans la carte : ⌘⏎ publie, Échap referme ; Entrée seule ne part jamais dans le champ du Salon. Vrai si c'était dans la carte. */
export function key(e: KeyboardEvent, p: Project): boolean {
  const el = e.target as HTMLElement | null, box = el?.closest<HTMLElement>('[data-pub]'); if (!box) return false;
  const c = cards.get(`${p.id}/${box.dataset.pub ?? ''}`); if (!c) return true;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && c.phase === 'edit') { e.preventDefault(); void go(p, c); }
  else if (e.key === 'Enter' && el instanceof HTMLInputElement) e.preventDefault();
  else if (e.key === 'Escape' && c.phase !== 'run') { e.preventDefault(); e.stopPropagation(); close(p.id, c.wt); }
  return true;
}
