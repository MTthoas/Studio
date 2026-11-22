// Cockpit d'un projet : onglets Architecture, API, Données, Tests et Environnements.
// Le Mac lit les dépôts du projet en lecture seule et lance leurs scripts (voir Stack.swift) ; la page ne lui donne ni
// chemin ni commande, seulement un dépôt, un emplacement de paquet et un nom de script qu'il retrouve lui-même.
// Les fichiers .env n'arrivent ici qu'en noms de variables : jamais une valeur. Rien de tout cela ne passe à distance
// (« project.stack » n'est pas dans REMOTE_ALLOWED, link.ts).
import * as native from '../../core/native.ts';
import * as infra from './infra.ts';
import { esc } from '../../lib/markdown.ts';
import { $, icon, target, toast, confirmBox, paintIfChanged } from '../../ui/kit.ts';
import { ROLES } from './model.ts';
import type { Project } from './model.ts';

type Script = { name: string; command: string; run: string; risky: boolean };
type Pkg = {
  rel: string; name: string; kind: string; tool: string; frameworks: string[]; data: string[]; role: string; node: string; port: number;
  scripts: Record<string, Script[]>; runnable: boolean; uses: string[]; workspace?: boolean;
};
type Route = { method: string; path: string; summary?: string; source: string; params: boolean };
type Field = { name: string; type: string; optional: boolean; list: boolean; key: boolean; unique: boolean; owns: boolean; ref?: string };
type Model = { name: string; fields: Field[] };
type Schema = { kind: string; rel: string; provider: string; models: Model[]; enums: { name: string; values: string[] }[] };
type Migration = { rel: string; tool: string; count: number; items: { name: string; at: number }[]; last: { name?: string; at?: number } };
type Var = { key: string; set: boolean; note?: string };
type EnvFile = { rel: string; stage: string; vars: Var[]; count: number; set: number; tracked: boolean; ignored: boolean; vs?: string; missing?: string[]; extra?: string[] };
type Alert = { level: 'danger' | 'warn'; code: string; text: string; rel: string; fix?: string; repo?: string };
type Service = { name: string; image: string; build: boolean; ports: string[]; kind?: string; db: boolean };
type Coverage = { rel: string; source: string; at: number; lines?: number; statements?: number; functions?: number; branches?: number };
type Repo = {
  name: string; role: string; path: string; main: boolean; truncated: boolean; packages: Pkg[];
  deploy: { rel: string; kind: string; host: string }[]; hosts: string[]; workflows: { rel: string; name: string; triggers: string[]; deploy: boolean }[];
  api: { routes: Route[]; specs: { rel: string; title: string; version: string; servers: string[]; count: number }[]; files: { rel: string; kind: string; count: number }[]; truncated: boolean };
  data: { schemas: Schema[]; migrations: Migration[]; tools: string[]; supabase: boolean; scripts: (Script & { rel: string })[] };
  env: { files: EnvFile[]; alerts: Alert[]; undocumented?: string[]; used?: number };
  tests: { frameworks: { name: string; command: string; rel: string }[]; files: number; byPackage: Record<string, number>; coverage: Coverage[] };
  compose: { rel: string; services: Service[] }[];
};
type Run = { repo: string; rel: string; script: string; command: string; family: string; status: 'running' | 'done' | 'failed' | 'stopped'; code: number; since: number; ended?: number; took: number; log: string; summary?: { passed: number; failed: number; skipped: number } };
type State = { ok: boolean; message?: string; folder?: boolean; at?: number; repos?: Repo[]; runs?: Record<string, Run>; alerts?: Alert[] };

/** Le cockpit n'agit que dans l'app Mac : l'analyse des dépôts et les scripts y vivent. */
const onMac = (): boolean => native.available() && document.documentElement.dataset.native === 'mac';
const KEYS = (r: { repo: string; rel: string; script: string }): string => `${r.repo}|${r.rel}|${r.script}`;
const place = (rel: string): string => (rel ? `${rel}/` : 'racine');
const roleLabel = (r: string): string => (r in ROLES ? ROLES[r as keyof typeof ROLES].label : r ? r : '');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n > 1 ? many : one}`;
const took = (s: number): string => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`);
const clock = (t: number): string => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const day = (t: number): string => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

const states = new Map<string, State>();
const empty = (title: string, text: string, ic = 'graph'): string => `<div class="st-empty">${icon(ic)}<div><strong>${title}</strong><p>${text}</p></div></div>`;
const macOnly = (what: string): string => empty('Cette vue se lit depuis l’app Mac', `Ouvre ce projet dans Studio pour Mac : il y lit les dépôts du dossier (${what}) sans rien exécuter.`);
const section = (title: string, body: string, meta = ''): string => `<section class="sk-sec"><h3>${esc(title)}${meta ? `<span>${meta}</span>` : ''}</h3>${body}</section>`;

// ---------- Dernier résultat des tests (gardé d'une session à l'autre pour la Vue d'ensemble) ----------
type Last = { at: number; passed: number; failed: number; skipped: number; ok: boolean };
const LKEY = 'studio.stack.last';
function lastOf(pid: string): Last | null {
  try { const v = (JSON.parse(localStorage.getItem(LKEY) ?? '{}') as Record<string, Last>)[pid]; return v && typeof v.at === 'number' ? v : null; } catch { return null; }
}
function keepLast(pid: string, r: Run): void {
  if (r.family !== 'test' || r.status === 'running' || r.status === 'stopped') return;
  const cur = lastOf(pid), at = r.ended ?? Date.now();
  if (cur && cur.at >= at) return;
  const s = r.summary ?? { passed: 0, failed: r.status === 'failed' ? 1 : 0, skipped: 0 };
  try {
    const all = JSON.parse(localStorage.getItem(LKEY) ?? '{}') as Record<string, Last>;
    all[pid] = { at, passed: s.passed, failed: s.failed, skipped: s.skipped, ok: r.status === 'done' && s.failed === 0 };
    localStorage.setItem(LKEY, JSON.stringify(all));
  } catch { /* stockage plein : la ligne d'état se contentera du résultat courant */ }
}

async function ask(p: Project, extra: Record<string, unknown> = {}, timeout = 30000): Promise<State> {
  const r = (await native.call('project', 'stack', { project: p.id, ...extra }, timeout)) as State;
  if (r.ok && r.repos) { states.set(p.id, r); for (const run of Object.values(r.runs ?? {})) keepLast(p.id, run); }
  return r;
}

// ---------- Lancement d'un script (boutons communs aux onglets) ----------
const runKey = (repo: string, rel: string, script: string): string => `${repo}|${rel}|${script}`;

function runButton(repo: Repo, pkg: Pkg, s: Script, st: State, label = ''): string {
  const run = st.runs?.[runKey(repo.name, pkg.rel, s.name)];
  const running = run?.status === 'running';
  const attrs = `data-repo="${esc(repo.name)}" data-rel="${esc(pkg.rel)}" data-script="${esc(s.name)}"`;
  return running
    ? `<button class="btn" data-sk="stop" ${attrs}>${icon('stop')}Arrêter</button>`
    : `<button class="btn" data-sk="run" ${attrs} data-risky="${s.risky ? '1' : ''}" title="Lance ${esc(s.run)} dans ${esc(place(pkg.rel))}">${icon('play')}${esc(label || 'Lancer')}</button>`;
}

/** Journal d'un lancement : lignes d'échec en évidence, replié par défaut sauf s'il a échoué. */
function logHTML(run: Run): string {
  const bad = /\b(FAIL|FAILED|failed|Error|AssertionError|ERR!)\b|✗|×|✘|✖/;
  const lines = run.log.replace(/\s+$/, '').split('\n');
  const body = lines.map(l => (bad.test(l) ? `<b class="sk-bad">${esc(l)}</b>` : esc(l))).join('\n');
  return `<details class="sk-log"${run.status === 'failed' ? ' open' : ''}><summary>Journal · ${plural(lines.length, 'ligne')}</summary><pre class="st-log" aria-label="Sortie de ${esc(run.command)}">${body || 'En attente de la sortie…'}</pre></details>`;
}

function runState(run: Run | undefined): string {
  if (!run) return '<span class="sk-mute">jamais lancé</span>';
  if (run.status === 'running') return `<span class="sk-run">en cours · ${took(Math.max(0, Math.round((Date.now() - run.since) / 1000)))}</span>`;
  const end = run.ended ? ` · ${clock(run.ended)}` : '';
  if (run.status === 'stopped') return `<span class="sk-mute">arrêté${end}</span>`;
  return run.status === 'done' ? `<span class="ok">réussi</span> · ${took(run.took)}${end}` : `<span class="err">échec (code ${run.code})</span> · ${took(run.took)}${end}`;
}
const sumHTML = (s: Run['summary']): string => (s ? `<span class="ok">${s.passed} réussi${s.passed > 1 ? 's' : ''}</span>${s.failed ? ` · <span class="err">${s.failed} échoué${s.failed > 1 ? 's' : ''}</span>` : ''}${s.skipped ? ` · ${s.skipped} ignoré${s.skipped > 1 ? 's' : ''}` : ''}` : '');

/** Scripts d'une famille pour un dépôt, avec leur état et leur journal. */
function scriptRows(repo: Repo, pkg: Pkg, list: Script[], st: State): string {
  return list.map(s => {
    const run = st.runs?.[runKey(repo.name, pkg.rel, s.name)];
    return `<div class="sk-row"><div><code>${esc(s.name)}</code><em>${esc(s.command)}</em></div><span class="sk-st">${runState(run)}</span>${runButton(repo, pkg, s, st)}${run ? logHTML(run) : ''}</div>`;
  }).join('');
}

// ---------- Architecture ----------
function pkgLabel(repo: Repo, pkg: Pkg): string { return `${repo.name.split('/').pop() ?? repo.name}${pkg.rel ? `/${pkg.rel}` : ''}`; }
const techOf = (pkg: Pkg): string => [...pkg.frameworks, ...pkg.data].join(' · ') || pkg.kind;

function archiHTML(p: Project, st: State): string {
  const repos = st.repos ?? [];
  if (!st.folder) return empty('Choisis d’abord le dossier du projet', 'Studio lit les dépôts de ce dossier. Le dossier se choisit dans l’onglet Code.');
  const pkgs = repos.flatMap(r => r.packages.map(k => ({ r, k })));
  if (!repos.length || (!pkgs.length && !repos.some(r => r.compose.length))) return empty('Rien à cartographier dans ce dossier', 'Aucun package.json, pyproject.toml, go.mod, Cargo.toml… n’a été trouvé (les dossiers node_modules, dist et build sont ignorés).');
  const col = (title: string, items: string[]): string => `<div class="sk-col"><h4>${title}</h4>${items.length ? items.join('') : '<p class="sk-mute">—</p>'}</div>`;
  const node = (label: string, sub: string, go: string, rel = ''): string => `<button class="sk-node" data-pj-tab="${go}"${rel ? ` title="${esc(rel)}"` : ''}><strong>${esc(label)}</strong><span>${esc(sub)}</span></button>`;
  const clients = pkgs.filter(x => ['site', 'mobile', 'app'].includes(x.k.role) && x.k.runnable).map(x => node(pkgLabel(x.r, x.k), `${roleLabel(x.k.role)} · ${techOf(x.k)}`, 'tests'));
  const apis = pkgs.filter(x => x.k.role === 'api').map(x => node(pkgLabel(x.r, x.k), `API · ${techOf(x.k)}`, 'api'));
  const libs = pkgs.filter(x => x.k.role === 'lib').map(x => node(pkgLabel(x.r, x.k), `Bibliothèque · ${techOf(x.k)}`, 'tests'));
  const stores = [
    ...repos.flatMap(r => r.compose.flatMap(c => c.services.filter(s => s.db).map(s => node(s.name, `${s.kind ?? 'Base'}${s.ports.length ? ` · :${s.ports[0] ?? ''}` : ''}`, 'data')))),
    ...repos.flatMap(r => r.data.schemas.map(s => node(`${s.kind[0]?.toUpperCase() ?? ''}${s.kind.slice(1)} · ${plural(s.models.length, 'modèle')}`, s.rel, 'data'))),
  ];
  // Ce qui tourne où : en local (port du script dev), en conteneur (compose), en ligne (hébergeur, site).
  const local = pkgs.filter(x => x.k.port && (x.k.scripts.dev?.length ?? 0) > 0).map(x => `<tr><td><code>localhost:${x.k.port}</code></td><td>${esc(pkgLabel(x.r, x.k))}</td><td>${esc(x.k.scripts.dev?.[0]?.run ?? '')}</td></tr>`);
  const boxes = repos.flatMap(r => r.compose.flatMap(c => c.services.map(s => `<tr><td><code>${esc(s.ports[0] ? `localhost:${s.ports[0].split(':')[0] ?? ''}` : 'conteneur')}</code></td><td>${esc(s.name)}</td><td>${esc(s.image || (s.build ? 'image construite ici' : ''))} · ${esc(c.rel)}</td></tr>`)));
  const hosts = [...new Set(repos.flatMap(r => r.hosts))];
  const live = [p.site ? `<tr><td><code>${esc(p.site.replace(/^https:\/\//, ''))}</code></td><td>Site en ligne</td><td>${hosts.length ? esc(hosts.join(', ')) : 'hébergeur non reconnu'}</td></tr>` : '', ...repos.flatMap(r => r.workflows.filter(w => w.deploy).map(w => `<tr><td><code>${esc(w.rel)}</code></td><td>${esc(w.name)}</td><td>déploiement · ${esc(w.triggers.join(', ') || 'manuel')}</td></tr>`))].filter(Boolean);
  const links: string[] = [];
  for (const { r, k } of pkgs) {
    for (const u of k.uses) { const t = r.packages.find(x => x.rel === u); links.push(`<li><code>${esc(pkgLabel(r, k))}</code> utilise <code>${esc(t ? pkgLabel(r, t) : u)}</code><em>dépendance du dépôt</em></li>`); }
    for (const d of k.data) { const s = repos.flatMap(x => x.compose.flatMap(c => c.services)).find(x => x.db && (x.kind ?? '').toLowerCase().startsWith(d.toLowerCase().slice(0, 4))); if (s) links.push(`<li><code>${esc(pkgLabel(r, k))}</code> parle à <code>${esc(s.name)}</code><em>${esc(d)} · service compose</em></li>`); }
  }
  for (const c of pkgs.filter(x => ['site', 'mobile', 'app'].includes(x.k.role))) {
    const api = pkgs.find(x => x.k.role === 'api' && x.r === c.r);
    const reads = c.r.env.files.flatMap(f => f.rel.startsWith(c.k.rel) ? f.vars : []).some(v => /(API|BACKEND|SERVER)[A-Z_]*URL|URL[A-Z_]*API/.test(v.key));
    if (api && reads) links.push(`<li><code>${esc(pkgLabel(c.r, c.k))}</code> appelle <code>${esc(pkgLabel(api.r, api.k))}</code><em>variable d’adresse d’API dans l’environnement</em></li>`);
  }
  const table = (rows: string[]): string => (rows.length ? `<table class="sk-table"><tbody>${rows.join('')}</tbody></table>` : '<p class="sk-mute">Rien de détecté.</p>');
  const rows = repos.map(r => `<div class="sk-repo"><header><strong>${esc(r.name)}</strong><span>${esc(roleLabel(r.role))}</span><code>${esc(r.path)}</code></header>${r.packages.length ? `<table class="sk-table"><thead><tr><th>Emplacement</th><th>Rôle</th><th>Technologies</th><th>Outil</th><th>Node</th></tr></thead><tbody>${r.packages.map(k => `<tr><td><code>${esc(place(k.rel))}</code>${k.name ? `<em>${esc(k.name)}</em>` : ''}</td><td>${esc(roleLabel(k.role))}</td><td>${esc(techOf(k))}</td><td>${esc(k.tool)}</td><td>${esc(k.node || '—')}</td></tr>`).join('')}</tbody></table>` : '<p class="sk-mute">Aucun paquet reconnu dans ce dépôt.</p>'}${r.truncated ? '<p class="sk-mute">Dossier très grand : l’analyse s’est arrêtée avant la fin.</p>' : ''}</div>`).join('');
  return `${section('Vue d’ensemble', `<div class="sk-map"><span class="sk-sr">Schéma : clients, services, données</span>${col('Clients', clients)}${col('Services', [...apis, ...libs])}${col('Données', stores)}</div>`, 'clique un bloc pour ouvrir l’onglet utile')}
    ${section('Ce qui tourne où', table([...local, ...boxes, ...live]))}
    ${section('Liens déduits', links.length ? `<ul class="sk-links">${links.slice(0, 40).join('')}</ul>` : '<p class="sk-mute">Aucun lien n’a pu être déduit des dépendances et des variables d’environnement.</p>')}
    ${section('Dépôts et paquets', rows)}`;
}

// ---------- API ----------
const API_KEY = 'studio.stack.base';
const baseOf = (p: Project, st: State): string => {
  try { const v = (JSON.parse(localStorage.getItem(API_KEY) ?? '{}') as Record<string, string>)[p.id]; if (v) return v; } catch { /* valeur illisible */ }
  const pk = (st.repos ?? []).flatMap(r => r.packages).find(k => k.role === 'api' && k.port) ?? (st.repos ?? []).flatMap(r => r.packages).find(k => k.port);
  return pk ? `http://localhost:${pk.port}` : 'http://localhost:3000';
};
/** Seules les adresses http://localhost:* et http://127.0.0.1:* sont atteignables : la politique de sécurité de la page (CSP) refuse le reste. */
function localBase(raw: string): string | null {
  try { const u = new URL(raw); return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') ? u.origin : null; } catch { return null; }
}
const apiFilter = new Map<string, { q: string; m: string }>();
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
let tried = new Map<string, string>();
let apiRoutes: Route[] = [];

function apiHTML(p: Project, st: State): string {
  if (!st.folder) return empty('Choisis d’abord le dossier du projet', 'Studio y cherche les routes de l’API. Le dossier se choisit dans l’onglet Code.', 'plug');
  const repos = st.repos ?? [];
  const routes = repos.flatMap(r => r.api.routes.map(x => ({ ...x, source: `${repos.length > 1 ? `${r.name.split('/').pop() ?? ''}:` : ''}${x.source}` })));
  apiRoutes = routes;
  const specs = repos.flatMap(r => r.api.specs.map(s => ({ ...s, repo: r.name }))), files = repos.flatMap(r => r.api.files);
  if (!routes.length && !files.length) return empty('Aucune route trouvée', 'Studio lit les fichiers OpenAPI et Swagger, les routes Next, SvelteKit, Nuxt, Express, NestJS, FastAPI, Flask, Django, Go, Rails, Laravel et Spring, ainsi que les fichiers .http, collections Postman et Bruno.', 'plug');
  const f = apiFilter.get(p.id) ?? { q: '', m: '' }, base = baseOf(p, st), local = localBase(base);
  const shown = routes.map((x, i) => ({ x, i })).filter(({ x }) => (!f.m || x.method === f.m) && (!f.q || `${x.path} ${x.summary ?? ''} ${x.source}`.toLowerCase().includes(f.q.toLowerCase())));
  const groups = new Map<string, { x: Route; i: number }[]>();
  for (const it of shown) { const k = it.x.path.split('/').filter(Boolean)[0]?.replace(/^:.*/, ':id') ?? '/'; groups.set(k, [...(groups.get(k) ?? []), it]); }
  const row = ({ x, i }: { x: Route; i: number }): string => {
    const can = x.method === 'GET' && !x.params && !!local;
    const res = tried.get(`${p.id}|${i}`);
    return `<div class="sk-row sk-route"><span class="sk-verb sk-${esc(x.method === '*' ? 'any' : x.method.toLowerCase())}">${esc(x.method === '*' ? 'tous' : x.method)}</span><div><code>${esc(x.path)}</code>${x.summary ? `<em>${esc(x.summary)}</em>` : ''}<em class="sk-src">${esc(x.source)}</em></div>
      ${x.method === 'GET' && !x.params ? `<button class="btn" data-sk="try" data-i="${i}"${can ? '' : ' disabled'} title="${can ? `GET ${esc(local ?? '')}${esc(x.path)}` : 'Studio n’appelle que http://localhost ou http://127.0.0.1'}">${icon('play')}Essayer</button>` : '<span></span>'}${res ? `<pre class="sk-res">${res}</pre>` : ''}</div>`;
  };
  const devs = repos.flatMap(r => r.packages.filter(k => k.role === 'api' || k.port).flatMap(k => (k.scripts.dev ?? []).slice(0, 2).map(s => ({ r, k, s }))));
  return `${section('Adresse de base', `<form class="sk-base" data-sk-base><input class="field" name="base" value="${esc(base)}" spellcheck="false" autocomplete="off" aria-label="Adresse de base de l’API"><button class="btn" type="submit">Appliquer</button></form>
      <p class="modal-hint">${icon('shield')}« Essayer » n’envoie que des GET sans paramètre, et seulement vers <code>http://localhost:*</code> ou <code>http://127.0.0.1:*</code> : la politique de sécurité (CSP) de Studio bloque le reste. L’API doit autoriser l’origine de Studio (CORS) pour que la réponse soit lisible.${local ? '' : ' <strong class="err">Cette adresse n’est pas locale : « Essayer » est désactivé.</strong>'}</p>`)}
    ${devs.length ? section('Lancer l’API', devs.map(({ r, k, s }) => { const run = st.runs?.[runKey(r.name, k.rel, s.name)]; return `<div class="sk-row"><div><code>${esc(s.name)}</code><em>${esc(pkgLabel(r, k))} · ${esc(s.command)}</em></div><span class="sk-st">${runState(run)}</span>${runButton(r, k, s, st)}${run ? logHTML(run) : ''}</div>`; }).join('')) : ''}
    ${section(`Routes · ${routes.length}${repos.some(r => r.api.truncated) ? '+' : ''}`, `<div class="sk-filter"><input class="field" data-sk-q value="${esc(f.q)}" placeholder="Filtrer par chemin, résumé, fichier" aria-label="Filtrer les routes" spellcheck="false"><span class="mb-seg" role="group">${METHODS.map(m => `<button data-sk="method" data-m="${m}" class="${f.m === m ? 'sel' : ''}" aria-pressed="${f.m === m}">${m}</button>`).join('')}</span></div>
      ${shown.length ? [...groups].map(([k, rows]) => `<div class="sk-group"><h4><code>/${esc(k === '/' ? '' : k)}</code><span>${rows.length}</span></h4>${rows.map(row).join('')}</div>`).join('') : '<p class="sk-mute">Aucune route ne correspond au filtre.</p>'}`)}
    ${specs.length || files.length ? section('Fichiers de description', `<table class="sk-table"><tbody>${specs.map(s => `<tr><td><code>${esc(s.rel)}</code></td><td>OpenAPI${s.version ? ` ${esc(s.version)}` : ''}${s.title ? ` · ${esc(s.title)}` : ''}</td><td>${plural(s.count, 'route')}${s.servers.length ? ` · ${esc(s.servers.join(', '))}` : ''}</td></tr>`).join('')}${files.map(f2 => `<tr><td><code>${esc(f2.rel)}</code></td><td>${f2.kind === 'http' ? 'Fichier .http' : f2.kind === 'postman' ? 'Collection Postman' : 'Collection Bruno'}</td><td>${plural(f2.count, 'requête')}</td></tr>`).join('')}</tbody></table>`) : ''}`;
}

// ---------- Données ----------
function schemaHTML(s: Schema): string {
  const rels = s.models.flatMap(m => m.fields.filter(f => f.ref && !f.list).map(f => `<li><code>${esc(m.name)}</code> → <code>${esc(f.ref ?? '')}</code><em>${esc(f.name)}${f.owns ? ' · clé étrangère' : ''}</em></li>`));
  const boxes = s.models.map(m => `<details class="sk-model"><summary><strong>${esc(m.name)}</strong><span>${plural(m.fields.length, 'champ')}</span></summary>
    <table class="sk-table"><tbody>${m.fields.map(f => `<tr><td><code>${esc(f.name)}</code></td><td>${esc(f.type)}${f.list ? '[]' : ''}${f.optional ? '?' : ''}</td><td>${[f.key ? 'clé' : '', f.unique ? 'unique' : '', f.ref ? `→ ${esc(f.ref)}` : ''].filter(Boolean).join(' · ')}</td></tr>`).join('')}</tbody></table></details>`).join('');
  return `<div class="sk-schema"><div class="sk-boxes">${s.models.map(m => `<span class="sk-chip">${esc(m.name)}</span>`).join('')}</div>${rels.length ? `<h4>Relations</h4><ul class="sk-links">${rels.slice(0, 60).join('')}</ul>` : ''}${boxes}
    ${s.enums.length ? `<h4>Énumérations</h4><table class="sk-table"><tbody>${s.enums.map(e => `<tr><td><code>${esc(e.name)}</code></td><td>${esc(e.values.join(', '))}</td></tr>`).join('')}</tbody></table>` : ''}</div>`;
}

function dataHTML(p: Project, st: State): string {
  if (!st.folder) return empty('Choisis d’abord le dossier du projet', 'Studio y cherche les modèles, les migrations et les scripts de base. Le dossier se choisit dans l’onglet Code.', 'database');
  const repos = st.repos ?? [];
  const schemas = repos.flatMap(r => r.data.schemas.map(s => ({ r, s }))), migs = repos.flatMap(r => r.data.migrations.map(m => ({ r, m })));
  const scripts = repos.flatMap(r => r.data.scripts.map(s => ({ r, s, k: r.packages.find(k => k.rel === s.rel) }))).filter(x => x.k);
  const services = repos.flatMap(r => r.compose.flatMap(c => c.services.filter(s => s.db || s.kind).map(s => ({ s, rel: c.rel }))));
  if (!schemas.length && !migs.length && !scripts.length && !services.length) return empty('Aucune base détectée', 'Studio reconnaît Prisma, Drizzle, les fichiers SQL, les dossiers de migrations (Prisma, Alembic, Rails, Knex, Supabase) et les services de base d’un fichier compose.', 'database');
  const run = (x: (typeof scripts)[number]): string => { const r = st.runs?.[runKey(x.r.name, x.s.rel, x.s.name)]; return `<div class="sk-row"><div><code>${esc(x.s.name)}</code><em>${esc(x.s.command)} · ${esc(place(x.s.rel))}</em></div><span class="sk-st">${runState(r)}</span>${x.k ? runButton(x.r, x.k, x.s, st) : ''}${r ? logHTML(r) : ''}</div>`; };
  return `${schemas.map(({ r, s }) => section(`${s.kind === 'prisma' ? 'Prisma' : s.kind === 'drizzle' ? 'Drizzle' : 'SQL'} · ${plural(s.models.length, 'modèle')}`, schemaHTML(s), `<code>${esc(s.rel)}</code>${s.provider ? ` · ${esc(s.provider)}` : ''}${repos.length > 1 ? ` · ${esc(r.name)}` : ''}`)).join('')}
    ${migs.length ? section('Migrations', migs.map(({ m }) => `<div class="sk-mig"><header><strong>${esc(m.tool)}</strong><code>${esc(m.rel)}</code><span>${plural(m.count, 'migration')}${m.last.at ? ` · dernière le ${esc(day(m.last.at))}` : ''}</span></header><table class="sk-table"><tbody>${m.items.map(i => `<tr><td><code>${esc(i.name)}</code></td><td>${i.at ? esc(day(i.at)) : ''}</td></tr>`).join('')}</tbody></table></div>`).join('')) : ''}
    ${scripts.length ? section('Scripts de base', `${scripts.map(run).join('')}<p class="modal-hint">${icon('shield')}Ces scripts agissent sur la base configurée dans l’environnement du projet. Ceux qui réinitialisent ou publient demandent une confirmation.</p>`) : ''}
    ${services.length ? section('Services de base (compose)', `<table class="sk-table"><tbody>${services.map(({ s, rel }) => `<tr><td><code>${esc(s.name)}</code></td><td>${esc(s.kind ?? '')}</td><td>${esc(s.image)}</td><td>${s.ports.length ? `:${esc(s.ports.join(', '))}` : ''}</td><td><code>${esc(rel)}</code></td></tr>`).join('')}</tbody></table>`) : ''}`;
}

// ---------- Tests ----------
const failBrief = (run: Run, label: string): string => `Les tests « ${label} » viennent d’échouer (${run.command}). Lis le journal ci-dessous, trouve la cause, corrige le code (pas les tests, sauf s’ils sont faux) et relance-les pour vérifier.\n\n${run.log.split('\n').slice(-60).join('\n')}`;

function testsHTML(p: Project, st: State): string {
  if (!st.folder) return empty('Choisis d’abord le dossier du projet', 'Studio y cherche les cadres de test. Le dossier se choisit dans l’onglet Code.', 'shield');
  const rows: string[] = [];
  for (const r of st.repos ?? []) {
    for (const k of r.packages) {
      const list = k.scripts.test ?? [], fw = r.tests.frameworks.filter(f => f.rel === k.rel), n = r.tests.byPackage[k.rel] ?? 0;
      if (!list.length && !fw.length && !n) continue;
      const cov = r.tests.coverage.find(c => c.rel === k.rel);
      const body = list.length ? list.map(s => {
        const run = st.runs?.[runKey(r.name, k.rel, s.name)];
        return `<div class="sk-row"><div><code>${esc(s.name)}</code><em>${esc(s.command)}</em></div><span class="sk-st">${runState(run)}${run?.summary ? `<br>${sumHTML(run.summary)}` : ''}</span><span class="sk-btns">${runButton(r, k, s, st)}${run?.status === 'failed' ? `<button class="btn btn-primary" data-sk="fix" data-repo="${esc(r.name)}" data-rel="${esc(k.rel)}" data-script="${esc(s.name)}">${icon('sparkle')}Corriger avec Claude</button>` : ''}</span>${run ? logHTML(run) : ''}</div>`;
      }).join('') : `<p class="sk-mute">Aucun script de test dans le package.json${fw[0] ? ` : lance <code>${esc(fw[0].command)}</code> à la main` : ''}.</p>`;
      rows.push(`<div class="sk-repo"><header><strong>${esc(pkgLabel(r, k))}</strong><span>${esc(fw.map(f => f.name).join(' · ') || 'cadre non reconnu')}</span><code>${plural(n, 'fichier')} de test</code></header>${body}
        ${cov ? `<p class="sk-cov">Couverture${cov.at ? ` au ${esc(day(cov.at))}` : ''} : ${cov.lines != null ? `lignes ${cov.lines} %` : ''}${cov.statements != null ? ` · instructions ${cov.statements} %` : ''}${cov.functions != null ? ` · fonctions ${cov.functions} %` : ''}${cov.branches != null ? ` · branches ${cov.branches} %` : ''}</p>` : ''}</div>`);
    }
  }
  if (!rows.length) return empty('Aucun test détecté', 'Studio reconnaît Vitest, Jest, Playwright, Cypress, Mocha, pytest, go test, cargo test, XCTest, flutter test, RSpec et PHPUnit.', 'shield');
  const last = lastOf(p.id);
  return `${last ? `<p class="sk-last">Dernier résultat, ${esc(day(last.at))} à ${esc(clock(last.at))} : ${last.ok ? '<span class="ok">réussi</span>' : '<span class="err">en échec</span>'} · ${last.passed} réussi${last.passed > 1 ? 's' : ''}, ${last.failed} échoué${last.failed > 1 ? 's' : ''}${last.skipped ? `, ${last.skipped} ignoré${last.skipped > 1 ? 's' : ''}` : ''}</p>` : ''}${rows.join('')}
    <p class="modal-hint">${icon('shield')}Lancer des tests exécute le code du projet, dans son dossier, avec <code>CI=true</code> (pas de mode « watch »). Seuls les scripts déclarés dans son package.json sont proposés.</p>`;
}

// ---------- Environnements ----------
const STAGES: [string, string][] = [['dev', 'Développement'], ['staging', 'Préproduction'], ['prod', 'Production']];
let servers: infra.ServerItem[] = [];

function envHTML(p: Project, st: State): string {
  if (!st.folder) return empty('Choisis d’abord le dossier du projet', 'Studio y lit les noms des variables d’environnement. Le dossier se choisit dans l’onglet Code.', 'gear');
  const repos = st.repos ?? [], alerts = st.alerts ?? [];
  const files = repos.flatMap(r => r.env.files.map(f => ({ r, f })));
  const alertRows = alerts.length ? `<div class="sk-alerts">${alerts.map(a => `<div class="sk-alert sk-${esc(a.level)}"><strong>${a.level === 'danger' ? 'À corriger' : 'À vérifier'}</strong><div><p>${esc(a.text)}</p>${a.fix ? `<code>${esc(a.fix)}</code>` : ''}</div>
      <button class="btn" data-sk="alert-fix" data-text="${esc(a.text)}" data-fix="${esc(a.fix ?? '')}">${icon('sparkle')}Demander à Claude</button></div>`).join('')}</div>` : '<p class="sk-mute">Aucune alerte : les fichiers d’environnement sont ignorés par Git et comparés à leur exemple.</p>';
  const colOf = (stage: string): string => {
    const own = files.filter(x => x.f.stage === stage);
    return own.length ? own.map(({ r, f }) => `<div class="sk-envfile"><header><code>${esc(f.rel)}</code>${repos.length > 1 ? `<em>${esc(r.name.split('/').pop() ?? r.name)}</em>` : ''}<span>${f.set}/${f.count} renseignée${f.set > 1 ? 's' : ''}</span></header>
      ${f.missing?.length ? `<p class="err">Manque (vs <code>${esc(f.vs ?? '')}</code>) : ${f.missing.map(k => `<code>${esc(k)}</code>`).join(' ')}</p>` : ''}
      <ul class="sk-vars">${f.vars.slice(0, 60).map(v => `<li><code>${esc(v.key)}</code><i class="${v.set ? 'ok' : 'err'}">${v.set ? 'renseignée' : 'vide'}</i></li>`).join('')}</ul>
      ${f.tracked ? '<p class="err">Suivi par Git.</p>' : !f.ignored && f.set ? '<p class="err">Non ignoré par Git.</p>' : ''}</div>`).join('') : '<p class="sk-mute">Aucun fichier.</p>';
  };
  const examples = files.filter(x => x.f.stage === 'example');
  const hosts = [...new Set(repos.flatMap(r => r.hosts))];
  const deploys = repos.flatMap(r => r.deploy.map(d => `<tr><td><code>${esc(d.rel)}</code></td><td>${esc(d.host)}</td></tr>`));
  const compose = repos.flatMap(r => r.compose.map(c => `<tr><td><code>${esc(c.rel)}</code></td><td>${esc(c.services.map(s => s.name).join(', '))}</td></tr>`));
  const flows = repos.flatMap(r => r.workflows.map(w => `<tr><td><code>${esc(w.rel)}</code></td><td>${esc(w.name)}</td><td>${esc(w.triggers.join(', '))}${w.deploy ? ' · déploie' : ''}</td></tr>`));
  const undoc = repos.flatMap(r => r.env.undocumented ?? []);
  return `${section('Alertes', alertRows)}
    ${section('Variables par environnement', `<div class="sk-cols">${STAGES.map(([k, l]) => `<div class="sk-col"><h4>${l}</h4>${colOf(k)}</div>`).join('')}</div>
      <p class="modal-hint">${icon('shield')}Studio ne lit que les noms des variables et si elles ont une valeur : jamais les valeurs elles-mêmes.</p>`)}
    ${examples.length ? section('Exemples', examples.map(({ f }) => `<div class="sk-envfile"><header><code>${esc(f.rel)}</code><span>${plural(f.count, 'variable')}</span></header><ul class="sk-vars">${f.vars.slice(0, 60).map(v => `<li><code>${esc(v.key)}</code>${v.note ? `<em>${esc(v.note)}</em>` : ''}</li>`).join('')}</ul></div>`).join('')) : ''}
    ${undoc.length ? section('Lues dans le code, décrites nulle part', `<p>${undoc.slice(0, 40).map(k => `<code>${esc(k)}</code>`).join(' ')}</p>`) : ''}
    ${section('Où ça tourne', `<table class="sk-table"><tbody>${p.site ? `<tr><td><code>${esc(p.site.replace(/^https:\/\//, ''))}</code></td><td>Site en ligne</td></tr>` : ''}${servers.map(s => `<tr><td><code>${esc(s.dest || s.host)}</code></td><td>Serveur${s.name ? ` · ${esc(s.name)}` : ''}${s.path ? ` · ${esc(s.path)}` : ''}</td></tr>`).join('')}${hosts.length ? `<tr><td>Hébergeur</td><td>${esc(hosts.join(', '))}</td></tr>` : ''}${deploys.join('')}${compose.join('')}</tbody></table>${!p.site && !servers.length && !hosts.length ? '<p class="sk-mute">Aucun site, serveur ni fichier de déploiement connu.</p>' : ''}`)}
    ${flows.length ? section('Workflows GitHub Actions', `<table class="sk-table"><tbody>${flows.join('')}</tbody></table>`) : ''}`;
}

// ---------- Onglets ----------
const RENDER: Record<string, (p: Project, st: State) => string> = { archi: archiHTML, api: apiHTML, data: dataHTML, tests: testsHTML, env: envHTML };
const TITLE: Record<string, string> = { archi: 'Architecture', api: 'API', data: 'Données', tests: 'Tests', env: 'Environnements' };
export const isTab = (tab: string): boolean => tab in RENDER;

/** Contenu de l'onglet avant la première réponse du Mac. */
export const tabHTML = (tab: string): string => (onMac()
  ? `<div class="sk-box" data-sk-box="${esc(tab)}"><div class="pj-skel"></div></div>`
  : `<div class="sk-box">${macOnly(tab === 'env' ? 'variables, déploiement' : tab === 'tests' ? 'tests' : tab === 'data' ? 'modèles, migrations' : tab === 'api' ? 'routes' : 'paquets et services')}</div>`);

let timer = 0;
/** Branche l'onglet : analyse du Mac, boutons, relecture toutes les 2 s tant qu'un script tourne. */
export function mount(root: HTMLElement, p: Project, tab: string, toClaude: (prompt: string) => Promise<void>): void {
  window.clearInterval(timer);
  const box = $('[data-sk-box]', root);
  if (!box || !onMac() || !(tab in RENDER)) return;
  const render = RENDER[tab];
  let busy = false;
  const paint = (st: State): void => {
    if (!box.isConnected) return;
    if (!st.ok) { paintIfChanged(box, empty('Lecture impossible', esc(st.message ?? 'Le Mac n’a pas pu lire le dossier.'))); return; }
    paintIfChanged(box, render ? render(p, st) : '');
  };
  const running = (): boolean => Object.values(states.get(p.id)?.runs ?? {}).some(r => r.status === 'running');
  const load = async (fresh = false): Promise<void> => {
    try { paint(await ask(p, fresh ? { fresh: true } : {})); } catch { paint({ ok: false, message: 'Le Mac n’a pas répondu à temps.' }); }
  };
  const cached = states.get(p.id);
  if (cached) paint(cached);
  if (tab === 'env') void infra.list(p).then(r => { servers = r.servers; const s = states.get(p.id); if (s) paint(s); }).catch(() => { /* serveurs : facultatif */ });
  void load(true);

  const act = async (b: HTMLElement): Promise<void> => {
    const op = b.dataset.sk ?? '', repo = b.dataset.repo ?? '', rel = b.dataset.rel ?? '', script = b.dataset.script ?? '';
    const st = states.get(p.id);
    if (op === 'run') {
      if (b.dataset.risky && !await confirmBox({ title: `Lancer « ${script} » ?`, text: 'Ce script réinitialise, supprime ou publie quelque chose. Il s’exécute sur ce Mac, avec ce que le projet a configuré.', ok: 'Lancer', danger: true })) return;
      const r = await ask(p, { op: 'run', repo, rel, script, name: p.name });
      if (!r.ok) toast(r.message ?? 'Le Mac n’a pas pu lancer le script.');
      paint(r.ok ? r : (st ?? r));
    } else if (op === 'stop') { paint(await ask(p, { op: 'stop', repo, rel, script })); }
    else if (op === 'fix') {
      const run = st?.runs?.[runKey(repo, rel, script)];
      if (run) await toClaude(failBrief(run, `${repo}${rel ? `/${rel}` : ''}`));
    } else if (op === 'alert-fix') {
      await toClaude(`${b.dataset.text ?? ''}\n\nCorrection proposée : ${b.dataset.fix ?? ''}\nFais-la proprement sans afficher ni recopier la valeur d’aucun secret.`);
    } else if (op === 'method') {
      const f = apiFilter.get(p.id) ?? { q: '', m: '' }, m = b.dataset.m ?? '';
      apiFilter.set(p.id, { ...f, m: f.m === m ? '' : m }); if (st) paint(st);
    } else if (op === 'try') {
      const route = apiRoutes[Number(b.dataset.i)], st2 = st, base = st2 ? localBase(baseOf(p, st2)) : null;
      if (!route || !base || route.method !== 'GET' || route.params) return;
      const k = `${p.id}|${b.dataset.i ?? ''}`, t0 = performance.now();
      tried.set(k, 'Appel en cours…'); if (st2) paint(st2);
      try {
        const res = await fetch(base + route.path, { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout(8000) });
        const text = (await res.text()).slice(0, 600);
        tried.set(k, `${res.ok ? '<span class="ok">' : '<span class="err">'}${res.status}</span> · ${Math.round(performance.now() - t0)} ms\n${esc(text)}`);
      } catch (e) {
        tried.set(k, `<span class="err">Pas de réponse lisible</span> · ${esc(e instanceof Error && e.name === 'TimeoutError' ? 'délai dépassé' : 'serveur éteint, ou CORS qui n’autorise pas Studio')}`);
      }
      if (st2) paint(st2);
    }
  };
  box.onclick = e => {
    const t = target(e);
    const b = t.closest<HTMLElement>('[data-sk]');
    if (!b || busy) return;
    busy = true;
    void act(b).catch(() => toast('Le Mac n’a pas répondu à temps.')).finally(() => { busy = false; });
  };
  box.oninput = e => {
    const i = target(e);
    if (!(i instanceof HTMLInputElement) || !i.hasAttribute('data-sk-q')) return;
    const f = apiFilter.get(p.id) ?? { q: '', m: '' };
    apiFilter.set(p.id, { ...f, q: i.value });
    const st = states.get(p.id), at = i.selectionStart;
    if (st) { paint(st); const n = $('[data-sk-q]', box) as HTMLInputElement | null; n?.focus(); if (n && at != null) n.setSelectionRange(at, at); }
  };
  box.onsubmit = e => {
    const f = target(e).closest<HTMLFormElement>('[data-sk-base]');
    if (!f) return;
    e.preventDefault();
    const v = (f.elements.namedItem('base') as HTMLInputElement | null)?.value.trim() ?? '';
    if (!localBase(v)) { toast('Adresse locale seulement : http://localhost:3000 ou http://127.0.0.1:3000'); return; }
    try { const all = JSON.parse(localStorage.getItem(API_KEY) ?? '{}') as Record<string, string>; all[p.id] = v; localStorage.setItem(API_KEY, JSON.stringify(all)); } catch { /* adresse non gardée */ }
    tried = new Map(); const st = states.get(p.id); if (st) paint(st);
  };
  timer = window.setInterval(() => {
    if (!box.isConnected) { window.clearInterval(timer); return; }
    if (!document.hidden && !busy && running()) void load();
  }, 2000);
}

// ---------- Vue d'ensemble : ligne « État du projet » ----------
/** Remplit la ligne d'état de la Vue d'ensemble : tests (dernier résultat), environnements, données, API. */
export async function overviewFill(root: HTMLElement, p: Project): Promise<void> {
  const box = $('[data-sk-state]', root);
  if (!box) return;
  const link = (tab: string, body: string): string => `<button class="sk-stat" data-pj-tab="${tab}">${body}</button>`;
  const lt = lastOf(p.id);
  const testPart = (): string => link('tests', `<span>Tests</span><strong>${lt ? (lt.ok ? '<span class="ok">réussis</span>' : '<span class="err">en échec</span>') : 'jamais lancés'}</strong>${lt ? `<em>${lt.passed} réussi${lt.passed > 1 ? 's' : ''}, ${lt.failed} échoué${lt.failed > 1 ? 's' : ''} · ${esc(day(lt.at))}</em>` : ''}`);
  if (!onMac()) { box.innerHTML = `<p class="sk-mute">Architecture, API, données, tests et environnements se lisent depuis l’app Mac.</p>`; return; }
  try {
    const st = states.get(p.id) ?? await ask(p);
    if (!box.isConnected) return;
    if (!st.ok || !st.folder) { box.innerHTML = `<p class="sk-mute">Choisis le dossier du projet pour voir son état.</p>`; return; }
    const repos = st.repos ?? [], alerts = st.alerts ?? [], danger = alerts.filter(a => a.level === 'danger').length;
    const models = repos.reduce((n, r) => n + r.data.schemas.reduce((m, s) => m + s.models.length, 0), 0), migs = repos.reduce((n, r) => n + r.data.migrations.reduce((m, x) => m + x.count, 0), 0);
    const routes = repos.reduce((n, r) => n + r.api.routes.length, 0);
    box.innerHTML = `<div class="sk-stats">${testPart()}
      ${link('env', `<span>Environnements</span><strong>${alerts.length ? `<span class="${danger ? 'err' : ''}">${plural(alerts.length, 'alerte')}</span>` : '<span class="ok">sans alerte</span>'}</strong>`)}
      ${link('data', `<span>Données</span><strong>${plural(models, 'modèle')}</strong><em>${plural(migs, 'migration')}</em>`)}
      ${link('api', `<span>API</span><strong>${plural(routes, 'route')}</strong>`)}</div>`;
  } catch { if (box.isConnected) box.innerHTML = testPart(); }
}

export const title = (tab: string): string => TITLE[tab] ?? '';
