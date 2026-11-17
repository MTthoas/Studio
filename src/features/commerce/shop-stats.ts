// Section « Chiffres » : ventes, commandes, panier moyen, sessions, conversion, remboursements, courbe par jour,
// meilleurs produits, canaux, à traiter, objectif mensuel. Relue toutes les 60 s tant qu'elle est à l'écran.
import { esc } from '../../lib/markdown.ts';
import { icon, modal, paintIfChanged, errMsg, need } from '../../ui/kit.ts';
import * as chart from '../../ui/chart.ts';
import * as api from '../../integrations/shopify/api.ts';
import { clicks, poll, money, int, dec, pct, symbol, loadingHTML, errHTML, parseNum, type Ctx } from './shop-common.ts';
import { openProduct, openProductById } from './shop-products.ts';
import { openOrder, toShip } from './shop-orders.ts';

const RANGES: [api.Range, string][] = [['today', 'Aujourd’hui'], ['7d', '7 jours'], ['30d', '30 jours'], ['90d', '90 jours'], ['month', 'Ce mois']];
/** Période choisie par boutique : gardée quand on change de section et revient. */
const chosen = new Map<string, api.Range>();
const goalKey = (domain: string): string => `studio.shop.goal.${domain}`;
const readGoal = (domain: string): number => { const n = Number(localStorage.getItem(goalKey(domain))); return Number.isFinite(n) && n > 0 ? n : 0; };

interface Data {
  s: api.Summary; month: api.Summary | null;
  ship: api.Order[] | null; shipErr: string;
  low: { product: api.Product; variant: api.Variant }[] | null; lowErr: string;
}

export function mount(c: Ctx): void {
  const { root, shop } = c;
  let range: api.Range = chosen.get(shop.domain) ?? '7d', data: Data | null = null, error = '', seq = 0;

  const paint = (): void => {
    if (!root.isConnected) return;
    const head = `<div class="sh-head"><div class="sh-seg" role="tablist" aria-label="Période">${RANGES.map(([k, l]) =>
      `<button class="btn${k === range ? ' on' : ''}" role="tab" aria-selected="${k === range}" data-sh="range" data-range="${k}">${esc(l)}</button>`).join('')}</div>
      <button class="btn sh-refresh" data-sh="refresh" title="Relire les chiffres">${icon('refresh')}Actualiser</button></div>`;
    const body = error ? errHTML(error) : data ? dashboard(data, shop) : loadingHTML('Lecture des chiffres…');
    if (paintIfChanged(root, head + body)) chart.bindTips(root);
  };

  const load = async (fresh = false): Promise<void> => {
    const mine = ++seq, r = range;
    if (fresh) api.forget(shop.domain);
    try {
      const s = await api.summary(shop, r, fresh);
      const [month, ship, low] = await Promise.allSettled([r === 'month' ? Promise.resolve(s) : api.summary(shop, 'month'), toShip(shop), api.lowStock(shop)]);
      if (mine !== seq) return;
      data = {
        s, month: month.status === 'fulfilled' ? month.value : null,
        ship: ship.status === 'fulfilled' ? ship.value : null, shipErr: ship.status === 'rejected' ? errMsg(ship.reason) : '',
        low: low.status === 'fulfilled' ? low.value : null, lowErr: low.status === 'rejected' ? errMsg(low.reason) : '',
      };
      error = '';
    } catch (e) { if (mine !== seq) return; error = errMsg(e); }
    paint();
  };

  const goal = (): void => {
    const cur = readGoal(shop.domain), cc = data?.s.currency ?? shop.currency ?? 'EUR';
    const m = modal({ title: 'Objectif du mois', cls: 'small', html: `<form class="sh-form" data-g><label class="sh-f"><span>Montant des ventes à atteindre (${esc(symbol(cc))})</span>
      <input class="field" name="goal" inputmode="decimal" autocomplete="off" value="${cur ? String(cur) : ''}" placeholder="3000" autofocus></label>
      <p class="sh-sub">Gardé sur ce Mac, pour cette boutique seulement.</p>
      <div class="modal-actions">${cur ? '<button type="button" class="btn" data-x>Retirer</button>' : ''}<button type="submit" class="btn btn-primary">Enregistrer</button></div></form>` });
    const form = need<HTMLFormElement>('[data-g]', m.node);
    form.onsubmit = e => {
      e.preventDefault();
      const v = parseNum(need<HTMLInputElement>('[name=goal]', form).value);
      if (!(v > 0)) { need('[name=goal]', form).focus(); return; }
      localStorage.setItem(goalKey(shop.domain), String(v)); m.close(); paint();
    };
    form.querySelector<HTMLElement>('[data-x]')?.addEventListener('click', () => { localStorage.removeItem(goalKey(shop.domain)); m.close(); paint(); });
  };

  c.reload = () => { void load(true); };
  clicks(root, {
    range: t => { const r = t.dataset.range as api.Range | undefined; if (!r || r === range) return; range = r; chosen.set(shop.domain, r); data = null; error = ''; paint(); void load(); },
    refresh: () => load(true),
    retry: () => { error = ''; paint(); return load(true); },
    goal,
    product: t => { const id = t.dataset.id ?? ''; return id.startsWith('gid://') ? openProductById(c, id) : undefined; },
    low: t => { const hit = data?.low?.find(x => x.product.id === t.dataset.id); if (hit) openProduct(c, hit.product); },
    order: t => { const o = data?.ship?.find(x => x.id === t.dataset.id); if (o) openOrder(c, o); },
    go: t => { root.dispatchEvent(new CustomEvent('commerce:go', { bubbles: true, detail: { section: t.dataset.section } })); },
  });

  paint();
  void load();
  poll(root, () => { void load(true); });
}

const tile = (k: string, v: string, extra = ''): string => `<div class="sh-tile"><span class="sh-k">${esc(k)}</span><strong>${v}</strong>${extra ? `<span class="sh-tr">${extra}</span>` : '<span class="sh-tr"></span>'}</div>`;

function dashboard(d: Data, shop: api.ShopCreds): string {
  const s = d.s, cur = s.currency, span = `${s.byDay.length} j`;
  const noVisits = s.sessions === null && s.conversion === null;
  const tiles = [
    tile('Ventes', esc(money(s.sales, cur)), chart.trend(s.sales, s.prev.sales, span)),
    tile('Commandes', esc(int(s.orders)), chart.trend(s.orders, s.prev.orders, span)),
    tile('Panier moyen', esc(money(s.aov, cur)), chart.trend(s.aov, s.prev.aov, span)),
    tile('Sessions', s.sessions === null ? '—' : esc(int(s.sessions))),
    tile('Conversion', s.conversion === null ? '—' : esc(pct(s.conversion))),
    tile('Remboursements', esc(money(s.refunds, cur))),
  ].join('');
  const points = s.byDay.map(x => ({ key: x.date, label: new Date(`${x.date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }), value: Math.round(x.sales) }));
  const sym = symbol(cur);
  const curve = s.byDay.length > 1 ? `<section class="sh-block"><h4>Ventes par jour</h4>${chart.stacked([{ label: 'Ventes', color: 'blue', points }],
    { unit: sym, units: sym, summary: `Ventes par jour sur ${s.byDay.length} jours : ${money(s.sales, cur)}` })}</section>` : '';
  const maxTop = Math.max(1, ...s.top.map(x => x.sales)), maxCh = Math.max(1, ...s.channels.map(x => x.sales)), totalCh = s.channels.reduce((a, x) => a + x.sales, 0) || 1;
  const top = `<section class="sh-block"><h4>Meilleurs produits</h4>${s.top.length ? s.top.map(x => {
    const inner = `<span class="sh-ln-main"><strong>${esc(x.title || 'Sans titre')}</strong><span class="sh-bar"><i style="width:${Math.max(2, x.sales / maxTop * 100)}%"></i></span></span>
      <span class="sh-ln-v">${esc(money(x.sales, cur))}<small>${esc(int(x.quantity))} vendu${x.quantity > 1 ? 's' : ''}</small></span>`;
    return x.id.startsWith('gid://') ? `<button class="sh-ln" data-sh="product" data-id="${esc(x.id)}">${inner}</button>` : `<div class="sh-ln">${inner}</div>`;
  }).join('') : '<p class="sh-sub">Aucune vente sur la période.</p>'}</section>`;
  const channels = `<section class="sh-block"><h4>Canaux de vente</h4>${s.channels.length ? s.channels.map(x => `<div class="sh-ln"><span class="sh-ln-main"><strong>${esc(x.name || 'Autre')}</strong>
    <span class="sh-bar"><i style="width:${Math.max(2, x.sales / maxCh * 100)}%"></i></span></span><span class="sh-ln-v">${esc(money(x.sales, cur))}<small>${Math.round(x.sales / totalCh * 100)} %</small></span></div>`).join('')
    : '<p class="sh-sub">Aucune vente sur la période.</p>'}</section>`;
  return `<div class="sh-tiles">${tiles}</div>${noVisits ? '<p class="sh-sub">Sessions et conversion ne sont pas disponibles : le droit read_reports manque à l’app, ou les chiffres sont calculés d’après les commandes.</p>' : ''}
    ${curve}<div class="sh-cols">${top}${channels}</div><div class="sh-cols">${todo(d, shop)}${goalBlock(d, shop)}</div>`;
}

function todo(d: Data, shop: api.ShopCreds): string {
  const ship = d.ship;
  const orders = d.shipErr ? `<p class="sh-sub">${esc(d.shipErr)}</p>` : !ship ? '' : ship.length ? ship.slice(0, 5).map(o => `<button class="sh-ln" data-sh="order" data-id="${esc(o.id)}">
      <span class="sh-ln-main"><strong>${esc(o.name)}</strong><span class="sh-sub">${esc(o.customer || o.email || 'Client inconnu')}</span></span><span class="sh-ln-v">${esc(money(o.total, o.currency))}</span></button>`).join('')
    : '<p class="sh-sub">Aucune commande à expédier.</p>';
  const more = ship && ship.length > 5 ? `<button class="link-btn" data-sh="go" data-section="commandes">Voir les ${ship.length >= 50 ? '50 premières' : ship.length} commandes à expédier</button>` : '';
  const low = d.lowErr ? `<p class="sh-sub">${esc(d.lowErr)}</p>` : !d.low ? '' : d.low.length ? d.low.slice(0, 6).map(x => `<button class="sh-ln" data-sh="low" data-id="${esc(x.product.id)}">
      <span class="sh-ln-main"><strong>${esc(x.product.title)}</strong><span class="sh-sub">${esc(x.variant.title === 'Default Title' ? 'Variante unique' : x.variant.title)}</span></span>
      <span class="sh-ln-v ${x.variant.stock !== null && x.variant.stock <= 0 ? 'bad' : 'warn'}">${esc(int(x.variant.stock ?? 0))} en stock</span></button>`).join('')
    : '<p class="sh-sub">Aucun stock bas.</p>';
  return `<section class="sh-block"><h4>À traiter<span class="sh-sub">${esc(shop.name || shop.domain)}</span></h4>
    <h5>À expédier${ship ? ` <b>${ship.length >= 50 ? '50+' : ship.length}</b>` : ''}</h5>${orders}${more}
    <h5>Stocks bas${d.low ? ` <b>${d.low.length}</b>` : ''}</h5>${low}</section>`;
}

function goalBlock(d: Data, shop: api.ShopCreds): string {
  const m = d.month, goal = readGoal(shop.domain);
  if (!m) return `<section class="sh-block"><h4>Objectif du mois</h4><p class="sh-sub">Les ventes du mois n’ont pas pu être lues.</p></section>`;
  const elapsed = Math.max(1, m.byDay.length), last = m.byDay[m.byDay.length - 1]?.date ?? '';
  const [y, mo] = last.split('-').map(Number), dim = y && mo ? new Date(y, mo, 0).getDate() : 30;
  const projected = m.sales / elapsed * dim, cur = m.currency;
  const head = `<h4>Objectif du mois<button class="link-btn" data-sh="goal">${goal ? 'Modifier' : 'Définir'}</button></h4>`;
  if (!goal) return `<section class="sh-block">${head}<div class="sh-big">${esc(money(m.sales, cur))}</div><p class="sh-sub">de ventes depuis le début du mois. Fixe un objectif pour suivre ta progression.</p>
    <p class="sh-sub">Au rythme actuel : environ ${esc(money(projected, cur))} à la fin du mois.</p></section>`;
  const reached = m.sales >= goal, ratio = projected / goal;
  const line = reached ? 'Objectif atteint.' : ratio >= 1 ? `Au rythme actuel, tu l’atteindras avec environ ${esc(money(projected, cur))} à la fin du mois.` : `Au rythme actuel : environ ${esc(money(projected, cur))} à la fin du mois, soit ${esc(dec(ratio * 100, 0))} % de l’objectif.`;
  return `<section class="sh-block">${head}<div class="sh-big">${esc(money(m.sales, cur))}<small>sur ${esc(money(goal, cur))} · ${esc(dec(Math.min(m.sales / goal, 9.99) * 100, 0))} %</small></div>
    ${chart.meter(m.sales, goal, 'green')}<p class="sh-sub">${line}</p></section>`;
}
