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
import { mountSetup } from './shop-setup.ts';

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

function cardHTML(p: Project, shop: api.ShopCreds, c: Card | undefined): string {
  const head = `<span class="sh-card-top"><i class="sh-dot"></i><strong>${esc(p.name)}</strong><span class="sh-sub">${esc(shop.name || shop.domain)}</span></span>`;
  if (!c) return `<button class="sh-card" style="${tint(p)}" data-sh="open" data-project="${esc(p.id)}">${head}<span class="sh-loading">Lecture des chiffres…</span></button>`;
  const figure = (k: string, s: api.Summary | null, span: string): string => s
    ? `<span class="sh-fig"><span class="sh-k">${esc(k)}</span><strong>${esc(money(s.sales, s.currency))}</strong><span class="sh-tr">${trend(s.sales, s.prev.sales, span)}</span></span>`
    : `<span class="sh-fig"><span class="sh-k">${esc(k)}</span><strong>—</strong><span class="sh-tr"></span></span>`;
  const chips = [
    c.ship === null ? '' : `<span class="sh-chip${c.ship ? ' warn' : ''}">${esc(count(c.ship))} à expédier</span>`,
    c.low === null ? '' : `<span class="sh-chip${c.low ? ' warn' : ''}">${esc(String(c.low))} stock${c.low > 1 ? 's' : ''} bas</span>`,
  ].join('');
  return `<button class="sh-card" style="${tint(p)}" data-sh="open" data-project="${esc(p.id)}">${head}
    <span class="sh-card-figs">${figure('Aujourd’hui', c.day, '1 j')}${figure('7 jours', c.week, '7 j')}</span>
    ${c.error ? `<span class="sh-card-err">${esc(c.error)}</span>` : ''}<span class="sh-card-foot">${chips}</span></button>`;
}

/** Toutes les boutiques reliées, une carte par projet. Une boutique en erreur n'empêche pas les autres. */
export function mountAll(box: HTMLElement): void {
  const root = makeRoot(box, 'sh-all');
  if (!api.supported()) { root.innerHTML = notMacHTML(); return; }
  const linked = (): { p: Project; shop: api.ShopCreds }[] => model.projects().flatMap(p => { const shop = api.shopOf(p); return shop ? [{ p, shop }] : []; });
  const cards = new Map<string, Card>();
  let seq = 0;

  const paint = (): void => {
    if (!root.isConnected) return;
    const list = linked();
    if (!list.length) {
      paintIfChanged(root, `<div class="sh-empty">${icon('plug')}<h3>Aucune boutique reliée</h3>
        <p>Relie une boutique Shopify à un projet : tu verras ici, côte à côte, les ventes du jour et des 7 derniers jours, les commandes à expédier et les stocks bas de chacune.</p>
        <div class="cx-grid"><button class="btn btn-primary" data-open-conn="commerce">Relier une boutique</button></div></div>`);
      return;
    }
    const mine = list.filter(x => cards.has(x.p.id)).length;
    const head = `<div class="sh-head"><h3 class="sh-title">Boutiques</h3><span class="sh-sub">${list.length} boutique${list.length > 1 ? 's' : ''}</span>
      <button class="btn sh-right" data-sh="refresh" title="Relire les chiffres">${icon('refresh')}Actualiser</button></div>`;
    const all = new Map([...cards].filter(([id]) => list.some(x => x.p.id === id)));
    const sums = mine ? `<div class="sh-tiles sh-tiles-4">
      <div class="sh-tile"><span class="sh-k">Ventes aujourd’hui</span><strong class="sh-multi">${totals(all, c => c.day)}</strong></div>
      <div class="sh-tile"><span class="sh-k">Ventes sur 7 jours</span><strong class="sh-multi">${totals(all, c => c.week)}</strong></div>
      <div class="sh-tile"><span class="sh-k">À expédier</span><strong>${esc(sumOf(all, c => c.ship))}</strong></div>
      <div class="sh-tile"><span class="sh-k">Stocks bas</span><strong>${esc(sumOf(all, c => c.low))}</strong></div></div>` : '';
    paintIfChanged(root, `${head}${sums}<div class="sh-cards">${list.map(x => cardHTML(x.p, x.shop, cards.get(x.p.id))).join('')}</div>`);
  };

  const loadOne = async (p: Project, shop: api.ShopCreds, fresh: boolean, mine: number): Promise<void> => {
    if (fresh) api.forget(shop.domain);
    const [day, week, ship, low] = await Promise.allSettled([api.summary(shop, 'today', fresh), api.summary(shop, '7d', fresh), toShip(shop), api.lowStock(shop)]);
    if (mine !== seq) return;
    const bad = [day, week, ship, low].find(r => r.status === 'rejected');
    cards.set(p.id, {
      day: day.status === 'fulfilled' ? day.value : null, week: week.status === 'fulfilled' ? week.value : null,
      ship: ship.status === 'fulfilled' ? ship.value.length : null, low: low.status === 'fulfilled' ? low.value.length : null,
      error: bad && bad.status === 'rejected' ? errMsg(bad.reason) : '',
    });
    paint();
  };
  const loadAll = (fresh: boolean): void => {
    const mine = ++seq;
    for (const { p, shop } of linked()) void loadOne(p, shop, fresh, mine);
  };

  clicks(root, {
    open: t => { const id = t.dataset.project; if (id) root.dispatchEvent(new CustomEvent('commerce:open', { bubbles: true, detail: { project: id } })); },
    refresh: () => { loadAll(true); },
  });
  paint();
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
