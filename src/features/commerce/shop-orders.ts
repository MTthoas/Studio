// Section « Commandes » : filtres, recherche, liste, et fiche d'une commande (note, expédition, tâche, notes liées).
import { esc } from '../../lib/markdown.ts';
import { icon, modal, paintIfChanged, errMsg, rel, full, toast, target } from '../../ui/kit.ts';
import * as api from '../../integrations/shopify/api.ts';
import * as tasks from '../tasks.ts';
import * as links from './links.ts';
import { clicks, poll, money, pill, PAID, FULFIL, RISK, shippable, atRisk, ext, linkedHTML, errHTML, loadingHTML, write, debounce, openNote, type Ctx } from './shop-common.ts';

/** Commandes ouvertes qui attendent d'être expédiées (50 au plus : le nombre affiché est « 50+ » au-delà). */
export const TO_SHIP = 'status:open fulfillment_status:unfulfilled';
export const toShip = async (shop: api.ShopCreds): Promise<api.Order[]> => (await api.orders(shop, { query: TO_SHIP, first: 50 })).filter(o => o.fulfillment !== 'FULFILLED');

type Filter = 'all' | 'ship' | 'unpaid' | 'risk';
const FILTERS: [Filter, string][] = [['all', 'Toutes'], ['ship', 'À expédier'], ['unpaid', 'Impayées'], ['risk', 'À risque']];
const SERVER: Record<Filter, string> = { all: '', ship: TO_SHIP, unpaid: 'financial_status:unpaid', risk: '' };

export function mount(c: Ctx): void {
  const { root, shop } = c;
  let filter: Filter = 'all', q = '', limit = 50, list: api.Order[] | null = null, error = '', seq = 0;
  root.innerHTML = `<div class="sh-head"><div class="sh-seg" data-f></div><label class="sh-search">${icon('search')}<input class="field" data-q placeholder="Rechercher : n° de commande, client, e-mail…" autocomplete="off" spellcheck="false" aria-label="Rechercher une commande"></label></div><div data-list></div>`;
  const fbox = root.querySelector<HTMLElement>('[data-f]'), lbox = root.querySelector<HTMLElement>('[data-list]');

  const paint = (): void => {
    if (!root.isConnected || !fbox || !lbox) return;
    paintIfChanged(fbox, FILTERS.map(([k, l]) => `<button class="btn${k === filter ? ' on' : ''}" data-sh="filter" data-k="${k}">${esc(l)}</button>`).join(''));
    if (error) { paintIfChanged(lbox, errHTML(error)); return; }
    if (!list) { paintIfChanged(lbox, loadingHTML('Lecture des commandes…')); return; }
    const shown = filter === 'risk' ? list.filter(atRisk) : list;
    const rows = shown.map(o => `<button class="sh-row" data-sh="order" data-id="${esc(o.id)}">
      <span class="sh-row-main"><strong>${esc(o.name)}</strong><span class="sh-sub">${esc(o.customer || o.email || 'Client inconnu')} · ${esc(rel(o.at))}</span></span>
      <span class="sh-row-pills">${pill(FULFIL, o.fulfillment)}${pill(PAID, o.paid)}${atRisk(o) ? pill(RISK, o.risk) : ''}</span>
      <span class="sh-row-v">${esc(money(o.total, o.currency))}</span></button>`).join('');
    const more = list.length >= limit && limit < 100 ? `<button class="btn sh-more" data-sh="more">Afficher plus</button>` : '';
    paintIfChanged(lbox, shown.length ? `<div class="sh-list">${rows}</div>${more}` : `<p class="sh-sub sh-none">${q || filter !== 'all' ? 'Aucune commande ne correspond.' : 'Aucune commande pour l’instant.'}</p>${more}`);
  };
  const load = async (fresh = false): Promise<void> => {
    const mine = ++seq, query = [SERVER[filter], q].filter(Boolean).join(' ');
    if (fresh) api.forget(shop.domain);
    try { const r = await api.orders(shop, { query, first: limit }); if (mine !== seq) return; list = r; error = ''; }
    catch (e) { if (mine !== seq) return; error = errMsg(e); }
    paint();
  };
  const restart = (): void => { list = null; error = ''; paint(); void load(); };
  c.reload = () => { void load(true); };

  const search = debounce(() => restart(), 350);
  root.addEventListener('input', e => { const t = target(e); if (t.matches('[data-q]')) { q = (t as HTMLInputElement).value.trim(); search(); } });
  clicks(root, {
    filter: t => { const k = t.dataset.k as Filter | undefined; if (k && k !== filter) { filter = k; restart(); } },
    more: () => { limit = Math.min(100, limit + 50); void load(); },
    retry: () => { restart(); },
    order: t => { const o = list?.find(x => x.id === t.dataset.id); if (o) openOrder(c, o); },
  });
  paint();
  void load();
  poll(root, () => { if (!q) void load(true); });
}

/** Fiche d'une commande, dans une fenêtre. Les écritures demandent confirmation, puis la fiche et la liste sont relues. */
export function openOrder(c: Ctx, first: api.Order): void {
  let o = first, busy = false;
  const m = modal({ title: `Commande ${o.name}`, cls: 'sh-modal', html: '' });
  const fail = (msg: string): void => { const e = m.body.querySelector('[data-err]'); if (e) { e.textContent = msg; e.removeAttribute('hidden'); } };
  const clear = (): void => { const e = m.body.querySelector('[data-err]'); if (e) { e.textContent = ''; e.setAttribute('hidden', ''); } };
  const render = (): void => {
    const notes = links.notesFor(c.p, { kind: 'order', id: o.id, name: o.name });
    m.body.innerHTML = `<div class="sh-fiche">
      <div class="sh-meta">${pill(FULFIL, o.fulfillment)}${pill(PAID, o.paid)}${atRisk(o) ? pill(RISK, o.risk) : ''}<span class="sh-sub">${esc(full(o.at))}</span><strong class="sh-total">${esc(money(o.total, o.currency))}</strong></div>
      <section class="sh-block"><h4>Client</h4><p class="sh-p"><strong>${esc(o.customer || 'Client inconnu')}</strong>${o.email ? `<br><span class="sh-sub">${esc(o.email)}</span>` : ''}</p></section>
      <section class="sh-block"><h4>Articles</h4>${o.items.map(i => `<div class="sh-item"><b>${esc(String(i.quantity))} ×</b><span>${esc(i.title)}${i.sku ? `<small>${esc(i.sku)}</small>` : ''}</span></div>`).join('') || '<p class="sh-sub">Aucun article lu.</p>'}</section>
      <section class="sh-block"><h4>Note de la commande</h4><textarea class="field area" rows="3" data-note placeholder="Visible seulement de toi dans Shopify">${esc(o.note)}</textarea>
        <div class="sh-acts"><button class="btn" data-sh="save-note">Enregistrer la note</button></div></section>
      ${shippable(o) ? `<section class="sh-block"><h4>Expédition</h4><div class="sh-inline"><input class="field" data-track placeholder="Numéro de suivi (facultatif)" autocomplete="off" spellcheck="false" aria-label="Numéro de suivi">
        <button class="btn btn-primary" data-sh="fulfill">${icon('check')}Marquer comme expédiée</button></div>
        <p class="sh-sub">Le client est prévenu par e-mail seulement si tu donnes un numéro de suivi.</p></section>` : ''}
      ${linkedHTML(notes)}
      <p class="sh-err-inline" data-err hidden></p>
      <div class="modal-actions">${ext(o.url, 'Ouvrir dans Shopify')}<button class="btn" data-sh="task">${icon('plus')}Créer une tâche</button><button class="btn" data-sh="close">Fermer</button></div></div>`;
  };
  const refresh = async (): Promise<void> => {
    try { const n = await api.order(c.shop, o.id); if (n) o = n; } catch (e) { toast(errMsg(e)); }
    render(); c.reload();
  };
  const guarded = async (fn: () => Promise<void>): Promise<void> => { if (busy) return; busy = true; clear(); try { await fn(); } finally { busy = false; } };

  clicks(m.node, {
    close: () => m.close(),
    note: t => { const id = t.dataset.id; if (id) { m.close(); openNote(id); } },
    'save-note': () => guarded(async () => {
      const v = (m.body.querySelector<HTMLTextAreaElement>('[data-note]')?.value ?? '').trim();
      if (v === o.note.trim()) { toast('La note n’a pas changé.'); return; }
      const ok = await write({ title: `Modifier la note de ${o.name} ?`, ok: 'Enregistrer',
        text: v ? `La note de la commande ${o.name} deviendra : « ${v} ».` : `La note de la commande ${o.name} sera effacée.` }, () => api.setOrderNote(c.shop, o.id, v), 'Note enregistrée', fail);
      if (ok) await refresh();
    }),
    fulfill: () => guarded(async () => {
      const number = (m.body.querySelector<HTMLInputElement>('[data-track]')?.value ?? '').trim();
      const ok = await write({ title: `Marquer ${o.name} comme expédiée ?`, ok: 'Marquer comme expédiée',
        text: `Tout ce qui reste à expédier dans la commande ${o.name} sera marqué comme expédié. ${number ? `Le client sera prévenu par e-mail, avec le numéro de suivi ${number}.` : 'Le client ne sera pas prévenu (pas de numéro de suivi).'}` },
        () => api.fulfill(c.shop, o.id, number ? { number } : undefined), 'Commande marquée comme expédiée', fail);
      if (ok) await refresh();
    }),
    task: () => guarded(async () => {
      const num = `n°${o.name.replace(/^#/, '')}`;
      const r = await tasks.add(`${shippable(o) ? 'Expédier' : 'Suivre'} la commande ${num}${o.customer ? ` (${o.customer.replace(/[#@]/g, '')})` : ''}`, c.p.id);
      if (r) toast('Tâche créée dans le projet');
    }),
  });
  render();
}
