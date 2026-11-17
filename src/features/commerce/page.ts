// Commerce : l'onglet « Boutique » d'un projet et la vue « Boutiques » (toutes les boutiques côte à côte).
// Une boutique Shopify = un projet (champ `shopify:` de sa note), un compte publicitaire Meta par projet (`meta:`).
// Ce fichier ne fait qu'aiguiller : les chiffres, commandes, produits, clients et réductions sont dans shop.ts,
// la publicité dans ads.ts, l'atelier marketing (modèles locaux) dans marketing.ts. App Mac seulement : Shopify et
// Meta ne se joignent que par le pont natif `commerce` (native/Shared/Commerce.swift).
import * as shop from './shop.ts';
import * as ads from './ads.ts';
import * as marketing from './marketing.ts';
import * as shopify from '../../integrations/shopify/api.ts';
import * as model from '../projects/model.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, menu, need, target, toast } from '../../ui/kit.ts';
import type { AppShell } from '../../types.ts';
import type { Project } from '../projects/model.ts';

let app: AppShell;
export const init = (api: AppShell): void => { app = api; shop.init(api); marketing.init(api); };
export const available = (): boolean => shopify.supported();
/** L'onglet Boutique n'est proposé qu'aux projets qui ont une boutique ou un compte publicitaire. */
export const concerns = (p: Project): boolean => !!p.shopify || !!p.meta;

const SECTIONS: [string, string][] = [['chiffres', 'Chiffres'], ['commandes', 'Commandes'], ['produits', 'Produits'], ['clients', 'Clients'],
  ['reductions', 'Réductions'], ['publicite', 'Publicité'], ['marketing', 'Marketing']];
const known = (s: string | undefined): s is string => !!s && SECTIONS.some(x => x[0] === s);
/** Dernière section ouverte, par projet (le temps de la session). */
const last = new Map<string, string>();

/** Onglet « Boutique » d'un projet. */
export function mount(box: HTMLElement, p: Project): void {
  box.innerHTML = `<div class="cm-root"><nav class="cm-nav" aria-label="Sections de la boutique">${SECTIONS.map(([k, l]) => `<button data-cm="${k}">${esc(l)}</button>`).join('')}</nav><div class="cm-body"></div></div>`;
  const root = need('.cm-root', box), body = need('.cm-body', root);
  const show = (k: string): void => {
    last.set(p.id, k);
    for (const b of root.querySelectorAll<HTMLElement>('[data-cm]')) b.toggleAttribute('aria-current', b.dataset.cm === k);
    body.innerHTML = '';
    if (k === 'publicite') ads.mount(body, p);
    else if (k === 'marketing') marketing.mount(body, p);
    else shop.mount(body, p, k as shop.Section);
  };
  root.addEventListener('click', e => { const b = target(e).closest<HTMLElement>('.cm-nav [data-cm]'); if (b && known(b.dataset.cm)) show(b.dataset.cm); });
  root.addEventListener('commerce:go', e => { const s = (e as CustomEvent<{ section?: string }>).detail?.section; if (known(s)) show(s); });
  show(last.get(p.id) ?? 'chiffres');
}

/** Vue « Boutiques » : toutes les boutiques reliées, et de quoi en relier une à un projet. */
export function mountAll(main: HTMLElement): void {
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('Boutiques')}<div class="tb-side tb-right">
    <button class="btn" data-cm-link>${icon('link')}Relier un projet</button><button class="btn" data-open-conn="commerce">${icon('gear')}Réglages</button></div></header>
    <div class="cm-page"><div class="cm-all"></div></div>`;
  const page = need('.cm-page', main);
  const open = (id: string): void => { void app.setView({ type: 'projets', project: id, tab: 'boutique' }); };
  page.addEventListener('commerce:open', e => { const id = (e as CustomEvent<{ project?: string }>).detail?.project; if (id) open(id); });
  need('[data-cm-link]', main).addEventListener('click', e => {
    const free = model.projects().filter(p => !p.shopify);
    if (!free.length) { toast(model.projects().length ? 'Tous tes projets ont déjà une boutique.' : 'Crée d’abord un projet : une boutique se relie à un projet.'); return; }
    menu(target(e).closest('button') ?? target(e), free.map(p => ({ label: p.name, icon: 'folder', run: () => open(p.id) })));
  });
  shop.mountAll(need('.cm-all', page));
}
