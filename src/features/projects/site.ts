// Onglet Site d'un projet, partie locale : Studio cherche un site dans le dossier du projet (app Mac), le lance
// sur ce Mac et le suit — adresse, pages vues, requêtes, journal du serveur de développement. Il y lance aussi les
// scripts « build » du projet et leurs variantes (build:prod…), dont la fin est notifiée par le Mac. Voir Sites.swift :
// la page ne fournit ni chemin ni commande, seulement l'emplacement relatif d'un site que le Mac vient de détecter.
import * as native from '../../core/native.ts';
import { esc } from '../../lib/markdown.ts';
import { $, icon, target, toast } from '../../ui/kit.ts';
import type { Project } from './model.ts';

type Found = { rel: string; kind: string; label: string; command: string };
type Live = { rel: string; kind: string; label: string; status: string; url: string; port: number; since: number; requests: number; pages: number; bytes: number; log: string };
type Maker = { rel: string; scripts: { name: string; command: string }[] };
type Build = { rel: string; script: string; command: string; status: 'building' | 'done' | 'failed' | 'stopped'; code: number; since: number; ended?: number; log: string };
type State = { ok: boolean; message?: string; folder?: boolean; sites?: Found[]; live?: Live; builds?: Maker[]; build?: Build };

const place = (rel: string): string => (rel ? `${rel}/` : 'racine du dossier');
const dec = (n: number): string => n.toFixed(1).replace('.', ',');
const size = (n: number): string => (n < 1024 ? `${n} o` : n < 1048576 ? `${dec(n / 1024)} Ko` : `${dec(n / 1048576)} Mo`);
function since(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? 'à l’instant' : m < 60 ? `depuis ${m} min` : `depuis ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
/** Seule une adresse locale annoncée par le Mac devient un lien. */
const localURL = (u: string): string => (/^https?:\/\/localhost:\d{2,5}\/$/.test(u) ? u : '');

const empty = (title: string, text: string): string => `<div class="st-empty">${icon('link')}<div><strong>${title}</strong><p>${text}</p></div></div>`;

function liveHTML(l: Live): string {
  const url = localURL(l.url), up = l.status === 'running' && !!url, failed = l.status === 'error';
  const state = failed ? '<span class="err">Arrêté sur une erreur</span>' : up ? `En ligne ${esc(since(l.since))}` : 'Démarrage…';
  const what = `${esc(l.label)} · ${esc(place(l.rel))}`;
  const head = `<div class="sv-head"><span class="pj-site-dot ${failed ? 'down' : up ? 'up' : ''}"></span>
    <div><strong>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>` : 'En attente de l’adresse…'}</strong><code>${what}</code></div>
    <span class="sv-state">${state}</span>
    <div class="sv-act">${url && !failed ? `<a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener">${icon('link')}Ouvrir</a>` : ''}${failed ? `<button class="btn btn-primary" data-st="start" data-rel="${esc(l.rel)}">${icon('refresh')}Relancer</button>` : ''}<button class="btn" data-st="stop">${icon('stop')}${failed ? 'Fermer' : 'Arrêter'}</button></div></div>`;
  if (l.kind === 'static') {
    return `${head}<div class="sv-grid">
      <div class="sv-tile"><span>Pages vues</span><strong>${l.pages}</strong><em>depuis le lancement, sur ce Mac</em></div>
      <div class="sv-tile"><span>Requêtes</span><strong>${l.requests}</strong><em>pages, styles, scripts, images</em></div>
      <div class="sv-tile"><span>Données servies</span><strong>${esc(size(l.bytes))}</strong><em>servi par Studio, sans cache</em></div></div>
      <p class="modal-hint">Le site n’est visible que depuis ce Mac (<code>127.0.0.1</code>). Recharge la page du navigateur après une modification.</p>`;
  }
  return `${head}<pre class="st-log" aria-label="Sortie du serveur de développement">${esc(l.log.trim() || 'En attente de la sortie du serveur…')}</pre>`;
}

function foundHTML(list: Found[]): string {
  return `<div class="st-list">${list.map(s => `<div class="st-row">${icon(s.kind === 'dev' ? 'terminal' : 'folder')}
    <div><strong>${esc(s.label)}</strong><code>${esc(place(s.rel))}</code><em>${s.kind === 'dev' ? `Lance <code>${esc(s.command)}</code> dans ce dossier : le code du projet s’exécute sur ce Mac` : 'Servi par Studio, visible depuis ce Mac uniquement'}</em></div>
    <button class="btn btn-primary" data-st="start" data-rel="${esc(s.rel)}">${icon('play')}Lancer</button></div>`).join('')}</div>`;
}

/** Durée écoulée, à la seconde près (un build dure rarement plus de quelques minutes). */
function took(from: number, to = Date.now()): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

/** Variante choisie dans chaque liste déroulante, par emplacement : le rafraîchissement redessine la section. */
const chosen = new Map<string, string>();

function makersHTML(list: Maker[]): string {
  return `<div class="st-list">${list.map(m => {
    const pick = m.scripts.find(s => s.name === chosen.get(m.rel)) ?? m.scripts[0];
    const variants = m.scripts.length > 1
      ? `<select class="field st-variant" data-st-variant data-rel="${esc(m.rel)}" aria-label="Variante de build">${m.scripts.map(s => `<option value="${esc(s.name)}"${s === pick ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
      : '';
    return `<div class="st-row">${icon('bolt')}
    <div><strong>${m.scripts.length > 1 ? `Build · ${m.scripts.length} variantes` : 'Build'}</strong><code>${esc(place(m.rel))}</code><em>Lance <code data-st-cmd>${esc(pick.command)}</code> sur ce Mac ; une notification t’avertit quand il se termine</em></div>
    ${variants}<button class="btn" data-st="build" data-rel="${esc(m.rel)}" data-script="${esc(pick.name)}">${icon('play')}Construire</button></div>`;
  }).join('')}</div>`;
}

function buildHTML(b: Build): string {
  const running = b.status === 'building', ok = b.status === 'done';
  const title = running ? 'Build en cours…' : ok ? 'Build terminé' : `Build en échec${b.code ? ` (code ${b.code})` : ''}`;
  const state = running ? `depuis ${took(b.since)}` : ok ? `réussi en ${took(b.since, b.ended)}` : `<span class="err">arrêté après ${took(b.since, b.ended)}</span>`;
  const again = `<button class="btn${ok ? '' : ' btn-primary'}" data-st="build" data-rel="${esc(b.rel)}" data-script="${esc(b.script)}">${icon('refresh')}Relancer</button>`;
  return `<div class="sv-head"><span class="pj-site-dot ${ok ? 'up' : running ? '' : 'down'}"></span>
    <div><strong>${title}</strong><code>${esc(b.command)} · ${esc(place(b.rel))}</code></div>
    <span class="sv-state">${state}</span>
    <div class="sv-act">${running ? '' : again}<button class="btn" data-st="build-stop">${icon(running ? 'stop' : 'check')}${running ? 'Arrêter' : 'Fermer'}</button></div></div>
    <pre class="st-log" aria-label="Sortie du build">${esc(b.log.trim() || 'En attente de la sortie du build…')}</pre>`;
}

/** Partie build : le build en cours ou terminé, sinon les dossiers qui savent se construire. */
function buildsHTML(st: State): string {
  if (st.build) return buildHTML(st.build);
  return st.builds?.length ? makersHTML(st.builds) : '';
}

function stateHTML(st: State): string {
  if (!st.ok) return empty('Lecture impossible', esc(st.message ?? 'Le dossier du projet n’a pas pu être lu.'));
  if (!st.folder) return empty('Choisis d’abord le dossier du projet', 'Studio y cherchera un site à lancer. Le dossier se choisit dans l’onglet Code.');
  return siteHTML(st) + buildsHTML(st);
}

function siteHTML(st: State): string {
  if (st.live) return liveHTML(st.live);
  if (!st.sites?.length) return st.builds?.length || st.build ? '' : empty('Aucun site trouvé dans le dossier', 'Studio reconnaît un dossier contenant un <code>index.html</code> (<code>site/</code>, <code>web/</code>, <code>docs/</code>, <code>dist/</code>…) et les projets Next.js, Astro, Vite, Nuxt ou SvelteKit qui ont un script <code>dev</code>.');
  return foundHTML(st.sites);
}

/** Contenu de la section avant la première réponse du Mac. */
export const localHTML = (): string => `<div class="st-local" data-st-local>${native.available() ? '<div class="pj-skel"></div>' : empty('Le site se lance depuis l’app Mac', 'Ouvre ce projet dans Studio pour Mac : il y détecte le site du dossier et le sert en local.')}</div>`;

/** Ce que l'onglet suivra quand le site tournera sur le serveur du projet. */
export const soonHTML = (): string => `<div class="sv-grid st-soon">
    <div class="sv-tile"><span>Monitoring</span><strong>—</strong><em>disponibilité, temps de réponse, certificat</em></div>
    <div class="sv-tile"><span>Consommation</span><strong>—</strong><em>processeur, mémoire et bande passante du site</em></div>
    <div class="sv-tile"><span>Visiteurs</span><strong>—</strong><em>pages vues lues dans les journaux du serveur, sans traceur</em></div></div>
  <p class="modal-hint">À venir : quand le site tournera sur le serveur du projet, Studio le suivra d’ici, par la même connexion SSH. <button class="link-btn" data-pj-tab="server">Voir l’onglet Serveur</button></p>`;

let timer = 0;
/** Branche la section locale : lecture de l'état, boutons, et rafraîchissement tant qu'un site tourne. */
export function mount(root: HTMLElement, p: Project): void {
  window.clearInterval(timer);
  const box = $('[data-st-local]', root);
  if (!box || !native.available()) return;
  let shown = '', busy = false;
  const paint = (st: State): void => {
    const html = stateHTML(st);
    box.dataset.live = (st.live && st.live.status !== 'error') || st.build?.status === 'building' ? '1' : '';
    if (html !== shown) { shown = html; box.innerHTML = html; }
  };
  const ask = async (extra: Record<string, unknown> = {}): Promise<State> => (await native.call('project', 'local', { project: p.id, ...extra }, 30000)) as State;
  const load = async (): Promise<void> => { const st = await ask(); if (box.isConnected && !busy) paint(st); };
  box.addEventListener('click', async e => {
    const b = target(e).closest<HTMLButtonElement>('[data-st]');
    if (!b || busy) return;
    busy = true; b.disabled = true;
    try {
      let st: State;
      const op = b.dataset.st;
      if (op === 'start') st = await ask({ op: 'start', rel: b.dataset.rel ?? '' });
      else if (op === 'build') st = await ask({ op: 'build', rel: b.dataset.rel ?? '', script: b.dataset.script ?? '', name: p.name });
      else { await ask({ op: op === 'build-stop' ? 'build-stop' : 'stop' }); st = await ask(); }
      if (!st.ok) { toast(st.message ?? (op === 'build' ? 'Impossible de lancer le build.' : 'Impossible de lancer le site.')); b.disabled = false; return; }
      if (box.isConnected) paint(st);
    } finally { busy = false; }
  });
  // Choix d'une variante : le bouton et la commande affichée suivent, et le choix survit aux rafraîchissements.
  box.addEventListener('change', e => {
    const sel = target(e).closest<HTMLSelectElement>('[data-st-variant]');
    const row = sel?.closest('.st-row');
    if (!sel || !row) return;
    chosen.set(sel.dataset.rel ?? '', sel.value);
    const go = row.querySelector<HTMLButtonElement>('[data-st="build"]'), cmd = row.querySelector('[data-st-cmd]');
    if (go) go.dataset.script = sel.value;
    if (cmd) cmd.textContent = (cmd.textContent ?? '').replace(/\S+$/, sel.value);
  });
  void load();
  timer = window.setInterval(() => {
    if (!box.isConnected) { window.clearInterval(timer); return; }
    if (box.dataset.live) void load();
  }, 2500);
}
