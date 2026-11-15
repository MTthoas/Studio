// GitHub : actualité de tes dépôts, lue directement sur api.github.com avec un jeton personnel du coffre.
// Ce fichier : accès à l'API et état (événements, non vus). La page est dans page.js.
// Lecture seule : Studio n'écrit jamais sur GitHub. Sans serveur, l'app interroge l'API toutes les 5 minutes.
import * as vault from '../../core/vault.ts';
import * as bus from '../../core/events.ts';
import { toast, errMsg } from '../../ui/kit.ts';
import type { AppShell } from '../../types.ts';

/** Événement public de l'API GitHub (champs utilisés seulement). */
export interface GhEvent {
  id: string; type: string; created_at: string;
  actor?: { login: string }; repo?: { name: string };
  payload?: {
    action?: string; ref?: string; ref_type?: string; number?: number;
    pull_request?: { number?: number; title?: string; merged?: boolean };
    issue?: { number?: number; title?: string };
    comment?: { body?: string };
    release?: { name?: string; tag_name?: string };
    member?: { login?: string };
  };
}
export interface Described { verb: string; what: string; url: string; kind: string; quote?: string | undefined }

const API = 'https://api.github.com', EVERY = 5 * 60e3, SEEN = 'carnet.github.seen', MAX_REPOS = 12;
let app: AppShell | null = null, events: GhEvent[] = [], me = '', error = '', loaded = false, busy = false;
const listeners = new Set<() => void>();
export const onUpdate = (f: () => void): void => { listeners.add(f); }; // la page s'abonne pour se redessiner
const emit = () => { app?.onCount?.(); listeners.forEach(f => f()); };
export const state = () => ({ events, me, error, loaded, seen: localStorage.getItem(SEEN) || '' });

export const connected = (): boolean => !!vault.secret('github');
export const active = (): boolean => vault.isOpen() && connected();

// Cache des lectures, en mémoire seulement. Trois économies : une même adresse demandée en même temps ne part
// qu'une fois (`inflight` : vue d'ensemble, cartes des dépôts et graphiques chargent les mêmes données ensemble),
// une réponse de moins de `REUSE` est resservie telle quelle, et au-delà la requête est conditionnelle
// (`If-None-Match`) : un 304 de GitHub est rapide, léger et ne compte pas dans la limite de requêtes.
// Les données rendues sont partagées : ne jamais les modifier en place.
const REUSE = 20e3, CACHE_MAX = 400;
const cache = new Map<string, { at: number; etag: string; data: unknown }>(), inflight = new Map<string, Promise<unknown>>();
export function api<T>(path: string, token: string | null = vault.secret('github'), { maxAge = REUSE } = {}): Promise<T> {
  if (!token) return Promise.reject(new Error('GitHub n’est pas connecté (Réglages → GitHub).'));
  const key = `${token} ${path}`, hit = cache.get(key), running = inflight.get(key);
  if (running) return running as Promise<T>;
  if (hit && Date.now() - hit.at < maxAge) return Promise.resolve(hit.data as T);
  const p = (async () => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (hit?.etag) headers['If-None-Match'] = hit.etag;
    const r = await fetch(API + path, { headers, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (r.status === 304 && hit) { hit.at = Date.now(); return hit.data; }
    if (r.status === 401) throw new Error('jeton refusé ou expiré');
    if (r.status === 403 || r.status === 429) throw new Error('limite de requêtes atteinte, réessaie plus tard');
    if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
    const data: unknown = await r.json();
    cache.delete(key); cache.set(key, { at: Date.now(), etag: r.headers.get('ETag') ?? '', data });
    if (cache.size > CACHE_MAX) { const old = cache.keys().next().value; if (old !== undefined) cache.delete(old); }
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p as Promise<T>;
}
/** Les lectures d'un dépôt seront revalidées auprès de GitHub (après une écriture, ou sur demande d'actualisation). */
function forget(repo: string): void { for (const [k, v] of cache) if (k.includes(` /repos/${repo}/`) || k.endsWith(` /repos/${repo}`)) v.at = 0; }
/** Commits par jour sur la branche principale (repli quand le dossier n'est pas sur ce Mac). */
export async function commitsPerDay(repo: string, days = 30): Promise<Record<string, number>> {
  if (!REPO_RE.test(repo)) throw new Error(`Dépôt invalide : ${repo}`);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const list = await api<{ commit: { committer?: { date?: string }; author?: { date?: string } } }[]>(`/repos/${repo}/commits?since=${encodeURIComponent(since)}&per_page=100`);
  const out: Record<string, number> = {};
  for (const c of list) { const d = new Date(c.commit.committer?.date ?? c.commit.author?.date ?? ''); if (isNaN(+d)) continue; const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

/** Ouvre une pull request (après le push d'une branche d'agent). */
export async function createPull(repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<{ number: number; html_url: string }> {
  if (!REPO_RE.test(repo)) throw new Error(`Dépôt invalide : ${repo}`);
  const token = vault.secret('github'); if (!token) throw new Error('GitHub n’est pas connecté (Réglages → GitHub).');
  const r = await fetch(`${API}/repos/${repo}/pulls`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, body: JSON.stringify(pr), credentials: 'omit', referrerPolicy: 'no-referrer' });
  const j = await r.json().catch(() => ({})) as { number?: number; html_url?: string; message?: string; errors?: { message?: string }[] };
  if (!r.ok || !j.number || !j.html_url) throw new Error(j.errors?.[0]?.message || j.message || `GitHub a répondu ${r.status}`);
  flowCache.delete(repo); repoCache.delete(repo); forget(repo);
  return { number: j.number, html_url: j.html_url };
}

/** Relance une exécution GitHub Actions : seulement ses jobs en échec quand `failedOnly`, sinon toute l'exécution.
 *  Même commit qu'à l'origine : pour construire le dernier commit d'une branche, il faut un nouveau push. */
export async function rerun(repo: string, runId: number, { failedOnly = true } = {}): Promise<void> {
  if (!REPO_RE.test(repo)) throw new Error(`Dépôt invalide : ${repo}`);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Exécution inconnue.');
  const token = vault.secret('github'); if (!token) throw new Error('GitHub n’est pas connecté (Réglages → GitHub).');
  const r = await fetch(`${API}/repos/${repo}/actions/runs/${runId}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (r.status === 403 || r.status === 404) throw new Error('Le jeton GitHub ne peut pas relancer les workflows : donne-lui le droit Actions en lecture et écriture (Réglages → GitHub).');
  if (!r.ok) { const j = await r.json().catch(() => ({})) as { message?: string }; throw new Error(j.message || `GitHub a répondu ${r.status}`); }
  flowCache.delete(repo); forget(repo);
}
export const viewer = (token?: string): Promise<{ login: string; id: number; name?: string | null }> => api('/user', token ?? vault.secret('github'));

/** Identité Git du compte connecté, pour les commits des copies quand Git n'en a pas (voir `fallbackIdentity`
 *  dans Projects.swift). Adresse « noreply » de GitHub : le commit est rattaché au compte sans exposer d'adresse. */
let authorCache: { name: string; email: string } | null = null;
export async function author(): Promise<{ name: string; email: string } | undefined> {
  if (authorCache) return authorCache;
  if (!vault.secret('github')) return undefined;
  try {
    const v = await viewer();
    if (!v.login || !v.id) return undefined;
    authorCache = { name: (v.name || '').trim() || v.login, email: `${v.id}+${v.login}@users.noreply.github.com` };
    return authorCache;
  } catch { return undefined; }
}

// ---------- Événements -> phrases ----------
const ACTION: Record<string, string> = { opened: 'a ouvert', closed: 'a fermé', reopened: 'a rouvert', merged: 'a fusionné', created: 'a créé', published: 'a publié', edited: 'a modifié', submitted: 'a relu', started: 'a mis une étoile à', labeled: 'a étiqueté', assigned: 'a assigné', synchronize: 'a mis à jour' };
const branch = (ref?: string) => (ref || '').replace(/^refs\/(heads|tags)\//, '');
export function describe(e: GhEvent): Described {
  const p = e.payload || {}, repo = e.repo?.name || '', base = `https://github.com/${repo}`, act = (p.action && ACTION[p.action]) || p.action || '';
  const pr = p.pull_request, is = p.issue;
  switch (e.type) {
    case 'PushEvent': return { verb: 'a poussé sur', what: branch(p.ref), url: `${base}/commits/${encodeURIComponent(branch(p.ref))}`, kind: 'push' };
    case 'PullRequestEvent': return { verb: `${p.action === 'closed' && pr?.merged ? 'a fusionné' : act} la PR`, what: `#${p.number ?? pr?.number ?? ''} ${pr?.title || ''}`.trim(), url: `${base}/pull/${p.number ?? pr?.number ?? ''}`, kind: 'pr' };
    case 'PullRequestReviewEvent': return { verb: 'a relu la PR', what: `#${pr?.number ?? ''} ${pr?.title || ''}`.trim(), url: `${base}/pull/${pr?.number ?? ''}`, kind: 'pr' };
    case 'PullRequestReviewCommentEvent': return { verb: 'a commenté la PR', what: `#${pr?.number ?? ''} ${pr?.title || ''}`.trim(), quote: p.comment?.body, url: `${base}/pull/${pr?.number ?? ''}`, kind: 'comment' };
    case 'IssuesEvent': return { verb: `${act} l’issue`, what: `#${is?.number ?? ''} ${is?.title || ''}`.trim(), url: `${base}/issues/${is?.number ?? ''}`, kind: 'issue' };
    case 'IssueCommentEvent': return { verb: 'a commenté', what: `#${is?.number ?? ''} ${is?.title || ''}`.trim(), quote: p.comment?.body, url: `${base}/issues/${is?.number ?? ''}`, kind: 'comment' };
    case 'ReleaseEvent': return { verb: 'a publié la version', what: p.release?.name || p.release?.tag_name || '', url: `${base}/releases`, kind: 'release' };
    case 'CreateEvent': return { verb: p.ref_type === 'repository' ? 'a créé le dépôt' : p.ref_type === 'tag' ? 'a créé le tag' : 'a créé la branche', what: p.ref || '', url: base, kind: 'branch' };
    case 'DeleteEvent': return { verb: p.ref_type === 'tag' ? 'a supprimé le tag' : 'a supprimé la branche', what: p.ref || '', url: base, kind: 'branch' };
    case 'ForkEvent': return { verb: 'a forké le dépôt', what: '', url: base, kind: 'star' };
    case 'WatchEvent': return { verb: 'a mis une étoile', what: '', url: base, kind: 'star' };
    case 'MemberEvent': return { verb: 'a ajouté un membre', what: p.member?.login || '', url: base, kind: 'star' };
    case 'PublicEvent': return { verb: 'a rendu le dépôt public', what: '', url: base, kind: 'star' };
    case 'CommitCommentEvent': return { verb: 'a commenté un commit', what: '', quote: p.comment?.body, url: base, kind: 'comment' };
    default: return { verb: e.type.replace(/Event$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(), what: '', url: base, kind: 'star' };
  }
}

// ---------- Chargement ----------
export const unseenCount = (): number => { const last = localStorage.getItem(SEEN) || ''; return events.filter(e => e.created_at > last && e.actor?.login !== me).length; };
export const latest = (n = 5): { e: GhEvent; d: Described }[] => events.slice(0, n).map(e => ({ e, d: describe(e) }));
export function markSeen(): void { const first = events[0]; if (first && first.created_at > (localStorage.getItem(SEEN) || '')) { localStorage.setItem(SEEN, first.created_at); app?.onCount?.(); } }

export async function poll({ quiet = true } = {}): Promise<void> {
  if (!active() || busy) return;
  busy = true;
  try {
    if (!me) me = (await viewer()).login;
    const repos = await api<{ full_name: string }[]>(`/user/repos?sort=pushed&per_page=${MAX_REPOS}&affiliation=owner,collaborator,organization_member`);
    const lists = await Promise.all(repos.map(r => api<GhEvent[]>(`/repos/${r.full_name}/events?per_page=20`).catch((): GhEvent[] => [])));
    const seen = new Set<string>();
    const before = events[0]?.created_at ?? '', known = events.length > 0;
    events = lists.flat().filter(e => e?.id && !seen.has(e.id) && seen.add(e.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 120);
    // Nouveautés depuis le passage précédent (pas au premier chargement) : déclencheur des automatisations.
    const fresh = known ? events.filter(e => e.created_at > before && e.actor?.login !== me) : [];
    // Un événement par dépôt : une automatisation ne reçoit que les dépôts de son périmètre.
    const byRepo = new Map<string, GhEvent[]>();
    for (const e of fresh.slice(0, 20)) { const r = e.repo?.name ?? '', l = byRepo.get(r); if (l) l.push(e); else byRepo.set(r, [e]); }
    for (const [repo, list] of byRepo) bus.emit('github', list.map(e => { const d = describe(e); return `- ${e.actor?.login ?? ''} ${d.verb} ${d.what} (${e.repo?.name ?? ''}) ${d.url}`; }).join('\n'), { repo });
    if (!localStorage.getItem(SEEN) && events[0]) localStorage.setItem(SEEN, events[0].created_at); // premier passage : rien n'est « nouveau »
    error = ''; loaded = true;
  } catch (e) { error = errMsg(e); if (!quiet) toast('GitHub : ' + error); }
  busy = false;
  emit();
}

export function init(shell: AppShell): void {
  app = shell;
  setInterval(() => poll(), EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) poll(); });
  vault.onChange(() => { if (!active()) { events = []; loaded = false; me = ''; cache.clear(); repoCache.clear(); flowCache.clear(); authorCache = null; emit(); } else if (!loaded) poll(); });
  poll();
}

// ---------- Projets : dépôt, PR ouvertes, CI et revues ----------
export interface RepoInfo { full_name: string; html_url: string; default_branch: string; open_issues_count: number; pushed_at: string; description: string | null }
export type CiState = 'success' | 'failure' | 'pending' | 'none';
export type ReviewState = 'approved' | 'changes' | 'pending' | 'none';
export interface Pull { number: number; title: string; url: string; author: string; draft: boolean; branch: string; updated: string; ci: CiState; review: ReviewState }

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const repoCache = new Map<string, { at: number; info: RepoInfo; pulls: Pull[] }>();

interface RawPull { number: number; title: string; html_url: string; draft?: boolean; updated_at: string; user?: { login: string }; head: { ref: string; sha: string }; requested_reviewers?: unknown[] }
async function ciOf(repo: string, sha: string): Promise<CiState> {
  const d = await api<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>(`/repos/${repo}/commits/${sha}/check-runs?per_page=50`);
  if (!d.total_count) return 'none';
  if (d.check_runs.some(r => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion ?? ''))) return 'failure';
  if (d.check_runs.some(r => r.status !== 'completed')) return 'pending';
  return 'success';
}
async function reviewOf(repo: string, p: RawPull): Promise<ReviewState> {
  const reviews = await api<{ user?: { login: string }; state: string }[]>(`/repos/${repo}/pulls/${p.number}/reviews?per_page=50`);
  const last = new Map<string, string>();
  for (const r of reviews) if (r.user && r.state !== 'COMMENTED') last.set(r.user.login, r.state);
  const states = [...last.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes';
  if (states.includes('APPROVED')) return 'approved';
  return p.requested_reviewers?.length ? 'pending' : 'none';
}

/** Dépôt et ses PR ouvertes (avec CI et revues), mis en cache une minute. */
export async function project(repo: string, { fresh = false } = {}): Promise<{ info: RepoInfo; pulls: Pull[] }> {
  if (!REPO_RE.test(repo)) throw new Error(`Dépôt invalide : ${repo}`);
  const hit = repoCache.get(repo);
  if (!fresh && hit && Date.now() - hit.at < 60e3) return hit;
  if (fresh) forget(repo);
  const [info, raw] = await Promise.all([api<RepoInfo>(`/repos/${repo}`), api<RawPull[]>(`/repos/${repo}/pulls?state=open&per_page=15&sort=updated&direction=desc`)]);
  const pulls = await Promise.all(raw.map(async p => {
    const [ci, review] = await Promise.all([ciOf(repo, p.head.sha).catch((): CiState => 'none'), reviewOf(repo, p).catch((): ReviewState => 'none')]);
    return { number: p.number, title: p.title, url: p.html_url, author: p.user?.login ?? '', draft: !!p.draft, branch: p.head.ref, updated: p.updated_at, ci, review };
  }));
  const out = { at: Date.now(), info, pulls };
  repoCache.set(repo, out);
  return out;
}
/** Activité récente d'un dépôt, déjà chargée par l'actualité GitHub. */
export const activityOf = (repo: string, n = 8): { e: GhEvent; d: Described }[] => events.filter(e => e.repo?.name === repo).slice(0, n).map(e => ({ e, d: describe(e) }));
/** Dépôts de l'utilisateur (pour choisir celui d'un projet). */
export const myRepos = async (): Promise<string[]> => (await api<{ full_name: string }[]>('/user/repos?sort=pushed&per_page=50&affiliation=owner,collaborator,organization_member')).map(r => r.full_name);

// ---------- Flux de travail (gitflow) d'un dépôt ----------
export type Stage = 'branche' | 'pr' | 'ci' | 'revue' | 'prete' | 'fusionnee' | 'publiee' | 'fermee';
export interface FlowItem {
  branch: string; stage: Stage; updated: string;
  pr?: { number: number; title: string; url: string; author: string; draft: boolean; mergedAt: string | null };
  ci: CiState; review: ReviewState; release?: { tag: string; url: string };
}
export interface Flow { repo: string; base: string; items: FlowItem[]; baseCi: CiState; releases: { tag: string; url: string; at: string }[]; /** Dernières exécutions de CI sur la branche principale, de la plus ancienne à la plus récente. */ history: { at: string; state: 'success' | 'failure' | 'pending'; label: string; url: string }[]; actions: Workflow[] }
/** Un workflow GitHub Actions : sa dernière exécution (toutes branches) et ses précédentes, de la plus ancienne à la plus récente. */
export interface Workflow { name: string; last: ActionRun; runs: { at: string; state: 'success' | 'failure' | 'pending'; label: string; url: string }[] }
export interface ActionRun { id: number; state: CiState; status: string; conclusion: string | null; branch: string; title: string; event: string; at: string; url: string; seconds: number | null }

interface RawRun { id: number; head_branch: string; status: string; conclusion: string | null; created_at: string; updated_at?: string; run_started_at?: string; name: string; html_url?: string; display_title?: string; event?: string }
interface RawPullAll extends RawPull { state: 'open' | 'closed'; merged_at: string | null; closed_at: string | null; created_at: string }
const runState = (r?: RawRun): CiState => !r ? 'none' : r.status !== 'completed' ? 'pending' : ['success', 'skipped', 'neutral'].includes(r.conclusion ?? '') ? 'success' : 'failure';
const flowCache = new Map<string, { at: number; flow: Flow }>();

/** Où en est chaque branche : PR, CI, revue, fusion dans la branche principale, publication. */
export async function flow(repo: string, { fresh = false } = {}): Promise<Flow> {
  if (!REPO_RE.test(repo)) throw new Error(`Dépôt invalide : ${repo}`);
  const hit = flowCache.get(repo); if (!fresh && hit && Date.now() - hit.at < 60e3) return hit.flow;
  if (fresh) forget(repo);
  const [info, branches, pulls, releases, runs] = await Promise.all([
    api<RepoInfo>(`/repos/${repo}`),
    api<{ name: string }[]>(`/repos/${repo}/branches?per_page=60`),
    api<RawPullAll[]>(`/repos/${repo}/pulls?state=all&per_page=30&sort=updated&direction=desc`),
    api<{ tag_name: string; html_url: string; published_at: string; draft: boolean }[]>(`/repos/${repo}/releases?per_page=10`),
    api<{ workflow_runs: RawRun[] }>(`/repos/${repo}/actions/runs?per_page=60`).catch(() => ({ workflow_runs: [] as RawRun[] })),
  ]);
  const base = info.default_branch;
  const lastRun = new Map<string, RawRun>();
  for (const r of runs.workflow_runs) if (r.name !== 'Dependabot Updates' && !lastRun.has(r.head_branch)) lastRun.set(r.head_branch, r);
  const rels = releases.filter(r => !r.draft && r.published_at).sort((a, b) => a.published_at.localeCompare(b.published_at));
  const seen = new Set<string>([base]), heads = pulls.filter(p => !seen.has(p.head.ref) && p.head.ref !== base && !!seen.add(p.head.ref));
  // Les PR ouvertes demandent chacune leur CI et leurs revues : toutes en parallèle, pas l'une après l'autre.
  const items: FlowItem[] = await Promise.all(heads.map(async (p): Promise<FlowItem> => {
    const pr = { number: p.number, title: p.title, url: p.html_url, author: p.user?.login ?? '', draft: !!p.draft, mergedAt: p.merged_at };
    if (p.state === 'closed') {
      const rel = p.merged_at ? rels.find(r => r.published_at >= (p.merged_at ?? '')) : undefined;
      return { branch: p.head.ref, stage: p.merged_at ? (rel ? 'publiee' : 'fusionnee') : 'fermee', updated: p.merged_at ?? p.closed_at ?? p.updated_at, pr, ci: runState(lastRun.get(p.head.ref)), review: 'none', ...(rel ? { release: { tag: rel.tag_name, url: rel.html_url } } : {}) };
    }
    const [ci, review] = await Promise.all([ciOf(repo, p.head.sha).catch((): CiState => runState(lastRun.get(p.head.ref))), reviewOf(repo, p).catch((): ReviewState => 'none')]);
    const stage: Stage = p.draft ? 'pr' : ci === 'failure' || ci === 'pending' ? 'ci' : review === 'approved' ? 'prete' : review === 'changes' || review === 'pending' ? 'revue' : ci === 'success' ? 'prete' : 'pr';
    return { branch: p.head.ref, stage, updated: p.updated_at, pr, ci, review };
  }));
  for (const b of branches) {
    if (seen.has(b.name)) continue;
    seen.add(b.name);
    const run = lastRun.get(b.name);
    items.push({ branch: b.name, stage: 'branche', updated: run?.created_at ?? '', ci: runState(run), review: 'none' });
  }
  const history = runs.workflow_runs.filter(r => r.head_branch === base && r.name !== 'Dependabot Updates').slice(0, 24).reverse()
    .map(r => { const st = runState(r); return { at: r.created_at, state: st === 'none' ? 'pending' as const : st, label: `${r.display_title || r.name} · ${new Date(r.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`, url: r.html_url ?? '' }; });
  const byWf = new Map<string, RawRun[]>();
  for (const r of runs.workflow_runs) { const l = byWf.get(r.name); if (l) l.push(r); else byWf.set(r.name, [r]); }
  const actions: Workflow[] = [...byWf].map(([name, list]) => {
    const r = list[0] as RawRun, from = Date.parse(r.run_started_at ?? r.created_at), to = Date.parse(r.updated_at ?? '');
    return {
      name,
      last: { id: r.id, state: runState(r), status: r.status, conclusion: r.conclusion, branch: r.head_branch, title: r.display_title || '', event: r.event ?? '', at: r.created_at, url: r.html_url ?? '', seconds: r.status === 'completed' && to >= from ? Math.round((to - from) / 1000) : null },
      runs: list.slice(0, 12).reverse().map(x => { const st = runState(x); return { at: x.created_at, state: st === 'none' ? 'pending' as const : st, label: `${x.display_title || x.name} · ${x.head_branch}`, url: x.html_url ?? '' }; }),
    };
  }).sort((a, b) => b.last.at.localeCompare(a.last.at));
  const flow: Flow = { repo, base, items, baseCi: runState(lastRun.get(base)), releases: rels.slice(-5).reverse().map(r => ({ tag: r.tag_name, url: r.html_url, at: r.published_at })), history, actions };
  flowCache.set(repo, { at: Date.now(), flow });
  return flow;
}
