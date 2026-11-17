// Projets. Un projet est une note qui contient un bloc ```projet :
//
//   ```projet
//   nom: Studio
//   dépôts: MTthoas/Studio (app), MTthoas/studio-site (site), MTthoas/studio-api (api)
//                                                   (le premier est le principal ; le rôle entre
//                                                    parenthèses est facultatif, deviné du nom sinon)
//   linear: Studio                                  (projet Linear, facultatif)
//   site: https://studio.example.com                (site web du projet, facultatif)
//   ```
//
// Une note ou une tâche appartient au projet si elle porte le tag #projet/<nom> (ou se trouve dans
// une note qui le porte). Le dossier local du projet n'est jamais écrit dans les notes : il reste sur le Mac.
import * as store from '../../core/store.ts';
import { fold } from '../../lib/fuzzy.ts';
import { hue, icon } from '../../ui/kit.ts';
import type { Note } from '../../types.ts';

export interface Project {
  /** Identifiant : celui de la note du projet. */
  id: string;
  note: Note;
  name: string;
  /** Nom court, utilisé dans le tag : #projet/<slug>. */
  slug: string;
  tag: string;
  /** Dépôts GitHub « propriétaire/nom » ; le premier est le principal. */
  repos: string[];
  /** Les mêmes dépôts, avec leur rôle dans le projet (même ordre que `repos`). */
  stack: Repo[];
  /** Nom du projet Linear associé, s'il y en a un. */
  linear: string | null;
  /** Site web du projet (https uniquement). */
  site: string | null;
  /** Boutique Shopify du projet : son domaine « nom.myshopify.com ». */
  shopify: string | null;
  /** Compte publicitaire Meta du projet : « act_<numéro> ». */
  meta: string | null;
  hue: string;
}

/** Rôle d'un dépôt dans le projet : l'app, son site, son API… */
export type Role = 'app' | 'site' | 'api' | 'mobile' | 'docs' | 'infra' | 'lib' | 'autre';
export interface Repo { name: string; role: Role }
export const ROLES: Record<Role, { label: string; icon: string; hue: string; hint: string }> = {
  app: { label: 'App', icon: 'code', hue: 'indigo', hint: 'le produit lui-même' },
  site: { label: 'Site', icon: 'link', hue: 'teal', hint: 'site web, vitrine, front' },
  api: { label: 'API', icon: 'plug', hue: 'orange', hint: 'backend, serveur' },
  mobile: { label: 'Mobile', icon: 'phone', hue: 'pink', hint: 'iOS, Android' },
  docs: { label: 'Docs', icon: 'notes', hue: 'amber', hint: 'documentation' },
  infra: { label: 'Infra', icon: 'server', hue: 'gray', hint: 'déploiement, CI, config' },
  lib: { label: 'Bibliothèque', icon: 'bolt', hue: 'violet', hint: 'SDK, paquet partagé' },
  autre: { label: 'Autre', icon: 'github', hue: 'blue', hint: '' },
};
export const ROLE_ORDER = Object.keys(ROLES) as Role[];
const ALIASES: [RegExp, Role][] = [
  [/^(app|application|produit|core)$/, 'app'], [/^(site|web|www|vitrine|front|frontend|landing)$/, 'site'],
  [/^(api|back|backend|serveur|server)$/, 'api'], [/^(mobile|ios|android)$/, 'mobile'], [/^(docs?|documentation)$/, 'docs'],
  [/^(infra|ops|deploy|devops|ci)$/, 'infra'], [/^(lib|bibliotheque|sdk|paquet|package)$/, 'lib'], [/^(autre|other)$/, 'autre'],
];
/** Lit un rôle écrit à la main (« web », « backend »…), null s'il n'est pas reconnu. */
export function roleOf(word: string): Role | null { const w = fold(word.trim()); return ALIASES.find(([re]) => re.test(w))?.[1] ?? null; }
/** Devine le rôle d'un dépôt à son nom : …-site, …-api, …-ios… ; sinon le principal est l'app, les autres « autre ». */
export function guessRole(repo: string, main: boolean): Role {
  const n = fold(repo.split('/')[1] ?? repo);
  if (/(^|[-_.])(site|web|www|landing|vitrine|front(end)?)([-_.]|$)|\.github\.io$/.test(n)) return 'site';
  if (/(^|[-_.])(api|back(end)?|server|serveur)([-_.]|$)/.test(n)) return 'api';
  if (/(^|[-_.])(ios|android|mobile)([-_.]|$)/.test(n)) return 'mobile';
  if (/(^|[-_.])docs?([-_.]|$)/.test(n)) return 'docs';
  if (/(^|[-_.])(infra|ops|deploy|terraform|k8s|helm)([-_.]|$)/.test(n)) return 'infra';
  if (/(^|[-_.])(sdk|lib|core|shared|ui)([-_.]|$)/.test(n)) return 'lib';
  return main ? 'app' : 'autre';
}
const ENTRY_RE = /(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\s*\(\s*([^)]*?)\s*\))?(?=[\s,;]|$)/g;
/** Lit la valeur du champ dépôts : « a/b (site), c/d ». */
export function parseRepos(v: string): Repo[] {
  const out: Repo[] = [];
  for (const m of v.matchAll(ENTRY_RE)) {
    const name = m[1] ?? ''; if (!REPO_RE.test(name) || out.some(r => r.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ name, role: (m[2] && roleOf(m[2])) || guessRole(name, !out.length) });
  }
  return out;
}
/** Écrit la valeur du champ dépôts, rôle toujours explicite pour qu'il se lise dans la note. */
export const formatRepos = (list: Repo[]): string => list.map(r => `${r.name} (${r.role})`).join(', ');
/** Pastille teintée d'un rôle (« ⌁ API »), partout où un dépôt est nommé. */
export const roleTag = (role: Role, cls = ''): string => { const r = ROLES[role]; return `<span class="pj-role${cls ? ` ${cls}` : ''}" style="--c:var(--c-${r.hue})">${icon(r.icon)}${r.label}</span>`; };
/** Le dépôt d'un projet qui correspond à un nom « propriétaire/nom » (casse ignorée). */
export const repoNamed = (p: Project, name: string | null | undefined): Repo | null => (name ? p.stack.find(r => r.name.toLowerCase() === name.toLowerCase()) ?? null : null);

const BLOCK_RE = /^```projet[ \t]*\n([\s\S]*?)\n```[ \t]*$/m;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const PROJECT_TAG_RE = /(^|\s)#projet\/([\p{L}\d][\p{L}\d_-]*)(?=[\s,.;:!?)]|$)/gu;

export const slugify = (s: string): string => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'projet';

/** Lit le bloc ```projet d'une note (null si la note n'en a pas, ou s'il est vide). */
/** Domaine d'une boutique Shopify, d'après ce qu'on a écrit (« nom », « nom.myshopify.com », une adresse d'admin). */
export function shopDomain(v: string): string | null {
  const t = v.trim().toLowerCase().replace(/^https?:\/\//, '');
  const m = t.match(/^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/) ?? t.match(/^([a-z0-9][a-z0-9-]*)(?:\.myshopify\.com)?(?:\/.*)?$/);
  return m?.[1] ? `${m[1]}.myshopify.com` : null;
}
/** Compte publicitaire Meta : « act_123 » (le préfixe est ajouté s'il manque). */
export function adAccount(v: string): string | null { const m = v.trim().match(/^(?:act_)?(\d{5,20})$/); return m ? `act_${m[1]}` : null; }

export function parse(n: Note): Project | null {
  const body = store.getBody(n); if (!body || !body.includes('```projet')) return null;
  const m = body.match(BLOCK_RE); if (!m) return null;
  let name = n.title.trim(), stack: Repo[] = [], linear: string | null = null, site: string | null = null, shopify: string | null = null, meta: string | null = null;
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = line.match(/^\s*([\p{L}]+)\s*:\s*(.*)$/u); if (!kv) continue;
    const k = fold(kv[1] ?? ''), v = (kv[2] ?? '').trim();
    if (k === 'nom' || k === 'name') name = v || name;
    else if (k === 'depot' || k === 'depots' || k === 'repo' || k === 'repos' || k === 'github') stack = parseRepos(v);
    else if (k === 'linear') linear = v || null;
    else if (k === 'site' || k === 'url' || k === 'web') site = /^https:\/\/[^\s]+$/i.test(v) ? v : null;
    else if (k === 'shopify' || k === 'boutique') shopify = shopDomain(v);
    else if (k === 'meta' || k === 'pub' || k === 'ads') meta = adAccount(v);
  }
  name = name || 'Projet';
  const slug = slugify(name);
  return { id: n.id, note: n, name, slug, tag: `projet/${slug}`, repos: stack.map(r => r.name), stack, linear, site, shopify, meta, hue: hue(slug) };
}

let cache: { idx: object; list: Project[]; ofNote: Map<string, Project | null> } | null = null;
/** Index des projets, recalculé seulement quand l'index des notes change. */
function ensure(): { list: Project[]; ofNote: Map<string, Project | null> } {
  const idx = store.index();
  if (cache?.idx === idx) return cache;
  const list: Project[] = [], seen = new Set<string>();
  for (const n of idx.live) { const p = parse(n); if (p && !seen.has(p.slug)) { seen.add(p.slug); list.push(p); } }
  list.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const bySlug = new Map(list.map(p => [p.slug, p])), ofNote = new Map<string, Project | null>();
  for (const n of idx.live) {
    let p: Project | null = list.find(x => x.id === n.id) ?? null;
    if (!p && !n.todo) for (const t of store.meta(n).tags) { if (t.startsWith('projet/')) { p = bySlug.get(t.slice(7).split('/')[0] ?? '') ?? null; if (p) break; } }
    ofNote.set(n.id, p);
  }
  // Sous-notes : sans tag à elles, elles suivent le projet de leur parente la plus proche qui en a un
  // (une sous-note de la note du projet est donc une note du projet).
  for (const n of idx.live) {
    if (ofNote.get(n.id) || n.todo || !n.parent) continue;
    const up = store.ancestors(n);
    for (let i = up.length - 1; i >= 0; i--) { const p = ofNote.get(up[i]?.id ?? ''); if (p) { ofNote.set(n.id, p); break; } }
  }
  cache = { idx, list, ofNote };
  return cache;
}

/** Tous les projets (une note par projet ; à nom égal, la plus ancienne gagne). */
export const projects = (): Project[] => ensure().list;
export const byId = (id: string | null | undefined): Project | null => (id ? projects().find(p => p.id === id) ?? null : null);
export const bySlug = (slug: string | null | undefined): Project | null => (slug ? projects().find(p => p.slug === slug) ?? null : null);

/** Projet d'une note : la note du projet elle-même, le premier tag #projet/… qui correspond à un projet, ou à
 *  défaut le projet de la note dont elle est une sous-note. */
export const projectOfNote = (n: Note): Project | null => ensure().ofNote.get(n.id) ?? null;

/** Notes du projet (la note du projet en premier). */
export function notesOf(p: Project): Note[] {
  return store.index().live.filter(n => n.id === p.id || projectOfNote(n)?.id === p.id)
    .sort((a, b) => (a.id === p.id ? -1 : b.id === p.id ? 1 : b.updated - a.updated));
}

/** Notes que la note du projet cite (`[[Titre]]`) ou qui la citent, sans être rangées dans le projet : l'onglet
 *  Notes les propose à côté, avec de quoi les y ranger. */
export function linkedTo(p: Project): Note[] {
  const seen = new Set<string>(), out: Note[] = [];
  for (const n of [...store.meta(p.note).links.map(l => store.findByTitle(l)), ...store.backlinks(p.note)]) {
    if (!n || n.deletedAt || n.todo || seen.has(n.id) || n.id === p.id || projectOfNote(n)?.id === p.id) continue;
    seen.add(n.id); out.push(n);
  }
  return out.sort((a, b) => b.updated - a.updated);
}
/** Notes qu'on peut ranger dans le projet : celles qui n'y sont pas, lisibles (le rangement réécrit leur tag), hors notes de projet. */
export function adoptable(p: Project): Note[] {
  return store.index().live.filter(n => !n.todo && !byId(n.id) && projectOfNote(n)?.id !== p.id && store.getBody(n) != null).sort((a, b) => b.updated - a.updated);
}

/** Retire tout tag #projet/… d'un texte (une ligne de tâche, le corps d'une note). */
export const stripProjectTags = (s: string): string => s.replace(PROJECT_TAG_RE, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');

/** Range une note dans un projet (ou la sort de tout projet) en réécrivant son tag. */
export async function setNoteProject(n: Note, p: Project | null): Promise<void> {
  const body = store.getBody(n);
  if (body == null) throw new Error('Déverrouille la note pour changer son projet.');
  if (p && p.id === n.id) return;
  let next = stripProjectTags(body).replace(/\n+$/, '');
  if (p) next += (next.trim() ? '\n\n' : '') + `#${p.tag}`;
  if (next === body) return;
  store.touch(n); store.setBody(n, next + '\n'); n.updated = Date.now();
  if (p && n.inbox) n.inbox = false;
  await store.saveNote(n);
}

/** Écrit (ou remplace) un champ du bloc ```projet de la note du projet. */
export async function setField(p: Project, key: 'dépôts' | 'linear' | 'site' | 'shopify' | 'meta', value: string): Promise<void> {
  const body = store.getBody(p.note); if (body == null) throw new Error('Déverrouille la note du projet.');
  const re = key === 'dépôts' ? /^(\s*)d[ée]p[oô]ts?\s*:.*$/m : new RegExp(`^(\\s*)${key}\\s*:.*$`, 'm');
  if (/[\r\n]/.test(value)) throw new Error('Valeur invalide.');
  const line = `${key}: ${value}`;
  const next = re.test(body) ? body.replace(re, (_, sp: string) => sp + line) : body.replace(/^(```projet[ \t]*\n[\s\S]*?)^```/m, (_, head: string) => `${head}${line}\n\`\`\``);
  if (next === body) return;
  store.touch(p.note); store.setBody(p.note, next); p.note.updated = Date.now(); await store.saveNote(p.note);
}

/** Crée la note d'un projet. */
/** Remplace la liste des dépôts du projet (ordre, rôles). */
export const setRepos = (p: Project, list: Repo[]): Promise<void> => setField(p, 'dépôts', formatRepos(list));

export async function createProject({ name, repos, linear, site, description }: { name: string; repos: Repo[]; linear: string | null; site?: string | null; description?: string }): Promise<Project> {
  const clean = repos.filter((r, i) => REPO_RE.test(r.name) && repos.findIndex(x => x.name.toLowerCase() === r.name.toLowerCase()) === i);
  const block = ['```projet', `nom: ${name.trim()}`, ...(clean.length ? [`dépôts: ${formatRepos(clean)}`] : []), ...(linear ? [`linear: ${linear}`] : []), ...(site && /^https:\/\//.test(site) ? [`site: ${site}`] : []), '```'].join('\n');
  const n = await store.createNote({ title: name.trim(), body: `${description?.trim() || 'Ce que ce projet doit accomplir, ses liens utiles, ses décisions.'}\n\n${block}\n` });
  const p = parse(n);
  if (!p) throw new Error('Projet invalide.');
  return p;
}
