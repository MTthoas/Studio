// Vue Modèles : des modèles ouverts installés et lancés par Studio, sur ce Mac ou sur un serveur d'un projet.
// Studio pilote Ollama par le pont natif (`models`, voir native/Shared/Models.swift) : rien ne part de la page vers
// le réseau, et sur un serveur tout passe par SSH (Ollama n'y écoute que sur 127.0.0.1, aucun port n'est ouvert).
// Un modèle installé devient le « Modèle local » de l'IA de Studio en un clic (`ai.setConfig`, `localVia`).
import * as native from '../core/native.ts';
import * as ai from '../integrations/ai.ts';
import * as projects from './projects/model.ts';
import * as infra from './projects/infra.ts';
import { CATALOG, KINDS, entryOf, type Entry, type Kind } from './modelcatalog.ts';
import { esc } from '../lib/markdown.ts';
import { fold } from '../lib/fuzzy.ts';
import { $, icon, modal, confirmBox, toast, paintIfChanged, menu, type MenuItem } from '../ui/kit.ts';
import type { AppShell } from '../types.ts';

let app!: AppShell;
export const init = (api: AppShell): void => { app = api; };
/** La vue n'existe que dans l'app Mac : c'est elle qui parle à Ollama et aux serveurs. */
export const available = (): boolean => document.documentElement.dataset.native === 'mac';

// ---------- Données ----------
interface Target { key: string; project: string; server: string; label: string; sub: string }
interface Installed { name: string; size: number; params: string; quant: string; family: string }
interface Loaded { name: string; size: number; vram: number }
interface Machine { os: string; cpu: string; cores: number; ram: number; gpu: string; vram: number; disk: number; apple: boolean }
interface Status { ok: boolean; message?: string; installed?: boolean; running?: boolean; version?: string; models?: Installed[]; loaded?: Loaded[]; machine?: Machine }
interface Job { id: string; project: string; server: string; kind: 'pull' | 'install'; model: string; status: string; total: number; done: number; state: 'run' | 'done' | 'error' | 'stopped'; error: string; log: string }

const KEY = 'studio.models.target';
const MAC: Target = { key: 'mac', project: '', server: '', label: 'Ce Mac', sub: '' };
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/;

const st = {
  target: localStorage.getItem(KEY) || 'mac',
  status: new Map<string, Status>(),
  loading: new Set<string>(),
  jobs: [] as Job[],
  /** Débit lissé de chaque téléchargement, calculé d'une relecture à l'autre. */
  speed: new Map<string, { at: number; done: number; rate: number }>(),
  kind: '' as Kind | '',
  q: '',
  /** Variante choisie à la main sur une fiche du catalogue. */
  pick: {} as Record<string, string>,
};
let root: HTMLElement | null = null;
let timer = 0, tick = 0;

function targets(): Target[] {
  const out = [MAC];
  for (const p of projects.projects()) for (const s of infra.knownServers(p.id)) out.push({ key: `${p.id}~${s.id}`, project: p.id, server: s.id, label: s.name || s.host, sub: p.name });
  return out;
}
const cur = (): Target => targets().find(t => t.key === st.target) ?? MAC;
const targetOf = (j: { project: string; server: string }): Target => targets().find(t => t.project === j.project && t.server === j.server) ?? (j.project ? { key: `${j.project}~${j.server}`, project: j.project, server: j.server, label: 'Serveur', sub: '' } : MAC);
const call = (action: string, t: Target, extra: Record<string, unknown> = {}, timeout = 30000) => native.call('models', action, { project: t.project, server: t.server, ...extra }, timeout);

// ---------- Formats ----------
const nf = (n: number, d = 1): string => n.toLocaleString('fr-FR', { maximumFractionDigits: d });
/** Taille de fichier, en unités décimales comme Ollama et le Finder. */
const size = (b: number): string => b >= 1e9 ? `${nf(b / 1e9, b >= 2e10 ? 0 : 1)} Go` : `${Math.max(1, Math.round(b / 1e6))} Mo`;
/** Mémoire, en unités binaires (un Mac « 36 Go » en annonce 36 × 2³⁰). */
const mem = (b: number): string => `${nf(b / 2 ** 30, 0)} Go`;
const pct = (j: Job): number => j.total > 0 ? Math.min(100, Math.floor(j.done / j.total * 100)) : 0;
function eta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '';
  return sec < 60 ? 'moins d’une minute' : sec < 3600 ? `encore ${Math.round(sec / 60)} min` : `encore ${nf(sec / 3600)} h`;
}
/** Statut brut d'Ollama pendant un téléchargement, en clair. */
function phase(j: Job): string {
  if (j.kind === 'install') return j.status || 'Installation d’Ollama';
  const s = j.status.toLowerCase();
  return s.startsWith('pulling manifest') ? 'Préparation' : s.startsWith('pulling') ? 'Téléchargement' : s.startsWith('verifying') ? 'Vérification' : s.startsWith('writing') ? 'Finalisation' : s === 'success' ? 'Terminé' : j.status || 'En attente';
}

// ---------- La machine fera-t-elle tourner ce modèle ? ----------
type Fit = 'ok' | 'tight' | 'slow' | 'no' | '';
const FIT: Record<Fit, string> = { ok: 'Tourne bien ici', tight: 'Juste en mémoire', slow: 'Sans carte graphique : lent', no: 'Trop lourd pour cette machine', '': '' };
/** Mémoire qu'il faut pour charger un modèle de `gb` Go : ses poids, plus le contexte. */
const needs = (gb: number): number => (gb * 1.15 + 1.5) * 1e9;
function fit(gb: number, m: Machine | undefined): Fit {
  if (!m?.ram) return '';
  const n = needs(gb);
  if (m.vram) return n <= m.vram ? 'ok' : n <= m.ram * 0.8 ? 'slow' : 'no';
  if (m.apple) return n <= m.ram * 0.6 ? 'ok' : n <= m.ram * 0.8 ? 'tight' : 'no';
  return n > m.ram * 0.8 ? 'no' : gb <= 3 ? 'ok' : 'slow';
}
/** Variante affichée d'une fiche : celle choisie à la main, sinon la plus grosse qui tourne bien sur la machine. */
function variantOf(e: Entry, m: Machine | undefined): string {
  const mine = st.pick[e.id]; if (mine && e.variants.some(v => v.tag === mine)) return mine;
  if (!m?.ram) return e.def;
  const by = (f: Fit[]) => [...e.variants].reverse().find(v => f.includes(fit(v.gb, m)));
  return (by(['ok']) ?? by(['tight', 'slow']) ?? e.variants[0]!).tag;
}

// ---------- Lectures ----------
async function load(t: Target = cur()): Promise<void> {
  if (st.loading.has(t.key)) return;
  st.loading.add(t.key);
  const r = await call('status', t, {}, 45000);
  st.loading.delete(t.key);
  st.status.set(t.key, r as unknown as Status);
  paint();
}

async function loadJobs(): Promise<void> {
  const r = await native.call('models', 'jobs', {}, 10000);
  if (!r.ok || !Array.isArray(r.jobs)) return;
  const before = st.jobs, now = Date.now();
  st.jobs = r.jobs as Job[];
  for (const j of st.jobs) {
    if (j.state === 'run') {
      const p = st.speed.get(j.id);
      if (!p) st.speed.set(j.id, { at: now, done: j.done, rate: 0 });
      else if (j.done > p.done && now > p.at) { const v = (j.done - p.done) / ((now - p.at) / 1000); st.speed.set(j.id, { at: now, done: j.done, rate: p.rate ? p.rate * 0.6 + v * 0.4 : v }); }
    } else if (before.find(x => x.id === j.id)?.state === 'run') finished(j);
  }
  for (const id of [...st.speed.keys()]) if (!st.jobs.some(j => j.id === id && j.state === 'run')) st.speed.delete(id);
  paint();
}

/** Une tâche vient de finir sous nos yeux : on le dit, et la cible est relue. */
function finished(j: Job): void {
  const t = targetOf(j);
  if (j.state === 'done') {
    void native.call('models', 'dismiss', { job: j.id }, 10000);
    st.jobs = st.jobs.filter(x => x.id !== j.id);
    if (j.kind === 'pull') toast(`${j.model} est installé sur ${t.label}`, { label: 'Utiliser', run: () => use(t, j.model) });
    else toast(`Ollama est installé sur ${t.label}`);
  }
  void load(t);
}

const jobFor = (t: Target, model: string): Job | undefined => st.jobs.find(j => j.kind === 'pull' && j.model === model && j.project === t.project && j.server === t.server && j.state === 'run');
const working = (): boolean => st.jobs.some(j => j.state === 'run');

// ---------- Rendu ----------
export function mount(main: HTMLElement): void {
  const head = `<header class="toolbar">${app.tbLeft()}${app.crumb('Modèles')}<div class="tb-side tb-right"></div></header>`;
  if (!available()) {
    main.innerHTML = `${head}<div class="ml-root"><div class="ml-page"><div class="ml-empty">${icon('cpu')}<b>Disponible dans l’app Studio pour Mac</b><p>C’est le Mac qui installe les modèles et parle aux serveurs.</p></div></div></div>`;
    return;
  }
  main.innerHTML = `${head}
  <div class="ml-root"><div class="ml-page">
    <div class="ml-head"><h1>Modèles</h1><p>Des modèles ouverts, installés et lancés par Studio avec Ollama. Sur ce Mac, rien ne quitte la machine ; sur un serveur, tout passe par SSH.</p></div>
    <div class="ml-targets" role="tablist" aria-label="Machine"></div>
    <div class="ml-machine"></div>
    <div class="ml-jobs"></div>
    <section class="ml-sec"><div class="ml-installed"></div></section>
    <section class="ml-sec">
      <div class="ml-sec-head"><h2>Catalogue</h2><div class="ml-kinds"></div><input class="field ml-q" type="search" placeholder="Chercher" aria-label="Chercher dans le catalogue" value="${esc(st.q)}"></div>
      <div class="ml-grid"></div>
      <form class="ml-any"><label for="ml-any">Un autre modèle</label><input class="field" id="ml-any" name="model" placeholder="Nom dans Ollama ou Hugging Face : llama3.2:1b, hf.co/auteur/modele" autocomplete="off" spellcheck="false"><button class="btn">${icon('download')}Installer</button></form>
    </section>
  </div></div>`;
  root = $<HTMLElement>('.ml-root', main);
  if (!root) return;
  root.addEventListener('click', e => void onClick(e));
  root.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.classList.contains('ml-q')) { st.q = t.value; paint(); } });
  root.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target as HTMLFormElement, input = f.elements.namedItem('model') as HTMLInputElement | null;
    if (!f.classList.contains('ml-any') || !input) return;
    const name = input.value.trim(); if (!name) return;
    void pull(cur(), name).then(ok => { if (ok) input.value = ''; });
  });
  paint();
  void load(); void loadJobs();
  // Les serveurs des projets : connus de la page s'ils ont déjà été lus, sinon relus une fois ici.
  void Promise.all(projects.projects().map(p => infra.list(p).catch(() => null))).then(() => paint());
  clearInterval(timer); tick = 0;
  timer = window.setInterval(() => {
    if (!root?.isConnected) { clearInterval(timer); root = null; return; }
    if (document.hidden) return;
    tick++;
    if (working() || tick % 4 === 0) void loadJobs();
    // Un serveur se relit par SSH : moins souvent que le Mac.
    if (tick % (cur().project ? 12 : 4) === 0) void load();
  }, 1500);
}

function paint(): void {
  if (!root?.isConnected) return;
  const t = cur(), s = st.status.get(t.key);
  const set = (sel: string, html: string) => { const n = $<HTMLElement>(sel, root!); if (n) paintIfChanged(n, html); };
  set('.ml-targets', targetsHTML(t));
  set('.ml-machine', machineHTML(t, s));
  set('.ml-jobs', st.jobs.map(jobHTML).join(''));
  set('.ml-installed', installedHTML(t, s));
  set('.ml-kinds', KINDS.map(([k, l]) => `<button class="ml-kind" data-ml="kind" data-kind="${k}" aria-pressed="${st.kind === k}">${l}</button>`).join(''));
  set('.ml-grid', gridHTML(t, s));
}

function targetsHTML(t: Target): string {
  const list = targets();
  const tabs = list.map(x => `<button class="ml-target" role="tab" data-ml="target" data-key="${esc(x.key)}" aria-selected="${x.key === t.key}">${icon(x.project ? 'server' : 'devices')}<span>${esc(x.label)}</span>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}${st.jobs.some(j => j.state === 'run' && j.project === x.project && j.server === x.server) ? '<i class="ml-dot"></i>' : ''}</button>`).join('');
  return tabs + (list.length === 1 ? `<span class="ml-targets-hint">Ajoute un serveur à un projet (onglet Serveur) pour y déployer des modèles.</span>` : '');
}

function machineHTML(t: Target, s: Status | undefined): string {
  const name = `<b>${esc(t.label)}</b>`;
  if (!s) return `<div class="ml-mach"><div class="ml-mach-id">${name}<span>${t.project ? 'Connexion au serveur…' : 'Lecture de la machine…'}</span></div><span class="spin"></span></div>`;
  if (!s.ok) return `<div class="ml-mach"><div class="ml-mach-id">${name}<span class="err">${esc(s.message || 'Machine injoignable.')}</span></div><button class="btn" data-ml="reload">${icon('refresh')}Réessayer</button></div>`;
  const m = s.machine, here = t.project ? 'sur ce serveur' : 'sur ce Mac';
  const specs = m ? [m.cpu, m.ram ? `${mem(m.ram)} de mémoire` : '', m.gpu && !m.apple ? `${m.gpu}${m.vram ? ` ${mem(m.vram)}` : ''}` : '', m.disk ? `${size(m.disk)} libres` : ''].filter(Boolean).map(esc).join('<i>·</i>') : '';
  const busy = st.jobs.some(j => j.kind === 'install' && j.state === 'run' && j.project === t.project && j.server === t.server);
  const state = !s.installed
    ? `<span class="ml-pill">Ollama absent</span><button class="btn btn-primary" data-ml="install"${busy ? ' disabled' : ''}>${icon('download')}Installer Ollama</button>`
    : !s.running ? `<span class="ml-pill">Ollama arrêté</span><button class="btn btn-primary" data-ml="start">${icon('play')}Démarrer</button>`
    : `<span class="ml-pill on"><i></i>Ollama ${esc(s.version || '')}</span>`;
  // Mémoire prise par les modèles chargés : ce qui reste dit si un autre modèle tiendra à côté.
  const used = (s.loaded ?? []).reduce((n, l) => n + l.size, 0), cap = m?.vram || m?.ram || 0;
  const gauge = used && cap ? `<div class="ml-gauge" title="Mémoire prise par les modèles chargés"><div class="ml-bar"><i style="width:${Math.min(100, Math.round(used / cap * 100))}%"></i></div><span>${size(used)} en mémoire sur ${mem(cap)} · ${(s.loaded ?? []).map(l => esc(l.name)).join(', ')}</span></div>` : '';
  const why = !s.installed ? `<p class="ml-mach-why">Studio s’appuie sur Ollama pour faire tourner les modèles ${here}. ${t.project ? 'L’installation lance le script officiel d’Ollama sur le serveur : il lui faut root, ou sudo sans mot de passe.' : `L’installation télécharge l’app officielle et vérifie sa signature. <button class="ml-link" data-ml="open">Ou passe par ollama.com</button>`}</p>` : '';
  return `<div class="ml-mach"><div class="ml-mach-id">${name}<span>${specs}</span></div><div class="ml-mach-state">${state}</div></div>${gauge}${why}`;
}

function jobHTML(j: Job): string {
  const t = targetOf(j), run = j.state === 'run', sp = st.speed.get(j.id)?.rate ?? 0, p = pct(j);
  const title = j.kind === 'install' ? 'Ollama' : j.model;
  const num = j.state === 'error' ? '' : j.state === 'stopped' ? 'Annulé' : j.total > 0 ? `${size(j.done)} sur ${size(j.total)}${run && sp > 0 ? ` · ${size(sp)}/s · ${eta((j.total - j.done) / sp)}` : ''}` : '';
  const act = run ? `<button class="btn btn-ghost" data-ml="cancel" data-job="${esc(j.id)}">Annuler</button>`
    : `${j.kind === 'pull' && j.state !== 'done' ? `<button class="btn btn-ghost" data-ml="retry" data-job="${esc(j.id)}">Réessayer</button>` : ''}<button class="btn btn-ghost" data-ml="dismiss" data-job="${esc(j.id)}" aria-label="Fermer">${icon('x')}</button>`;
  return `<div class="ml-job ${j.state}">
    <div class="ml-job-top"><b>${esc(title)}</b><span class="ml-job-where">${esc(t.label)} · ${esc(j.state === 'error' ? 'Échec' : j.state === 'done' ? 'Terminé' : phase(j))}</span><span class="ml-job-num">${esc(num)}</span>${run && j.total > 0 ? `<span class="ml-job-pct">${p} %</span>` : ''}${act}</div>
    ${run ? `<div class="ml-bar${j.total > 0 ? '' : ' wait'}"><i style="width:${j.total > 0 ? p : 100}%"></i></div>` : ''}
    ${j.state === 'error' ? `<p class="ml-job-err">${esc(j.error || 'La tâche a échoué.')}</p>` : ''}
    ${j.kind === 'install' && j.log && j.state !== 'done' ? `<pre class="ml-job-log">${esc(j.log)}</pre>` : ''}
  </div>`;
}

/** Le modèle local que l'IA de Studio utilise, s'il tourne sur cette cible par Studio. */
function inUse(t: Target): string {
  const c = ai.config();
  if (c.provider !== 'local' || !c.localVia) return '';
  return (c.localVia === 'mac' ? !t.project : c.localProject === t.project && c.localServer === t.server) ? c.localModel : '';
}

function installedHTML(t: Target, s: Status | undefined): string {
  const list = s?.ok ? s.models ?? [] : [];
  const head = `<div class="ml-sec-head"><h2>Installés</h2>${list.length ? `<span class="ml-count">${list.length} · ${size(list.reduce((n, m) => n + m.size, 0))}</span>` : ''}</div>`;
  if (!s?.ok || !s.running) return '';
  if (!list.length) return `${head}<div class="ml-none">Aucun modèle sur ${esc(t.label)}. Choisis-en un dans le catalogue : il sera prêt en quelques minutes.</div>`;
  const used = inUse(t), loaded = new Set((s.loaded ?? []).map(l => l.name));
  return head + `<div class="ml-rows">${list.map(m => {
    const e = entryOf(m.name), on = used === m.name;
    return `<div class="ml-row${on ? ' on' : ''}">
      <div class="ml-row-main"><div class="ml-row-name"><b>${esc(m.name)}</b>${on ? `<span class="ml-badge use">${icon('sparkle')}IA de Studio</span>` : ''}${loaded.has(m.name) ? '<span class="ml-badge live"><i></i>En mémoire</span>' : ''}</div>
      <span class="ml-row-sub">${[e ? `${e.name} · ${e.by}` : m.family, m.params, m.quant, size(m.size)].filter(Boolean).map(esc).join('<i>·</i>')}</span></div>
      <div class="ml-row-acts"><button class="btn btn-ghost" data-ml="try" data-model="${esc(m.name)}">Essayer</button>${on ? '' : `<button class="btn" data-ml="use" data-model="${esc(m.name)}">Utiliser</button>`}<button class="btn btn-ghost ml-more" data-ml="more" data-model="${esc(m.name)}" aria-label="Autres actions">${icon('more')}</button></div>
    </div>`;
  }).join('')}</div>`;
}

function gridHTML(t: Target, s: Status | undefined): string {
  const m = s?.ok ? s.machine : undefined, ready = !!(s?.ok && s.running), have = new Set(s?.ok ? (s.models ?? []).map(x => x.name) : []);
  const q = fold(st.q.trim());
  const list = CATALOG.filter(e => (!st.kind || e.kinds.includes(st.kind)) && (!q || fold(`${e.name} ${e.id} ${e.by} ${e.desc}`).includes(q)));
  if (!list.length) return `<div class="ml-none">Rien dans le catalogue pour « ${esc(st.q)} ». Le champ ci-dessous installe n’importe quel modèle par son nom.</div>`;
  return list.map(e => {
    const tag = variantOf(e, m), v = e.variants.find(x => x.tag === tag)!, ref = `${e.id}:${tag}`;
    const f = fit(v.gb, m), job = jobFor(t, ref), done = have.has(ref);
    const sizes = e.variants.map(x => `<button class="ml-size ${fit(x.gb, m)}" data-ml="pick" data-id="${e.id}" data-tag="${x.tag}" aria-pressed="${x.tag === tag}" title="${esc([`${nf(x.gb)} Go`, FIT[fit(x.gb, m)]].filter(Boolean).join(' · '))}">${esc(x.tag)}${have.has(`${e.id}:${x.tag}`) ? icon('check') : ''}</button>`).join('');
    const act = job ? `<div class="ml-card-prog"><div class="ml-bar${job.total > 0 ? '' : ' wait'}"><i style="width:${job.total > 0 ? pct(job) : 100}%"></i></div><span>${job.total > 0 ? `${pct(job)} %` : esc(phase(job))}</span></div>`
      : done ? `<span class="ml-have">${icon('check')}Installé</span>`
      : `<button class="btn${f === 'no' ? '' : ' btn-primary'}" data-ml="pull" data-model="${esc(ref)}"${ready ? '' : ' disabled'}>${icon('download')}Installer</button>`;
    return `<article class="ml-card">
      <header><b>${esc(e.name)}</b><span>${esc(e.by)}</span></header>
      <p>${esc(e.desc)}</p>
      <div class="ml-tags">${e.tools ? `<span class="ml-tag tools" title="Sait appeler les outils de Studio : notes, tâches, GitHub, Linear">${icon('plug')}Outils</span>` : ''}${e.kinds.map(k => `<span class="ml-tag">${KINDS.find(x => x[0] === k)?.[1] ?? k}</span>`).join('')}</div>
      <div class="ml-sizes">${sizes}</div>
      <footer><div class="ml-card-meta"><span>${nf(v.gb)} Go · ${nf(needs(v.gb) / 1e9, 0)} Go de mémoire</span>${f ? `<span class="ml-fit ${f}"><i></i>${FIT[f]}</span>` : ''}</div>${act}</footer>
    </article>`;
  }).join('');
}

// ---------- Actions ----------
async function pull(t: Target, model: string): Promise<boolean> {
  if (!MODEL_RE.test(model) || model.length > 120) { toast('Ce nom de modèle n’est pas valide'); return false; }
  const s = st.status.get(t.key), e = entryOf(model), v = e?.variants.find(x => `${e.id}:${x.tag}` === model);
  if (s?.ok && !s.running) { toast(s.installed ? `Démarre d’abord Ollama sur ${t.label}` : `Installe d’abord Ollama sur ${t.label}`); return false; }
  if (v && s?.machine?.disk && v.gb * 1e9 > s.machine.disk) { toast(`Pas assez de place sur ${t.label} : ${nf(v.gb)} Go à télécharger, ${size(s.machine.disk)} libres`); return false; }
  const r = await call('pull', t, { model });
  if (!r.ok) { toast(r.message || 'Le téléchargement n’a pas pu démarrer'); return false; }
  await loadJobs();
  return true;
}

function use(t: Target, model: string): void {
  const before = ai.config(), e = entryOf(model);
  ai.setConfig({ provider: 'local', localVia: t.project ? 'server' : 'mac', localProject: t.project, localServer: t.server, localModel: model });
  paint();
  toast(`L’IA de Studio utilise ${model} sur ${t.label}${e && !e.tools ? '. Ce modèle n’appelle pas d’outils : garde-le pour les demandes simples' : ''}`, { label: 'Annuler', run: () => { ai.setConfig(before); paint(); } });
}

async function remove(t: Target, model: string): Promise<void> {
  if (!await confirmBox({ title: `Supprimer ${model} ?`, text: `Le modèle sera effacé de ${t.label}. Tu pourras le réinstaller depuis le catalogue.`, ok: 'Supprimer', danger: true })) return;
  const r = await call('delete', t, { model });
  if (!r.ok) toast(r.message || 'Suppression impossible');
  else if (inUse(t) === model) toast(`${model} était le modèle de l’IA de Studio : choisis-en un autre`);
  await load(t);
}

function more(anchor: HTMLElement, t: Target, model: string): void {
  const s = st.status.get(t.key), loaded = (s?.loaded ?? []).some(l => l.name === model);
  const others = targets().filter(x => x.key !== t.key);
  const items: MenuItem[] = [
    ...others.map((x): MenuItem => ({ label: `Installer aussi sur ${x.label}`, icon: x.project ? 'server' : 'devices', hint: x.sub, run: () => { void pull(x, model).then(ok => { if (ok) toast(`${model} part sur ${x.label}`, { label: 'Voir', run: () => pick(x.key) }); }); } })),
    ...(others.length ? ['-' as const] : []),
    ...(loaded ? [{ label: 'Libérer la mémoire', icon: 'stop', run: () => { void call('unload', t, { model }).then(r => { if (!r.ok) toast(r.message || 'Impossible de décharger le modèle'); return load(t); }); } }] : []),
    { label: 'Copier le nom', icon: 'copy', run: () => { void navigator.clipboard.writeText(model); toast('Nom copié'); } },
    '-',
    { label: 'Supprimer', icon: 'trash', danger: true, run: () => void remove(t, model) },
  ];
  menu(anchor, items);
}

function pick(key: string): void {
  st.target = key; localStorage.setItem(KEY, key);
  paint(); void load();
}

async function onClick(e: Event): Promise<void> {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ml]'); if (!b) return;
  const act = b.dataset.ml, t = cur(), model = b.dataset.model ?? '';
  if (act === 'target') return pick(b.dataset.key ?? 'mac');
  if (act === 'kind') { st.kind = (b.dataset.kind ?? '') as Kind | ''; return paint(); }
  if (act === 'pick') { st.pick[b.dataset.id ?? ''] = b.dataset.tag ?? ''; return paint(); }
  if (act === 'reload') { st.status.delete(t.key); paint(); return load(t); }
  if (act === 'open') { void call('open', MAC); return; }
  if (act === 'pull') { (b as HTMLButtonElement).disabled = true; if (!await pull(t, model)) (b as HTMLButtonElement).disabled = false; return; }
  if (act === 'use') return use(t, model);
  if (act === 'try') return tryModel(t, model);
  if (act === 'more') return more(b, t, model);
  if (act === 'install') {
    if (t.project && !await confirmBox({ title: `Installer Ollama sur ${t.label} ?`, text: 'Studio lance le script officiel d’Ollama (ollama.com/install.sh) sur le serveur, par SSH. Il installe le service et n’écoute que sur le serveur lui-même : aucun port n’est ouvert vers l’extérieur.', ok: 'Installer' })) return;
    const r = await call('install', t);
    if (!r.ok) toast(r.message || 'L’installation n’a pas pu démarrer');
    return loadJobs();
  }
  if (act === 'start') {
    (b as HTMLButtonElement).disabled = true; b.innerHTML = '<span class="spin"></span>Démarrage…';
    const r = await call('start', t, {}, 60000);
    if (!r.ok) toast(r.message || 'Ollama n’a pas démarré');
    const box = root && $<HTMLElement>('.ml-machine', root); if (box) box.innerHTML = ''; // le bouton a été réécrit à la main : force le prochain rendu
    paint();
    return load(t);
  }
  const job = st.jobs.find(j => j.id === b.dataset.job);
  if (act === 'cancel' && job) { await native.call('models', 'cancel', { job: job.id }, 10000); return loadJobs(); }
  if (act === 'dismiss' && job) { await native.call('models', 'dismiss', { job: job.id }, 10000); return loadJobs(); }
  if (act === 'retry' && job) { await native.call('models', 'dismiss', { job: job.id }, 10000); await pull(targetOf(job), job.model); return loadJobs(); }
}

// ---------- Essayer un modèle ----------
interface ChatReply { choices?: { message?: { content?: string | null } }[]; usage?: { completion_tokens?: number } }

function tryModel(t: Target, model: string): void {
  const m = modal({ title: `Essayer ${model}`, cls: 'ml-try', html: `<div class="ml-try-out"><p class="ml-try-hint">Une conversation d’essai sur ${esc(t.label)}. Elle n’est pas gardée, et le modèle n’a accès à aucune note.</p></div>
    <form class="ml-try-form"><textarea class="field area" name="q" rows="2" placeholder="Écris un message" aria-label="Message"></textarea>
    <div class="ml-try-foot"><span class="ml-try-stat"></span><button class="btn btn-primary">Envoyer</button></div></form>` });
  const out = $<HTMLElement>('.ml-try-out', m.node), form = $<HTMLFormElement>('.ml-try-form', m.node), stat = $<HTMLElement>('.ml-try-stat', m.node);
  const field = form?.elements.namedItem('q') as HTMLTextAreaElement | null, send = form && $<HTMLButtonElement>('button', form);
  if (!out || !form || !field || !send || !stat) return;
  const messages: { role: string; content: string }[] = [];
  const add = (cls: string, text: string): HTMLElement => { const d = document.createElement('div'); d.className = `ml-msg ${cls}`; d.textContent = text; out.append(d); out.scrollTop = out.scrollHeight; return d; };
  field.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = field.value.trim(); if (!text || send.disabled) return;
    field.value = ''; send.disabled = true;
    messages.push({ role: 'user', content: text }); add('me', text);
    const wait = add('ai wait', ''); wait.innerHTML = '<span class="spin"></span>';
    stat.textContent = 'Le premier message charge le modèle en mémoire : il peut prendre un moment.';
    const start = Date.now();
    const r = await call('chat', t, { body: { model, messages } }, 620000);
    const sec = (Date.now() - start) / 1000, reply = r.reply as ChatReply | undefined, answer = reply?.choices?.[0]?.message?.content?.trim();
    wait.classList.remove('wait');
    if (!r.ok || !answer) { wait.classList.add('err'); wait.textContent = r.message || 'Le modèle n’a rien répondu.'; messages.pop(); stat.textContent = ''; }
    else {
      wait.textContent = answer; messages.push({ role: 'assistant', content: answer });
      const n = reply?.usage?.completion_tokens ?? 0;
      stat.textContent = [`${nf(sec)} s`, n ? `${n} tokens` : '', n && sec > 0 ? `${nf(n / sec)} tokens/s` : ''].filter(Boolean).join(' · ');
    }
    out.scrollTop = out.scrollHeight; send.disabled = false; field.focus();
    void load(t);
  });
  field.focus();
}
