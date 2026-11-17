// Boutique Shopify d'un projet : point d'entrée. Une section de l'onglet « Boutique » (chiffres, commandes, produits,
// clients, réductions), la vue « Boutiques » (toutes les boutiques côte à côte) et le bloc de l'accueil.
// Rien ne parle à Shopify ici : tout passe par src/integrations/shopify/api.ts (app Mac seulement).
import { esc } from '../../lib/markdown.ts';
import { icon, paintIfChanged, errMsg } from '../../ui/kit.ts';
import { trend } from '../../ui/chart.ts';
import * as api from '../../integrations/shopify/api.ts';
import * as model from '../projects/model.ts';
import type { Project } from '../projects/model.ts';
import type { AppShell } from '../../types.ts';
import { setApp, makeRoot, clicks, poll, money, int, notMacHTML, type Ctx } from './shop-common.ts';
import { mount as mountStats } from './shop-stats.ts';
import { mount as mountOrders, toShip } from './shop-orders.ts';
import { mount as mountProducts } from './shop-products.ts';
import { mountClients, mountDiscounts } from './shop-clients.ts';
import { mountSetup, attachMenu, settings } from './shop-setup.ts';

export { settings } from './shop-setup.ts';
export type Section = 'chiffres' | 'commandes' | 'produits' | 'clients' | 'reductions';

export const init = (app: AppShell): void => { setApp(app); };

const SECTIONS: Record<Section, (c: Ctx) => void> = {
  chiffres: mountStats, commandes: mountOrders, produits: mountProducts, clients: mountClients, reductions: mountDiscounts,
};

/** Section de l'onglet Boutique d'un projet. */
export function mount(box: HTMLElement, p: Project, section: Section): void {
  const root = makeRoot(box);
  if (!api.supported()) { root.innerHTML = notMacHTML(); return; }
  const shop = api.shopOf(p);
  if (!shop) { mountSetup(root, p, () => mount(box, p, section)); return; }
  SECTIONS[section]({ p, shop, root, reload: () => undefined });
}

// ---------- Vue « Boutiques » ----------
interface Card { day: api.Summary | null; week: api.Summary | null; ship: number | null; low: number | null; error: string }
const count = (n: number): string => n >= 50 ? '50+' : String(n);
const tint = (p: Project): string => `--c:var(--c-${esc(p.hue)})`;

/** Total par devise, un montant par ligne. */
function totals(cards: Map<string, Card>, pick: (c: Card) => api.Summary | null): string {
  const sum = new Map<string, number>();
  for (const c of cards.values()) { const s = pick(c); if (s) sum.set(s.currency, (sum.get(s.currency) ?? 0) + s.sales); }
  return sum.size ? [...sum].map(([cur, n]) => `<span>${esc(money(n, cur))}</span>`).join('') : '<span>—</span>';
}
const sumOf = (cards: Map<string, Card>, pick: (c: Card) => number | null): string => {
  let n = 0, seen = false;
  for (const c of cards.values()) { const v = pick(c); if (v !== null) { n += v; seen = true; } }
  return seen ? (n >= 50 ? `${int(n)}+` : int(n)) : '—';
};

function cardHTML(p: Project | null, shop: api.ShopCreds, c: Card | undefined): string {
  const name = p?.name ?? (shop.name || shop.domain);
  const head = `<span class="sh-card-top"><i class="sh-dot"></i><strong>${esc(name)}</strong><span class="sh-sub">${esc(p ? shop.name || shop.domain : shop.domain)}</span></span>`;
  const act = p ? `data-sh="open" data-project="${esc(p.id)}"` : `data-sh="card-attach" data-domain="${esc(shop.domain)}" title="Rattacher à un projet pour ouvrir ses commandes, ses produits et sa publicité"`;
  const style = p ? tint(p) : '--c:var(--c-gray)';
  const orphan = p ? '' : `<span class="sh-chip warn">${icon('folder')}Rattacher à un projet</span>`;
  if (!c) return `<button class="sh-card" style="${style}" ${act}>${head}<span class="sh-loading">Lecture des chiffres…</span>${orphan ? `<span class="sh-card-foot">${orphan}</span>` : ''}</button>`;
  const figure = (k: string, s: api.Summary | null, span: string): string => s
    ? `<span class="sh-fig"><span class="sh-k">${esc(k)}</span><strong>${esc(money(s.sales, s.currency))}</strong><span class="sh-tr">${trend(s.sales, s.prev.sales, span)}</span></span>`
    : `<span class="sh-fig"><span class="sh-k">${esc(k)}</span><strong>—</strong><span class="sh-tr"></span></span>`;
  const chips = [
    orphan,
    c.ship === null ? '' : `<span class="sh-chip${c.ship ? ' warn' : ''}">${esc(count(c.ship))} à expédier</span>`,
    c.low === null ? '' : `<span class="sh-chip${c.low ? ' warn' : ''}">${esc(String(c.low))} stock${c.low > 1 ? 's' : ''} bas</span>`,
  ].join('');
  return `<button class="sh-card" style="${style}" ${act}>${head}
    <span class="sh-card-figs">${figure('Aujourd’hui', c.day, '1 j')}${figure('7 jours', c.week, '7 j')}</span>
    ${c.error ? `<span class="sh-card-err">${esc(c.error)}</span>` : ''}<span class="sh-card-foot">${chips}</span></button>`;
}

/** Toutes les boutiques du coffre (rattachées ou non à un projet), une carte chacune, et le formulaire pour en ajouter.
 *  Une boutique en erreur n'empêche pas les autres. */
export function mountAll(box: HTMLElement): void {
  const root = makeRoot(box, 'sh-all');
  if (!api.supported()) { root.innerHTML = notMacHTML(); return; }
  root.innerHTML = '<div class="sh-all-list"></div><div class="sh-all-add"></div>';
  const listBox = root.querySelector<HTMLElement>('.sh-all-list'), addBox = root.querySelector<HTMLElement>('.sh-all-add');
  if (!listBox || !addBox) return;
  const all = (): { p: Project | null; shop: api.ShopCreds }[] => {
    const projects = model.projects();
    return api.shops().map(shop => ({ shop, p: projects.find(p => p.shopify === shop.domain) ?? null }));
  };
  const cards = new Map<string, Card>();
  let seq = 0, adding = false;

  /** Le formulaire d'ajout : ouvert d'office tant qu'il n'y a aucune boutique (ou que le coffre est fermé). */
  const form = (): void => {
    const open = adding || !api.shops().length;
    addBox.hidden = !open;
    if (!open) { addBox.replaceChildren(); return; }
    if (addBox.querySelector('.sh-set')) return;
    addBox.innerHTML = `<h3 class="sh-title">${api.shops().length ? 'Ajouter une boutique' : 'Relier ta première boutique'}</h3>${settings.html()}`;
    settings.bind(addBox, () => { adding = false; paint(); loadAll(false); form(); });
  };

  const paint = (): void => {
    if (!root.isConnected) return;
    const list = all();
    if (!list.length) { paintIfChanged(listBox, ''); return; }
    const head = `<div class="sh-head"><h3 class="sh-title">Boutiques</h3><span class="sh-sub">${list.length} boutique${list.length > 1 ? 's' : ''}</span>
      <button class="btn sh-right" data-sh="refresh" title="Relire les chiffres">${icon('refresh')}Actualiser</button>
      <button class="btn${adding ? ' on' : ''}" data-sh="add">${icon('plus')}Ajouter une boutique</button></div>`;
    const mine = new Map([...cards].filter(([d]) => list.some(x => x.shop.domain === d)));
    const sums = mine.size ? `<div class="sh-tiles sh-tiles-4">
      <div class="sh-tile"><span class="sh-k">Ventes aujourd’hui</span><strong class="sh-multi">${totals(mine, c => c.day)}</strong></div>
      <div class="sh-tile"><span class="sh-k">Ventes sur 7 jours</span><strong class="sh-multi">${totals(mine, c => c.week)}</strong></div>
      <div class="sh-tile"><span class="sh-k">À expédier</span><strong>${esc(sumOf(mine, c => c.ship))}</strong></div>
      <div class="sh-tile"><span class="sh-k">Stocks bas</span><strong>${esc(sumOf(mine, c => c.low))}</strong></div></div>` : '';
    paintIfChanged(listBox, `${head}${sums}<div class="sh-cards">${list.map(x => cardHTML(x.p, x.shop, cards.get(x.shop.domain))).join('')}</div>`);
  };

  const loadOne = async (shop: api.ShopCreds, fresh: boolean, mine: number): Promise<void> => {
    if (fresh) api.forget(shop.domain);
    const [day, week, ship, low] = await Promise.allSettled([api.summary(shop, 'today', fresh), api.summary(shop, '7d', fresh), toShip(shop), api.lowStock(shop)]);
    if (mine !== seq) return;
    const bad = [day, week, ship, low].find(r => r.status === 'rejected');
    cards.set(shop.domain, {
      day: day.status === 'fulfilled' ? day.value : null, week: week.status === 'fulfilled' ? week.value : null,
      ship: ship.status === 'fulfilled' ? ship.value.length : null, low: low.status === 'fulfilled' ? low.value.length : null,
      error: bad && bad.status === 'rejected' ? errMsg(bad.reason) : '',
    });
    paint();
  };
  const loadAll = (fresh: boolean): void => {
    const mine = ++seq;
    for (const { shop } of all()) void loadOne(shop, fresh, mine);
  };

  clicks(listBox, {
    open: t => { const id = t.dataset.project; if (id) root.dispatchEvent(new CustomEvent('commerce:open', { bubbles: true, detail: { project: id } })); },
    'card-attach': t => { const s = api.shops().find(x => x.domain === t.dataset.domain); if (s) attachMenu(t, s, () => { paint(); form(); }); },
    refresh: () => { loadAll(true); },
    add: () => { adding = !adding; paint(); form(); if (adding) addBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); },
  });
  paint();
  form();
  loadAll(false);
  poll(root, () => loadAll(true));
}

// ---------- Accueil ----------
/** Une ligne par boutique reliée (corps du bloc ; le titre est celui de l'accueil), '' si aucune ou hors Mac. */
export async function homeHTML(): Promise<string> {
  if (!api.supported()) return '';
  const list = model.projects().flatMap(p => { const shop = api.shopOf(p); return shop ? [{ p, shop }] : []; });
  if (!list.length) return '';
  const rows = await Promise.all(list.map(async ({ p, shop }) => {
    const [day, ship] = await Promise.allSettled([api.summary(shop, 'today'), toShip(shop)]);
    const sales = day.status === 'fulfilled' ? esc(money(day.value.sales, day.value.currency)) : '—';
    const todo = ship.status === 'fulfilled' ? `${esc(count(ship.value.length))} à expédier` : '';
    return `<button class="sh-hm-row" style="${tint(p)}" data-sh-project="${esc(p.id)}"><i class="sh-dot"></i><span class="sh-hm-name">${esc(p.name)}</span>
      <span class="sh-hm-v">${sales}<small>aujourd’hui</small></span><span class="sh-hm-ship${ship.status === 'fulfilled' && ship.value.length ? ' warn' : ''}">${todo}</span></button>`;
  }));
  return `<div class="sh-hm">${rows.join('')}</div>`;
}
