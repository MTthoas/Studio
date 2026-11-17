// Section « Produits » : recherche, filtres, liste avec image, repérage des fiches incomplètes, et fiche d'un produit
// (prix et stock par variante, statut, liens, notes liées, note de travail, marketing).
import { esc } from '../../lib/markdown.ts';
import { icon, modal, paintIfChanged, errMsg, toast, target } from '../../ui/kit.ts';
import * as api from '../../integrations/shopify/api.ts';
import * as links from './links.ts';
import { clicks, poll, money, int, pill, PRODUCT, img, ext, linkedHTML, errHTML, loadingHTML, write, debounce, openNote, parseNum, type Ctx } from './shop-common.ts';

type Filter = 'all' | 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'todo';
const FILTERS: [Filter, string][] = [['all', 'Tous'], ['ACTIVE', 'Actifs'], ['DRAFT', 'Brouillons'], ['ARCHIVED', 'Archivés'], ['todo', 'À compléter']];
const SERVER: Record<Filter, string> = { all: '', ACTIVE: 'status:active', DRAFT: 'status:draft', ARCHIVED: 'status:archived', todo: '' };

/** Ce qui manque à une fiche produit. */
export const missing = (p: api.Product): string[] => [!p.image ? 'Sans image' : '', !p.description.trim() ? 'Sans description' : '', !p.seoDescription.trim() ? 'Sans SEO' : ''].filter(Boolean);
const price = (p: api.Product, cur: string): string => p.priceMin === p.priceMax ? money(p.priceMin, cur) : `${money(p.priceMin, cur)} – ${money(p.priceMax, cur)}`;
const currency = (c: Ctx): string => c.shop.currency || 'EUR';
const VARIANT = (v: api.Variant): string => v.title === 'Default Title' ? 'Variante unique' : v.title;

export function mount(c: Ctx): void {
  const { root, shop } = c, cur = currency(c);
  let filter: Filter = 'all', q = '', limit = 40, list: api.Product[] | null = null, error = '', seq = 0;
  root.innerHTML = `<div class="sh-head"><div class="sh-seg" data-f></div><label class="sh-search">${icon('search')}<input class="field" data-q placeholder="Rechercher un produit…" autocomplete="off" spellcheck="false" aria-label="Rechercher un produit"></label></div><div data-list></div>`;
  const fbox = root.querySelector<HTMLElement>('[data-f]'), lbox = root.querySelector<HTMLElement>('[data-list]');

  const paint = (): void => {
    if (!root.isConnected || !fbox || !lbox) return;
    const todo = list ? list.filter(p => missing(p).length).length : 0;
    paintIfChanged(fbox, FILTERS.map(([k, l]) => `<button class="btn${k === filter ? ' on' : ''}" data-sh="filter" data-k="${k}">${esc(l)}${k === 'todo' && todo ? ` <span class="sh-count">${todo}</span>` : ''}</button>`).join(''));
    if (error) { paintIfChanged(lbox, errHTML(error)); return; }
    if (!list) { paintIfChanged(lbox, loadingHTML('Lecture des produits…')); return; }
    const shown = filter === 'todo' ? list.filter(p => missing(p).length) : list;
    const rows = shown.map(p => {
      const miss = missing(p);
      return `<button class="sh-row sh-prow" data-sh="product" data-id="${esc(p.id)}">${img(p.image)}
        <span class="sh-row-main"><strong>${esc(p.title)}</strong><span class="sh-sub">${esc([p.vendor, p.type].filter(Boolean).join(' · ') || p.handle)}</span>${miss.length ? `<span class="sh-miss">${miss.map(m => `<i>${esc(m)}</i>`).join('')}</span>` : ''}</span>
        <span class="sh-row-pills">${pill(PRODUCT, p.status)}</span>
        <span class="sh-row-stock${p.stock !== null && p.stock <= 5 ? ' warn' : ''}">${p.stock === null ? 'Stock non suivi' : `${esc(int(p.stock))} en stock`}</span>
        <span class="sh-row-v">${esc(price(p, cur))}</span></button>`;
    }).join('');
    const more = list.length >= limit && limit < 100 ? `<button class="btn sh-more" data-sh="more">Afficher plus</button>` : '';
    paintIfChanged(lbox, shown.length ? `<div class="sh-list">${rows}</div>${more}` : `<p class="sh-sub sh-none">${q || filter !== 'all' ? 'Aucun produit ne correspond.' : 'Aucun produit pour l’instant.'}</p>${more}`);
  };
  const load = async (fresh = false): Promise<void> => {
    const mine = ++seq, query = [SERVER[filter], q].filter(Boolean).join(' ');
    if (fresh) api.forget(shop.domain);
    try { const r = await api.products(shop, { query, first: limit }); if (mine !== seq) return; list = r; error = ''; }
    catch (e) { if (mine !== seq) return; error = errMsg(e); }
    paint();
  };
  const restart = (): void => { list = null; error = ''; paint(); void load(); };
  c.reload = () => { void load(true); };

  const search = debounce(() => restart(), 350);
  root.addEventListener('input', e => { const t = target(e); if (t.matches('[data-q]')) { q = (t as HTMLInputElement).value.trim(); search(); } });
  clicks(root, {
    filter: t => { const k = t.dataset.k as Filter | undefined; if (k && k !== filter) { filter = k; restart(); } },
    more: () => { limit = Math.min(100, limit + 40); void load(); },
    retry: () => { restart(); },
    product: t => { const p = list?.find(x => x.id === t.dataset.id); if (p) openProduct(c, p); },
  });
  paint();
  void load();
  poll(root, () => { if (!q) void load(true); });
}

/** Ouvre la fiche d'un produit d'après son identifiant (lu d'abord). */
export async function openProductById(c: Ctx, id: string): Promise<void> {
  const p = await api.product(c.shop, id);
  if (!p) { toast('Produit introuvable : il a peut-être été supprimé.'); return; }
  openProduct(c, p);
}

/** Fiche d'un produit, dans une fenêtre. Chaque écriture dit ce qui change, demande confirmation, puis relit le produit. */
export function openProduct(c: Ctx, first: api.Product): void {
  let p = first, busy = false;
  const cur = currency(c);
  const m = modal({ title: p.title, cls: 'sh-modal', html: '' });
  const err = (): HTMLElement | null => m.body.querySelector<HTMLElement>('[data-err]');
  const fail = (msg: string): void => { const e = err(); if (e) { e.textContent = msg; e.removeAttribute('hidden'); } };
  const render = (): void => {
    const notes = links.notesFor(c.p, { kind: 'product', id: p.id, name: p.title, handle: p.handle });
    const miss = missing(p);
    const variants = p.variants.map(v => `<div class="sh-var" data-v="${esc(v.id)}"><div class="sh-var-name"><strong>${esc(VARIANT(v))}</strong>${v.sku ? `<span class="sh-sub">${esc(v.sku)}</span>` : ''}</div>
      <div class="sh-var-edit"><label><span class="sh-k">Prix (${esc(cur)})</span><input class="field" data-price inputmode="decimal" value="${esc(v.price.toFixed(2).replace('.', ','))}" aria-label="Prix de ${esc(VARIANT(v))}"></label>
        <button class="btn" data-sh="price" data-v="${esc(v.id)}">Changer le prix</button></div>
      <div class="sh-var-edit"><label><span class="sh-k">Stock</span><input class="field" data-stock inputmode="numeric" value="${v.stock === null ? '' : esc(String(v.stock))}"${v.stock === null ? ' disabled placeholder="non suivi"' : ''} aria-label="Stock de ${esc(VARIANT(v))}"></label>
        <button class="btn" data-sh="stock" data-v="${esc(v.id)}"${v.stock === null ? ' disabled' : ''}>Changer le stock</button></div></div>`).join('');
    const statuses = (['ACTIVE', 'DRAFT', 'ARCHIVED'] as const).map(s => `<button class="btn${s === p.status ? ' on' : ''}" data-sh="status" data-s="${s}"${s === p.status ? ' disabled' : ''}>${esc(PRODUCT[s]?.[0] ?? s)}</button>`).join('');
    m.body.innerHTML = `<div class="sh-fiche"><div class="sh-hero">${img(p.image, 'sh-img lg')}<div class="sh-hero-main"><strong>${esc(p.title)}</strong>
      <span class="sh-sub">${esc([p.vendor, p.type].filter(Boolean).join(' · ') || p.handle)}</span><span class="sh-meta">${pill(PRODUCT, p.status)}<span class="sh-sub">${esc(price(p, cur))} · ${p.stock === null ? 'stock non suivi' : `${esc(int(p.stock))} en stock`}</span></span></div></div>
      ${miss.length ? `<p class="sh-warn">${icon('help')}Fiche incomplète : ${esc(miss.join(', ').toLowerCase())}.</p>` : ''}
      <section class="sh-block"><h4>Statut</h4><div class="sh-seg">${statuses}</div></section>
      <section class="sh-block"><h4>Variantes${p.variants.length >= 20 ? '<span class="sh-sub">20 premières</span>' : ''}</h4>${variants || '<p class="sh-sub">Aucune variante.</p>'}
        <p class="sh-sub">Le stock modifié est celui du premier emplacement de la boutique.</p></section>
      ${linkedHTML(notes)}
      <p class="sh-err-inline" data-err hidden></p>
      <div class="modal-actions sh-wrap"><button class="btn" data-sh="work-note">${icon('notes')}Note du produit</button><button class="btn" data-sh="marketing">${icon('sparkle')}Marketing</button>${ext(p.url, 'Ouvrir dans Shopify')}${p.status === 'ACTIVE' ? ext(p.onlineUrl, 'Voir dans la boutique', 'eye') : ''}<button class="btn" data-sh="close">Fermer</button></div></div>`;
  };
  const refresh = async (): Promise<void> => {
    try { const n = await api.product(c.shop, p.id); if (n) p = n; } catch (e) { toast(errMsg(e)); }
    render(); c.reload();
  };
  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return; busy = true;
    const e = err(); if (e) { e.textContent = ''; e.setAttribute('hidden', ''); }
    try { await fn(); } finally { busy = false; }
  };
  const variant = (t: HTMLElement): { v: api.Variant; row: HTMLElement } | null => {
    const v = p.variants.find(x => x.id === t.dataset.v), row = t.closest<HTMLElement>('.sh-var');
    return v && row ? { v, row } : null;
  };
  const name = (v: api.Variant): string => v.title === 'Default Title' ? `« ${p.title} »` : `« ${p.title} » (${v.title})`;

  clicks(m.node, {
    close: () => m.close(),
    note: t => { const id = t.dataset.id; if (id) { m.close(); openNote(id); } },
    'work-note': () => guarded(async () => { const n = await links.noteFor(c.p, p); m.close(); openNote(n.id); }),
    marketing: () => { const prod = p; m.close(); void import('./marketing.ts').then(x => x.openFor(c.p, prod)).catch(e => toast(errMsg(e))); },
    status: t => guarded(async () => {
      const s = t.dataset.s as api.Product['status'] | undefined; if (!s || s === p.status) return;
      const effect = s === 'ACTIVE' ? 'Il sera visible et achetable dans ta boutique.' : s === 'DRAFT' ? 'Il ne sera plus visible dans ta boutique.' : 'Il sera archivé et retiré de ta boutique.';
      const ok = await write({ title: `Passer « ${p.title} » en ${PRODUCT[s]?.[0].toLowerCase() ?? s} ?`, ok: 'Changer le statut', text: `Le statut de « ${p.title} » passe de ${PRODUCT[p.status]?.[0].toLowerCase() ?? p.status} à ${PRODUCT[s]?.[0].toLowerCase() ?? s}. ${effect}` },
        () => api.updateProduct(c.shop, p.id, { status: s }), 'Statut modifié', fail);
      if (ok) await refresh();
    }),
    price: t => guarded(async () => {
      const x = variant(t); if (!x) return;
      const n = parseNum(x.row.querySelector<HTMLInputElement>('[data-price]')?.value ?? '');
      if (!(n >= 0)) { fail('Prix invalide : écris un nombre, par exemple 24,90.'); return; }
      const next = Math.round(n * 100) / 100;
      if (next === x.v.price) { toast('Le prix n’a pas changé.'); return; }
      const ok = await write({ title: 'Changer le prix ?', ok: 'Changer le prix', text: `Passer le prix de ${name(x.v)} de ${money(x.v.price, cur)} à ${money(next, cur)} ?` },
        () => api.setPrice(c.shop, p.id, x.v.id, next), 'Prix modifié', fail);
      if (ok) await refresh();
    }),
    stock: t => guarded(async () => {
      const x = variant(t); if (!x || x.v.stock === null) return;
      const n = parseNum(x.row.querySelector<HTMLInputElement>('[data-stock]')?.value ?? '');
      if (!Number.isInteger(n) || n < 0) { fail('Stock invalide : écris un nombre entier, 0 ou plus.'); return; }
      if (n === x.v.stock) { toast('Le stock n’a pas changé.'); return; }
      const ok = await write({ title: 'Changer le stock ?', ok: 'Changer le stock', text: `Passer le stock de ${name(x.v)} de ${int(x.v.stock)} à ${int(n)} ?` },
        () => api.setStock(c.shop, x.v.inventoryItem, n), 'Stock modifié', fail);
      if (ok) await refresh();
    }),
  });
  render();
}
