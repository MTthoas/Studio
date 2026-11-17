// Bloc ```shopify (alias ```boutique) d'une note : chiffres, commandes, stock, produits et publicité de la boutique du projet.
// Une instruction par ligne ; chaque ligne devient un petit encadré qui se remplit seul (asynchrone) sans bloquer l'aperçu.
//
// L'aperçu d'une note est redessiné à chaque frappe : `block` rend donc tout de suite un HTML synchrone (le dernier rendu
// connu de la ligne, sinon un squelette) et ne relance une lecture que si ce rendu a plus de 60 s. Les lectures passent par
// le cache de l'API ; le remplissage retrouve les encadrés dans le document par leur clé (`data-sf-key`).
import * as shopify from '../../integrations/shopify/api.ts';
import * as meta from '../../integrations/meta/api.ts';
import { paidFr, fulfillFr, productStatusFr } from '../../integrations/shopify/tools.ts';
import * as vault from '../../core/vault.ts';
import * as model from '../projects/model.ts';
import { esc } from '../../lib/markdown.ts';
import { fold } from '../../lib/fuzzy.ts';
import { icon, paintIfChanged, errMsg } from '../../ui/kit.ts';
import { bars, trend, meter, bindTips } from '../../ui/chart.ts';
import type { Note } from '../../types.ts';

export const LANGS = new Set(['shopify', 'boutique']);

/** Les instructions, en Markdown (aide et nouveautés). */
export const HELP = [
  'Un bloc ` ```shopify ` (ou ` ```boutique `) affiche les chiffres de la boutique du projet de la note. Une instruction par ligne ; les lignes vides et celles qui commencent par `#` sont ignorées.',
  '',
  '- `ventes 30j` : ventes, commandes et panier moyen avec la tendance (`aujourd’hui`, `7j`, `30j`, `90j`, `mois`) ; `ventes 30j par jour` ajoute la courbe',
  '- `top produits 7j` : les produits les plus vendus ; `canaux 30j` : les ventes par canal',
  '- `commandes à expédier`, `commandes impayées` ou `commandes` : les 10 dernières, avec un lien vers l’admin',
  '- `stock < 5` : les variantes dont le stock est bas (seuil libre)',
  '- `commande: #1042` : le détail d’une commande',
  '- `produit: <handle>` : la carte d’un produit (prix, stock, statut)',
  '- `pub 7j` : dépense, clics et ROAS du compte publicitaire du projet (Meta connecté)',
  '- `objectif 5000` : avancement des ventes du mois vers un objectif',
  '- `boutique: nom.myshopify.com` : choisit une autre boutique que celle du projet de la note',
].join('\n');

// ---------- Instructions ----------
type Range = shopify.Range;
type Cmd =
  | { k: 'shop'; v: string }
  | { k: 'sales'; range: Range; daily: boolean }
  | { k: 'top'; range: Range }
  | { k: 'channels'; range: Range }
  | { k: 'orders'; filter: 'ship' | 'unpaid' | 'all' }
  | { k: 'stock'; n: number }
  | { k: 'order'; ref: string }
  | { k: 'product'; handle: string }
  | { k: 'ads'; range: Range }
  | { k: 'goal'; n: number }
  | { k: 'unknown'; text: string };

const RANGE_LABEL: Record<Range, string> = { today: 'aujourd’hui', '7d': '7 derniers jours', '30d': '30 derniers jours', '90d': '90 derniers jours', month: 'ce mois-ci' };
const SPAN: Record<Range, string> = { today: '1 j', '7d': '7 j', '30d': '30 j', '90d': '90 j', month: 'mois' };

function rangeOf(rest: string, def: Range = '30d'): Range {
  if (/aujourd|\bauj\b|today|\bjour\b/.test(rest) && !/\d\s*(j|jours?|d)\b/.test(rest)) return 'today';
  if (/\bmois\b|month/.test(rest)) return 'month';
  if (/trimestre/.test(rest)) return '90d';
  if (/semaine/.test(rest)) return '7d';
  const n = rest.match(/(\d+)\s*(?:j|jours?|d)\b/);
  if (n) { const v = Number(n[1]); return v <= 1 ? 'today' : v <= 7 ? '7d' : v <= 30 ? '30d' : '90d'; }
  return def;
}

function parseLine(raw: string): Cmd | null {
  const t = raw.trim();
  if (!t || t.startsWith('#')) return null;
  const s = fold(t.replace(/[’‘`]/g, '\'')).replace(/\s+/g, ' ').trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^boutique\s*:\s*(\S+)\s*$/i))) return { k: 'shop', v: m[1] ?? '' };
  if ((m = s.match(/^commandes?\s*:?\s*#?(\d{1,10})$/))) return { k: 'order', ref: m[1] ?? '' };
  if ((m = t.match(/^produits?\s*:?\s*([a-z0-9][a-z0-9_-]*)\s*$/i)) && !/^(top|phares?)$/i.test(m[1] ?? '')) return { k: 'product', handle: (m[1] ?? '').toLowerCase() };
  if ((m = s.match(/^stocks?\s*(?:<=?|inferieur(?:e|s)?\s*a|sous|moins de)?\s*(\d+)?$/))) return { k: 'stock', n: m[1] ? Number(m[1]) : 5 };
  if ((m = s.match(/^objectifs?\s*:?\s*([\d\s.,]+)\s*(?:€|eur|euros?)?$/))) {
    const n = Number((m[1] ?? '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? { k: 'goal', n } : { k: 'unknown', text: t };
  }
  if ((m = s.match(/^(?:pubs?|publicites?|ads|meta)\b(.*)$/))) return { k: 'ads', range: rangeOf(m[1] ?? '', '7d') };
  if ((m = s.match(/^(?:top|meilleures? ventes|produits? (?:phares?|top|vedettes?))\b(.*)$/))) return { k: 'top', range: rangeOf(m[1] ?? '') };
  if ((m = s.match(/^canal|^canaux\b(.*)$/))) return { k: 'channels', range: rangeOf(s) };
  if ((m = s.match(/^commandes?\b(.*)$/))) {
    const rest = m[1] ?? '';
    if (/expedi/.test(rest)) return { k: 'orders', filter: 'ship' };
    if (/impaye|non paye|attente de paiement/.test(rest)) return { k: 'orders', filter: 'unpaid' };
    if (!rest.trim()) return { k: 'orders', filter: 'all' };
    return { k: 'unknown', text: t };
  }
  if ((m = s.match(/^(?:ventes?|chiffres?|ca|chiffre d'affaires)\b(.*)$/))) {
    const rest = m[1] ?? '', daily = /par jour|jour par jour|quotidien|courbe|graphique/.test(rest);
    return { k: 'sales', range: rangeOf(rest.replace(/par jour|jour par jour/g, '')), daily };
  }
  return { k: 'unknown', text: t };
}

export function parse(code: string): Cmd[] {
  return code.split('\n').map(parseLine).filter((c): c is Cmd => c !== null);
}

// ---------- Boutique de la note ----------
type Found = { shop: shopify.ShopCreds } | { msg: string };
const MAC_ONLY = 'Visible dans l’app Mac.';
function shopFor(note: Note, cmds: Cmd[]): Found {
  const locked = vault.enabled() && !vault.isOpen();
  const known = (domain: string): Found => {
    const shop = shopify.shops().find(s => s.domain === domain);
    if (shop) return { shop };
    return { msg: locked ? 'Le coffre est verrouillé : déverrouille-le pour afficher ta boutique.' : `La boutique ${domain} n’est pas encore connectée : ajoute-la dans Réglages → Boutiques.` };
  };
  const line = [...cmds].reverse().find((c): c is Extract<Cmd, { k: 'shop' }> => c.k === 'shop');
  if (line) {
    const d = model.shopDomain(line.v);
    return d ? known(d) : { msg: `Domaine de boutique non reconnu : « ${line.v} ». Écris par exemple boutique: ma-boutique.myshopify.com.` };
  }
  const p = model.projectOfNote(note);
  if (p?.shopify) return known(p.shopify);
  return { msg: p
    ? `Le projet « ${p.name} » n’a pas encore de boutique : ajoute shopify: ma-boutique.myshopify.com dans son bloc projet, ou une ligne boutique: ma-boutique.myshopify.com ici.`
    : 'Pour relier une boutique, mets cette note dans un projet qui a un champ shopify: ma-boutique.myshopify.com, ou ajoute une ligne boutique: ma-boutique.myshopify.com dans ce bloc.' };
}

// ---------- Formats ----------
const day = (ms: number): string => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const link = (u: string): string => /^https:\/\/(admin\.shopify\.com|[a-z0-9.-]+\.(myshopify\.com|shopify\.com))\//.test(u) ? u : '#';
const webLink = (u: string): string => /^https:\/\//.test(u) ? u : '#';
const a = (href: string, label: string, cls = ''): string => `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
const cur = (shop: shopify.ShopCreds): string => shop.currency || 'EUR';
const tile = (label: string, value: string, extra = ''): string => `<div class="sf-tile"><span>${esc(label)}</span><b>${esc(value)}</b>${extra}</div>`;
const empty = (t: string): string => `<p class="sf-empty">${esc(t)}</p>`;
const pill = (t: string, warn = false): string => `<span class="sf-pill${warn ? ' warn' : ''}">${esc(t)}</span>`;
const cdn = (u: string): string => /^https:\/\/cdn\.shopify\.com\//.test(u) ? u : '';
const pct = (n: number): string => `${(n * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;

function orderStates(o: shopify.Order): string {
  const out = [pill(paidFr(o.paid), /PENDING|AUTHORIZED|PARTIALLY_PAID|VOIDED|EXPIRED/.test(o.paid)), pill(fulfillFr(o.fulfillment), /UNFULFILLED|PARTIALLY|ON_HOLD/.test(o.fulfillment))];
  if (o.risk === 'INVESTIGATE' || o.risk === 'CANCEL') out.push(pill(o.risk === 'CANCEL' ? 'risque élevé' : 'à vérifier', true));
  return out.join('');
}
const orderRow = (o: shopify.Order): string =>
  `<a class="sf-row" href="${esc(link(o.url))}" target="_blank" rel="noopener noreferrer"><span class="sf-id">${esc(o.name)}</span><span class="sf-main">${esc(o.customer || 'Client inconnu')}</span><span class="sf-sts">${orderStates(o)}</span><span class="sf-amt">${esc(shopify.money(o.total, o.currency))}</span><span class="sf-when">${esc(day(o.at))}</span></a>`;

// ---------- Rendu de chaque instruction ----------
interface Ctx { shop: shopify.ShopCreds; account: string | null }
interface View { icon: string; title: string; sub: string; body: (c: Ctx) => Promise<string> }

function view(cmd: Cmd): View | null {
  switch (cmd.k) {
    case 'sales': return { icon: 'graph', title: 'Ventes', sub: RANGE_LABEL[cmd.range], body: async ({ shop }) => {
      const s = await shopify.summary(shop, cmd.range), span = SPAN[cmd.range];
      const tiles = [tile('Ventes', shopify.money(s.sales, s.currency), trend(s.sales, s.prev.sales, span)), tile('Commandes', String(s.orders), trend(s.orders, s.prev.orders, span)),
        tile('Panier moyen', shopify.money(s.aov, s.currency), trend(s.aov, s.prev.aov, span))];
      if (s.conversion !== null) tiles.push(tile('Conversion', pct(s.conversion)));
      if (s.refunds > 0) tiles.push(tile('Remboursements', shopify.money(s.refunds, s.currency)));
      const points = s.byDay.map(d => ({ key: d.date, label: new Date(`${d.date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }), value: Math.round(d.sales) }));
      const chart = cmd.daily && points.length > 1 ? bars(points, { color: 'green', unit: s.currency, units: s.currency, summary: `Ventes par jour, ${RANGE_LABEL[cmd.range]}` }) : '';
      return `<div class="sf-tiles">${tiles.join('')}</div>${chart}`;
    } };
    case 'top': return { icon: 'graph', title: 'Produits les plus vendus', sub: RANGE_LABEL[cmd.range], body: async ({ shop }) => {
      const s = await shopify.summary(shop, cmd.range);
      if (!s.top.length) return empty('Aucune vente sur la période.');
      return s.top.slice(0, 8).map((p, i) => `<div class="sf-row"><span class="sf-id">${i + 1}</span><span class="sf-main">${esc(p.title)}</span><span class="sf-sts">× ${esc(p.quantity)}</span><span class="sf-amt">${esc(shopify.money(p.sales, s.currency))}</span></div>`).join('');
    } };
    case 'channels': return { icon: 'graph', title: 'Canaux de vente', sub: RANGE_LABEL[cmd.range], body: async ({ shop }) => {
      const s = await shopify.summary(shop, cmd.range), total = s.channels.reduce((n, c) => n + c.sales, 0);
      if (!s.channels.length) return empty('Aucun canal sur la période.');
      return s.channels.slice(0, 8).map(c => `<div class="sf-row"><span class="sf-main">${esc(c.name)}</span><span class="sf-bar">${meter(c.sales, total, 'blue')}</span><span class="sf-amt">${esc(shopify.money(c.sales, s.currency))}</span></div>`).join('');
    } };
    case 'orders': {
      const title = cmd.filter === 'ship' ? 'Commandes à expédier' : cmd.filter === 'unpaid' ? 'Commandes impayées' : 'Dernières commandes';
      const query = cmd.filter === 'ship' ? 'fulfillment_status:unfulfilled status:open' : cmd.filter === 'unpaid' ? 'financial_status:unpaid status:open' : '';
      return { icon: 'inbox', title, sub: '10 dernières', body: async ({ shop }) => {
        const list = await shopify.orders(shop, { query, first: 10 });
        return list.length ? list.map(orderRow).join('') : empty(cmd.filter === 'all' ? 'Aucune commande.' : 'Rien à signaler.');
      } };
    }
    case 'stock': return { icon: 'list', title: 'Stock bas', sub: `${cmd.n} ou moins`, body: async ({ shop }) => {
      const low = await shopify.lowStock(shop, cmd.n);
      if (!low.length) return empty(`Aucune variante à ${cmd.n} ou moins.`);
      const rows = low.slice(0, 15).map(({ product, variant }) => `<a class="sf-row" href="${esc(link(product.url))}" target="_blank" rel="noopener noreferrer"><span class="sf-main">${esc(product.title)}${variant.title && variant.title !== 'Default Title' ? ` <i>· ${esc(variant.title)}</i>` : ''}</span><span class="sf-sts">${variant.sku ? esc(variant.sku) : ''}</span><span class="sf-amt${(variant.stock ?? 0) <= 0 ? ' warn' : ''}">${esc(variant.stock ?? 0)}</span></a>`);
      return rows.join('') + (low.length > 15 ? `<p class="sf-empty">et ${low.length - 15} autre(s)</p>` : '');
    } };
    case 'order': return { icon: 'inbox', title: `Commande #${cmd.ref}`, sub: '', body: async ({ shop }) => {
      const o = await shopify.order(shop, cmd.ref);
      if (!o) return empty(`Commande #${cmd.ref} introuvable.`);
      const items = o.items.map(i => `<li>${esc(i.quantity)} × ${esc(i.title)}${i.sku ? ` <i>${esc(i.sku)}</i>` : ''}</li>`).join('');
      return `<div class="sf-order"><div class="sf-line"><strong>${esc(o.name)}</strong><span class="sf-sts">${orderStates(o)}</span><span class="sf-amt">${esc(shopify.money(o.total, o.currency))}</span></div>
        <div class="sf-meta">${esc(o.customer || 'Client inconnu')}${o.email ? ` · ${esc(o.email)}` : ''} · ${esc(new Date(o.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }))}</div>
        ${items ? `<ul class="sf-items">${items}</ul>` : ''}${o.note ? `<p class="sf-note">${esc(o.note)}</p>` : ''}<div class="sf-links">${a(link(o.url), 'Ouvrir dans l’admin', 'sf-lnk')}</div></div>`;
    } };
    case 'product': return { icon: 'notes', title: 'Produit', sub: cmd.handle, body: async ({ shop }) => {
      const p = await shopify.product(shop, cmd.handle);
      if (!p) return empty(`Produit « ${cmd.handle} » introuvable.`);
      const c = cur(shop), img = cdn(p.image);
      const price = p.priceMin === p.priceMax ? shopify.money(p.priceMin, c) : `${shopify.money(p.priceMin, c)} – ${shopify.money(p.priceMax, c)}`;
      const stock = p.stock === null ? 'stock non suivi' : `${p.stock} en stock`;
      const state = productStatusFr(p.status);
      return `<div class="sf-prod">${img ? `<img src="${esc(img)}" alt="${esc(p.title)}" loading="lazy" width="72" height="72">` : '<span class="sf-noimg"></span>'}
        <div class="sf-info"><strong>${esc(p.title)}</strong><div class="sf-meta">${esc(price)} · <span class="${p.stock !== null && p.stock <= 0 ? 'warn' : ''}">${esc(stock)}</span> · ${pill(state, p.status !== 'ACTIVE')}</div>
        <div class="sf-links">${a(link(p.url), 'Admin', 'sf-lnk')}${p.onlineUrl ? a(webLink(p.onlineUrl), 'Boutique', 'sf-lnk') : ''}</div></div></div>`;
    } };
    case 'ads': return { icon: 'bolt', title: 'Publicité', sub: RANGE_LABEL[cmd.range === 'today' ? 'today' : cmd.range === '7d' ? '7d' : '30d'], body: async ({ account }) => {
      if (!meta.connected()) return empty('Meta n’est pas connecté (Réglages → Boutiques → Meta).');
      if (!account) return empty('Ajoute meta: act_… au bloc du projet pour voir sa publicité.');
      const r = await meta.insights(account, cmd.range === 'today' ? 'today' : cmd.range === '7d' ? '7d' : '30d'), t = r.total;
      return `<div class="sf-tiles">${tile('Dépense', shopify.money(t.spend, r.currency))}${tile('Clics', String(t.clicks))}${tile('ROAS', t.roas === null ? '—' : `× ${t.roas.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`)}${tile('Achats', String(t.purchases))}</div>`;
    } };
    case 'goal': return { icon: 'graph', title: 'Objectif du mois', sub: '', body: async ({ shop }) => {
      const s = await shopify.summary(shop, 'month'), p = Math.round(s.sales / cmd.n * 100);
      const now = new Date(), left = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
      return `<div class="sf-goal"><div class="sf-line"><strong>${esc(shopify.money(s.sales, s.currency))}</strong><span class="sf-meta">sur ${esc(shopify.money(cmd.n, s.currency))} · ${esc(p)} %</span></div>${meter(Math.min(s.sales, cmd.n), cmd.n, 'green')}
        <div class="sf-meta">${s.sales >= cmd.n ? 'Objectif atteint.' : `Il reste ${esc(shopify.money(cmd.n - s.sales, s.currency))}${left > 0 ? ` et ${left} jour${left > 1 ? 's' : ''}` : ''}.`}</div></div>`;
    } };
    default: return null;
  }
}

// ---------- Rendus gardés en mémoire, remplissage asynchrone ----------
interface Job { run: () => Promise<string>; domain: string; html: string; at: number; busy: Promise<void> | null }
const FRESH = 60e3, MAX_JOBS = 200;
const jobs = new Map<string, Job>();
let queued = false, wired = false;

/** Lit (ou relit) une ligne et remplit tous ses encadrés visibles. */
function load(key: string, force = false): Promise<void> {
  const j = jobs.get(key);
  if (!j) return Promise.resolve();
  if (j.busy) return j.busy;
  if (!force && j.html && Date.now() - j.at < FRESH) { fill(key, j); return Promise.resolve(); }
  j.at = Date.now();
  mark(key, true);
  j.busy = j.run().then(h => { j.html = h; }, (e: unknown) => { j.html = `<p class="sf-err">${esc(errMsg(e))}</p>`; })
    .finally(() => { j.busy = null; j.at = Date.now(); fill(key, j); });
  return j.busy;
}
const parts = (key: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-sf-key]')].filter(e => e.dataset['sfKey'] === key);
function mark(key: string, busy: boolean): void { for (const e of parts(key)) e.classList.toggle('sf-busy', busy); }
function fill(key: string, j: Job): void {
  for (const e of parts(key)) {
    const body = e.querySelector<HTMLElement>('.sf-body');
    if (body) { if (paintIfChanged(body, j.html)) bindTips(e); }
    e.removeAttribute('data-sf-pending'); e.classList.remove('sf-busy');
    const w = e.querySelector<HTMLElement>('.sf-upd'); if (w) w.textContent = new Date(j.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
}
function flush(): void {
  const keys = new Set<string>();
  for (const e of document.querySelectorAll<HTMLElement>('[data-sf-pending]')) if (e.dataset['sfKey']) keys.add(e.dataset['sfKey']);
  for (const k of keys) void load(k);
}
/** Planifie un remplissage après l'insertion de l'aperçu dans le document (deux filets : image suivante et délai court). */
function schedule(): void {
  if (queued) return;
  queued = true;
  const go = (): void => { queued = false; flush(); };
  requestAnimationFrame(go);
  setTimeout(() => { queued = false; flush(); }, 250);
}
/** Une seule écoute déléguée pour tous les blocs : l'aperçu d'une note est recréé à chaque rendu (exception assumée à la règle des écouteurs). */
function listen(): void {
  if (wired) return;
  wired = true;
  document.addEventListener('click', e => {
    const t = (e.target as Element | null)?.closest?.('[data-sf-refresh]'); if (!t) return;
    const key = (t.closest('[data-sf-key]') as HTMLElement | null)?.dataset['sfKey'], j = key ? jobs.get(key) : undefined;
    if (!key || !j) return;
    e.preventDefault();
    shopify.forget(j.domain); meta.forget();
    void load(key, true);
  });
}

function part(cmd: Cmd, shop: shopify.ShopCreds, account: string | null): string {
  const v = view(cmd);
  if (!v) return '';
  const key = `${shop.domain}|${JSON.stringify(cmd)}`;
  let j = jobs.get(key);
  const run = (): Promise<string> => v.body({ shop, account });
  if (j) j.run = run;
  else {
    if (jobs.size >= MAX_JOBS) { const old = jobs.keys().next().value; if (old !== undefined) jobs.delete(old); }
    j = { run, domain: shop.domain, html: '', at: 0, busy: null };
    jobs.set(key, j);
  }
  const stale = !j.html || Date.now() - j.at >= FRESH, name = shop.name || shop.domain;
  if (stale && !j.busy) schedule();
  const when = j.at ? new Date(j.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  return `<section class="sf-part${j.busy ? ' sf-busy' : ''}" data-sf-key="${esc(key)}"${stale ? ' data-sf-pending' : ''}>
    <div class="sf-head">${icon(v.icon)}<span class="sf-t"><strong>${esc(v.title)}</strong> · ${esc(name)}${v.sub ? ` · ${esc(v.sub)}` : ''}</span><span class="sf-upd" title="Dernière lecture">${esc(when)}</span>
    <button class="icon-btn" data-sf-refresh title="Actualiser" aria-label="Actualiser">${icon('refresh')}</button></div>
    <div class="sf-body">${j.html || '<p class="sf-empty">Chargement…</p>'}</div></section>`;
}

const msg = (t: string): string => `<div class="sf"><section class="sf-part"><div class="sf-head">${icon('graph')}<span class="sf-t"><strong>Boutique</strong></span></div><div class="sf-body"><p class="sf-empty">${esc(t)}</p></div></section></div>`;
const helpLine = (text: string): string => `<p class="sf-help">${text ? `« ${esc(text)} » n’est pas une instruction connue. ` : ''}Instructions : ventes 30j · ventes 30j par jour · top produits 7j · canaux 30j · commandes à expédier · commandes impayées · commandes · stock &lt; 5 · commande: #1042 · produit: handle · pub 7j · objectif 5000 · boutique: domaine</p>`;

/** HTML synchrone du bloc : dernier rendu connu de chaque ligne (ou squelette), rempli ensuite tout seul. */
export function block(note: Note, code: string, _idx: number): string {
  if (!shopify.supported()) return msg(MAC_ONLY);
  const cmds = parse(code), found = shopFor(note, cmds);
  if ('msg' in found) return msg(found.msg);
  listen();
  const shop = found.shop, account = model.projects().find(p => p.shopify === shop.domain)?.meta ?? null;
  const out: string[] = [];
  for (const c of cmds) {
    if (c.k === 'shop') continue;
    if (c.k === 'unknown') { out.push(helpLine(c.text)); continue; }
    out.push(part(c, shop, account));
  }
  if (!out.length) out.push(helpLine(''));
  return `<div class="sf">${out.join('')}</div>`;
}
