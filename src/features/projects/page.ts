// Page Projets : la liste des projets, et le cockpit d'un projet — son dossier sur le Mac (VS Code, Finder,
// Terminal), ses tâches, ses notes, et les panneaux fournis par les plugins (GitHub, Linear…).
import * as store from '../../core/store.ts';
import * as native from '../../core/native.ts';
import * as github from '../../integrations/github/api.ts';
import * as linear from '../../integrations/linear/api.ts';
import * as registry from '../../plugins/registry.ts';
import * as todo from '../tasks.ts';
import * as model from './model.ts';
import { esc, plain } from '../../lib/markdown.ts';
import { $, icon, menu, modal, need, rel, target, toast, errMsg, confirmBox, hue } from '../../ui/kit.ts';
import { pickFrom } from './notepick.ts';
import type { AppShell, Note } from '../../types.ts';
import type { Project, Repo, Role } from './model.ts';
import * as flux from './flux.ts';
import * as sessions from './sessions.ts';
import * as salon from './salon.ts';
import * as review from './review.ts';
import * as site from './site.ts';
import * as mobile from './mobile.ts';
import * as stack from './stack.ts';
import * as docker from './docker.ts';
import * as commerce from '../commerce/page.ts';
import * as projIcons from '../../ui/projicons.ts';
import * as recos from '../social/recos.ts';
import * as infra from './infra.ts';
import * as specs from './specs.ts';
import * as chart from '../../ui/chart.ts';
import * as bridge from '../../integrations/remote.ts';
import { shareable, linkable, notesAllowed } from '../../integrations/ai.ts';

let app!: AppShell;
export const init = (shell: AppShell): void => {
  app = shell;
  salon.init((pid, tab) => app.setView({ type: 'projets', project: pid, tab }));
  // Une conversation Claude Code a été ouverte, renommée ou supprimée : la barre latérale et le fil d'Ariane suivent.
  sessions.onChange(() => {
    app.renderSidebar();
    const c = $('#main .toolbar .crumb');
    if (c && app.view() === 'projets') c.outerHTML = trailHTML();
  });
  // Serveurs du projet lus, ajoutés, retirés, ou autre serveur affiché : la barre latérale suit.
  infra.onChange(() => { app.renderSidebar(); const v = app.viewState(), pr = v.project ? model.byId(v.project) : null, slot = $('.pj-srv'); if (pr && slot) slot.outerHTML = serverBadge(pr); });
};

const titleOf = (n: Note) => n.title.trim() || 'Sans titre';
const go = (id: string | null, tab?: string) => app.setView({ type: 'projets', project: id, ...(tab ? { tab } : {}) });

// ---------- Dossier local (app Mac) ----------
/** `home` : dossier mère du projet (où sont rangés et clonés ses dépôts), `homeSet` s'il a été choisi
 *  (sinon c'est le parent du dépôt principal). */
interface Folder { path: string | null; name?: string; git?: boolean; branch?: string; ahead?: number; behind?: number; changes?: number; remote?: string; home?: string | null; homeSet?: boolean }
const folders = new Map<string, Folder>();
async function folderOf(p: Project, fresh = false): Promise<Folder | null> {
  if (!bridge.local()) return null;
  if (!fresh && folders.has(p.id)) return folders.get(p.id) ?? null;
  const r = await native.call('project', 'info', { project: p.id, repos: p.stack }, 10000);
  const f: Folder = { path: typeof r.path === 'string' ? r.path : null, ...(r as Partial<Folder>) };
  folders.set(p.id, f);
  return f;
}
const moreBtn = `<button class="icon-btn" data-pj="folder-menu" title="Plus d’actions" aria-label="Plus d’actions sur le dossier">${icon('more')}</button>`;
function folderHTML(p: Project, f: Folder | null): string {
  if (!bridge.local()) { const at = bridge.where(); return `<p class="pj-folder muted">${icon(at ? 'devices' : 'folder')}${at ? `Dossier et VS Code sur <strong>${esc(at.kind === 'remote' ? at.name : 'le Mac')}</strong> · Claude Code se pilote d’ici` : 'Le dossier du projet et VS Code s’ouvrent depuis l’app Studio pour Mac.'}</p>`; }
  if (!f) return `<p class="pj-folder muted">${icon('folder')}Lecture du dossier…</p>`;
  const main = p.stack[0]?.name;
  if (!f.path && f.home) return `<div class="pj-folder">${icon('download')}<span>${main ? `Le dépôt principal <b>${esc(main)}</b> n’est pas encore dans ce dossier.` : 'Associe un dépôt GitHub au projet pour le cloner ici.'}</span><span class="pj-open">${main ? `<button class="btn btn-primary" data-pj="repo-clone" data-repo="${esc(main)}">${icon('download')}Le cloner ici</button>` : ''}${moreBtn}</span></div>`;
  if (!f.path) return `<div class="pj-folder">${icon('folder')}<span>Choisis le <b>dossier mère</b> du projet : ses dépôts y sont rangés, ceux qui manquent y seront clonés.</span><span class="pj-open"><button class="btn btn-primary" data-pj="home">Choisir le dossier mère</button>${moreBtn}</span></div>`;
  const git = f.git ? `<span class="pj-git">${icon('pr')}${esc(f.branch ?? '?')}${f.changes ? ` · <b>${f.changes} modif.</b>` : ' · à jour'}${f.ahead ? ` · ↑${f.ahead}` : ''}${f.behind ? ` · ↓${f.behind}` : ''}</span>` : '<span class="pj-git muted">pas un dépôt Git</span>';
  const own = model.repoNamed(p, f.remote);
  const hint = own ? model.roleTag(own.role, 'sm') : f.remote ? `<button class="link-btn" data-pj="link-repo" data-repo="${esc(f.remote)}">Associer ${esc(f.remote)}</button>` : '';
  return `<div class="pj-folder">${icon('folder')}<code title="${esc(f.path)}">${esc(f.path.replace(/^\/Users\/[^/]+/, '~'))}</code>${git}${hint}
    <span class="pj-open"><button class="btn" data-pj="vscode">${icon('code')}VS Code</button>${moreBtn}</span></div>`;
}
/** Menu « … » de la ligne dossier : tout ce qui n'est pas l'action principale, dossier mère compris. */
function folderMenu(root: HTMLElement, p: Project, tab: string, anchor: Element): void {
  const f = folders.get(p.id); if (!f) return;
  const main = p.stack[0]?.name, run = (act: string, repo = '', choose = false) => () => { void folderAct(root, p, tab, act, repo, choose, anchor); };
  const items: Parameters<typeof menu>[1] = [];
  if (f.path) items.push({ label: 'Ouvrir dans le Finder', icon: 'folder', run: run('finder') }, { label: 'Ouvrir dans le Terminal', icon: 'terminal', run: run('terminal') }, '-', { label: 'Changer le dossier du dépôt principal', icon: 'pencil', run: run('pick') });
  else if (main && f.home) items.push({ label: 'Cloner ailleurs…', icon: 'download', run: run('repo-clone', main, true) }, { label: 'J’ai déjà un clone', icon: 'folder', run: run('pick') });
  else items.push({ label: 'Choisir directement le dépôt', icon: 'folder', run: run('pick') });
  items.push('-');
  if (f.home) items.push({ label: `Dossier mère : ${f.home.replace(/^\/Users\/[^/]+/, '~')}${f.homeSet ? '' : ' (parent du dépôt principal)'}` }, { label: 'Changer le dossier mère', icon: 'folder', hint: 'Ses dépôts y sont rangés, ceux qui manquent y sont clonés', run: run('home') });
  else items.push({ label: 'Choisir le dossier mère', icon: 'folder', run: run('home') });
  menu(anchor, items);
}

// ---------- Liste ----------
function listHTML(): string {
  const all = model.projects();
  if (!all.length) return `<div class="pj-empty"><h2>Un projet réunit tout ce qui le concerne</h2>
    <p>Son dossier sur ton Mac, ses dépôts GitHub (l’app, son site, son API…) et leurs PR, ses tickets Linear, ses tâches et ses notes. Tu y ouvres VS Code en un clic, et tu peux bientôt y confier une tâche à Claude Code.</p>
    <button class="btn btn-primary" data-pj="new">${icon('plus')}Créer un projet</button></div>`;
  return `<div class="pj-grid">${all.map(p => {
    const t = todo.ofProject(p.id), notes = model.notesOf(p).length - 1;
    return `<button class="pj-card" data-pj-open="${esc(p.id)}" style="--c:var(--c-${p.hue})">${projIcons.tile(p, 'pi-lg')}<strong>${esc(p.name)}</strong>
      <span class="pj-sub">${p.kind === 'social' ? `${icon('camera')}${p.tiktok ? `<span data-no-i18n>TikTok · ${esc(p.tiktok)}</span>` : 'Réseaux sociaux'}` : p.stack.length ? `${icon('github')}${esc(p.stack[0]?.name ?? '')}` : 'Pas de dépôt'}${p.linear ? ` · ${icon('linear')}${esc(p.linear)}` : ''}</span>
      ${p.stack.length ? `<span class="pj-roles">${p.stack.map(r => model.roleTag(r.role, 'sm')).join('')}</span>` : ''}
      <span class="pj-stats"><b>${t.openCount}</b> tâche${t.openCount > 1 ? 's' : ''}${t.doing.length ? ` · ${t.doing.length} en cours` : ''} · <b>${notes}</b> note${notes > 1 ? 's' : ''}</span></button>`;
  }).join('')}<button class="pj-card pj-new" data-pj="new">${icon('plus')}<strong>Nouveau projet</strong></button></div>`;
}

// ---------- Cockpit d'un projet ----------
function taskRows(p: Project): string {
  const c = todo.ofProject(p.id), items = [...c.late, ...c.doing, ...c.today, ...c.soon, ...c.tickets, ...c.undated, ...c.notes].filter((t, i, a) => a.indexOf(t) === i).slice(0, 10);
  const cc = bridge.where();
  return `${items.length ? items.map(t => `<div class="pj-row"><label class="tg-task hm-task"><input type="checkbox" data-note="${t.note.id}" data-line="${t.line}"${t.status === 'doing' ? ' class="doing"' : ''}><span>${esc(plain(t.text))}</span>${t.ticket ? `<em class="hm-ticket">${esc(t.ticket)}</em>` : ''}${t.due ? `<em class="td-due${t.due < store.dayKey() ? ' late' : ''}">${esc(todo.dueLabel(t.due))}</em>` : ''}</label>${cc ? `<button class="pj-cc" data-pj-cc-task="${esc(plain(t.text))}" title="Confier cette tâche à Claude Code">${icon('terminal')}Claude Code</button>` : ''}</div>`).join('') : '<p class="hm-empty">Aucune tâche ouverte dans ce projet.</p>'}
    <button class="hm-more" data-pj="kanban">${c.openCount > items.length ? `${c.openCount - items.length} de plus · ` : ''}Ouvrir en Kanban</button>`;
}
const taskBox = (p: Project) => `<form class="td-add pj-add"><span class="td-plus">${icon('plus')}</span><input placeholder="Nouvelle tâche du projet, ex. « Corriger la synchro vendredi »" aria-label="Nouvelle tâche du projet" autocomplete="off"></form><div class="pj-tasklist">${taskRows(p)}</div>`;
// Notes cochées dans l'onglet Notes, par projet : la sélection part vers Claude Code (une consigne, ou un agent par
// note) ou vers la page Claude, d'un clic. Les notes #privé ne se cochent pas ; une note chiffrée se coche une à une,
// déverrouillée (« Tout cocher » la saute, la reverrouiller la retire de la sélection).
const pickedNotes = new Map<string, Set<string>>();
function picksOf(p: Project): Set<string> { let s = pickedNotes.get(p.id); if (!s) { s = new Set(); pickedNotes.set(p.id, s); } return s; }
const pickable = (p: Project): Note[] => model.notesOf(p).filter(n => linkable(n) && store.getBody(n) != null);
/** Ce que « Tout cocher » coche : tout sauf les notes chiffrées. */
const bulkPickable = (p: Project): Note[] => pickable(p).filter(n => !n.enc);
/** Barre de sélection : une invitation tant que rien n'est coché, puis les envois possibles. */
function pickBarHTML(p: Project): string {
  const all = pickable(p), bulk = bulkPickable(p), sel = picksOf(p), k = all.filter(n => sel.has(n.id)).length, cc = !!bridge.where();
  // Interrupteur général coupé : on le dit, plutôt qu’une liste sans cases qui ne s’explique pas.
  if (!notesAllowed()) return `<span class="pj-pickbar-t">${icon('lock')}Notes fermées à l’IA : aucune ne peut être liée à Claude.</span><span class="pj-pickbar-end"><button class="link-btn" data-open-conn="ia">Autoriser dans les Réglages</button></span>`;
  if (!all.length) return '';
  if (!k) return `<span class="pj-pickbar-t">${icon('check')}Coche des notes pour les envoyer à Claude${cc ? ' ou à Claude Code' : ''}.</span><span class="pj-pickbar-end"><button class="link-btn" data-pj="pick-all">Tout cocher (${bulk.length})</button></span>`;
  return `<span class="pj-pickbar-t"><b>${k}</b> note${k > 1 ? 's' : ''} cochée${k > 1 ? 's' : ''}</span>
    ${cc ? `<button class="btn btn-primary" data-pj="pick-cc" title="Une consigne Claude Code, avec ces notes jointes">${icon('terminal')}Claude Code</button>${k > 1 ? `<button class="btn" data-pj="pick-fan" title="Prépare un agent Claude Code par note : ils travaillent en parallèle, chacun dans sa copie">${icon('bolt')}Un agent par note</button>` : ''}` : ''}
    <button class="btn" data-pj="pick-claude" title="Conversation du projet : Claude lit ces notes">${icon('sparkle')}Claude</button>
    <span class="pj-pickbar-end">${bulk.some(n => !sel.has(n.id)) ? '<button class="link-btn" data-pj="pick-all">Tout cocher</button>' : ''}<button class="link-btn" data-pj="pick-none">Tout décocher</button></span>`;
}
/** Importe des fichiers de contexte (CLAUDE.md, AGENTS.md, .cursorrules, notes d'architecture…) : une note du projet
 *  par fichier, marquée #contexte-ia. Titre : le premier titre « # » du fichier, sinon son nom. */
const CTX_MAX = 400_000;
function importContexts(p: Project): void {
  const i = document.createElement('input');
  i.type = 'file'; i.multiple = true; i.hidden = true; i.accept = '.md,.markdown,.mdc,.mdx,.txt,.rst,.cursorrules,.windsurfrules,text/markdown,text/plain';
  i.onchange = async () => {
    const files = [...(i.files ?? [])]; i.remove(); if (!files.length) return;
    let k = 0; const skipped: string[] = [];
    for (const file of files) {
      try {
        const text = (await file.text()).replace(/\r\n?/g, '\n').trim();
        if (!text || text.length > CTX_MAX || text.includes('\u0000')) { skipped.push(file.name); continue; }
        const h1 = /^#\s+(.+)$/m.exec(text.slice(0, 2000))?.[1]?.trim();
        const title = (h1 || file.name.replace(/\.[^.]+$/, '') || file.name).slice(0, 120);
        await store.createNote({ title, body: `${text}\n\n#${p.tag} #${model.CONTEXT_TAG}\n` }); k++;
      } catch { skipped.push(file.name); }
    }
    if (k) toast(`${k} contexte${k > 1 ? 's' : ''} IA importé${k > 1 ? 's' : ''} dans ${p.name}`);
    if (skipped.length) toast(`Non importé${skipped.length > 1 ? 's' : ''} (vide, binaire ou trop long) : ${skipped.join(', ')}`);
    refresh();
  };
  document.body.append(i); i.click();
}
/** Choix des notes du projet lues d'office par l'IA (tag #contexte-ia). */
async function pickContexts(p: Project): Promise<void> {
  const list = model.notesOf(p).filter(n => !n.todo && shareable(n) && store.getBody(n) != null), had = list.filter(model.isContext).map(n => n.id);
  const ids = await pickFrom(list, had, { title: `Contextes IA de ${p.name}`, ok: 'Enregistrer',
    hint: `${icon('sparkle')}Les notes cochées reçoivent <code>#${model.CONTEXT_TAG}</code> : l’IA de Studio et chaque nouvelle consigne Claude Code de ce projet les lisent d’office pour se situer dans l’application.`,
    empty: 'Aucune note lisible dans ce projet : importe d’abord un contexte.' });
  if (!ids) return;
  const want = new Set(ids);
  try { for (const n of list) await model.setContext(n, want.has(n.id)); } catch (err) { toast(errMsg(err)); }
  toast(`${want.size} contexte${want.size > 1 ? 's' : ''} IA dans ${p.name}`); refresh();
}
function noteRows(p: Project): string {
  // La note du projet d'abord, puis celles qui y sont rangées (tag #projet/… ou sous-note d'une note du projet).
  const notes = model.notesOf(p), linked = model.linkedTo(p);
  const cc = bridge.where(), sel = picksOf(p), ok = new Set(pickable(p).map(n => n.id));
  // Une note supprimée, sortie du projet ou devenue privée quitte la sélection.
  for (const id of [...sel]) if (!ok.has(id)) sel.delete(id);
  const pick = (n: Note) => ok.has(n.id) ? `<label class="pj-pick${n.enc ? ' pj-enc' : ''}" title="${n.enc ? 'Note chiffrée : lue par l’IA seulement si tu la coches' : 'Cocher pour l’envoyer à l’IA'}"><input type="checkbox" data-pj-pick="${n.id}"${sel.has(n.id) ? ' checked' : ''} aria-label="Cocher la note ${esc(titleOf(n))}"></label>` : `<span class="pj-pick" title="${store.isLocked(n) ? 'Note chiffrée verrouillée : déverrouille-la pour la joindre à l’IA' : '#privé : jamais envoyée à l’IA'}">${icon('lock')}</span>`;
  // Un seul bouton IA par ligne : un menu (Claude, Claude Code) quand Claude Code est joignable, sinon Claude directement.
  const ask = (n: Note) => !ok.has(n.id) ? '' : cc
    ? `<button class="pj-cc pj-ai" data-pj-ai-note="${n.id}" title="Envoyer cette note à Claude ou à Claude Code" aria-label="Envoyer à l’IA">${icon('sparkle')}</button>`
    : `<button class="pj-cc pj-ai" data-pj-ask-note="${n.id}" title="Discuter de cette note avec Claude" aria-label="Discuter avec Claude">${icon('sparkle')}</button>`;
  const meta = (n: Note) => [n.id === p.id ? 'Note du projet' : '', n.enc ? `<span class="pj-enctag">${store.isLocked(n) ? 'Chiffrée, verrouillée' : 'Chiffrée'}</span>` : '', model.isContext(n) ? '<b class="pj-ctxtag" title="Lue d’office par l’IA dans ce projet">Contexte IA</b>' : '', esc(rel(n.updated))].filter(Boolean).join(' · ');
  const row = (n: Note) => `<div class="pj-row pj-noterow${n.id === p.id ? ' pj-home' : ''}${sel.has(n.id) ? ' sel' : ''}">${pick(n)}<button class="w-row" data-open-note="${n.id}">${icon(n.id === p.id ? 'folder' : n.enc ? 'lock' : 'notes')}<span>${esc(titleOf(n))}</span><em>${meta(n)}</em></button>${ask(n)}</div>`;
  const ctxs = model.contextsOf(p).filter(n => ok.has(n.id)).length;
  return `<div class="pj-pickbar${sel.size ? ' on' : ''}" data-pickbar>${pickBarHTML(p)}</div>
    ${notes.map(row).join('')}
    ${notes.length < 2 ? '<p class="hm-empty">Pour ranger une note dans ce projet : crée-la d’ici, range une note existante, fais-en une sous-note de la note du projet, ou ajoute-lui <code>#' + esc(p.tag) + '</code>.</p>' : ''}
    <div class="pj-noteadd"><button class="hm-more" data-pj="new-note">${icon('plus')}Nouvelle note</button><button class="hm-more" data-pj="adopt">${icon('folder')}Ranger une note existante…</button><button class="hm-more" data-pj="ctx" title="Notes que l’IA lit d’office dans ce projet">${icon('sparkle')}Contextes IA${ctxs ? ` · ${ctxs}` : ''}</button></div>
    ${linked.length ? `<h3 class="pj-linked-h">Liées à la note du projet <span>citées par elle ou qui la citent, sans être rangées ici</span></h3>
      ${linked.map(n => `<div class="pj-row pj-noterow"><span class="pj-pick">${icon('link')}</span><button class="w-row" data-open-note="${n.id}">${icon('notes')}<span>${esc(titleOf(n))}</span><em>${[esc(model.projectOfNote(n)?.name ?? ''), esc(rel(n.updated))].filter(Boolean).join(' · ')}</em></button>${store.getBody(n) != null && !model.byId(n.id) ? `<button class="pj-cc" data-pj-adopt="${n.id}" title="Ajoute #${esc(p.tag)} à cette note">${icon('folder')}Ranger ici</button>` : ''}</div>`).join('')}` : ''}`;
}
const section = (id: string, title: string, ic: string, body: string, cls = '', meta = '') => `<section class="pj-sec ${cls}" data-sec="${esc(id)}"><h2>${icon(ic)}${esc(title)}${meta ? `<span class="pj-sec-meta">${meta}</span>` : ''}</h2><div class="pj-sec-body">${body}</div></section>`;

/** Bloc replié par défaut : le titre se lit, le contenu reste dans la page (les remplissages asynchrones y arrivent quand même). */
const fold = (id: string, title: string, body: string, cls = '', meta = '') => `<details class="pj-sec pj-fold ${cls}" data-sec="${esc(id)}"><summary>${icon('chevronRight')}${esc(title)}${meta ? `<span class="pj-sec-meta">${meta}</span>` : ''}</summary><div class="pj-sec-body">${body}</div></details>`;

/** Sous-menus d'un projet (aussi affichés dans la barre latérale). */
export const TABS: [string, string, string][] = [
  ['recos', 'Recos photo', 'camera'], ['salon', 'Salon', 'sparkle'], ['overview', 'Vue d’ensemble', 'home'], ['sessions', 'Claude Code', 'terminal'], ['tasks', 'Tâches', 'check'], ['notes', 'Notes', 'notes'],
  ['code', 'Code', 'code'], ['archi', 'Architecture', 'graph'], ['api', 'API', 'plug'], ['data', 'Données', 'database'], ['tests', 'Tests', 'shield'],
  ['site', 'Site', 'link'], ['mobile', 'Mobile', 'phone'], ['docker', 'Docker', 'container'], ['env', 'Environnements', 'gear'],
  ['flux', 'Flux', 'pr'], ['server', 'Serveur', 'server'], ['boutique', 'Boutique', 'shop'],
];
/** Familles de la barre d'onglets : l'ordre de TABS suit celui-ci. */
const FAMILIES: [string, string[]][] = [
  ['Piloter', ['recos', 'salon', 'overview', 'sessions', 'tasks', 'notes']], ['Construire', ['code', 'archi', 'api', 'data', 'tests']],
  ['Faire tourner', ['site', 'mobile', 'docker', 'env']], ['Livrer', ['flux', 'server', 'boutique']],
];
/** Les onglets montrés pour ce projet : « Boutique » seulement s'il a une boutique ou un compte publicitaire, « Mobile »
 *  seulement s'il a un dépôt de rôle mobile ou une app mobile dans son dossier (ou si on y est). */
/** Un projet social (réseaux, compte TikTok) n'a ni dépôt ni serveur : seulement ses recos photo, son Salon, ses tâches, ses notes. */
const SOCIAL_TABS = new Set(['recos', 'salon', 'tasks', 'notes', 'boutique']);
export const tabsOf = (p: Project, tab = ''): [string, string, string][] => TABS.filter(t => t[0] === tab
  || ((p.kind !== 'social' || SOCIAL_TABS.has(t[0])) && (t[0] === 'recos' ? p.kind === 'social'
    : t[0] === 'salon' ? claudeAvailable() : t[0] === 'boutique' ? commerce.available() && commerce.concerns(p) : t[0] === 'mobile' ? mobile.concerns(p) : true)));
/** Onglet d'arrivée d'un projet : le Salon quand Claude Code est joignable, sinon la Vue d'ensemble (web pur : pas de Salon). */
export const defaultTab = (p?: Project | null): string => p?.kind === 'social' ? 'recos' : claudeAvailable() ? 'salon' : 'overview';
const curTab = (p?: Project | null): string => { const t = app.viewState().tab; return t && TABS.some(x => x[0] === t) && (t !== 'salon' || claudeAvailable()) ? t : defaultTab(p); };
const panelsHTML = (p: Project, tab: string) => registry.projectPanels(p, tab).map(x => section(x.id, x.title, x.icon, '<p class="nf-empty">Chargement…</p>', 'pj-panel')).join('');
const card = (tab: string, title: string, body: string) => `<button class="pj-ov" data-pj-tab="${tab}"><span class="pj-ov-h">${esc(title)}${icon('chevronRight')}</span><span class="pj-ov-b" data-ov="${tab}">${body}</span></button>`;

function siteHTML(p: Project): string {
  if (!p.site) return `<p class="hm-empty">Aucun site associé à ce projet.</p><form class="td-add pj-site-form"><span class="td-plus">${icon('link')}</span><input type="url" placeholder="https://studio.exemple.com" aria-label="Adresse du site" required></form>`;
  const host = p.site.replace(/^https:\/\//, '').replace(/\/$/, '');
  return `<div class="pj-site"><div class="pj-site-h"><span class="pj-site-dot" data-site-dot></span><a href="${esc(p.site)}" target="_blank" rel="noopener">${esc(host)}</a></div>
    <p class="pj-site-st" data-site-st>${native.available() ? 'Vérification…' : 'La vérification du site se fait depuis l’app Mac.'}</p>
    <div class="pj-site-act"><a class="btn btn-primary" href="${esc(p.site)}" target="_blank" rel="noopener">${icon('link')}Ouvrir le site</a>${native.available() ? `<button class="btn" data-pj="site-check">${icon('refresh')}Vérifier</button>` : ''}<button class="btn" data-pj="site-edit">Changer l’adresse</button></div></div>`;
}

function tabBody(p: Project, tab: string): string {
  const folderBox = `<div class="pj-folder-box">${folderHTML(p, folders.get(p.id) ?? null)}</div>`;
  if (tab === 'code') return `${folderBox}<div class="pj-review"><span>${icon('sparkle')}Revue IA</span><button class="btn" data-pj="review-working">Changements en cours</button><button class="btn" data-pj="review-branch">Branche actuelle</button></div>
    ${section('branches', 'Branches locales', 'pr', native.available() ? '<p class="nf-empty">Chargement…</p>' : '<p class="hm-empty">Visibles dans l’app Mac.</p>')}${panelsHTML(p, 'code')}`;
  if (tab === 'flux') return '<div class="pj-flux"><p class="nf-empty">Chargement du flux…</p></div>';
  if (tab === 'salon') return '<div class="sl-box"></div>';
  if (tab === 'recos') return '<div class="rc-box"></div>';
  if (tab === 'sessions') return '<div class="ss-box"></div>';
  if (tab === 'server') return '<div class="sv-box"><div class="pj-skel"></div></div>';
  if (tab === 'docker') return '<div class="dk-box"><p class="nf-empty">Lecture de Docker…</p></div>';
  if (tab === 'boutique') return '<div class="cm-box"></div>';
  if (tab === 'tasks') return `${section('tasks', 'Tâches', 'check', taskBox(p))}${panelsHTML(p, 'tasks')}`;
  if (tab === 'notes') return section('notes', 'Notes', 'notes', noteRows(p));
  if (tab === 'mobile') return mobile.tabHTML(section);
  if (stack.isTab(tab)) return stack.tabHTML(tab);
  if (tab === 'site') return `${section('site-local', 'En local', 'terminal', site.localHTML())}${section('site', 'En ligne', 'link', siteHTML(p))}${section('site-prod', 'En production', 'server', site.soonHTML())}`;
  const notes = model.notesOf(p).length - 1;
  return `${folderBox}
    ${bridge.where() ? `<section class="pj-quick">${sessions.composerHTML(p, { compact: true })}<div data-ov="agents"></div></section>` : ''}
    <div class="pj-state" data-sk-state><div class="pj-skel"></div></div>
    ${fold('shortcuts', 'Raccourcis', `<div class="pj-ovs">
      ${card('code', 'Pull requests', p.repos.length ? 'Lecture des PR…' : 'Aucun dépôt associé')}
      ${card('site', 'Site', p.site ? esc(p.site.replace(/^https:\/\//, '')) : 'Ajouter le site du projet')}
      ${card('notes', 'Notes', `<b>${notes}</b> note${notes > 1 ? 's' : ''}`)}
      ${card('docker', 'Docker', docker.supported() ? 'Lecture des conteneurs…' : 'Visible dans l’app Mac')}</div>`)}
    ${fold('repos', p.stack.length > 1 ? `Dépôts · ${p.stack.length}` : 'Dépôts', reposHTML(p), 'pj-stack')}
    ${fold('activity', 'Activité', activityHTML(p), 'ac-sec', '30 derniers jours')}${panelsHTML(p, 'overview')}`;
}

// ---------- Serveur (VPS, VM) ----------
// Connexion, clés SSH, empreinte et extensions (Docker, Kubernetes) : voir infra.ts.
interface ServerStatus extends infra.ServerConf { online?: boolean; ms?: number; error?: string; load?: number[]; cpus?: number; uptime?: string; disk?: { size: string; used: string; free: string; pct: number }; mem?: { total: number; used: number }; git?: string; claude?: string; os?: string }
const level = (pct: number) => pct >= 90 ? 'red' : pct >= 75 ? 'amber' : 'green';
function serverHTML(st: ServerStatus, sid = ''): string {
  const local = bridge.local();
  const head = `<div class="sv-head"><span class="pj-site-dot ${st.online ? 'up' : 'down'}"></span><div><strong>${esc(st.name || st.dest || st.host || '')}</strong>${st.name ? `<span class="sv-dest">${esc(st.dest ?? st.host ?? '')}</span>` : ''}<code>${esc(st.path ?? '')}</code>${infra.viaHTML(st)}</div>
    <span class="sv-state">${st.online ? `En ligne · ${st.ms} ms` : 'Injoignable'}</span>
    <span class="sv-act">${local ? `<button class="btn" data-sv="terminal">${icon('terminal')}Terminal SSH</button>` : ''}<button class="btn" data-sv="refresh">${icon('refresh')}Actualiser</button>${local ? `<button class="icon-btn" data-sv="edit" title="Modifier" aria-label="Modifier le serveur">${icon('pencil')}</button>` : ''}</span></div>`;
  if (!st.online) return head + `<p class="sv-err">${icon('shield')}${esc(st.error || 'La connexion SSH a échoué.')}</p>${local ? infra.offlineHTML(st) : ''}`;
  const load = st.load?.[0] ?? 0, cpus = st.cpus || 1, loadPct = Math.min(100, Math.round(load / cpus * 100));
  const memPct = st.mem ? Math.round(st.mem.used / st.mem.total * 100) : 0, diskPct = st.disk?.pct ?? 0;
  const tile = (label: string, value: string, sub: string, pct?: number) => `<div class="sv-tile"><span>${label}</span><strong>${value}</strong>${pct !== undefined ? chart.meter(pct, 100, level(pct)) : ''}<em>${sub}</em></div>`;
  return head + `<div class="sv-grid">
      ${tile('Charge', load.toLocaleString('fr-FR', { maximumFractionDigits: 2 }), `${cpus} cœur${cpus > 1 ? 's' : ''} · ${loadPct} %`, loadPct)}
      ${st.mem ? tile('Mémoire', `${memPct} %`, `${(st.mem.used / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} / ${(st.mem.total / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`, memPct) : tile('Mémoire', '—', 'non disponible')}
      ${st.disk ? tile('Disque', `${diskPct} %`, `${esc(st.disk.used)} sur ${esc(st.disk.size)} · ${esc(st.disk.free)} libres`, diskPct) : tile('Disque', '—', 'dossier introuvable')}
    </div>
    <dl class="sv-facts"><div><dt>Dépôt</dt><dd>${st.git ? `<code>${esc(st.git.replace(/^## /, ''))}</code>` : 'pas un dépôt Git'}</dd></div>
      <div><dt>Claude Code</dt><dd>${st.claude ? esc(st.claude) : '<span class="warn">non installé</span>'}</dd></div>
      <div><dt>Système</dt><dd>${esc(st.os ?? '')}${st.uptime ? ` · allumé depuis ${esc(st.uptime)}` : ''}</dd></div></dl>
    ${specs.html()}
    ${infra.extsHTML(st)}
    ${st.claude ? `<h3 class="ss-h">Lancer un agent sur ce serveur <span>dans une copie isolée du dépôt distant</span></h3>${sessions.composerHTML(model.byId(app.viewState().project) as Project, { machine: 'server', server: sid })}` : `<p class="modal-hint">Installe Claude Code sur le serveur (<code>curl -fsSL https://claude.ai/install.sh | bash</code>) et connecte-le (<code>claude</code> puis <code>/login</code>) pour y lancer des agents.</p>`}`;
}
/** Choix du serveur quand le projet en a plusieurs, et bouton d'ajout (sur le Mac). */
function serverTabs(list: infra.ServerItem[], cur: string): string {
  if (list.length < 2 && !bridge.local()) return '';
  return `<div class="sv-pick" role="tablist" aria-label="Serveurs du projet">${list.map(s => `<button class="sv-pick-b${s.id === cur ? ' on' : ''}" role="tab" aria-selected="${s.id === cur}" data-sv-pick="${esc(s.id)}" title="${esc(s.dest)}">${icon('server')}${esc(s.name || s.dest)}</button>`).join('')}${bridge.local() ? `<button class="sv-pick-b sv-pick-add" data-sv="add">${icon('plus')}Ajouter un serveur</button>` : ''}</div>`;
}
async function server(root: HTMLElement, p: Project): Promise<void> {
  const box = $('.sv-box', root); if (!box) return;
  if (!bridge.where()) { box.innerHTML = `<div class="ag-empty">${icon('server')}<h3>Le serveur se pilote depuis le Mac</h3><p>Ouvre ce projet dans l’app Studio pour Mac, ou lie cet appareil au Mac pour suivre le serveur d’ici.</p></div>`; return; }
  // Plusieurs serveurs par projet : on garde le dernier choisi pour chaque projet, sinon le premier.
  const ls = await infra.list(p);
  if (!box.isConnected) return;
  if (!ls.ok) { box.innerHTML = `<p class="hm-empty">${esc(ls.message ?? 'Lecture impossible.')}</p>`; return; }
  if (!ls.servers.length) {
    if (!bridge.local()) { box.innerHTML = `<div class="ag-empty">${icon('server')}<h3>Aucun serveur relié</h3><p>Relie le serveur du projet depuis le Mac (onglet Serveur).</p></div>`; return; }
    infra.use(p, ''); await infra.openForm(box, p); return;
  }
  const want = infra.current(p), sid = ls.servers.some(s => s.id === want) ? want : ls.servers[0].id;
  infra.use(p, sid);
  const st = (await bridge.call('agent', 'server', { project: p.id, op: 'status', server: sid }, 30000)) as ServerStatus & { ok: boolean; message?: string };
  if (!box.isConnected || infra.current(p) !== sid) return;
  const tabs = serverTabs(ls.servers, sid);
  if (!st.ok) { box.innerHTML = `${tabs}<p class="hm-empty">${esc(st.message ?? 'Lecture impossible.')}</p>`; return; }
  box.innerHTML = tabs + serverHTML(st, sid);
  box.dataset.st = JSON.stringify(st);
  if (st.online) { infra.loadExts(box, p); void specs.load(box, p); }
  sessions.bindComposer(box, p, r => { sessions.select(r.session || null, p.id); void go(p.id, 'sessions'); });
}

// ---------- Activité ----------
// Un tableau de mesures, sans boîtes ni icônes : libellé, chiffre, puis une courbe en barres fines. Les deux séries
// datées partagent la même échelle de 30 jours et un seul axe de dates. Le libellé mène à l’onglet correspondant.
const DAYS = 30;
const row = (tab: string, label: string, key: string, body = '<span class="ac-skel"></span>') =>
  `<div class="ac-row"><button class="ac-name" data-pj-tab="${tab}" title="Ouvrir">${esc(label)}</button><div class="ac-cells" data-ch="${key}">${body}</div></div>`;
/** Chiffre principal, ce qu’il compte, et une ligne de précisions (déjà échappées par l’appelant). */
const fig = (n: string, unit: string, ...sub: string[]) => `<div class="ac-fig"><p><strong>${n}</strong><span>${esc(unit)}</span></p><small>${sub.filter(Boolean).join(' · ')}</small></div>`;
const muted = (t: string) => `<div class="ac-fig"><p><strong>—</strong></p></div><p class="ac-empty">${t}</p>`;
/** Évolution sur 7 jours en texte neutre : une baisse n’est pas une alerte. */
function delta(cur: number, prev: number): string {
  if (!cur && !prev) return '';
  if (!prev) return '<span title="Rien les 7 jours précédents">nouveau sur 7 j</span>';
  const pct = Math.round((cur - prev) / prev * 100);
  return `<span title="Par rapport aux 7 jours précédents">${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)} % sur 7 j</span>`;
}
/** Barres fines d’une série journalière ; `tips[i]` est l’infobulle du jour i. Les jours vides gardent un trait de 1 px. */
function acBars(points: chart.Point[], tips: string[], summary: string, unit: string): string {
  const max = Math.max(1, ...points.map(x => x.value));
  const word = (n: number) => `${chart.fmt(n)} ${unit}${n > 1 ? 's' : ''}`;
  return `<div class="ac-plot"><div class="ac-bars" role="img" aria-label="${esc(summary)}">${points.map((x, i) =>
    `<span class="ac-b${i === points.length - 1 ? ' now' : ''}" data-tip="${esc(tips[i] ?? '')}">${x.value ? `<i style="height:${Math.max(6, x.value / max * 100).toFixed(1)}%"></i>` : '<i class="z"></i>'}</span>`).join('')}</div>
    <table class="sr-only"><caption>${esc(summary)}</caption>${points.filter(x => x.value).map(x => `<tr><th>${esc(x.label)}</th><td>${esc(word(x.value))}</td></tr>`).join('')}</table></div>`;
}
/** Axe des dates, commun aux séries datées : trois repères et « aujourd’hui ». */
function axisHTML(): string {
  const pts = chart.lastDays(DAYS, {}), at = (i: number) => new Date(`${pts[i]?.key}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const t = [0, 10, 20].map(i => `<span style="--x:${((i + .5) / DAYS * 100).toFixed(2)}%">${esc(at(i))}</span>`).join('');
  return `<div class="ac-row ac-ax" aria-hidden="true"><div class="ac-axis">${t}<span style="--x:100%">aujourd’hui</span></div></div>`;
}
function activityHTML(p: Project): string {
  return `<div class="ac-wrap" style="--k:var(--c-${p.hue})">${row('code', 'Commits', 'commits')}${row('sessions', 'Claude Code', 'tokens')}${axisHTML()}${row('tasks', 'Tâches', 'tasks', tasksBody(p))}${row('flux', 'Intégration continue', 'ci')}</div>`;
}
function tasksBody(p: Project): string {
  const c = todo.ofProject(p.id), done = c.doneAll.length, total = done + c.openCount;
  if (!total) return muted('Aucune tâche dans ce projet pour l’instant.');
  const late = c.late.length, doing = c.doing.filter(t => !c.late.includes(t)).length, rest = Math.max(0, c.openCount - late - doing);
  const parts: [string, string, number][] = [['done', 'terminées', done], ['doing', 'en cours', doing], ['todo', 'à faire', rest], ['late', 'en retard', late]];
  return `${fig(`${Math.round(done / total * 100)} %`, 'terminées', `${done} sur ${total}`)}
    <div class="ac-plot"><div class="ac-segs" role="img" aria-label="${esc(parts.map(([, l, n]) => `${n} ${l}`).join(', '))}">${parts.filter(x => x[2]).map(([k, l, n]) => `<i class="s-${k}" style="flex-grow:${n}" data-tip="${esc(`${n} ${l}`)}"></i>`).join('')}</div>
    <p class="ac-legend">${parts.filter(x => x[2]).map(([k, l, n]) => `<span class="s-${k}"><b>${n}</b> ${l}</span>`).join('')}</p></div>`;
}
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
async function dashboard(root: HTMLElement, p: Project, f: Folder | null): Promise<void> {
  const short = (name: string) => name.split('/')[1] ?? name;
  // Commits par jour, tous dépôts confondus (le détail par dépôt est dans l’infobulle) : le dossier du Mac (toutes branches), les autres depuis GitHub.
  void (async () => {
    const series: { label: string; points: chart.Point[] }[] = [];
    let here: Repo | null = null, local = false;
    if (f?.path || (!bridge.local() && bridge.where())) {
      const r = await bridge.call('agent', 'commits', { project: p.id, days: DAYS }, 20000);
      if (r.ok && r.found !== false) {
        local = true;
        // Depuis un appareil lié, le remote du dossier n'est pas connu : le dossier du Mac est supposé être le dépôt principal.
        here = model.repoNamed(p, f?.remote) ?? (f ? null : p.stack[0] ?? null);
        series.push({ label: here ? short(here.name) : 'Dossier du Mac', points: chart.lastDays(DAYS, r.days as Record<string, number>) });
      }
    }
    if (github.connected()) {
      const others = p.stack.filter(r => r.name !== here?.name);
      const got = await Promise.allSettled(others.map(r => github.commitsPerDay(r.name, DAYS)));
      others.forEach((r, i) => { const g = got[i]; if (g?.status === 'fulfilled') series.push({ label: short(r.name), points: chart.lastDays(DAYS, g.value) }); });
    }
    if (!series.length) return fill(root, '[data-ch="commits"]', muted(p.repos.length ? 'Connecte GitHub ou choisis le dossier du projet pour voir son activité.' : 'Associe un dépôt ou choisis le dossier du projet.'));
    const all = (series[0]?.points ?? []).map((pt, i) => ({ ...pt, value: series.reduce((a, s) => a + (s.points[i]?.value ?? 0), 0) }));
    const n = all.reduce((a, x) => a + x.value, 0), [cur, prev] = chart.lastVsPrev(all);
    const src = series.length > 1 ? series.map(s => `${esc(s.label)} ${chart.fmt(s.points.reduce((a, x) => a + x.value, 0))}`).join(', ') : local ? 'toutes branches' : 'branche principale';
    const tips = all.map((d, i) => {
      const by = series.length > 1 ? series.filter(s => s.points[i]?.value).map(s => `${s.label} ${s.points[i]?.value}`).join(', ') : '';
      return `${d.label} · ${chart.fmt(d.value)} commit${d.value > 1 ? 's' : ''}${by ? ` (${by})` : ''}`;
    });
    fill(root, '[data-ch="commits"]', fig(chart.fmt(n), `commit${n > 1 ? 's' : ''}`, delta(cur, prev), src)
      + acBars(all, tips, `${n} commits sur 30 jours`, 'commit'));
  })();
  // Claude Code : tokens écrits par jour.
  void (async () => {
    if (!bridge.where()) return fill(root, '[data-ch="tokens"]', muted('La consommation de Claude Code se lit depuis l’app Mac, ou depuis un appareil lié au Mac.'));
    if (bridge.local() && !f?.path) return fill(root, '[data-ch="tokens"]', muted('Choisis le dossier du projet pour suivre Claude Code.'));
    const r = await bridge.call('agent', 'daily', { project: p.id, days: DAYS }, 30000);
    const tok = (r.tokens as Record<string, number>) ?? {}, n = sum(tok), ses = sum((r.sessions as Record<string, number>) ?? {});
    if (!n) return fill(root, '[data-ch="tokens"]', muted('Aucune session Claude Code ces 30 derniers jours.'));
    const pts = chart.lastDays(DAYS, tok), [cur, prev] = chart.lastVsPrev(pts);
    fill(root, '[data-ch="tokens"]', fig(chart.fmt(n), 'tokens écrits', delta(cur, prev), `${ses} session${ses > 1 ? 's' : ''}`)
      + acBars(pts, pts.map(d => `${d.label} · ${chart.fmt(d.value)} token${d.value > 1 ? 's' : ''}`), `${n} tokens écrits par Claude Code sur 30 jours`, 'token'));
  })();
  // CI : les dernières exécutions sur la branche principale, une ligne par dépôt.
  void (async () => {
    if (!p.repos.length || !github.connected()) return fill(root, '[data-ch="ci"]', muted(p.repos.length ? 'Connecte GitHub pour suivre la CI.' : 'Associe un dépôt GitHub au projet.'));
    const got = await Promise.allSettled(p.stack.map(r => github.flow(r.name)));
    const rows = p.stack.flatMap((r, i) => { const g = got[i]; return g?.status === 'fulfilled' ? [{ r, fl: g.value }] : []; });
    if (!rows.length) return fill(root, '[data-ch="ci"]', muted('GitHub ne répond pas.'));
    const runs = rows.flatMap(x => x.fl.history), done = runs.filter(x => x.state !== 'pending'), ok = done.filter(x => x.state === 'success').length;
    if (!runs.length) return fill(root, '[data-ch="ci"]', muted('Aucune exécution de CI sur les branches principales.'));
    const rate = (h: chart.Run[]): number | null => { const d = h.filter(x => x.state !== 'pending'); return d.length ? Math.round(d.filter(x => x.state === 'success').length / d.length * 100) : null; };
    const main = rows[0], rel0 = main?.fl.releases[0], WORD = { success: 'réussie', failure: 'en échec', pending: 'en cours' };
    const run = (x: chart.Run) => { const tip = esc(`${x.label} · ${WORD[x.state]}`), at = `class="ac-run s-${x.state}" data-tip="${tip}" aria-label="${tip}"`; return x.url ? `<a ${at} role="listitem" href="${esc(x.url)}" target="_blank" rel="noopener"></a>` : `<span ${at} role="listitem"></span>`; };
    fill(root, '[data-ch="ci"]', fig(done.length ? `${Math.round(ok / done.length * 100)} %` : '—', 'réussies', `${runs.length} exécutions`)
      + `<div class="ac-plot"><div class="ac-ci">${rows.map(({ r, fl }) => {
        const pc = rate(fl.history), st = fl.history[fl.history.length - 1]?.state;
        return `<div class="ac-ci-row"><code title="${esc(r.name)}">${esc(short(r.name))}</code>${fl.history.length ? `<div class="ac-runs" role="list">${fl.history.map(run).join('')}</div>` : '<span class="ac-none">pas de CI</span>'}<b class="${st === 'failure' ? 'err' : ''}">${pc === null ? '—' : `${pc} %`}</b></div>`;
      }).join('')}</div>${main && rel0 ? `<p class="ac-foot">Dernière version de ${esc(short(main.r.name))} : <code>${esc(rel0.tag)}</code></p>` : ''}</div>`);
  })();
  chart.bindTips(root);
}
async function agentsStrip(root: HTMLElement, p: Project): Promise<void> {
  const box = $('[data-ov="agents"]', root); if (!box || !bridge.where()) return;
  const r = await bridge.call('agent', 'list', { project: p.id }, 10000), list = ((r.runs as sessions.AgentRun[] | undefined) ?? []).filter(x => x.status === 'running' || x.status === 'starting');
  box.innerHTML = list.map(x => `<button class="pj-agent" data-pj-agent="${esc(x.session)}"><i class="ss-live on"></i><span>${esc(x.prompt)}</span><em>${esc(x.lastText || 'Démarrage…')}</em>${icon('chevronRight')}</button>`).join('');
}

/** Le Salon est la seule face d'un projet (28 nov. 2026, « garde que la lounge ») : plus de rangée d'onglets. Claude Code,
 *  Tâches et Flux ne se listent plus nulle part (le Salon les porte : étapes en direct, équipe, carte de livraison) ; ils
 *  restent des adresses, ouvertes par « Vue technique » et par la carte de livraison. Les autres vues sont des outils. */
const HIDDEN_TABS = new Set(['salon', 'sessions', 'tasks', 'flux']);
function moreTabs(p: Project, tab: string, anchor: Element): void {
  const have = tabsOf(p, tab).filter(t => !HIDDEN_TABS.has(t[0]) || (t[0] === 'tasks' && p.kind === 'social')), items: Parameters<typeof menu>[1] = [];
  for (const [title, keys] of FAMILIES) {
    const mine = have.filter(t => keys.includes(t[0])); if (!mine.length) continue;
    if (items.length) items.push('-');
    items.push({ label: title }, ...mine.map(([k, l, ic]) => ({ label: l, icon: ic, checked: k === tab, run: () => go(p.id, k) })));
  }
  menu(anchor, items);
}

/** Pastille du serveur du projet, en tête de page : un nom, ou « N serveurs » ; ouvre l'onglet Serveur. Vide sans serveur. */
function serverBadge(p: Project): string {
  const all = infra.sideServers(p.id);
  if (!all.length) return '<span class="pj-srv" hidden></span>';
  const cur = all.find(s => s.sel) ?? all[0]!, label = all.length > 1 ? `${all.length} serveurs` : cur.name;
  return `<button type="button" class="lv-chip pj-srv" data-pj-tab="server" title="${esc(all.map(s => s.name).join(', '))} · ouvrir l’onglet Serveur">${icon('server')}${esc(label)}</button>`;
}

function detailHTML(p: Project, tab: string): string {
  return `<div class="pj-head" style="--c:var(--c-${p.hue})"><div class="pj-title"><button type="button" class="pj-icbtn" data-pj="icon" title="Changer la couleur" aria-label="Changer la couleur du projet">${projIcons.tile(p, 'pi-lg')}</button><h1>${esc(p.name)}</h1></div>
      <div class="pj-bar"><div class="pj-links" data-k="${esc(`${model.formatRepos(p.stack)}|${p.site ?? ''}|${p.linear ?? ''}`)}">${p.stack.map(r => `<a class="lv-chip pj-chip-repo" href="https://github.com/${esc(r.name)}" target="_blank" rel="noopener" title="${esc(`${model.ROLES[r.role].label} · ${r.name}`)}">${model.roleTag(r.role, 'sm')}${esc(r.name.split('/')[1] ?? r.name)}</a>`).join('')}${p.linear ? `<span class="lv-chip">${icon('linear')}${esc(p.linear)}</span>` : ''}${p.site ? `<a class="lv-chip" href="${esc(p.site)}" target="_blank" rel="noopener">${icon('link')}${esc(p.site.replace(/^https:\/\//, ''))}</a>` : ''}<span class="lv-chip">#${esc(p.tag)}</span>${serverBadge(p)}</div><div class="pj-acts">${claudeAvailable() ? `<button class="btn btn-ghost pj-note" data-pj-tab="salon" title="Revenir au Salon du projet">${icon('sparkle')}Salon</button>` : ''}<button class="btn btn-ghost pj-note" data-pj="tabs-more" aria-haspopup="menu" title="Les autres vues du projet">${icon('more')}Outils</button><button class="btn btn-ghost pj-note" data-pj="edit">${icon('notes')}Note du projet</button><button class="btn btn-ghost pj-note" data-pj="claude" title="Conversation bornée à ce projet : Claude ne voit que ses données">${icon('sparkle')}Claude</button></div></div>
</div>
    <div class="pj-body" data-tab="${tab}">${tabBody(p, tab)}</div>`;
}

const fill = (root: HTMLElement, sel: string, html: string) => { const b = $(sel, root); if (b) b.innerHTML = html; };
async function hydrate(root: HTMLElement, p: Project, tab: string): Promise<void> {
  for (const x of registry.projectPanels(p, tab)) {
    void Promise.resolve().then(() => x.render(p)).then(html => fill(root, `[data-sec="${CSS.escape(x.id)}"] .pj-sec-body`, html))
      .catch(e => fill(root, `[data-sec="${CSS.escape(x.id)}"] .pj-sec-body`, `<p class="nf-empty">${esc(errMsg(e))}</p>`));
  }
  // Une app mobile dans le dossier fait apparaître l'onglet Mobile (regardé une fois par session, sur le Mac).
  void mobile.probe(p).then(changed => {
    if (!changed) return;
    app.renderSidebar();
  });
  if (tab === 'flux') { const box = $('.pj-flux', root); if (box) { void flux.mount(box, p); chart.bindTips(root); } }
  if (tab === 'recos') { const box = $('.rc-box', root); if (box) recos.mount(box, p, { openNote: id => app.openNote(id) }); }
  if (tab === 'salon') { const box = $('.sl-box', root); if (box) salon.mount(box, p, { openTech: id => { sessions.select(id || null, p.id); void go(p.id, 'sessions'); }, bar: app.tbLeft(), openNote: id => app.openNote(id), openSkills: () => void app.setView({ type: 'tag', tag: salon.SKILL_TAG }) }); }
  const f = await folderOf(p);
  fill(root, '.pj-folder-box', folderHTML(p, f));
  if (tab === 'sessions') { const box = $('.ss-box', root); if (box) sessions.mount(box, p, f?.path ?? null); }
  if (tab === 'code' && native.available()) {
    const r = await native.call('project', 'branches', { project: p.id }, 20000), list = (r.branches as { name: string; date: string; ahead: number; behind: number; upstream: string }[] | undefined) ?? [];
    fill(root, '[data-sec="branches"] .pj-sec-body', list.length ? list.map(b => `<div class="pj-br"><code>${esc(b.name)}</code>${b.name === f?.branch ? '<em class="pj-badge approved">actuelle</em>' : ''}${b.upstream ? '' : '<em class="pj-badge">locale</em>'}<span>${b.ahead ? `↑${b.ahead} ` : ''}${b.behind ? `↓${b.behind}` : ''}</span><time>${esc(rel(Date.parse(b.date)))}</time></div>`).join('') : '<p class="hm-empty">Choisis le dossier du projet pour voir ses branches.</p>');
  }
  if (tab === 'site') site.mount(root, p);
  if (tab === 'mobile') mobile.mount(root, p);
  if (stack.isTab(tab)) stack.mount(root, p, tab, prompt => toClaude(p, { prompt }));
  if (tab === 'site' && p.site && native.available()) void checkSite(root, p);
  if (tab === 'server') void server(root, p);
  if (tab === 'docker') { const box = $('.dk-box', root); if (box) docker.mount(box, p, f?.path ?? null); }
  if (tab === 'boutique') { const box = $('.cm-box', root); if (box) commerce.mount(box, p); }
  if (tab === 'overview') {
    void stack.overviewFill(root, p); void overview(root, p, f); void dashboard(root, p, f); void agentsStrip(root, p); void docker.fillCard(root, p);
    sessions.bindComposer(root, p, r => { sessions.select(r.session || null, p.id); void go(p.id, 'sessions'); });
  }
}

async function checkSite(root: HTMLElement, p: Project): Promise<void> {
  const st = $('[data-site-st]', root), dot = $('[data-site-dot]', root); if (!st || !p.site) return;
  st.textContent = 'Vérification…';
  const r = await native.call('project', 'site', { url: p.site }, 20000);
  dot?.classList.toggle('up', !!r.up); dot?.classList.toggle('down', !r.up);
  st.innerHTML = !r.ok ? esc(r.message ?? 'Vérification impossible.') : r.up ? `En ligne · code ${String(r.status)} · ${String(r.ms)} ms` : `<span class="err">Ne répond pas</span>${r.status ? ` · code ${String(r.status)}` : ''}${r.message ? ` · ${esc(String(r.message))}` : ''}`;
}

async function overview(root: HTMLElement, p: Project, f: Folder | null): Promise<void> {
  if (p.repos.length && github.connected()) {
    Promise.allSettled(p.repos.map(r => github.project(r))).then(res => {
      const ok = res.flatMap(x => x.status === 'fulfilled' ? [x.value] : []);
      if (!ok.length) { fill(root, '[data-ov="code"]', 'GitHub ne répond pas'); return; }
      const pulls = ok.flatMap(x => x.pulls);
      const failing = pulls.filter(x => x.ci === 'failure').length, ready = pulls.filter(x => x.review === 'approved' && x.ci === 'success').length;
      fill(root, '[data-ov="code"]', `<b>${pulls.length}</b> PR ouverte${pulls.length > 1 ? 's' : ''}${p.repos.length > 1 ? ` sur ${p.repos.length} dépôts` : ''}${failing ? ` · <span class="err">${failing} CI en échec</span>` : ''}${ready ? ` · <span class="ok">${ready} prête${ready > 1 ? 's' : ''}</span>` : ''}${f?.branch ? ` · sur <code>${esc(f.branch)}</code>` : ''}`);
    }).catch(() => fill(root, '[data-ov="code"]', 'GitHub ne répond pas'));
  }
  void repoStates(root, p, f);
  if (p.site && native.available()) {
    const r = await native.call('project', 'site', { url: p.site }, 20000);
    fill(root, '[data-ov="site"]', `${esc(p.site.replace(/^https:\/\//, ''))} · ${r.up ? `<span class="ok">en ligne</span> · ${String(r.ms)} ms` : '<span class="err">ne répond pas</span>'}`);
  }
}

// ---------- Dépôts du projet (app, site, API…) ----------
/** Une carte par dépôt : son rôle, son nom, puis son état GitHub (CI, PR, version) rempli par `repoStates`. */
function reposHTML(p: Project): string {
  const cards = p.stack.map((r, i) => {
    const [owner, name] = r.name.split('/');
    return `<div class="pj-rp" style="--c:var(--c-${model.ROLES[r.role].hue})" data-rp="${esc(r.name)}">
      <header>${model.roleTag(r.role)}${i === 0 && p.stack.length > 1 ? '<em class="pj-badge">principal</em>' : ''}<span class="pj-rp-here" data-rp-here hidden>${icon('folder')}ce Mac</span>
        <button class="icon-btn" data-pj="repo-menu" data-repo="${esc(r.name)}" title="Rôle, ordre, retirer" aria-label="Options du dépôt ${esc(r.name)}">${icon('more')}</button></header>
      <a class="pj-rp-name" href="https://github.com/${esc(r.name)}" target="_blank" rel="noopener"><span>${esc(owner ?? '')}/</span>${esc(name ?? '')}</a>
      <p class="pj-rp-st" data-rp-local hidden></p>
      <p class="pj-rp-st" data-rp-st>${github.connected() ? '<span class="pj-skel sm"></span>' : '<span class="muted">Connecte GitHub pour voir la CI et les PR</span>'}</p></div>`;
  }).join('');
  return `<div class="pj-rps">${cards}<button class="pj-rp pj-rp-add" data-pj="repo-add">${icon('plus')}<strong>${p.stack.length ? 'Ajouter un dépôt' : 'Associer un dépôt GitHub'}</strong><span>${ROLE_HINT}</span></button></div>`;
}
const ROLE_HINT = 'App · Site · API · Mobile · Docs…';
const CI_TXT: Record<string, [string, string]> = { success: ['green', 'CI verte'], failure: ['red', 'CI en échec'], pending: ['amber', 'CI en cours'], none: ['gray', 'pas de CI'] };
async function repoStates(root: HTMLElement, p: Project, f: Folder | null): Promise<void> {
  const here = model.repoNamed(p, f?.remote);
  if (here) { const b = $(`[data-rp="${CSS.escape(here.name)}"] [data-rp-here]`, root); if (b) b.hidden = false; }
  if (f && (f.path || f.home) && (p.stack.length > 1 || !f.path)) void localRepos(root, p);
  if (!github.connected()) return;
  await Promise.all(p.stack.map(async r => {
    const box = $(`[data-rp="${CSS.escape(r.name)}"] [data-rp-st]`, root); if (!box) return;
    try {
      const [fl, pr] = await Promise.all([github.flow(r.name), github.project(r.name)]);
      const [hueCi, ci] = CI_TXT[fl.baseCi] ?? ['gray', ''], rel0 = fl.releases[0];
      box.innerHTML = `<span class="pj-rp-ci" style="--c:var(--c-${hueCi})"><i></i>${ci}</span><span><b>${pr.pulls.length}</b> PR</span>${rel0 ? `<span class="pj-rp-tag">${esc(rel0.tag)}</span>` : ''}<span class="muted">${esc(rel(Date.parse(pr.info.pushed_at)))}</span>`;
    } catch (e) { box.innerHTML = `<span class="err">${esc(errMsg(e))}</span>`; }
  }));
}
/** Le dossier de chaque dépôt sur ce Mac, affiché sur sa carte et modifiable. Le Mac retrouve seul les clones rangés à côté
 *  du dossier du projet ; pour les autres, un clic les clone au même endroit (ou désigne un dossier). Les agents travaillent
 *  dans tous ceux qui ont un dossier. Le dépôt du dossier du projet se change avec `pick`, les autres avec `repo-pick`. */
async function localRepos(root: HTMLElement, p: Project): Promise<void> {
  if (!native.available() || document.documentElement.dataset.native !== 'mac') return;
  const r = await native.call('project', 'repos', { project: p.id, repos: p.stack }, 30000);
  if (!r.ok || !Array.isArray(r.repos)) return;
  for (const x of r.repos as { name: string; path: string | null; main?: boolean }[]) {
    const card = $(`[data-rp="${CSS.escape(model.repoNamed(p, x.name)?.name ?? x.name)}"]`, root); if (!card) continue;
    const badge = $('[data-rp-here]', card), box = $('[data-rp-local]', card);
    if (x.path) {
      if (badge) { badge.hidden = false; badge.title = x.path; }
      if (box) {
        box.hidden = false;
        const change = x.main ? `data-pj="pick"` : `data-pj="repo-pick" data-repo="${esc(x.name)}"`;
        box.innerHTML = `<span class="muted" title="${esc(x.path)}">${icon('folder')}${esc(x.path)}${x.main ? ' · dossier du projet' : ''}</span><button class="link-btn" ${change}>Changer</button>`;
      }
      continue;
    }
    if (box) {
      box.hidden = false;
      const where = typeof r.home === 'string' ? ` dans ${esc(r.home)}` : '';
      box.innerHTML = `<span class="muted">Pas sur ce Mac : les agents ne le voient pas.</span><button class="link-btn" data-pj="repo-clone" data-repo="${esc(x.name)}" title="Cloner${where}">${icon('download')}Cloner${where}</button><button class="link-btn" data-pj="repo-clone" data-repo="${esc(x.name)}" data-choose="1">Cloner ailleurs…</button><button class="link-btn" data-pj="repo-pick" data-repo="${esc(x.name)}">${icon('folder')}Choisir son dossier</button>`;
    }
  }
}
/** Choix d'un rôle en pastilles (boutons radio), pour les fenêtres d'ajout et de création. */
const rolePicker = (name: string, cur: Role) => `<div class="pj-rolepick" role="radiogroup" aria-label="Rôle du dépôt">${model.ROLE_ORDER.map(k => `<label style="--c:var(--c-${model.ROLES[k].hue})" title="${esc(model.ROLES[k].hint)}"><input type="radio" name="${name}" value="${k}"${k === cur ? ' checked' : ''}><span>${icon(model.ROLES[k].icon)}${model.ROLES[k].label}</span></label>`).join('')}</div>`;
const cleanRepo = (v: string) => v.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
function fillRepoList(node: ParentNode): void {
  if (github.connected()) github.myRepos().then(rs => { const d = $('#pj-repos', node); if (d) d.innerHTML = rs.map(r => `<option value="${esc(r)}">`).join(''); }).catch(() => {});
}
/** Le rôle suit le nom tapé (…-site, …-api) tant que la personne n'en a pas choisi un. */
function autoRole(input: HTMLInputElement, scope: ParentNode, radio: string, main: () => boolean): void {
  let touched = false;
  scope.addEventListener('change', e => { if ((e.target as HTMLInputElement).name === radio) touched = true; });
  input.addEventListener('input', () => {
    if (touched) return;
    const role = model.guessRole(cleanRepo(input.value), main());
    const r = scope.querySelector<HTMLInputElement>(`input[name="${radio}"][value="${role}"]`); if (r) r.checked = true;
  });
}
function addRepoDialog(p: Project): void {
  const m = modal({ title: `Ajouter un dépôt à ${p.name}`, cls: 'pj-create', html: `<form>
    <label class="pj-field"><span>Dépôt GitHub</span><input class="field" name="repo" placeholder="propriétaire/dépôt" list="pj-repos" autocomplete="off" required autofocus><datalist id="pj-repos"></datalist></label>
    <div class="pj-field"><span>Son rôle dans le projet</span>${rolePicker('role', p.stack.length ? 'autre' : 'app')}</div>
    <p class="lock-err" role="alert"></p>
    <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">${icon('plus')}Ajouter</button></div></form>` });
  need('[data-x]', m.node).onclick = m.close;
  fillRepoList(m.node);
  const form = need<HTMLFormElement>('form', m.node), input = need<HTMLInputElement>('[name=repo]', form);
  autoRole(input, form, 'role', () => !p.stack.length);
  form.onsubmit = async e => {
    e.preventDefault();
    const name = cleanRepo(input.value), role = (new FormData(form).get('role') as Role | null) ?? 'autre', err = need('.lock-err', m.node);
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) { err.textContent = 'Le dépôt s’écrit « propriétaire/nom ».'; return; }
    if (model.repoNamed(p, name)) { err.textContent = 'Ce dépôt fait déjà partie du projet.'; return; }
    try { await model.setRepos(p, [...p.stack, { name, role }]); m.close(); toast(`${name} ajouté · ${model.ROLES[role].label}`); }
    catch (x) { err.textContent = errMsg(x); }
  };
}
function repoMenu(p: Project, anchor: Element, name: string): void {
  const i = p.stack.findIndex(r => r.name === name), cur = p.stack[i]; if (!cur) return;
  const save = (list: Repo[], msg: string) => model.setRepos(p, list).then(() => toast(msg)).catch(e => toast(errMsg(e)));
  menu(anchor, [{ label: 'Rôle du dépôt' },
    ...model.ROLE_ORDER.map(k => ({ label: model.ROLES[k].label, icon: model.ROLES[k].icon, hint: model.ROLES[k].hint, checked: cur.role === k,
      run: () => save(p.stack.map(r => r.name === name ? { ...r, role: k } : r), `${name} · ${model.ROLES[k].label}`) })),
    '-',
    ...(i > 0 ? [{ label: 'En faire le dépôt principal', icon: 'pin', run: () => save([cur, ...p.stack.filter(r => r.name !== name)], `${name} est le dépôt principal`) }] : []),
    { label: 'Ouvrir sur GitHub', icon: 'github', run: () => window.open(`https://github.com/${name}`, '_blank', 'noopener') },
    { label: 'Retirer du projet', icon: 'trash', danger: true, run: async () => {
      if (await confirmBox({ title: `Retirer ${name} ?`, text: 'Le dépôt n’est pas touché sur GitHub : il ne fait simplement plus partie de ce projet.', ok: 'Retirer', danger: true })) void save(p.stack.filter(r => r.name !== name), `${name} retiré du projet`);
    } }]);
}

// ---------- Création ----------
export async function createDialog(): Promise<void> {
  const m = modal({ title: 'Nouveau projet', cls: 'pj-create', html: `<form>
    <div class="pj-kind" role="radiogroup" aria-label="Genre de projet"><label><input type="radio" name="kind" value="code" checked><span>${icon('code')}Code</span></label><label><input type="radio" name="kind" value="social"><span>${icon('camera')}Réseaux sociaux</span></label><i class="pj-kind-ind" aria-hidden="true"></i></div>
    <div class="pj-field"><span>Nom</span><div class="pj-namerow"><button type="button" class="pj-icbtn" data-icon title="Choisir la couleur" aria-label="Choisir la couleur">${projIcons.tile({ icon: 'window', hue: 'blue' }, 'pi-lg')}</button><input class="field" name="name" placeholder="Ex. Studio" required autofocus aria-label="Nom du projet"></div></div>
    <label class="pj-field pj-social"><span>Compte TikTok <em>facultatif</em></span><input class="field" name="tiktok" placeholder="@compte" autocomplete="off" spellcheck="false"></label>
    <div class="pj-field pj-code"><span>Dépôts GitHub <em>facultatif · l’app, son site, son API…</em></span><div class="pj-newrepos"></div><datalist id="pj-repos"></datalist>
      <button type="button" class="link-btn pj-addrow" data-row>${icon('plus')}Un autre dépôt</button></div>
    <label class="pj-field pj-code"><span>Projet Linear <em>facultatif</em></span><input class="field" name="linear" placeholder="Nom du projet dans Linear" list="pj-linear" autocomplete="off"><datalist id="pj-linear"></datalist></label>
    <label class="pj-field"><span>En une phrase <em>facultatif</em></span><input class="field" name="desc" placeholder="Ce que ce projet doit accomplir"></label>
    ${native.available() ? '<p class="modal-hint pj-code">Tu choisiras ensuite son dossier sur ce Mac.</p>' : ''}
    <p class="lock-err" role="alert"></p>
    <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Créer le projet</button></div></form>` });
  need('[data-x]', m.node).onclick = m.close;
  fillRepoList(m.node);
  // Genre et icône : l'icône suit le nom tant qu'on ne l'a pas choisie ; le genre montre ses seuls champs.
  const form = need<HTMLFormElement>('form', m.node), nameIn = need<HTMLInputElement>('input[name=name]', m.node), icBtn = need('[data-icon]', m.node);
  let look: { icon: string; hue: string } | null = null;
  const kindNow = (): model.Kind => (new FormData(form).get('kind') === 'social' ? 'social' : 'code');
  let drawn = '';
  const paintIcon = (hop = false): void => {
    const name = nameIn.value.trim(), shown = look ?? { icon: projIcons.guessIcon(name, kindNow()), hue: hue(model.slugify(name || 'projet')) }, key = `${shown.icon}|${shown.hue}`;
    if (key === drawn && !hop) return;
    // L'icône change en cours de frappe (« Boutique » → sac) : elle saute, comme quand on la choisit.
    icBtn.innerHTML = projIcons.tile(shown, `pi-lg${hop || drawn ? ' pi-hop' : ''}`); drawn = key;
  };
  const placeKind = (): void => {
    const box = need('.pj-kind', m.node), on = box.querySelector<HTMLElement>('input:checked + span'), ind = box.querySelector<HTMLElement>('.pj-kind-ind');
    // Le bouton est dans son <label> : sa position se lit par rapport au groupe, pas à son parent.
    if (on && ind) { const a = box.getBoundingClientRect(), b = on.getBoundingClientRect(); ind.style.width = `${b.width}px`; ind.style.translate = `${b.left - a.left}px 0`; }
    m.node.querySelector('.modal')?.classList.toggle('pj-is-social', kindNow() === 'social');
  };
  form.addEventListener('change', e => { if ((e.target as HTMLInputElement).name === 'kind') { placeKind(); paintIcon(true); } });
  nameIn.addEventListener('input', () => paintIcon());
  icBtn.addEventListener('click', () => {
    const name = nameIn.value.trim();
    projIcons.picker(icBtn, look ?? { icon: projIcons.guessIcon(name, kindNow()), hue: hue(model.slugify(name || 'projet')) }, next => { look = next; paintIcon(true); });
  });
  requestAnimationFrame(placeKind); paintIcon();
  const rows = need('.pj-newrepos', m.node);
  let n = 0;
  const addRow = (): void => {
    const k = n++, first = !rows.children.length;
    rows.insertAdjacentHTML('beforeend', `<div class="pj-newrepo" data-k="${k}"><input class="field" name="repo${k}" placeholder="${first ? 'propriétaire/app' : 'propriétaire/site, propriétaire/api…'}" list="pj-repos" autocomplete="off">${rolePicker(`role${k}`, first ? 'app' : 'autre')}</div>`);
    const row = rows.lastElementChild as HTMLElement;
    autoRole(need<HTMLInputElement>('input.field', row), row, `role${k}`, () => rows.firstElementChild === row);
    if (!first) need<HTMLInputElement>('input.field', row).focus();
  };
  addRow();
  need('[data-row]', m.node).onclick = addRow;
  if (linear.connected()) linear.projects().then(ps => { const d = $('#pj-linear', m.node); if (d) d.innerHTML = ps.map(x => `<option value="${esc(x.name)}">`).join(''); }).catch(() => {});
  need('form', m.node).onsubmit = async e => {
    e.preventDefault();
    const f = target(e) as HTMLFormElement, val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.value.trim() ?? '';
    const name = val('name'), data = new FormData(f);
    const repos: Repo[] = [...rows.querySelectorAll<HTMLElement>('.pj-newrepo')].map(r => ({ name: cleanRepo(val(`repo${r.dataset.k ?? ''}`)), role: (data.get(`role${r.dataset.k ?? ''}`) as Role | null) ?? 'autre' })).filter(r => r.name);
    const bad = repos.find(r => !/^[\w.-]+\/[\w.-]+$/.test(r.name));
    if (bad) { need('.lock-err', m.node).textContent = `« ${bad.name} » : un dépôt s’écrit « propriétaire/nom ».`; return; }
    if (model.projects().some(p => p.slug === model.slugify(name))) { need('.lock-err', m.node).textContent = 'Un projet porte déjà ce nom.'; return; }
    try {
      const kind = kindNow(), handle = val('tiktok');
      if (kind === 'social' && handle && !model.tiktokHandle(handle)) { need('.lock-err', m.node).textContent = 'Un compte TikTok s’écrit « @nom » (lettres, chiffres, point, tiret bas).'; return; }
      const p = await model.createProject({ name, repos: kind === 'social' ? [] : repos, linear: kind === 'social' ? null : val('linear') || null, description: val('desc'),
        kind, tiktok: kind === 'social' ? handle || null : null, icon: look?.icon ?? null, tint: look?.hue ?? null });
      m.close();
      if (p.kind !== 'social' && native.available() && document.documentElement.dataset.native === 'mac') { const r = await native.call('project', 'home', { project: p.id, repos: p.stack }, 600000); if (r.ok) folders.delete(p.id); }
      await go(p.id);
      toast(`Projet « ${p.name} » créé`);
    } catch (x) { need('.lock-err', m.node).textContent = errMsg(x); }
  };
}

const label = (text: string) => { const s = $('[data-act=project] span'); if (s) s.textContent = text; };
/** Choisir le projet d'une note (menu depuis l'éditeur). */
export function projectMenuItems(n: Note): { label: string; icon?: string; run?: () => unknown; checked?: boolean }[] {
  const cur = model.projectOfNote(n), all = model.projects().filter(p => p.id !== n.id);
  return [{ label: 'Projet de la note' }, ...all.map(p => ({ label: p.name, checked: cur?.id === p.id, run: () => model.setNoteProject(n, p).then(() => { label(p.name); toast(`Rangée dans « ${p.name} »`); }) })),
    { label: 'Aucun projet', checked: !cur, run: () => model.setNoteProject(n, null).then(() => label('Projet')) }, { label: 'Nouveau projet…', icon: 'plus', run: () => createDialog() }];
}

// ---------- Vers Claude Code ----------
/** Claude Code est joignable d'ici (sur ce Mac, ou un Mac lié qui l'autorise). */
export const claudeAvailable = (): boolean => !!bridge.where();
/** Ouvre l'onglet Claude Code du projet avec des notes jointes ou une consigne déjà écrite. */
export function toClaude(p: Project, what: { notes?: string[]; prompt?: string; fan?: string }): Promise<void> {
  sessions.handoff(p, { notes: what.notes ?? [], prompt: what.prompt ?? '', fan: what.fan ?? '' });
  return go(p.id, 'sessions');
}

/** Conversations Claude Code récentes d'un projet, pour la barre latérale. */
export const sideSessions = (pid: string) => sessions.sideSessions(pid);
export const preloadSessions = (p: Project): void => sessions.preload(p);
/** Choisit la conversation à ouvrir dans l'onglet Claude Code du projet (`null` : la liste). */
export const sideServers = (pid: string) => infra.sideServers(pid);
/** Choisit le serveur que l'onglet Serveur du projet affichera (clic dans la barre latérale). */
export const openServer = (pid: string, id: string): void => { const p = model.byId(pid); if (p) infra.use(p, id); };
export const openSession =(pid: string, id: string | null, agent: string | null = null): void => sessions.select(id, pid, agent);
/** Ouvre une conversation d'agent dans l'onglet Claude Code de son projet (depuis l'Espace agents). */
/** Menu d'une conversation ou d'un sous-agent de la barre latérale. */
export const sideMenu = sessions.sideMenu;
export const openAgent = (pid: string, id: string): void => { sessions.select(id, pid); void go(pid, 'sessions'); };

// ---------- Page ----------
/** Fil d'Ariane : Projets › projet › onglet › conversation Claude Code › sous-agent, chaque niveau ramenant à sa page. */
function trailHTML(): string {
  const p = model.byId(app.viewState().project), tab = curTab(p);
  const up: [string, string] = ['Projets', 'data-pj-open=""'];
  if (!p) return app.crumb('Projets');
  if (tab === defaultTab(p)) return app.crumb(p.name, [up]);
  const home: [string, string] = [p.name, `data-pj-tab="${defaultTab(p)}"`], label = TABS.find(x => x[0] === tab)?.[1] ?? '';
  const talk = tab === 'sessions' ? sessions.current(p.id) : null;
  if (!talk) return app.crumb(label, [up, home]);
  const tabUp: [string, string] = [label, 'data-pj-tab="sessions"'];
  return talk.sub ? app.crumb(talk.sub.title, [up, home, tabUp, [talk.title, 'data-pj-talk']]) : app.crumb(talk.title, [up, home, tabUp]);
}

/** Menu du projet dans le fil d'Ariane du Salon : les projets avec leur état, puis tous les projets et la planification. */
function projectMenu(p: Project, anchor: Element): void {
  const state = (x: Project): string => {
    const t = sessions.sideSessions(x.id), live = t.filter(s => s.live).length, review = t.filter(s => !s.live && s.stage?.cls === 'st-review').length;
    return live ? `${live} au travail` : review ? 'prêt à publier' : '';
  };
  menu(anchor, [{ label: 'Projets' },
    ...model.projects().map(x => ({ label: x.name, hint: state(x), checked: x.id === p.id, run: () => go(x.id, defaultTab(x)) })),
    '-', { label: 'Tous les projets', icon: 'list', run: () => go(null) }, { label: 'Nouveau projet…', icon: 'plus', run: () => createDialog() },
    { label: 'Planification', icon: 'history', run: () => app.setView({ type: 'planner' }) }]);
}

export function mount(main: HTMLElement): void {
  sessions.stop(); salon.stop(); recos.stop();
  const p = model.byId(app.viewState().project), tab = curTab(p);
  if (p) sessions.preload(p);
  // Salon : plein écran, sans en-tête de projet ni onglets (`body.lounge`, css/salon.css) ; sa barre porte le fil d'Ariane.
  const lounge = !!p && tab === 'salon';
  document.body.classList.toggle('lounge', lounge);
  main.innerHTML = lounge ? '<div class="todo pj pj-lounge"><div class="sl-box"></div></div>' : `<header class="toolbar">${app.tbLeft()}${trailHTML()}<div class="tb-side tb-right">${p ? '' : `<button class="btn btn-ghost" data-pj="new">${icon('plus')}<span>Nouveau projet</span></button>`}</div></header>
    <div class="todo pj"><div class="todo-in pj-in">${p ? detailHTML(p, tab) : `<div class="td-head"><h1>Projets</h1><p class="td-sub">Un projet réunit son dossier, ses dépôts, ses PR, ses tickets, ses tâches et ses notes.</p></div><div class="pj-list">${listHTML()}</div>`}</div></div>`;
  const root = need('.pj', main);
  $('.toolbar [data-pj=new]', main)?.addEventListener('click', () => void createDialog());
  // Écouté sur la barre d'outils : le fil d'Ariane est redessiné quand la conversation change de nom.
  $('.toolbar', main)?.addEventListener('click', e => {
    const t = target(e);
    if (!t.closest('.crumb')) return;
    if (t.closest('[data-pj-open]')) void go(null);
    else if (p && t.closest('[data-pj-talk]')) sessions.openSub(null);
    else if (p && t.closest('[data-pj-tab="sessions"]')) sessions.open(null);
    else if (p && t.closest('[data-pj-tab]')) void go(p.id, defaultTab(p));
  });
  if (p) void hydrate(root, p, tab);
  root.addEventListener('submit', async e => {
    if (!p) return;
    const f = target(e);
    if (f.closest('.pj-add')) {
      e.preventDefault();
      const i = need<HTMLInputElement>('input', f), v = i.value; if (!v.trim()) return;
      i.value = ''; await todo.add(v, p.id); refresh();
    }
    if (f.closest('.sv-form')) {
      e.preventDefault();
      if (!await infra.submit(f as HTMLFormElement, p)) return;
      const box = $('.sv-box', root); if (box) box.innerHTML = '<div class="pj-skel"></div>'; void server(root, p); return;
    }
    if (f.closest('.pj-site-form')) {
      e.preventDefault();
      const v = need<HTMLInputElement>('input', f).value.trim();
      if (!/^https:\/\/[^\s]+$/i.test(v)) { toast('L’adresse doit commencer par https://'); return; }
      await model.setField(p, 'site', v); toast('Site associé au projet');
    }
  });
  root.addEventListener('click', async e => {
    const t = target(e), open = t.closest('[data-pj-open]');
    if (open) { await go(open.dataset.pjOpen || null); return; }
    const tb = t.closest('[data-pj-tab]');
    if (tb && p) { await app.setView({ type: 'projets', project: p.id, tab: tb.dataset.pjTab ?? defaultTab(p) }); return; }
    // Case d'une note : la sélection suit, la barre se met à jour sans redessiner la liste.
    const pk = t.closest('[data-pj-pick]') as HTMLInputElement | null;
    if (pk && p) {
      const sel = picksOf(p), id = pk.dataset.pjPick ?? '';
      if (pk.checked) sel.add(id); else sel.delete(id);
      pk.closest('.pj-row')?.classList.toggle('sel', pk.checked);
      const bar = $('[data-pickbar]', root); if (bar) { bar.innerHTML = pickBarHTML(p); bar.classList.toggle('on', sel.size > 0); }
      return;
    }
    const aiNote = t.closest('[data-pj-ai-note]');
    if (aiNote && p) {
      const id = p.id, nid = aiNote.dataset.pjAiNote ?? '';
      menu(aiNote, [{ label: 'Discuter avec Claude', icon: 'sparkle', hint: 'Conversation du projet, avec cette note', run: () => void import('../chat.ts').then(m => m.startIn(id, [nid])) },
        { label: 'Confier à Claude Code', icon: 'terminal', hint: 'Une consigne, avec cette note jointe', run: () => toClaude(p, { notes: [nid] }) }]);
      return;
    }
    const askNote = t.closest('[data-pj-ask-note]');
    if (askNote && p) { const id = p.id, nid = askNote.dataset.pjAskNote ?? ''; void import('../chat.ts').then(m => m.startIn(id, [nid])); return; }
    const adopt = t.closest<HTMLElement>('[data-pj-adopt]');
    if (adopt && p) {
      const n = store.get(adopt.dataset.pjAdopt ?? '');
      if (n) { await model.setNoteProject(n, p); toast(`« ${titleOf(n)} » rangée dans ${p.name}`); refresh(); }
      return;
    }
    const ccNote = t.closest('[data-pj-cc-note]'), ccTask = t.closest('[data-pj-cc-task]');
    if ((ccNote || ccTask) && p) { await toClaude(p, ccNote ? { notes: [ccNote.dataset.pjCcNote ?? ''] } : { prompt: ccTask?.dataset.pjCcTask ?? '' }); return; }
    if (p && t.closest('.sv-box') && specs.click(t, p)) return;
    if (p && t.closest('.sv-box') && await infra.click(t, p, () => { const box = $('.sv-box', root); if (box) box.innerHTML = '<div class="pj-skel"></div>'; void server(root, p); })) return;
    const pick = t.closest('[data-sv-pick]');
    if (pick && p) {
      const id = pick.dataset.svPick ?? '';
      if (id !== infra.current(p)) { infra.use(p, id); const box = $('.sv-box', root); if (box) box.innerHTML = '<div class="pj-skel"></div>'; void server(root, p); }
      return;
    }
    const sv = t.closest('[data-sv]');
    if (sv && p) {
      const act = sv.dataset.sv, box = $('.sv-box', root);
      if (act === 'refresh') { if (box) box.innerHTML = '<div class="pj-skel"></div>'; void server(root, p); }
      if (act === 'terminal') { const r = await native.call('agent', 'server', { project: p.id, op: 'terminal', server: infra.current(p) }, 10000); if (!r.ok) toast(r.message ?? 'Impossible.'); }
      if (act === 'add' && box) await infra.openForm(box, p, undefined, true);
      if (act === 'edit' && box) await infra.openForm(box, p, JSON.parse(box.dataset.st || '{}') as ServerStatus);
      if (act === 'cancel') void server(root, p);
      return;
    }
    const ag = t.closest('[data-pj-agent]');
    if (ag && p) { sessions.select(ag.dataset.pjAgent || null, p.id); await go(p.id, 'sessions'); return; }
    const issue = t.closest('.lv-row[data-issue]');
    if (issue) { void import('../../integrations/linear/page.ts').then(m => m.openTicket(issue.dataset.issue ?? '')); return; }
    const b = t.closest('[data-pj]'); if (!b) return;
    const act = b.dataset.pj;
    if (act === 'new') { void createDialog(); return; }
    if (!p) return;
    if (act === 'edit') app.openNote(p.id);
    if (act === 'pick-all' || act === 'pick-none') {
      const sel = picksOf(p); if (act === 'pick-all') for (const n of bulkPickable(p)) sel.add(n.id); else sel.clear();
      const box = $('[data-sec="notes"] .pj-sec-body', root); if (box) box.innerHTML = noteRows(p);
      return;
    }
    if (act === 'pick-cc' || act === 'pick-fan' || act === 'pick-claude') {
      // Dans l'ordre de la liste (les plus récentes d'abord) ; la sélection est consommée par l'envoi.
      const sel = picksOf(p), ids = pickable(p).filter(n => sel.has(n.id)).map(n => n.id); if (!ids.length) return;
      sel.clear();
      if (act === 'pick-claude') { const id = p.id; void import('../chat.ts').then(m => m.startIn(id, ids)); return; }
      await toClaude(p, { notes: ids, ...(act === 'pick-fan' ? { fan: 'notes' } : {}) }); return;
    }
    if (act === 'claude') { const id = p.id; void import('../chat.ts').then(m => m.startIn(id)); return; }
    if (act === 'kanban') { todo.showProject(p.id); await app.setView({ type: 'tasks' }); }
    if (act === 'adopt') {
      const ids = await pickFrom(model.adoptable(p), [], { title: `Ranger dans ${p.name}`, ok: 'Ranger', sub: n => model.projectOfNote(n)?.name ?? '',
        hint: `${icon('folder')}Chaque note cochée reçoit <code>#${esc(p.tag)}</code> ; une note déjà rangée ailleurs change de projet.`,
        empty: 'Toutes tes notes lisibles sont déjà dans ce projet.' });
      if (!ids?.length) return;
      let k = 0;
      for (const id of ids) { const n = store.get(id); if (n) { await model.setNoteProject(n, p); k++; } }
      toast(`${k} note${k > 1 ? 's' : ''} rangée${k > 1 ? 's' : ''} dans ${p.name}`); refresh();
      return;
    }
    if (act === 'ctx-import') { importContexts(p); return; }
    if (act === 'ctx-pick') { await pickContexts(p); return; }
    if (act === 'ctx') {
      menu(b, [{ label: 'Choisir les contextes IA…', icon: 'check', hint: `Notes du projet que l’IA lit d’office (#${model.CONTEXT_TAG})`, run: () => pickContexts(p) },
        { label: 'Importer des fichiers…', icon: 'download', hint: 'CLAUDE.md, AGENTS.md, notes d’architecture : une note par fichier', run: () => importContexts(p) }]);
      return;
    }
    if (act === 'new-note') { const n = await store.createNote({ title: '', body: `\n\n#${p.tag}` }); app.openNote(n.id); }
    if (act === 'tabs-more') { moreTabs(p, tab, b); return; }
    if (act === 'proj-menu') { projectMenu(p, b); return; }
    if (act === 'icon') {
      projIcons.picker(b, { icon: p.icon, hue: p.hue }, next => {
        // L'en-tête change tout de suite ; la note du projet (et donc la barre latérale) suit à l'enregistrement.
        const t = b.querySelector('.pi'); if (t) t.outerHTML = projIcons.tile({ ...next }, 'pi-lg pi-hop');
        void (async () => {
          try { if (next.icon !== p.icon) await model.setField(p, 'icône', next.icon); if (next.hue !== p.hue) await model.setField(p, 'couleur', next.hue); app.renderSidebar(); }
          catch (x) { toast(errMsg(x)); }
        })();
      });
      return;
    }
    if (act === 'folder-menu') { folderMenu(root, p, tab, b); return; }
    if (act === 'pick' || act === 'home' || act === 'vscode' || act === 'finder' || act === 'terminal' || act === 'repo-clone' || act === 'repo-pick') { await folderAct(root, p, tab, act, b.dataset.repo ?? '', !!b.dataset.choose, b); return; }
    if (act === 'link-repo' && b.dataset.repo) { const role = model.guessRole(b.dataset.repo, !p.stack.length); await model.setRepos(p, [...p.stack, { name: b.dataset.repo, role }]); toast(`${b.dataset.repo} associé au projet · ${model.ROLES[role].label}`); }
    if (act === 'repo-add') addRepoDialog(p);
    if (act === 'repo-menu' && b.dataset.repo) repoMenu(p, b, b.dataset.repo);
    if (act === 'review-working') await review.review(p, 'working');
    if (act === 'review-branch') await review.review(p, 'branch');
    if (act === 'site-check') await checkSite(root, p);
    if (act === 'site-edit') { const box = $('[data-sec="site"] .pj-sec-body', root); if (box) box.innerHTML = `<form class="td-add pj-site-form"><span class="td-plus">${icon('link')}</span><input type="url" value="${esc(p.site ?? '')}" aria-label="Adresse du site" required></form>`; }
  });
}

/** Actions sur le dossier du projet et de ses dépôts, lancées par un bouton ou par le menu « … » de la ligne dossier. */
async function folderAct(root: HTMLElement, p: Project, tab: string, act: string, repo: string, choose: boolean, from: Element): Promise<void> {
  if (act === 'pick' || act === 'home') {
    const r = await native.call('project', act, { project: p.id, repos: p.stack }, 600000);
    if (r.ok) {
      folders.delete(p.id);
      if (act === 'home') toast(r.repo ? 'Ce dossier est un dépôt Git : il devient le dépôt principal, son parent sert de dossier mère' : typeof r.path === 'string' ? 'Dossier mère choisi · dépôt principal retrouvé dedans' : 'Dossier mère choisi · les dépôts manquants y seront clonés');
      void hydrate(root, p, tab); void localRepos(root, p);
    } else if (r.message) toast(r.message);
    return;
  }
  if (act === 'vscode' || act === 'finder' || act === 'terminal') { const r = await native.call('project', 'open', { project: p.id, app: act }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); return; }
  if ((act === 'repo-clone' || act === 'repo-pick') && repo) {
    const box = from.closest<HTMLElement>('[data-rp-local], .pj-folder') ?? $('.pj-folder', root);
    if (act === 'repo-clone' && box && !choose) box.innerHTML = `<span class="spin"></span>Clonage de ${esc(repo)} dans le dossier mère…`;
    const r = await native.call('project', act, { project: p.id, repo, repos: p.stack, ...(choose ? { choose: true } : {}) }, act === 'repo-clone' ? 1220000 : 600000);
    if (r.ok) toast(act === 'repo-clone' ? `${repo} cloné${typeof r.path === 'string' ? ` dans ${r.path}` : ''} : les agents y travaillent aussi` : `${repo} retrouvé sur ce Mac`);
    else if (!r.cancelled) toast(r.message ?? 'Impossible.');
    folders.delete(p.id);
    const f = await folderOf(p);
    fill(root, '.pj-folder-box', folderHTML(p, f));
    void localRepos(root, p);
  }
}

export function refresh(): void {
  const root = $('#main .pj'); if (!root) return;
  const p = model.byId(app.viewState().project);
  if (!p) { const l = $('.pj-list', root); if (l) l.innerHTML = listHTML(); return; }
  const tasks = $('.pj-tasklist', root), notes = $('[data-sec="notes"] .pj-sec-body', root);
  if (tasks) tasks.innerHTML = taskRows(p);
  if (notes) notes.innerHTML = noteRows(p);
  // Le bloc ```projet a changé (site, dépôts) : on redessine l'en-tête et l'onglet.
  const head = $('.pj-links', root), want = `${model.formatRepos(p.stack)}|${p.site ?? ''}|${p.linear ?? ''}`;
  if (head && head.dataset.k !== want) mount(need('#main'));
}
