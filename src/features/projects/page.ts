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
import { $, icon, menu, modal, need, rel, target, toast, errMsg, confirmBox } from '../../ui/kit.ts';
import { pickFrom } from './notepick.ts';
import type { AppShell, Note } from '../../types.ts';
import type { Project, Repo, Role } from './model.ts';
import * as flux from './flux.ts';
import * as sessions from './sessions.ts';
import * as review from './review.ts';
import * as site from './site.ts';
import * as docker from './docker.ts';
import * as commerce from '../commerce/page.ts';
import * as infra from './infra.ts';
import * as specs from './specs.ts';
import * as chart from '../../ui/chart.ts';
import * as bridge from '../../integrations/remote.ts';
import { shareable } from '../../integrations/ai.ts';

let app!: AppShell;
export const init = (shell: AppShell): void => {
  app = shell;
  // Une conversation Claude Code a été ouverte, renommée ou supprimée : la barre latérale et le fil d'Ariane suivent.
  sessions.onChange(() => {
    app.renderSidebar();
    const c = $('#main .toolbar .crumb');
    if (c && app.view() === 'projets') c.outerHTML = trailHTML();
  });
  // Serveurs du projet lus, ajoutés, retirés, ou autre serveur affiché : la barre latérale suit.
  infra.onChange(() => app.renderSidebar());
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
const homeLine = (f: Folder) => f.home ? `<div class="pj-folder pj-home">${icon('folder')}<span class="muted">Dossier mère</span><code title="Ses dépôts y sont rangés, ceux qui manquent y sont clonés">${esc(f.home)}</code>${f.homeSet ? '' : '<span class="muted">(parent du dépôt principal)</span>'}<button class="link-btn" data-pj="home">${f.homeSet ? 'Changer' : 'Choisir le dossier mère'}</button></div>` : '';
function folderHTML(p: Project, f: Folder | null): string {
  if (!bridge.local()) { const at = bridge.where(); return `<p class="pj-folder muted">${icon(at ? 'devices' : 'folder')}${at ? `Dossier et VS Code sur <strong>${esc(at.kind === 'remote' ? at.name : 'le Mac')}</strong> · Claude Code se pilote d’ici` : 'Le dossier du projet et VS Code s’ouvrent depuis l’app Studio pour Mac.'}</p>`; }
  if (!f) return `<p class="pj-folder muted">${icon('folder')}Lecture du dossier…</p>`;
  const main = p.stack[0]?.name;
  if (!f.path && f.home) return `${homeLine(f)}<div class="pj-folder">${icon('download')}<span>${main ? `Le dépôt principal <b>${esc(main)}</b> n’est pas encore dans ce dossier.` : 'Associe un dépôt GitHub au projet pour le cloner ici.'}</span>${main ? `<span class="pj-open"><button class="btn btn-primary" data-pj="repo-clone" data-repo="${esc(main)}">${icon('download')}Le cloner ici</button><button class="btn" data-pj="repo-clone" data-repo="${esc(main)}" data-choose="1">Cloner ailleurs…</button><button class="btn" data-pj="pick">J’ai déjà un clone</button></span>` : ''}</div>`;
  if (!f.path) return `<div class="pj-folder">${icon('folder')}<span>Choisis le <b>dossier mère</b> du projet : ses dépôts y sont rangés, ceux qui manquent y seront clonés.</span><span class="pj-open"><button class="btn btn-primary" data-pj="home">Choisir le dossier mère</button><button class="btn" data-pj="pick">Choisir directement le dépôt</button></span></div>`;
  const git = f.git ? `<span class="pj-git">${icon('pr')}${esc(f.branch ?? '?')}${f.changes ? ` · <b>${f.changes} modif.</b>` : ' · à jour'}${f.ahead ? ` · ↑${f.ahead}` : ''}${f.behind ? ` · ↓${f.behind}` : ''}</span>` : '<span class="pj-git muted">pas un dépôt Git</span>';
  const own = model.repoNamed(p, f.remote);
  const hint = own ? model.roleTag(own.role, 'sm') : f.remote ? `<button class="link-btn" data-pj="link-repo" data-repo="${esc(f.remote)}">Associer ${esc(f.remote)}</button>` : '';
  return `${homeLine(f)}<div class="pj-folder">${icon('folder')}<code title="${esc(f.path)}">${esc(f.path.replace(/^\/Users\/[^/]+/, '~'))}</code>${git}${hint}
    <span class="pj-open"><button class="btn" data-pj="vscode">${icon('code')}VS Code</button><button class="btn" data-pj="finder">${icon('folder')}Finder</button><button class="btn" data-pj="terminal">${icon('terminal')}Terminal</button><button class="icon-btn" data-pj="pick" title="Changer le dossier du dépôt principal" aria-label="Changer le dossier du dépôt principal">${icon('more')}</button></span></div>`;
}

// ---------- Liste ----------
function listHTML(): string {
  const all = model.projects();
  if (!all.length) return `<div class="pj-empty"><h2>Un projet réunit tout ce qui le concerne</h2>
    <p>Son dossier sur ton Mac, ses dépôts GitHub (l’app, son site, son API…) et leurs PR, ses tickets Linear, ses tâches et ses notes. Tu y ouvres VS Code en un clic, et tu peux bientôt y confier une tâche à Claude Code.</p>
    <button class="btn btn-primary" data-pj="new">${icon('plus')}Créer un projet</button></div>`;
  return `<div class="pj-grid">${all.map(p => {
    const t = todo.ofProject(p.id), notes = model.notesOf(p).length - 1;
    return `<button class="pj-card" data-pj-open="${esc(p.id)}" style="--c:var(--c-${p.hue})"><span class="pj-dot"></span><strong>${esc(p.name)}</strong>
      <span class="pj-sub">${p.stack.length ? `${icon('github')}${esc(p.stack[0]?.name ?? '')}` : 'Pas de dépôt'}${p.linear ? ` · ${icon('linear')}${esc(p.linear)}` : ''}</span>
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
// note) ou vers la page Claude, d'un clic. Seules les notes lisibles par l'IA se cochent (ni chiffrées, ni #privé).
const pickedNotes = new Map<string, Set<string>>();
function picksOf(p: Project): Set<string> { let s = pickedNotes.get(p.id); if (!s) { s = new Set(); pickedNotes.set(p.id, s); } return s; }
const pickable = (p: Project): Note[] => model.notesOf(p).filter(n => shareable(n) && store.getBody(n) != null);
/** Barre de sélection : une invitation tant que rien n'est coché, puis les envois possibles. */
function pickBarHTML(p: Project): string {
  const all = pickable(p), sel = picksOf(p), k = all.filter(n => sel.has(n.id)).length, cc = !!bridge.where();
  if (!all.length) return '';
  if (!k) return `<span class="pj-pickbar-t">${icon('check')}Coche des notes pour les envoyer à Claude${cc ? ' ou à Claude Code' : ''}.</span><span class="pj-pickbar-end"><button class="link-btn" data-pj="pick-all">Tout cocher (${all.length})</button></span>`;
  return `<span class="pj-pickbar-t"><b>${k}</b> note${k > 1 ? 's' : ''} cochée${k > 1 ? 's' : ''}</span>
    ${cc ? `<button class="btn btn-primary" data-pj="pick-cc" title="Une consigne Claude Code, avec ces notes jointes">${icon('terminal')}Claude Code</button>${k > 1 ? `<button class="btn" data-pj="pick-fan" title="Prépare un agent Claude Code par note : ils travaillent en parallèle, chacun dans sa copie">${icon('bolt')}Un agent par note</button>` : ''}` : ''}
    <button class="btn" data-pj="pick-claude" title="Conversation du projet : Claude lit ces notes">${icon('sparkle')}Claude</button>
    <span class="pj-pickbar-end">${k < all.length ? '<button class="link-btn" data-pj="pick-all">Tout cocher</button>' : ''}<button class="link-btn" data-pj="pick-none">Tout décocher</button></span>`;
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
function noteRows(p: Project): string {
  // La note du projet d'abord, puis celles qui y sont rangées (tag #projet/… ou sous-note d'une note du projet).
  const notes = model.notesOf(p), linked = model.linkedTo(p);
  const cc = bridge.where(), sel = picksOf(p), ok = new Set(pickable(p).map(n => n.id));
  // Une note supprimée, sortie du projet ou devenue privée quitte la sélection.
  for (const id of [...sel]) if (!ok.has(id)) sel.delete(id);
  const pick = (n: Note) => ok.has(n.id) ? `<label class="pj-pick" title="Cocher pour l’envoyer à l’IA"><input type="checkbox" data-pj-pick="${n.id}"${sel.has(n.id) ? ' checked' : ''} aria-label="Cocher la note ${esc(titleOf(n))}"></label>` : `<span class="pj-pick" title="Chiffrée ou #privé : jamais envoyée à l’IA">${icon('lock')}</span>`;
  const ask = (n: Note) => ok.has(n.id) ? `<button class="pj-cc" data-pj-ask-note="${n.id}" title="Discuter de cette note avec Claude (conversation du projet)">${icon('sparkle')}Claude</button>` : '';
  const ctxs = model.contextsOf(p).filter(n => ok.has(n.id)).length;
  return `<div class="pj-pickbar${sel.size ? ' on' : ''}" data-pickbar>${pickBarHTML(p)}</div>
    ${ctxs ? `<p class="pj-ctxinfo">${icon('sparkle')}<span><b>${ctxs} contexte${ctxs > 1 ? 's' : ''} IA</b> : lu${ctxs > 1 ? 's' : ''} d’office par l’IA de Studio et par chaque nouvelle consigne Claude Code de ce projet, pour se situer dans l’application.</span></p>` : ''}
    ${notes.length ? notes.map(n => `<div class="pj-row pj-noterow${sel.has(n.id) ? ' sel' : ''}">${pick(n)}<button class="w-row" data-open-note="${n.id}">${icon(n.id === p.id ? 'folder' : 'notes')}<span>${esc(titleOf(n))}${n.id === p.id ? '<i class="pj-main">Note du projet</i>' : ''}${model.isContext(n) ? '<i class="pj-main pj-ctxtag" title="Lue d’office par l’IA dans ce projet">Contexte IA</i>' : ''}</span><em>${esc(rel(n.updated))}</em></button>${ask(n)}${cc && ok.has(n.id) ? `<button class="pj-cc" data-pj-cc-note="${n.id}" title="Confier cette note à Claude Code">${icon('terminal')}Claude Code</button>` : ''}</div>`).join('') : ''}
    ${notes.length < 2 ? '<p class="hm-empty">Pour ranger une note dans ce projet : crée-la d’ici, range une note existante, fais-en une sous-note de la note du projet, ou ajoute-lui <code>#' + esc(p.tag) + '</code>.</p>' : ''}
    <div class="pj-noteadd"><button class="hm-more" data-pj="new-note">${icon('plus')}Nouvelle note du projet</button><button class="hm-more" data-pj="adopt">${icon('folder')}Ranger une note existante…</button><button class="hm-more" data-pj="ctx-import" title="Fichiers Markdown ou texte (CLAUDE.md, AGENTS.md, notes d’architecture…) : chacun devient une note du projet marquée #${model.CONTEXT_TAG}, que l’IA lit d’office">${icon('sparkle')}Importer des contextes IA…</button><button class="hm-more" data-pj="ctx-pick" title="Choisir les notes du projet que l’IA lit d’office (tag #${model.CONTEXT_TAG})">${icon('check')}Contextes IA…</button></div>
    ${linked.length ? `<h3 class="pj-linked-h">Liées à la note du projet <span>citées par elle ou qui la citent, sans être rangées ici</span></h3>
      ${linked.map(n => `<div class="pj-row pj-noterow"><span class="pj-pick">${icon('link')}</span><button class="w-row" data-open-note="${n.id}">${icon('notes')}<span>${esc(titleOf(n))}${model.projectOfNote(n) ? `<i class="pj-main">${esc(model.projectOfNote(n)?.name ?? '')}</i>` : ''}</span><em>${esc(rel(n.updated))}</em></button>${store.getBody(n) != null && !model.byId(n.id) ? `<button class="pj-cc" data-pj-adopt="${n.id}" title="Ajoute #${esc(p.tag)} à cette note">${icon('folder')}Ranger ici</button>` : ''}</div>`).join('')}` : ''}`;
}
const section = (id: string, title: string, ic: string, body: string, cls = '', meta = '') => `<section class="pj-sec ${cls}" data-sec="${esc(id)}"><h2>${icon(ic)}${esc(title)}${meta ? `<span class="pj-sec-meta">${meta}</span>` : ''}</h2><div class="pj-sec-body">${body}</div></section>`;

/** Sous-menus d'un projet (aussi affichés dans la barre latérale). */
export const TABS: [string, string, string][] = [
  ['overview', 'Vue d’ensemble', 'home'], ['sessions', 'Claude Code', 'terminal'], ['code', 'Code', 'code'], ['flux', 'Flux', 'pr'], ['server', 'Serveur', 'server'], ['docker', 'Docker', 'container'],
  ['tasks', 'Tâches', 'check'], ['notes', 'Notes', 'notes'], ['site', 'Site', 'link'], ['boutique', 'Boutique', 'shop'],
];
/** Les onglets montrés pour ce projet : « Boutique » seulement s'il a une boutique ou un compte publicitaire (ou si on y est). */
export const tabsOf = (p: Project, tab = ''): [string, string, string][] => TABS.filter(t => t[0] !== 'boutique' || tab === 'boutique' || (commerce.available() && commerce.concerns(p)));
const curTab = (): string => { const t = app.viewState().tab; return t && TABS.some(x => x[0] === t) ? t : 'overview'; };
const panelsHTML = (p: Project, tab: string) => registry.projectPanels(p, tab).map(x => section(x.id, x.title, x.icon, '<p class="nf-empty">Chargement…</p>', 'pj-panel')).join('');
const card = (tab: string, title: string, ic: string, hue: string, body: string) => `<button class="pj-ov" data-pj-tab="${tab}" style="--c:var(--c-${hue})"><span class="pj-ov-h"><span class="pj-ico">${icon(ic)}</span>${esc(title)}${icon('chevronRight')}</span><span class="pj-ov-b" data-ov="${tab}">${body}</span></button>`;

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
  if (tab === 'sessions') return '<div class="ss-box"></div>';
  if (tab === 'server') return '<div class="sv-box"><div class="pj-skel"></div></div>';
  if (tab === 'docker') return '<div class="dk-box"><p class="nf-empty">Lecture de Docker…</p></div>';
  if (tab === 'boutique') return '<div class="cm-box"></div>';
  if (tab === 'tasks') return `${section('tasks', 'Tâches', 'check', taskBox(p))}${panelsHTML(p, 'tasks')}`;
  if (tab === 'notes') return section('notes', 'Notes', 'notes', noteRows(p));
  if (tab === 'site') return `${section('site-local', 'En local', 'terminal', site.localHTML())}${section('site', 'En ligne', 'link', siteHTML(p))}${section('site-prod', 'En production', 'server', site.soonHTML())}`;
  const notes = model.notesOf(p).length - 1;
  return `${folderBox}
    ${bridge.where() ? `<section class="pj-quick">${sessions.composerHTML(p, { compact: true })}<div data-ov="agents"></div></section>` : ''}
    ${section('repos', p.stack.length > 1 ? `Dépôts · ${p.stack.length}` : 'Dépôts', 'github', reposHTML(p), 'pj-stack')}
    ${section('activity', 'Activité', 'activity', `<div class="pj-dash">
      ${chartCard('code', 'Commits', 'code', 'blue', 'commits', 'wide')}
      ${chartCard('tasks', 'Tâches', 'check', 'green', 'tasks', '', tasksChart(p))}
      ${chartCard('sessions', 'Claude Code', 'terminal', 'violet', 'tokens')}
      ${chartCard('flux', 'Intégration continue', 'pr', 'teal', 'ci')}
    </div>`, 'pj-act', '30 derniers jours')}
    ${section('shortcuts', 'Raccourcis', 'bolt', `<div class="pj-ovs">
      ${card('code', 'Pull requests', 'pr', 'blue', p.repos.length ? 'Lecture des PR…' : 'Aucun dépôt associé')}
      ${card('site', 'Site', 'link', 'teal', p.site ? esc(p.site.replace(/^https:\/\//, '')) : 'Ajouter le site du projet')}
      ${card('notes', 'Notes', 'notes', 'amber', `<b>${notes}</b> note${notes > 1 ? 's' : ''}`)}
      ${card('docker', 'Docker', 'container', 'blue', docker.supported() ? 'Lecture des conteneurs…' : 'Visible dans l’app Mac')}</div>`)}${panelsHTML(p, 'overview')}`;
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

// ---------- Tableau de bord ----------
const chartCard = (tab: string, title: string, ic: string, hue: string, key: string, cls = '', body = '<div class="pj-skel"></div>') =>
  `<section class="pj-chart ${cls}" style="--c:var(--c-${hue})"><header><span class="pj-ico">${icon(ic)}</span><h3>${esc(title)}</h3><button class="pj-more" data-pj-tab="${tab}">Ouvrir${icon('chevronRight')}</button></header><div class="pj-chart-b" data-ch="${key}">${body}</div></section>`;
/** Chiffre clé d'une carte : le nombre, ce qu'il compte, une tendance, puis une précision à droite. */
const kpi = (n: string, label: string, extra = '', trend = '') => `<p class="pj-kpi"><strong>${n}</strong><span>${label}</span>${trend}${extra}</p>`;
const muted = (t: string) => `<p class="pj-chart-empty">${t}</p>`;
function tasksChart(p: Project): string {
  const c = todo.ofProject(p.id), done = c.doneAll.length, total = done + c.openCount;
  if (!total) return muted('Aucune tâche dans ce projet pour l’instant.');
  const late = c.late.length, doing = c.doing.filter(t => !c.late.includes(t)).length, rest = Math.max(0, c.openCount - late - doing);
  return `${kpi(`${Math.round(done / total * 100)} %`, 'terminées', `<em>${done} sur ${total}</em>`)}
    ${chart.segments([{ label: 'Terminées', value: done, color: 'green' }, { label: 'En cours', value: doing, color: 'amber' }, { label: 'À faire', value: rest, color: 'gray' }, { label: 'En retard', value: late, color: 'red' }])}`;
}
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
async function dashboard(root: HTMLElement, p: Project, f: Folder | null): Promise<void> {
  const short = (name: string) => name.split('/')[1] ?? name;
  // Commits par jour, empilés par dépôt (couleur de son rôle) : le dossier du Mac (toutes branches), les autres depuis GitHub.
  void (async () => {
    const series: chart.Series[] = [];
    let here: Repo | null = null, local = false;
    if (f?.path || (!bridge.local() && bridge.where())) {
      const r = await bridge.call('agent', 'commits', { project: p.id, days: 30 }, 20000);
      if (r.ok && r.found !== false) {
        local = true;
        // Depuis un appareil lié, le remote du dossier n'est pas connu : le dossier du Mac est supposé être le dépôt principal.
        here = model.repoNamed(p, f?.remote) ?? (f ? null : p.stack[0] ?? null);
        series.push({ label: here ? short(here.name) : 'Dossier du Mac', color: here ? model.ROLES[here.role].hue : 'blue', points: chart.lastDays(30, r.days as Record<string, number>) });
      }
    }
    if (github.connected()) {
      const others = p.stack.filter(r => r.name !== here?.name);
      const got = await Promise.allSettled(others.map(r => github.commitsPerDay(r.name, 30)));
      others.forEach((r, i) => { const g = got[i]; if (g?.status === 'fulfilled') series.push({ label: short(r.name), color: model.ROLES[r.role].hue, points: chart.lastDays(30, g.value) }); });
    }
    if (!series.length) return fill(root, '[data-ch="commits"]', muted(p.repos.length ? 'Connecte GitHub ou choisis le dossier du projet pour voir son activité.' : 'Associe un dépôt ou choisis le dossier du projet.'));
    const all = (series[0]?.points ?? []).map((pt, i) => ({ ...pt, value: series.reduce((a, s) => a + (s.points[i]?.value ?? 0), 0) }));
    const n = all.reduce((a, x) => a + x.value, 0), [cur, prev] = chart.lastVsPrev(all);
    const src = series.length > 1 ? `${series.length} dépôts` : local ? 'toutes branches' : 'branche principale';
    const legend = series.length > 1 ? `<ul class="ch-legend">${series.map(s => `<li style="--c:var(--c-${s.color})"><i></i>${esc(s.label)}<b>${chart.fmt(s.points.reduce((a, x) => a + x.value, 0))}</b></li>`).join('')}</ul>` : '';
    fill(root, '[data-ch="commits"]', kpi(chart.fmt(n), `commit${n > 1 ? 's' : ''}`, `<em>${src}</em>`, chart.trend(cur, prev))
      + chart.stacked(series, { unit: 'commit', summary: `${n} commits sur 30 jours` }) + legend);
  })();
  // Claude Code : tokens écrits par jour.
  void (async () => {
    if (!bridge.where()) return fill(root, '[data-ch="tokens"]', muted('La consommation de Claude Code se lit depuis l’app Mac, ou depuis un appareil lié au Mac.'));
    if (bridge.local() && !f?.path) return fill(root, '[data-ch="tokens"]', muted('Choisis le dossier du projet pour suivre Claude Code.'));
    const r = await bridge.call('agent', 'daily', { project: p.id, days: 30 }, 30000);
    const tok = (r.tokens as Record<string, number>) ?? {}, n = sum(tok), ses = sum((r.sessions as Record<string, number>) ?? {});
    if (!n) return fill(root, '[data-ch="tokens"]', muted('Aucune session Claude Code ces 30 derniers jours.'));
    const pts = chart.lastDays(30, tok), [cur, prev] = chart.lastVsPrev(pts);
    fill(root, '[data-ch="tokens"]', kpi(chart.fmt(n), 'tokens écrits', `<em>${ses} session${ses > 1 ? 's' : ''}</em>`, chart.trend(cur, prev))
      + chart.stacked([{ label: 'Claude Code', color: 'violet', points: pts }], { unit: 'token', summary: `${n} tokens écrits par Claude Code sur 30 jours` }));
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
    const main = rows[0], rel0 = main?.fl.releases[0];
    fill(root, '[data-ch="ci"]', kpi(done.length ? `${Math.round(ok / done.length * 100)} %` : '—', 'réussies', `<em>${runs.length} exécutions</em>`)
      + `<div class="pj-ci-rows">${rows.map(({ r, fl }) => {
        const pc = rate(fl.history), st = fl.history[fl.history.length - 1]?.state;
        return `<div class="pj-ci-row">${model.roleTag(r.role, 'sm')}<code title="${esc(r.name)}">${esc(short(r.name))}</code>${fl.history.length ? chart.strip(fl.history) : '<span class="pj-ci-none">pas de CI</span>'}<b class="${st === 'failure' ? 'err' : st === 'pending' ? 'warn' : 'ok'}">${pc === null ? '—' : `${pc} %`}</b></div>`;
      }).join('')}</div>`
      + (main && rel0 ? `<p class="pj-chart-foot">Dernière version de ${esc(short(main.r.name))} : <b>${esc(rel0.tag)}</b></p>` : ''));
  })();
  chart.bindTips(root);
}
async function agentsStrip(root: HTMLElement, p: Project): Promise<void> {
  const box = $('[data-ov="agents"]', root); if (!box || !bridge.where()) return;
  const r = await bridge.call('agent', 'list', { project: p.id }, 10000), list = ((r.runs as sessions.AgentRun[] | undefined) ?? []).filter(x => x.status === 'running' || x.status === 'starting');
  box.innerHTML = list.map(x => `<button class="pj-agent" data-pj-agent="${esc(x.session)}"><i class="ss-live on"></i><span>${esc(x.prompt)}</span><em>${esc(x.lastText || 'Démarrage…')}</em>${icon('chevronRight')}</button>`).join('');
}

function detailHTML(p: Project, tab: string): string {
  return `<div class="pj-head" style="--c:var(--c-${p.hue})"><button class="lv-back" data-pj-open="">${icon('back')}Projets</button>
      <div class="pj-title"><span class="pj-dot"></span><h1>${esc(p.name)}</h1><button class="btn pj-note" data-pj="edit">${icon('notes')}Note du projet</button><button class="btn pj-note" data-pj="claude" title="Conversation bornée à ce projet : Claude ne voit que ses données">${icon('sparkle')}Claude</button></div>
      <div class="pj-links" data-k="${esc(`${model.formatRepos(p.stack)}|${p.site ?? ''}|${p.linear ?? ''}`)}">${p.stack.map(r => `<a class="lv-chip pj-chip-repo" href="https://github.com/${esc(r.name)}" target="_blank" rel="noopener" title="${esc(`${model.ROLES[r.role].label} · ${r.name}`)}">${model.roleTag(r.role, 'sm')}${esc(r.name.split('/')[1] ?? r.name)}</a>`).join('')}${p.linear ? `<span class="lv-chip">${icon('linear')}${esc(p.linear)}</span>` : ''}${p.site ? `<a class="lv-chip" href="${esc(p.site)}" target="_blank" rel="noopener">${icon('link')}${esc(p.site.replace(/^https:\/\//, ''))}</a>` : ''}<span class="lv-chip">#${esc(p.tag)}</span></div>
      <nav class="lv-tabs pj-tabs">${tabsOf(p, tab).map(([k, l]) => `<button data-pj-tab="${k}" class="${k === tab ? 'sel' : ''}">${esc(l)}</button>`).join('')}</nav></div>
    <div class="pj-body" data-tab="${tab}">${tabBody(p, tab)}</div>`;
}

const fill = (root: HTMLElement, sel: string, html: string) => { const b = $(sel, root); if (b) b.innerHTML = html; };
async function hydrate(root: HTMLElement, p: Project, tab: string): Promise<void> {
  for (const x of registry.projectPanels(p, tab)) {
    void Promise.resolve().then(() => x.render(p)).then(html => fill(root, `[data-sec="${CSS.escape(x.id)}"] .pj-sec-body`, html))
      .catch(e => fill(root, `[data-sec="${CSS.escape(x.id)}"] .pj-sec-body`, `<p class="nf-empty">${esc(errMsg(e))}</p>`));
  }
  if (tab === 'flux') { const box = $('.pj-flux', root); if (box) { void flux.mount(box, p); chart.bindTips(root); } }
  const f = await folderOf(p);
  fill(root, '.pj-folder-box', folderHTML(p, f));
  if (tab === 'sessions') { const box = $('.ss-box', root); if (box) sessions.mount(box, p, f?.path ?? null); }
  if (tab === 'code' && native.available()) {
    const r = await native.call('project', 'branches', { project: p.id }, 20000), list = (r.branches as { name: string; date: string; ahead: number; behind: number; upstream: string }[] | undefined) ?? [];
    fill(root, '[data-sec="branches"] .pj-sec-body', list.length ? list.map(b => `<div class="pj-br"><code>${esc(b.name)}</code>${b.name === f?.branch ? '<em class="pj-badge approved">actuelle</em>' : ''}${b.upstream ? '' : '<em class="pj-badge">locale</em>'}<span>${b.ahead ? `↑${b.ahead} ` : ''}${b.behind ? `↓${b.behind}` : ''}</span><time>${esc(rel(Date.parse(b.date)))}</time></div>`).join('') : '<p class="hm-empty">Choisis le dossier du projet pour voir ses branches.</p>');
  }
  if (tab === 'site') site.mount(root, p);
  if (tab === 'site' && p.site && native.available()) void checkSite(root, p);
  if (tab === 'server') void server(root, p);
  if (tab === 'docker') { const box = $('.dk-box', root); if (box) docker.mount(box, p, f?.path ?? null); }
  if (tab === 'boutique') { const box = $('.cm-box', root); if (box) commerce.mount(box, p); }
  if (tab === 'overview') {
    void overview(root, p, f); void dashboard(root, p, f); void agentsStrip(root, p); void docker.fillCard(root, p);
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
    <label class="pj-field"><span>Nom</span><input class="field" name="name" placeholder="Ex. Studio" required autofocus></label>
    <div class="pj-field"><span>Dépôts GitHub <em>facultatif · l’app, son site, son API…</em></span><div class="pj-newrepos"></div><datalist id="pj-repos"></datalist>
      <button type="button" class="link-btn pj-addrow" data-row>${icon('plus')}Un autre dépôt</button></div>
    <label class="pj-field"><span>Projet Linear <em>facultatif</em></span><input class="field" name="linear" placeholder="Nom du projet dans Linear" list="pj-linear" autocomplete="off"><datalist id="pj-linear"></datalist></label>
    <label class="pj-field"><span>En une phrase <em>facultatif</em></span><input class="field" name="desc" placeholder="Ce que ce projet doit accomplir"></label>
    ${native.available() ? '<p class="modal-hint">Tu choisiras ensuite son dossier sur ce Mac.</p>' : ''}
    <p class="lock-err" role="alert"></p>
    <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Créer le projet</button></div></form>` });
  need('[data-x]', m.node).onclick = m.close;
  fillRepoList(m.node);
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
      const p = await model.createProject({ name, repos, linear: val('linear') || null, description: val('desc') });
      m.close();
      if (native.available() && document.documentElement.dataset.native === 'mac') { const r = await native.call('project', 'home', { project: p.id, repos: p.stack }, 600000); if (r.ok) folders.delete(p.id); }
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
/** Choisit la conversation à ouvrir dans l'onglet Claude Code du projet (`null` : la liste). */
export const sideServers = (pid: string) => infra.sideServers(pid);
/** Choisit le serveur que l'onglet Serveur du projet affichera (clic dans la barre latérale). */
export const openServer = (pid: string, id: string): void => { const p = model.byId(pid); if (p) infra.use(p, id); };
export const openSession =(pid: string, id: string | null, agent: string | null = null): void => sessions.select(id, pid, agent);
/** Ouvre une conversation d'agent dans l'onglet Claude Code de son projet (depuis l'Espace agents). */
export const openAgent = (pid: string, id: string): void => { sessions.select(id, pid); void go(pid, 'sessions'); };

// ---------- Page ----------
/** Fil d'Ariane : Projets › projet › onglet › conversation Claude Code › sous-agent, chaque niveau ramenant à sa page. */
function trailHTML(): string {
  const p = model.byId(app.viewState().project), tab = curTab();
  const up: [string, string] = ['Projets', 'data-pj-open=""'];
  if (!p) return app.crumb('Projets');
  if (tab === 'overview') return app.crumb(p.name, [up]);
  const home: [string, string] = [p.name, 'data-pj-tab="overview"'], label = TABS.find(x => x[0] === tab)?.[1] ?? '';
  const talk = tab === 'sessions' ? sessions.current(p.id) : null;
  if (!talk) return app.crumb(label, [up, home]);
  const tabUp: [string, string] = [label, 'data-pj-tab="sessions"'];
  return talk.sub ? app.crumb(talk.sub.title, [up, home, tabUp, [talk.title, 'data-pj-talk']]) : app.crumb(talk.title, [up, home, tabUp]);
}

export function mount(main: HTMLElement): void {
  sessions.stop();
  const p = model.byId(app.viewState().project), tab = curTab();
  if (p) sessions.preload(p);
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${trailHTML()}<div class="tb-side tb-right">${p ? '' : `<button class="btn btn-ghost" data-pj="new">${icon('plus')}<span>Nouveau projet</span></button>`}</div></header>
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
    else if (p && t.closest('[data-pj-tab]')) void go(p.id, 'overview');
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
    if (tb && p) { await app.setView({ type: 'projets', project: p.id, tab: tb.dataset.pjTab ?? 'overview' }); return; }
    // Case d'une note : la sélection suit, la barre se met à jour sans redessiner la liste.
    const pk = t.closest('[data-pj-pick]') as HTMLInputElement | null;
    if (pk && p) {
      const sel = picksOf(p), id = pk.dataset.pjPick ?? '';
      if (pk.checked) sel.add(id); else sel.delete(id);
      pk.closest('.pj-row')?.classList.toggle('sel', pk.checked);
      const bar = $('[data-pickbar]', root); if (bar) { bar.innerHTML = pickBarHTML(p); bar.classList.toggle('on', sel.size > 0); }
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
      const sel = picksOf(p); sel.clear(); if (act === 'pick-all') for (const n of pickable(p)) sel.add(n.id);
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
    if (act === 'ctx-pick') {
      const list = model.notesOf(p).filter(n => !n.todo && shareable(n) && store.getBody(n) != null), had = list.filter(model.isContext).map(n => n.id);
      const ids = await pickFrom(list, had, { title: `Contextes IA de ${p.name}`, ok: 'Enregistrer',
        hint: `${icon('sparkle')}Les notes cochées reçoivent <code>#${model.CONTEXT_TAG}</code> : l’IA de Studio et chaque nouvelle consigne Claude Code de ce projet les lisent d’office pour se situer dans l’application.`,
        empty: 'Aucune note lisible dans ce projet : importe d’abord un contexte.' });
      if (!ids) return;
      const want = new Set(ids);
      try { for (const n of list) await model.setContext(n, want.has(n.id)); } catch (err) { toast(errMsg(err)); }
      toast(`${want.size} contexte${want.size > 1 ? 's' : ''} IA dans ${p.name}`); refresh();
      return;
    }
    if (act === 'new-note') { const n = await store.createNote({ title: '', body: `\n\n#${p.tag}` }); app.openNote(n.id); }
    if (act === 'pick' || act === 'home') {
      const r = await native.call('project', act, { project: p.id, repos: p.stack }, 600000);
      if (r.ok) {
        folders.delete(p.id);
        if (act === 'home') toast(r.repo ? 'Ce dossier est un dépôt Git : il devient le dépôt principal, son parent sert de dossier mère' : typeof r.path === 'string' ? 'Dossier mère choisi · dépôt principal retrouvé dedans' : 'Dossier mère choisi · les dépôts manquants y seront clonés');
        void hydrate(root, p, tab); void localRepos(root, p);
      } else if (r.message) toast(r.message);
    }
    if (act === 'vscode' || act === 'finder' || act === 'terminal') { const r = await native.call('project', 'open', { project: p.id, app: act }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); }
    if (act === 'link-repo' && b.dataset.repo) { const role = model.guessRole(b.dataset.repo, !p.stack.length); await model.setRepos(p, [...p.stack, { name: b.dataset.repo, role }]); toast(`${b.dataset.repo} associé au projet · ${model.ROLES[role].label}`); }
    if (act === 'repo-add') addRepoDialog(p);
    if (act === 'repo-menu' && b.dataset.repo) repoMenu(p, b, b.dataset.repo);
    if ((act === 'repo-clone' || act === 'repo-pick') && b.dataset.repo) {
      const repo = b.dataset.repo, choose = !!b.dataset.choose, box = b.closest<HTMLElement>('[data-rp-local], .pj-folder');
      if (act === 'repo-clone' && box && !choose) box.innerHTML = `<span class="spin"></span>Clonage de ${esc(repo)} dans le dossier mère…`;
      const r = await native.call('project', act, { project: p.id, repo, repos: p.stack, ...(choose ? { choose: true } : {}) }, act === 'repo-clone' ? 1220000 : 600000);
      if (r.ok) toast(act === 'repo-clone' ? `${repo} cloné${typeof r.path === 'string' ? ` dans ${r.path}` : ''} : les agents y travaillent aussi` : `${repo} retrouvé sur ce Mac`);
      else if (!r.cancelled) toast(r.message ?? 'Impossible.');
      folders.delete(p.id);
      const f = await folderOf(p);
      fill(root, '.pj-folder-box', folderHTML(p, f));
      void localRepos(root, p);
    }
    if (act === 'review-working') await review.review(p, 'working');
    if (act === 'review-branch') await review.review(p, 'branch');
    if (act === 'site-check') await checkSite(root, p);
    if (act === 'site-edit') { const box = $('[data-sec="site"] .pj-sec-body', root); if (box) box.innerHTML = `<form class="td-add pj-site-form"><span class="td-plus">${icon('link')}</span><input type="url" value="${esc(p.site ?? '')}" aria-label="Adresse du site" required></form>`; }
  });
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
