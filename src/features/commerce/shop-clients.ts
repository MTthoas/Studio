// Sections « Clients » (liste, tri, fiche avec ses commandes et ses notes liées) et « Réductions » (codes, création d'un code).
import { esc } from '../../lib/markdown.ts';
import { icon, modal, paintIfChanged, errMsg, rel, target, need } from '../../ui/kit.ts';
import * as api from '../../integrations/shopify/api.ts';
import * as links from './links.ts';
import { openOrder } from './shop-orders.ts';
import { clicks, poll, money, int, pill, PAID, FULFIL, DISCOUNT, ext, linkedHTML, errHTML, loadingHTML, write, debounce, openNote, parseNum, day, type Ctx } from './shop-common.ts';

// ---------- Clients ----------
type Sort = 'recent' | 'spent' | 'orders' | 'last';
const SORTS: [Sort, string][] = [['recent', 'Récents'], ['spent', 'Total dépensé'], ['orders', 'Commandes'], ['last', 'Dernière commande']];
const sorter: Record<Sort, (a: api.Customer, b: api.Customer) => number> = {
  recent: () => 0, spent: (a, b) => b.spent - a.spent, orders: (a, b) => b.orders - a.orders, last: (a, b) => (b.last ?? 0) - (a.last ?? 0),
};

export function mountClients(c: Ctx): void {
  const { root, shop } = c, cur = shop.currency || 'EUR';
  let sort: Sort = 'recent', q = '', limit = 50, list: api.Customer[] | null = null, error = '', seq = 0;
  root.innerHTML = `<div class="sh-head"><div class="sh-seg" data-f></div><label class="sh-search">${icon('search')}<input class="field" data-q placeholder="Rechercher un client : nom, e-mail…" autocomplete="off" spellcheck="false" aria-label="Rechercher un client"></label></div><div data-list></div>`;
  const fbox = root.querySelector<HTMLElement>('[data-f]'), lbox = root.querySelector<HTMLElement>('[data-list]');

  const paint = (): void => {
    if (!root.isConnected || !fbox || !lbox) return;
    paintIfChanged(fbox, `<span class="sh-k">Trier par</span>${SORTS.map(([k, l]) => `<button class="btn${k === sort ? ' on' : ''}" data-sh="sort" data-k="${k}">${esc(l)}</button>`).join('')}`);
    if (error) { paintIfChanged(lbox, errHTML(error)); return; }
    if (!list) { paintIfChanged(lbox, loadingHTML('Lecture des clients…')); return; }
    const shown = [...list].sort(sorter[sort]);
    const rows = shown.map(x => `<button class="sh-row" data-sh="customer" data-id="${esc(x.id)}">
      <span class="sh-row-main"><strong>${esc(x.name || x.email || 'Client sans nom')}</strong><span class="sh-sub">${esc(x.email)}</span></span>
      <span class="sh-row-stock">${esc(int(x.orders))} commande${x.orders > 1 ? 's' : ''}${x.last ? ` · ${esc(rel(x.last))}` : ''}</span><span class="sh-row-v">${esc(money(x.spent, cur))}</span></button>`).join('');
    const more = list.length >= limit && limit < 100 ? `<button class="btn sh-more" data-sh="more">Afficher plus</button>` : '';
    paintIfChanged(lbox, shown.length ? `<div class="sh-list">${rows}</div>${more}` : `<p class="sh-sub sh-none">${q ? 'Aucun client ne correspond.' : 'Aucun client pour l’instant.'}</p>`);
  };
  const load = async (fresh = false): Promise<void> => {
    const mine = ++seq;
    if (fresh) api.forget(shop.domain);
    try { const r = await api.customers(shop, { query: q, first: limit }); if (mine !== seq) return; list = r; error = ''; }
    catch (e) { if (mine !== seq) return; error = errMsg(e); }
    paint();
  };
  const restart = (): void => { list = null; error = ''; paint(); void load(); };
  c.reload = () => { void load(true); };
  const search = debounce(() => restart(), 350);
  root.addEventListener('input', e => { const t = target(e); if (t.matches('[data-q]')) { q = (t as HTMLInputElement).value.trim(); search(); } });
  clicks(root, {
    sort: t => { const k = t.dataset.k as Sort | undefined; if (k) { sort = k; paint(); } },
    more: () => { limit = Math.min(100, limit + 50); void load(); },
    retry: () => { restart(); },
    customer: t => { const x = list?.find(y => y.id === t.dataset.id); if (x) openCustomer(c, x); },
  });
  paint();
  void load();
  poll(root, () => { if (!q) void load(true); });
}

function openCustomer(c: Ctx, cu: api.Customer): void {
  const cur = c.shop.currency || 'EUR';
  const m = modal({ title: cu.name || cu.email || 'Client', cls: 'sh-modal', html: '' });
  let recent: api.Order[] | null = null, recentErr = '';
  const render = (): void => {
    const notes = links.notesFor(c.p, { kind: 'customer', id: cu.id, name: cu.name, email: cu.email });
    const orders = recentErr ? `<p class="sh-sub">${esc(recentErr)}</p>` : !cu.email ? '<p class="sh-sub">Pas d’e-mail : impossible de retrouver ses commandes d’ici.</p>' : !recent ? loadingHTML()
      : recent.length ? recent.map(o => `<button class="sh-row" data-sh="order" data-id="${esc(o.id)}"><span class="sh-row-main"><strong>${esc(o.name)}</strong><span class="sh-sub">${esc(rel(o.at))}</span></span>
        <span class="sh-row-pills">${pill(FULFIL, o.fulfillment)}${pill(PAID, o.paid)}</span><span class="sh-row-v">${esc(money(o.total, o.currency))}</span></button>`).join('') : '<p class="sh-sub">Aucune commande trouvée.</p>';
    m.body.innerHTML = `<div class="sh-fiche"><div class="sh-tiles sh-tiles-3">
        <div class="sh-tile"><span class="sh-k">Commandes</span><strong>${esc(int(cu.orders))}</strong></div>
        <div class="sh-tile"><span class="sh-k">Total dépensé</span><strong>${esc(money(cu.spent, cur))}</strong></div>
        <div class="sh-tile"><span class="sh-k">Dernière commande</span><strong>${cu.last ? esc(day(cu.last)) : '—'}</strong></div></div>
      ${cu.email ? `<p class="sh-p"><span class="sh-sub">${esc(cu.email)}</span></p>` : ''}
      <section class="sh-block"><h4>Dernières commandes</h4>${orders}</section>
      ${linkedHTML(notes)}
      <div class="modal-actions">${ext(cu.url, 'Ouvrir dans Shopify')}<button class="btn" data-sh="close">Fermer</button></div></div>`;
  };
  clicks(m.node, {
    close: () => m.close(),
    note: t => { const id = t.dataset.id; if (id) { m.close(); openNote(id); } },
    order: t => { const o = recent?.find(x => x.id === t.dataset.id); if (o) openOrder(c, o); },
  });
  render();
  if (cu.email) void api.orders(c.shop, { query: `email:${cu.email}`, first: 10 }).then(r => { recent = r; }, e => { recentErr = errMsg(e); }).then(() => { if (m.node.isConnected) render(); });
}

// ---------- Réductions ----------
export function mountDiscounts(c: Ctx): void {
  const { root, shop } = c;
  let list: api.Discount[] | null = null, error = '', seq = 0;
  const paint = (): void => {
    if (!root.isConnected) return;
    const head = `<div class="sh-head"><h3 class="sh-title">Codes et réductions</h3><button class="btn btn-primary sh-right" data-sh="new">${icon('plus')}Nouveau code</button></div>`;
    let body: string;
    if (error) body = errHTML(error);
    else if (!list) body = loadingHTML('Lecture des réductions…');
    else if (!list.length) body = '<p class="sh-sub sh-none">Aucune réduction pour l’instant.</p>';
    else body = `<div class="sh-list">${list.map(d => `<div class="sh-row sh-static"><span class="sh-row-main"><strong>${esc(d.code || d.title || 'Réduction')}</strong>
      <span class="sh-sub">${esc([d.code ? d.title : 'Automatique', d.summary].filter(x => x && x !== d.code).join(' · '))}</span></span>
      <span class="sh-row-pills">${pill(DISCOUNT, d.status)}</span><span class="sh-row-stock">${esc(int(d.used))} utilisation${d.used > 1 ? 's' : ''}</span></div>`).join('')}</div>`;
    paintIfChanged(root, head + body);
  };
  const load = async (fresh = false): Promise<void> => {
    const mine = ++seq;
    if (fresh) api.forget(shop.domain);
    try { const r = await api.discounts(shop); if (mine !== seq) return; list = r; error = ''; }
    catch (e) { if (mine !== seq) return; error = errMsg(e); }
    paint();
  };
  c.reload = () => { void load(true); };
  clicks(root, { new: () => newCode(c), retry: () => { error = ''; paint(); return load(true); } });
  paint();
  void load();
  poll(root, () => { void load(true); });
}

function newCode(c: Ctx): void {
  const cur = c.shop.currency || 'EUR';
  const m = modal({ title: 'Nouveau code de réduction', cls: 'sh-modal small', html: `<form class="sh-form" data-form>
    <label class="sh-f"><span>Code (ce que le client saisit)</span><input class="field" name="code" autocomplete="off" spellcheck="false" placeholder="BIENVENUE10" required autofocus></label>
    <div class="sh-two"><label class="sh-f"><span>Type</span><select class="field" name="kind"><option value="percent">Pourcentage</option><option value="amount">Montant fixe (${esc(cur)})</option></select></label>
      <label class="sh-f"><span>Valeur</span><input class="field" name="value" inputmode="decimal" autocomplete="off" placeholder="10" required></label></div>
    <div class="sh-two"><label class="sh-f"><span>Dernier jour (facultatif)</span><input class="field" type="date" name="end"></label>
      <label class="sh-f"><span>Limite d’utilisations (facultatif)</span><input class="field" name="limit" inputmode="numeric" autocomplete="off" placeholder="100"></label></div>
    <p class="sh-sub">Valable pour tous les clients, sur toute la commande, à partir de maintenant.</p>
    <p class="sh-err-inline" data-err hidden></p>
    <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button type="submit" class="btn btn-primary">Créer le code</button></div></form>` });
  const form = need<HTMLFormElement>('[data-form]', m.node), err = need('[data-err]', m.node);
  const fail = (msg: string): void => { err.textContent = msg; err.removeAttribute('hidden'); };
  need('[data-x]', m.node).onclick = () => m.close();
  let busy = false;
  form.onsubmit = async e => {
    e.preventDefault(); if (busy) return;
    err.setAttribute('hidden', '');
    const g = (n: string): string => need<HTMLInputElement>(`[name=${n}]`, form).value.trim();
    const code = g('code').replace(/\s+/g, '').toUpperCase(), percent = g('kind') === 'percent', value = parseNum(g('value'));
    const limitRaw = g('limit'), limit = limitRaw ? parseNum(limitRaw) : 0, end = g('end');
    if (!code) { fail('Écris le code.'); return; }
    if (!(value > 0)) { fail('Indique une valeur positive.'); return; }
    if (percent && value > 100) { fail('Un pourcentage ne dépasse pas 100.'); return; }
    if (limitRaw && !(Number.isInteger(limit) && limit > 0)) { fail('La limite doit être un nombre entier positif.'); return; }
    const endsAt = end ? new Date(`${end}T23:59:59`).toISOString() : undefined;
    busy = true;
    const ok = await write({ title: `Créer le code ${code} ?`, ok: 'Créer le code',
      text: `Créer le code ${code} : ${percent ? `${value.toLocaleString('fr-FR')} %` : money(value, cur)} de réduction sur la commande, pour tous les clients, dès maintenant, ${end ? `jusqu’au ${day(new Date(`${end}T12:00:00`).getTime())}` : 'sans date de fin'}, ${limit ? `limité à ${int(limit)} utilisation${limit > 1 ? 's' : ''}` : 'sans limite d’utilisations'} ?` },
      () => api.createDiscount(c.shop, { code, ...(percent ? { percent: value } : { amount: value }), ...(endsAt ? { endsAt } : {}), ...(limit ? { usageLimit: limit } : {}) }), `Code ${code} créé`, fail);
    busy = false;
    if (ok) { m.close(); c.reload(); }
  };
}
