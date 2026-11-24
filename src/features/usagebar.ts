// Jauge d'usage de l'IA au pied de la barre latérale : une ligne par source utile (deux au plus), le détail au clic.
// Le bloc `#usage-side` se repaint seul quand les données changent ; app.ts ne fait que l'insérer et relayer les clics.
import * as quota from '../integrations/quota.ts';
import * as usage from '../integrations/usage.ts';
import { esc } from '../lib/markdown.ts';
import type { Meter, Source } from '../integrations/quota.ts';

const ID = 'usage-side';
let open = false;
let started = false;

const level = (p: number | null): string => p === null ? '' : p >= 100 ? ' ub-red' : p >= 80 ? ' ub-amber' : '';

/** « reste 1 h 36 » dans la journée, sinon « jeudi 09:00 ». */
function when(ms?: number): string {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return '';
  const m = Math.ceil(d / 60000);
  if (d < 864e5) return m < 60 ? `reste ${m} min` : `reste ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  return new Date(ms).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
}
const ago = (t: number): string => {
  if (!t) return 'pas encore lu';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 10 ? 'à l’instant' : s < 60 ? `il y a ${s} s` : s < 3600 ? `il y a ${Math.round(s / 60)} min` : `il y a ${Math.round(s / 3600)} h`;
};

const bar = (p: number | null): string => p === null ? '' : `<span class="ub-bar${level(p)}"><i style="width:${p}%"></i></span>`;
/** Compteur le plus parlant d'une source : la fenêtre de 5 h, sinon le premier. */
const best = (s: Source): Meter | undefined => s.meters.find(m => m.key === 'five_hour') ?? s.meters.find(m => m.pct !== null) ?? s.meters[0];
/** Modèle d'une limite par modèle (`seven_day_opus` → « Opus »), sinon null. */
const model = (key: string): string | null => {
  const k = /^seven_day_(opus|sonnet|fable|haiku)$/.exec(key)?.[1];
  return k ? k[0].toUpperCase() + k.slice(1) : null;
};
const right = (m: Meter): string => {
  if (m.pct === null) return esc(m.value ?? '');
  const w = m.pct >= 100 ? (m.resetsAt && m.resetsAt > Date.now() ? `épuisée · ${new Date(m.resetsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : 'épuisée') : `${m.pct} %${when(m.resetsAt) ? ` · ${when(m.resetsAt)}` : ''}`;
  return esc(w);
};

/** Sources à montrer : celle du fournisseur actif d'abord, puis les autres, deux au plus. */
const ordered = (): Source[] => [...quota.sources()].sort((a, b) => Number(b.active) - Number(a.active));

/** Nom court du fournisseur, en tête de sa carte : on doit voir d'où vient le chiffre. */
const provider = (s: Source): string => s.kind === 'subscription' ? 'Claude' : s.kind === 'local' ? 'Local' : s.id === 'openai' ? 'OpenAI' : 'Claude API';
/** « repart dans 4 h 48 », « repart jeudi 09:00 », ou rien. */
function resets(ms?: number): string {
  if (!ms || ms <= Date.now()) return '';
  const d = ms - Date.now(), m = Math.ceil(d / 60000);
  if (d < 864e5) return `repart dans ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`}`;
  return `repart ${new Date(ms).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}`;
}
/** Valeur en tête de carte : « 12 % », « épuisée » ou la valeur brute (tokens, modèle). */
const head = (m: Meter): string => m.pct === null ? esc(m.value ?? '') : m.pct >= 100 ? 'épuisée' : `${m.pct} %`;

/** Une carte par source (deux au plus) : nom du fournisseur et valeur du compteur principal, sa jauge, puis en petit
 *  ce qu'il mesure et quand il repart ; pour l'abonnement, une ligne compacte par modèle entamé (Opus, Sonnet, Fable). */
function lines(): string {
  return ordered().slice(0, 2).map(s => {
    const main = best(s);
    if (!main) return '';
    const p = main.pct;
    const sub = [esc(main.label), esc(resets(main.resetsAt))].filter(Boolean);
    const mods = s.kind === 'subscription' ? s.meters.filter(m => m !== main && m.pct !== null && model(m.key)).slice(0, 3) : [];
    const hint = s.note === 'limits-off' ? `<button class="ub-link" data-ub="limits">Afficher mes limites</button>` : '';
    return `<div class="ub-row"><div class="ub-l"><b>${esc(provider(s))}</b><span class="ub-v ${level(p).trim()}">${head(main)}</span></div>${bar(p)}`
      + `<div class="ub-sub"><span>${sub[0] ?? ''}</span>${sub[1] ? `<span>${sub[1]}</span>` : ''}</div>`
      + mods.map(m => `<div class="ub-mod"><span>${esc(model(m.key) ?? m.label)}</span>${bar(m.pct)}<span class="${level(m.pct).trim()}">${head(m)}</span></div>`).join('')
      + `${hint}</div>`;
  }).join('');
}

function detail(): string {
  const body = ordered().map(s => `<div class="ub-src"><div class="ub-name"><b>${esc(s.name)}</b>${s.active ? '<em>actif</em>' : ''}</div>`
    + s.meters.map(m => `<div class="ub-m"><div class="ub-l"><span>${esc(m.label)}</span><span class="${level(m.pct).trim()}">${m.pct === null ? esc(m.value ?? '') : `${right(m)}${m.value ? ` · ${esc(m.value)}` : ''}`}</span></div>${bar(m.pct)}</div>`).join('')
    + (s.note === 'limits-off' ? `<button class="ub-link" data-ub="limits">Afficher mes limites</button>` : s.note ? `<small>${esc(s.note)}</small>` : '') + '</div>').join('');
  return `<div class="ub-pop" role="dialog" aria-label="Usage de l’IA">${body}<div class="ub-foot"><small>Mis à jour ${esc(ago(quota.updatedAt()))}</small><span class="ub-sp"></span><button class="ub-link" data-ub="refresh">Actualiser</button><button class="ub-link" data-open-conn="ia">Réglages IA</button></div></div>`;
}

function inner(): string {
  if (!quota.sources().length) return '';
  return `<button class="ub-box" data-ub="toggle" aria-expanded="${open}" title="Usage de l’IA">${lines()}</button>`;
}

// Le popover vit dans document.body : un rendu de la barre latérale (qui réinsère html()) ne le touche pas.
export const html = (): string => `<div id="${ID}">${inner()}</div>`;

let last = '', lastPop = '', pop: HTMLElement | null = null;
const inPop = (t: Element | null): boolean => !!t?.closest?.(`#${ID}, .ub-pop`);

function paint(): void {
  if (open && !quota.sources().length) open = false;
  const el = document.getElementById(ID);
  if (el) {
    const h = inner();
    if (h !== last || !el.firstElementChild) { last = h; el.innerHTML = h; }
  } else last = '';
  const box = el?.querySelector<HTMLElement>('.ub-box');
  if (!open || !box) { pop?.remove(); pop = null; lastPop = ''; return; }
  const d = detail();
  if (!pop) { pop = document.createElement('div'); document.body.appendChild(pop); lastPop = ''; }
  if (d !== lastPop) { lastPop = d; pop.outerHTML = d; pop = document.body.querySelector<HTMLElement>('.ub-pop'); } // le défilement ne bouge que si le contenu change
  if (!pop) return;
  const r = box.getBoundingClientRect(); // ancré au-dessus du bloc
  pop.style.left = `${Math.round(r.left)}px`; pop.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`; pop.style.width = `${Math.max(260, Math.round(r.width))}px`;
}
const close = (): void => { if (open) { open = false; paint(); } };

export function init(): void {
  if (started) return; started = true;
  quota.onChange(paint);
  usage.onChange(paint);
  setInterval(() => { if (document.visibilityState === 'visible') void quota.refresh(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void quota.refresh(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('mousedown', e => { if (open && !inPop(e.target as Element | null)) close(); });
  addEventListener('resize', () => { if (open) paint(); });
  void quota.refresh();
}

/** Rend true si le clic concernait la jauge (l'appelant n'a alors rien d'autre à faire). */
export function click(el: HTMLElement): boolean {
  const a = el.closest<HTMLElement>('[data-ub]')?.dataset.ub;
  if (a === 'toggle') { open = !open; paint(); if (open) void quota.refresh(); return true; }
  if (a === 'refresh') { void quota.refresh(true); return true; }
  if (a === 'limits') { void quota.limits('enable'); return true; }
  if (el.closest('.ub-pop [data-open-conn]')) { close(); return false; } // laisse l'écoute déléguée ouvrir les réglages
  return inPop(el);
}
