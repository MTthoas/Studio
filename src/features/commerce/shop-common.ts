// Boutique Shopify : outils communs aux sections (chiffres, commandes, produits, clients, réductions, boutiques).
// Rien ne parle à Shopify ici : tout passe par src/integrations/shopify/api.ts.
import { esc } from '../../lib/markdown.ts';
import { el, icon, toast, errMsg, confirmBox, target } from '../../ui/kit.ts';
import * as vault from '../../core/vault.ts';
import * as api from '../../integrations/shopify/api.ts';
import type { ShopCreds } from '../../integrations/shopify/api.ts';
import type { AppShell, Note } from '../../types.ts';
import type { Project } from '../projects/model.ts';

let app: AppShell | null = null;
export const setApp = (shell: AppShell): void => { app = shell; };
/** Ouvre l'onglet Boutique d'un projet. */
export const openProject = (id: string): void => { if (app) void app.setView({ type: 'projets', project: id, tab: 'boutique' }); };
export const openNote = (id: string): void => { if (app) app.openNote(id); else toast('Impossible d’ouvrir la note pour l’instant.'); };

/** Ce que partagent une section et ses fenêtres : le projet, sa boutique, la racine, et de quoi relire la liste. */
export interface Ctx { p: Project; shop: ShopCreds; root: HTMLElement; reload(): void }

export const money = api.money;
export const int = (n: number): string => Math.round(n).toLocaleString('fr-FR');
export const dec = (n: number, d = 1): string => n.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
export const pct = (fraction: number): string => `${(fraction * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
/** Symbole d'une devise (« € », « $ ») pour les graphiques. */
export function symbol(currency: string): string {
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).formatToParts(0).find(x => x.type === 'currency')?.value ?? currency; }
  catch { return currency; }
}
export const day = (ms: number): string => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

// ---------- Libellés français des valeurs brutes de Shopify ----------
export type Tone = '' | 'ok' | 'warn' | 'down';
export const PAID: Record<string, [string, Tone]> = {
  PAID: ['Payée', 'ok'], PENDING: ['Paiement en attente', 'warn'], AUTHORIZED: ['Paiement autorisé', 'warn'], PARTIALLY_PAID: ['Payée en partie', 'warn'],
  PARTIALLY_REFUNDED: ['Remboursée en partie', ''], REFUNDED: ['Remboursée', ''], VOIDED: ['Annulée', ''], EXPIRED: ['Expirée', ''],
};
export const FULFIL: Record<string, [string, Tone]> = {
  UNFULFILLED: ['À expédier', 'warn'], OPEN: ['À expédier', 'warn'], PENDING_FULFILLMENT: ['Expédition en attente', 'warn'], PARTIALLY_FULFILLED: ['Expédiée en partie', 'warn'],
  IN_PROGRESS: ['En préparation', 'warn'], SCHEDULED: ['Programmée', ''], ON_HOLD: ['Expédition suspendue', ''], FULFILLED: ['Expédiée', 'ok'],
  REQUEST_DECLINED: ['Demande refusée', 'down'], RESTOCKED: ['Remise en stock', ''],
};
export const RISK: Record<string, [string, Tone]> = { INVESTIGATE: ['À vérifier', 'warn'], CANCEL: ['Risque élevé', 'down'], ACCEPT: ['Risque faible', ''], NONE: ['', ''] };
export const PRODUCT: Record<string, [string, Tone]> = { ACTIVE: ['Actif', 'ok'], DRAFT: ['Brouillon', ''], ARCHIVED: ['Archivé', ''] };
export const DISCOUNT: Record<string, [string, Tone]> = { ACTIVE: ['Actif', 'ok'], SCHEDULED: ['Programmé', 'warn'], EXPIRED: ['Expiré', ''] };
export const label = (t: Record<string, [string, Tone]>, k: string): [string, Tone] => t[k] ?? [k ? k.toLowerCase().replace(/_/g, ' ') : '', ''];
export const pill = (t: Record<string, [string, Tone]>, k: string): string => {
  const [text, tone] = label(t, k);
  return text ? `<span class="sh-pill ${tone}">${esc(text)}</span>` : '';
};
/** Une commande qui peut encore être expédiée d'ici. */
export const shippable = (o: api.Order): boolean => !['FULFILLED', 'RESTOCKED', 'ON_HOLD', 'REQUEST_DECLINED'].includes(o.fulfillment);
export const atRisk = (o: api.Order): boolean => o.risk === 'INVESTIGATE' || o.risk === 'CANCEL';

// ---------- Morceaux de HTML ----------
export const tail = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
/** Adresse https seulement (jamais javascript: ni data:). */
export const httpsUrl = (u: string): string => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; } };
/** Image d'un produit : seule l'origine cdn.shopify.com est permise (CSP `img-src`). */
export function img(url: string, cls = 'sh-img'): string {
  let ok = false;
  try { ok = !!url && new URL(url).origin === 'https://cdn.shopify.com'; } catch { ok = false; }
  return ok ? `<img class="${cls}" loading="lazy" decoding="async" alt="" src="${esc(url)}">` : `<span class="${cls} sh-noimg">${icon('container')}</span>`;
}
export const ext = (url: string, text: string, ic = 'link'): string => {
  const u = httpsUrl(url);
  return u ? `<a class="btn sh-ext" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${icon(ic)}${esc(text)}</a>` : '';
};
export const errHTML = (msg: string, retry = true): string => `<div class="sh-err" role="alert"><p>${esc(msg)}</p>${retry ? '<button class="btn" data-sh="retry">Réessayer</button>' : ''}</div>`;
export const loadingHTML = (text = 'Chargement…'): string => `<p class="sh-loading">${esc(text)}</p>`;
export const notMacHTML = (): string => `<div class="sh-empty">${icon('plug')}<h3>Boutique Shopify</h3><p>La gestion d’une boutique Shopify se fait depuis l’app Studio pour Mac : c’est elle qui parle à Shopify, et qui garde tes accès chiffrés.</p></div>`;

/** Rubrique « Notes liées » d'une fiche. */
export function linkedHTML(notes: Note[]): string {
  const rows = notes.slice(0, 12).map(n => `<button class="sh-note" data-sh="note" data-id="${esc(n.id)}">${icon('notes')}<span>${esc(n.title.trim() || 'Sans titre')}</span></button>`).join('');
  return `<section class="sh-block"><h4>Notes liées</h4>${rows ? `<div class="sh-notes">${rows}</div>${notes.length > 12 ? `<p class="sh-sub">${notes.length - 12} de plus</p>` : ''}`
    : '<p class="sh-sub">Aucune note du projet n’en parle. Colle son adresse d’admin dans une note du projet pour la lier.</p>'}</section>`;
}

// ---------- Comportements ----------
export interface Handlers { [name: string]: (t: HTMLElement, e: Event) => unknown }
/** Écoute les clics sur `node` seulement, par délégation sur `data-sh="…"` ; une erreur est montrée en toast. */
export function clicks(node: HTMLElement, h: Handlers): void {
  node.addEventListener('click', e => {
    const t = target(e).closest<HTMLElement>('[data-sh]');
    if (!t || !node.contains(t)) return;
    const fn = h[t.dataset.sh ?? '']; if (!fn) return;
    try { const r = fn(t, e); if (r instanceof Promise) r.catch(err => toast(errMsg(err))); } catch (err) { toast(errMsg(err)); }
  });
}
/** Relecture périodique : s'arrête quand `root` quitte le document, saute les tours où la fenêtre est cachée. */
export function poll(root: HTMLElement, run: () => void, ms = 60000): void {
  const t = setInterval(() => { if (!root.isConnected) clearInterval(t); else if (!document.hidden) run(); }, ms);
}
export function makeRoot(box: HTMLElement, cls = ''): HTMLElement {
  const root = el(`<div class="sh-root${cls ? ` ${cls}` : ''}"></div>`);
  box.replaceChildren(root);
  return root;
}
/** Écriture sur Shopify : demande confirmation (en disant ce qui change), exécute, annonce. Vrai si c'est fait. */
export async function write(c: { title: string; text: string; ok?: string; danger?: boolean }, run: () => Promise<void>, done: string, onError: (m: string) => void = m => toast(m)): Promise<boolean> {
  if (!await confirmBox(c)) return false;
  try { await run(); } catch (e) { onError(errMsg(e)); return false; }
  toast(done);
  return true;
}
/** Nombre saisi (virgule ou point), NaN si vide ou invalide. */
export const parseNum = (s: string): number => { const t = s.trim().replace(/\s/g, '').replace(',', '.'); return t && /^-?\d*\.?\d+$/.test(t) ? Number(t) : NaN; };
export const debounce = (fn: () => void, ms: number): (() => void) => { let t = 0; return () => { clearTimeout(t); t = window.setTimeout(fn, ms); }; };

/** Ce qui empêche d'utiliser le coffre : '' si tout va bien. */
export const vaultIssue = (): '' | 'absent' | 'locked' => !vault.enabled() ? 'absent' : !vault.isOpen() ? 'locked' : '';
