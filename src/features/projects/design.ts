// Vue « Design » du Salon (28 nov. 2026, « un onglet dans mon système agentique pour consulter le web design ») : ce que
// l'équipe a produit de visible, sans quitter le fil. Préfixe `dz-`, styles dans css/salon.css.
//   - Captures : les captures d'écran citées par les agents du fil (chemins sous .git/studio-images, lues par `agent image`
//     comme les images jointes : attach.ts). La plus récente en grand, les autres en bande ; ← → passent de l'une à l'autre,
//     un clic sur la grande l'ouvre en plein écran (visionneuse d'attach.ts).
//   - Aperçu : le site du projet servi en local par le Mac (`project local`, voir site.ts et Sites.swift), dans un cadre aux
//     largeurs d'un ordinateur, d'une tablette ou d'un téléphone. Seule une adresse locale annoncée par le Mac est chargée
//     (`frame-src` de index.html : localhost et 127.0.0.1), dans un cadre isolé (`sandbox`).
// Le Salon repeint toutes les secondes ou presque : `paint` ne réécrit que ce qui change (le cadre de l'aperçu n'est jamais
// rechargé par un repeint ; la largeur se règle par un attribut, pas par le HTML).
import * as native from '../../core/native.ts';
import * as attach from './attach.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, paintIfChanged, rel } from '../../ui/kit.ts';
import { t as tr } from '../../ui/i18n.ts';
import type { Project } from './model.ts';

export interface Shot { path: string; at: number; who: string }
type Tab = 'shots' | 'live';
type Size = 'desk' | 'tablet' | 'phone';
interface Live { url: string; label: string; status: string }

let tab: Tab = 'shots', size: Size = 'desk', picked = '';
/** Site local par projet : dernière réponse du Mac, heure de la lecture, lecture en cours. */
const sites = new Map<string, { live: Live | null; at: number; busy: boolean }>();
const SIZES: [Size, string, string][] = [['desk', 'Ordinateur', 'devices'], ['tablet', 'Tablette', 'frame'], ['phone', 'Téléphone', 'phone']];
/** Seule une adresse locale annoncée par le Mac est chargée dans le cadre. */
const localURL = (u: unknown): string => (typeof u === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/$/.test(u) ? u : '');
/** Adresse épinglée depuis le tiroir de terminaux (un port vu dans la sortie) : prime sur le site annoncé par le Mac. */
const pinned = new Map<string, Live>();
/** Montre `url` (http://localhost:N, 127.0.0.1 ou 0.0.0.0, ramené à localhost) dans l'onglet « Aperçu du site » du projet. */
export function preview(pid: string, url: string): boolean {
  const m = /^(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/.exec(url), u = m ? localURL(`${m[1]}://localhost:${m[2]}/`) : '';
  if (!u) return false;
  pinned.set(pid, { url: u, label: 'Terminal', status: 'running' }); tab = 'live';
  return true;
}

/** Relit l'état du site local (au plus toutes les 6 s, une lecture à la fois), puis demande un repeint si quelque chose a changé. */
function readSite(p: Project, again: () => void): void {
  const s = sites.get(p.id) ?? { live: null, at: 0, busy: false };
  sites.set(p.id, s);
  if (!native.available() || s.busy || Date.now() - s.at < 6000) return;
  s.busy = true;
  void native.call('project', 'local', { project: p.id }, 30000).then(r => {
    const l = (r as { live?: { url?: string; label?: string; status?: string } }).live, before = JSON.stringify(s.live);
    s.live = l ? { url: localURL(l.url), label: String(l.label ?? ''), status: String(l.status ?? '') } : null;
    if (JSON.stringify(s.live) !== before) again();
  }).catch(() => undefined).finally(() => { s.at = Date.now(); s.busy = false; });
}

const seg = (items: [string, string][], cur: string, attr: string): string => `<span class="sl-seg" role="group">${items.map(([v, l]) => `<button type="button" data-dz="${attr}" data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join('')}</span>`;
const emptyHTML = (ic: string, title: string, text: string, action = ''): string => `<div class="dz-empty">${icon(ic)}<h3>${title}</h3><p>${text}</p>${action}</div>`;

function shotsHTML(shots: Shot[]): string {
  if (!shots.length) return emptyHTML('image', 'Aucune capture dans ce fil', 'Quand un agent montre son travail, ses captures d’écran arrivent ici, la plus récente en grand.',
    `<button type="button" class="btn" data-dz="ask">${icon('camera')}Demander une capture</button>`);
  const cur = shots.find(s => s.path === picked) ?? shots[0] as Shot, i = shots.indexOf(cur);
  const strip = shots.length > 1 ? `<div class="dz-strip" role="listbox" aria-label="Captures du fil">${shots.map(s => `<button type="button" class="dz-thumb${s === cur ? ' on' : ''}" role="option" aria-selected="${s === cur}" data-dz="pick" data-path="${esc(s.path)}" data-at-path="${esc(s.path)}" title="${esc(s.who)}"><span class="at-ph" aria-hidden="true"></span></button>`).join('')}</div>` : '';
  return `<div class="dz-stage"><button type="button" class="dz-big" data-at-path="${esc(cur.path)}" title="Agrandir" aria-label="Agrandir la capture"><span class="at-ph" aria-hidden="true"></span></button></div>
    <footer class="dz-foot"><span class="dz-cap"><b>${esc(cur.who)}</b><time>${esc(rel(cur.at))}</time></span>${shots.length > 1 ? `<span class="dz-nav"><button type="button" class="icon-btn" data-dz="prev" title="Capture précédente (←)" aria-label="Capture précédente"${i >= shots.length - 1 ? ' disabled' : ''}>${icon('chevronRight')}</button><span>${shots.length - i} / ${shots.length}</span><button type="button" class="icon-btn" data-dz="next" title="Capture suivante (→)" aria-label="Capture suivante"${i <= 0 ? ' disabled' : ''}>${icon('chevronRight')}</button></span>` : ''}</footer>${strip}`;
}

function liveHTML(p: Project): string {
  if (!native.available()) return emptyHTML('devices', 'L’aperçu se lance depuis l’app Mac', 'Ouvre ce projet dans Studio pour Mac : il y sert le site du dossier en local, et l’affiche ici.');
  const s = sites.get(p.id), l = pinned.get(p.id) ?? s?.live;
  if (!s?.at && !l) return '<div class="dz-empty"><span class="spin"></span><p>Recherche du site local…</p></div>';
  if (!l?.url || l.status !== 'running') return emptyHTML('play', l ? 'Le site démarre…' : 'Le site n’est pas lancé',
    l ? 'L’aperçu s’affiche dès que le serveur local répond.' : 'Lance le site du projet sur ce Mac : il s’affiche ici, à la largeur de ton choix.',
    l ? '' : `<button type="button" class="btn" data-pj-tab="site">${icon('play')}Lancer le site</button>`);
  return `<div class="dz-stage dz-live"><div class="dz-device"><iframe class="dz-frame" src="${esc(l.url)}" title="Aperçu du site" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe></div></div>
    <footer class="dz-foot"><span class="dz-cap"><b>${esc(l.label || 'Site local')}</b><code>${esc(l.url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</code></span><span class="dz-nav"><button type="button" class="icon-btn" data-dz="reload" title="Recharger l’aperçu" aria-label="Recharger l’aperçu">${icon('refresh')}</button><a class="icon-btn" href="${esc(l.url)}" target="_blank" rel="noopener" title="Ouvrir dans le navigateur" aria-label="Ouvrir dans le navigateur">${icon('share')}</a></span></footer>`;
}

/** Dessine la vue dans `box` (rien n'est réécrit si rien n'a changé). `again` : redemander un rendu (état du site lu). */
export function paint(box: HTMLElement, p: Project, shots: Shot[], again: () => void = () => undefined): void {
  if (picked && !shots.some(s => s.path === picked)) picked = '';
  if (tab === 'live') readSite(p, again);
  const head = `<header class="dz-bar">${seg([['shots', `Captures${shots.length ? `<span>${shots.length}</span>` : ''}`], ['live', 'Aperçu du site']], tab, 'tab')}${tab === 'live' ? `<span class="sl-seg dz-sizes" role="group" aria-label="Largeur de l’aperçu">${SIZES.map(([v, l, ic]) => `<button type="button" data-dz="size" data-v="${v}" aria-pressed="${v === size}" title="${l}" aria-label="${l}">${icon(ic)}</button>`).join('')}</span>` : ''}</header>`;
  box.dataset.size = size;
  if (paintIfChanged(box, head + (tab === 'shots' ? shotsHTML(shots) : liveHTML(p)))) box.querySelector('.dz-thumb.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  attach.hydrate(box, p.id);
}

/** Clic dans la vue. Rend vrai si le geste est pris (le Salon repeint alors) ; `ask` écrit une demande dans le champ. */
export function click(e: Event, box: HTMLElement, shots: Shot[], ask: (text: string) => void): boolean {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dz]'); if (!b) return false;
  const act = b.dataset.dz, i = Math.max(0, shots.findIndex(s => s.path === picked));
  // Une vignette de la bande choisit la capture : la visionneuse d'attach.ts (même clic) ne doit pas s'ouvrir.
  if (act === 'pick') { e.stopImmediatePropagation(); picked = b.dataset.path ?? ''; }
  else if (act === 'tab') tab = b.dataset.v === 'live' ? 'live' : 'shots';
  else if (act === 'prev') picked = shots[Math.min(shots.length - 1, i + 1)]?.path ?? picked;
  else if (act === 'next') picked = shots[Math.max(0, i - 1)]?.path ?? picked;
  else if (act === 'ask') ask(tr('Montre-moi une capture d’écran de ce que tu as changé.'));
  else if (act === 'size') {
    // La largeur change par attribut : le cadre garde sa page (un repeint le rechargerait).
    size = (b.dataset.v as Size | undefined) ?? 'desk'; box.dataset.size = size;
    box.querySelectorAll<HTMLElement>('[data-dz="size"]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.v === size)));
    return false;
  }
  else if (act === 'reload') { const f = box.querySelector<HTMLIFrameElement>('.dz-frame'); if (f) f.src = f.src; return false; }
  return true;
}

/** ← → dans la vue Captures. Rend vrai si la touche est prise. */
export function key(e: KeyboardEvent, shots: Shot[]): boolean {
  if (tab !== 'shots' || shots.length < 2 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return false;
  const i = Math.max(0, shots.findIndex(s => s.path === picked));
  picked = shots[e.key === 'ArrowLeft' ? Math.min(shots.length - 1, i + 1) : Math.max(0, i - 1)]?.path ?? picked;
  return true;
}
