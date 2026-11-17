// Shopify : lecture et écriture d'une boutique par l'API GraphQL Admin (version 2026-04), via le pont natif `commerce`
// (Mac seulement : jamais de fetch depuis la page, Shopify n'autorise pas le CORS). Les identifiants de chaque boutique
// sont dans le coffre (`shopify`, une liste de ShopCreds) ; l'app Mac les envoie à Shopify, la page ne reçoit jamais de jeton d'accès.
// Les lectures sont gardées ~60 s en mémoire et partagées : ne jamais modifier en place ce qu'elles rendent.
// Toute écriture réussie vide le cache de la boutique. L'appelant a déjà demandé confirmation à l'utilisateur.
import * as native from '../../core/native.ts';
import * as vault from '../../core/vault.ts';
import * as model from '../../features/projects/model.ts';
import type { Project } from '../../features/projects/model.ts';

export interface ShopCreds { domain: string; name: string; token?: string; clientId?: string; clientSecret?: string; currency?: string }

/** Droits d'API à cocher sur l'app Shopify pour que tout fonctionne (guide de connexion). */
export const SCOPES: string[] = [
  'read_products', 'write_products', 'read_orders', 'write_orders', 'read_customers',
  'read_inventory', 'write_inventory', 'read_locations', 'read_discounts', 'write_discounts', 'read_reports',
  'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
];

/** Seule l'app Mac parle à Shopify (le pont `commerce` n'est pas ouvert aux appareils liés). */
export const supported = (): boolean => native.available() && document.documentElement.dataset.native === 'mac';

// ---------- Identifiants (coffre) ----------
const list = (): ShopCreds[] => { const v = vault.secret<ShopCreds[]>('shopify'); return Array.isArray(v) ? v.filter(s => !!s && typeof s.domain === 'string') : []; };
export const shops = (): ShopCreds[] => list();
export const shopOf = (p: Project): ShopCreds | null => (p.shopify && list().find(s => s.domain === p.shopify)) || null;
export const connected = (p: Project): boolean => !!shopOf(p);

function needVault(): void {
  if (!vault.enabled()) throw new Error('Active d’abord le coffre (Réglages → Coffre) : les accès à la boutique y sont gardés chiffrés.');
  if (!vault.isOpen()) throw new Error('Le coffre est verrouillé : déverrouille-le d’abord.');
}

/** Ajoute ou remplace une boutique (même domaine) après avoir vérifié les identifiants par une requête `shop`. */
export async function saveShop(c: ShopCreds): Promise<ShopCreds> {
  const domain = model.shopDomain(c.domain);
  if (!domain) throw new Error('Adresse de boutique invalide : elle doit ressembler à nom.myshopify.com.');
  const token = c.token?.trim(), clientId = c.clientId?.trim(), clientSecret = c.clientSecret?.trim();
  if (!token && !(clientId && clientSecret)) throw new Error('Indique le jeton d’accès, ou l’identifiant client et la clé secrète de l’app.');
  needVault();
  const auth: Partial<ShopCreds> = token ? { token } : { clientId: clientId ?? '', clientSecret: clientSecret ?? '' };
  const probe: ShopCreds = { domain, name: c.name, ...auth };
  const d = await gql<{ shop: { name: string; currencyCode: string } }>(probe, 'query { shop { name currencyCode } }');
  const saved: ShopCreds = { domain, name: d.shop.name || c.name || domain, currency: d.shop.currencyCode, ...auth };
  await vault.setSecret('shopify', [...list().filter(s => s.domain !== domain), saved]);
  forget(domain);
  return saved;
}
export async function removeShop(domain: string): Promise<void> {
  needVault();
  await vault.setSecret('shopify', list().filter(s => s.domain !== domain));
  forget(domain);
}

// ---------- Requêtes ----------
interface GqlError { message?: string; extensions?: { code?: string } }
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const scopeIn = (errors: unknown[]): string => {
  for (const e of errors) { const m = /\b(?:read|write)_[a-z_]+/.exec((e as GqlError | null)?.message ?? ''); if (m) return m[0]; }
  return '';
};

/** Requête ou mutation GraphQL, sans cache. Lève une Error au message français, utilisable tel quel dans l'interface. */
export async function gql<T>(shop: ShopCreds, query: string, variables?: object, retry = true): Promise<T> {
  if (!supported()) throw new Error('Shopify n’est disponible que dans l’app Studio pour Mac.');
  const auth = shop.token ? { token: shop.token } : { clientId: shop.clientId ?? '', clientSecret: shop.clientSecret ?? '' };
  const r = await native.call('commerce', 'shopify', { shop: shop.domain, ...auth, query, ...(variables ? { variables } : {}) }, 45000);
  const errors = Array.isArray(r.errors) ? r.errors as unknown[] : [];
  if (r.ok && !errors.length) return (r.data ?? {}) as T;
  const codes = errors.map(e => (e as GqlError | null)?.extensions?.code);
  if (retry && (r.status === 429 || codes.includes('THROTTLED'))) { await wait(2000); return gql<T>(shop, query, variables, false); }
  if (r.status === 403 || codes.includes('ACCESS_DENIED')) {
    const s = scopeIn(errors);
    if (s) throw new Error(`Il manque le droit ${s} à l’app Shopify : ajoute-le dans la configuration de l’app, puis réinstalle-la sur la boutique.`);
  }
  const first = (errors[0] as GqlError | null)?.message;
  throw new Error(r.message || first || 'Shopify a répondu avec une erreur.');
}

// ---------- Cache de lecture ----------
const FRESH = 60e3, CACHE_MAX = 300;
const cache = new Map<string, { at: number; data: unknown }>(), inflight = new Map<string, Promise<unknown>>();
let epoch = 0;
/** Vide le cache de lecture (d'une boutique, ou de toutes). Appelé après chaque écriture réussie. */
export const forget = (domain?: string): void => {
  epoch++;
  const mine = (k: string) => !domain || k.startsWith(domain + '\u0000');
  for (const k of [...cache.keys()]) if (mine(k)) cache.delete(k);
  for (const k of [...inflight.keys()]) if (mine(k)) inflight.delete(k);
};
function cached<T>(shop: ShopCreds, key: string, load: () => Promise<T>, fresh = false): Promise<T> {
  const k = `${shop.domain}\u0000${key}`, hit = cache.get(k), run = inflight.get(k);
  if (!fresh) {
    if (hit && Date.now() - hit.at < FRESH) return Promise.resolve(hit.data as T);
    if (run) return run as Promise<T>;
  }
  const started = epoch;
  const p = load().then(data => {
    if (epoch === started) { cache.delete(k); cache.set(k, { at: Date.now(), data }); if (cache.size > CACHE_MAX) { const old = cache.keys().next().value; if (old !== undefined) cache.delete(old); } }
    return data;
  }).finally(() => { if (inflight.get(k) === p) inflight.delete(k); });
  inflight.set(k, p);
  return p;
}
/** `gql` en lecture, mis en cache ~60 s par (boutique, requête, variables). Ne pas modifier le résultat. */
export const read = <T>(shop: ShopCreds, query: string, variables?: object, fresh = false): Promise<T> =>
  cached(shop, query + '\u0000' + JSON.stringify(variables ?? {}), () => gql<T>(shop, query, variables), fresh);

/** Écriture : lève si `userErrors` n'est pas vide (messages joints). */
function check(errs: { field?: string[] | null; message: string }[] | undefined | null): void {
  if (errs?.length) throw new Error(errs.map(e => e.message).join(' ; '));
}
async function write<T>(shop: ShopCreds, query: string, variables: object, pick: (d: T) => { message: string }[] | undefined): Promise<T> {
  const d = await gql<T>(shop, query, variables);
  check(pick(d));
  forget(shop.domain);
  return d;
}

// ---------- Aides ----------
const num = (v: unknown): number => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0; };
const at = (v: string | null | undefined): number => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0; };
const tail = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const shopName = (shop: ShopCreds): string => shop.domain.replace(/\.myshopify\.com$/, '');
export const adminUrl = (shop: ShopCreds, path = ''): string => `https://admin.shopify.com/store/${shopName(shop)}${path ? '/' + path.replace(/^\//, '') : ''}`;
export const money = (n: number, currency: string): string => {
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(n); }
  catch { return `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${currency}`; }
};
interface Money { shopMoney: { amount: string; currencyCode: string } }
interface Page<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
const MONEY = 'shopMoney { amount currencyCode }';
const PAGE = 'pageInfo { hasNextPage endCursor }';

/** Lit des pages successives (par curseur) jusqu'à `max` éléments. */
async function paged<T>(max: number, size: number, one: (after: string | null, n: number) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = []; let after: string | null = null;
  while (out.length < max) {
    const p: Page<T> = await one(after, Math.min(size, max - out.length));
    out.push(...p.nodes);
    if (!p.pageInfo.hasNextPage || !p.pageInfo.endCursor) break;
    after = p.pageInfo.endCursor;
  }
  return out.slice(0, max);
}
const count = (n: number | undefined, def: number, max: number): number => Math.max(1, Math.min(max, Math.floor(n ?? def)));
const search = (q: string | undefined): string => (q ?? '').trim();

// ---------- Commandes ----------
export interface Order { id: string; name: string; at: number; customer: string; email: string; total: number; currency: string; paid: string; fulfillment: string;
  risk: string; note: string; items: { title: string; quantity: number; sku: string }[]; url: string }
interface OrderNode { id: string; name: string; createdAt: string; email: string | null; note: string | null; displayFinancialStatus: string | null; displayFulfillmentStatus: string;
  customer: { displayName: string } | null; totalPriceSet: Money; risk: { recommendation: string } | null;
  lineItems: { nodes: { title: string; quantity: number; sku: string | null }[] } }
// Coût de requête borné à 1000 par Shopify : peu de lignes par commande, pages de 40.
const ORDER = `id name createdAt email note displayFinancialStatus displayFulfillmentStatus customer { displayName } totalPriceSet { ${MONEY} }
  risk { recommendation } lineItems(first: 8) { nodes { title quantity sku } }`;
const toOrder = (shop: ShopCreds, o: OrderNode): Order => ({
  id: o.id, name: o.name, at: at(o.createdAt), customer: o.customer?.displayName ?? '', email: o.email ?? '',
  total: num(o.totalPriceSet.shopMoney.amount), currency: o.totalPriceSet.shopMoney.currencyCode,
  paid: o.displayFinancialStatus ?? '', fulfillment: o.displayFulfillmentStatus, risk: o.risk?.recommendation ?? 'NONE', note: o.note ?? '',
  items: o.lineItems.nodes.map(i => ({ title: i.title, quantity: i.quantity, sku: i.sku ?? '' })), url: adminUrl(shop, `orders/${tail(o.id)}`),
});
/** Commandes, les plus récentes d'abord. `query` suit la recherche Shopify (ex. `fulfillment_status:unfulfilled`). */
export async function orders(shop: ShopCreds, o: { query?: string; first?: number } = {}): Promise<Order[]> {
  const max = count(o.first, 50, 100), q = search(o.query);
  const nodes = await paged<OrderNode>(max, 40, async (after, n) =>
    (await read<{ orders: Page<OrderNode> }>(shop, `query($n: Int!, $after: String, $q: String) { orders(first: $n, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER} } ${PAGE} } }`, { n, after, q: q || null })).orders);
  return nodes.map(n => toOrder(shop, n));
}
/** Une commande par son nom (« #1042 », « 1042 ») ou son identifiant gid. */
export async function order(shop: ShopCreds, idOrName: string): Promise<Order | null> {
  const v = idOrName.trim();
  if (v.startsWith('gid://')) {
    const d = await read<{ order: OrderNode | null }>(shop, `query($id: ID!) { order(id: $id) { ${ORDER} } }`, { id: v });
    return d.order ? toOrder(shop, d.order) : null;
  }
  const d = await read<{ orders: { nodes: OrderNode[] } }>(shop, `query($q: String!) { orders(first: 1, query: $q) { nodes { ${ORDER} } } }`, { q: `name:${v.replace(/^#/, '')}` });
  const n = d.orders.nodes[0];
  return n ? toOrder(shop, n) : null;
}

// ---------- Produits ----------
export interface Variant { id: string; title: string; sku: string; price: number; compareAt: number | null; stock: number | null; inventoryItem: string; cost: number | null }
export interface Product { id: string; title: string; handle: string; status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED'; vendor: string; type: string; tags: string[];
  description: string; descriptionHtml: string; seoTitle: string; seoDescription: string; image: string; images: string[]; stock: number | null;
  priceMin: number; priceMax: number; variants: Variant[]; url: string; onlineUrl: string }
interface ProductNode { id: string; title: string; handle: string; status: Product['status']; vendor: string; productType: string; tags: string[]; description: string; descriptionHtml: string;
  seo: { title: string | null; description: string | null }; featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  media: { nodes: { image?: { url: string } | null }[] }; totalInventory: number | null; onlineStoreUrl: string | null;
  priceRangeV2: { minVariantPrice: { amount: string }; maxVariantPrice: { amount: string } };
  variants: { nodes: { id: string; title: string; sku: string | null; price: string; compareAtPrice: string | null; inventoryQuantity: number | null; inventoryItem: { id: string; unitCost: { amount: string } | null } }[] } }
// Pages de 10 produits à 20 variantes : le coût demandé reste sous la limite de 1000 points.
const PRODUCT = `id title handle status vendor productType tags description descriptionHtml seo { title description }
  featuredMedia { preview { image { url } } } media(first: 4) { nodes { ... on MediaImage { image { url } } } }
  totalInventory onlineStoreUrl priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
  variants(first: 20) { nodes { id title sku price compareAtPrice inventoryQuantity inventoryItem { id unitCost { amount } } } }`;
const toProduct = (shop: ShopCreds, p: ProductNode): Product => {
  const image = p.featuredMedia?.preview?.image?.url ?? '';
  const images = p.media.nodes.flatMap(m => m.image?.url ? [m.image.url] : []);
  return {
    id: p.id, title: p.title, handle: p.handle, status: p.status, vendor: p.vendor, type: p.productType, tags: p.tags,
    description: p.description, descriptionHtml: p.descriptionHtml, seoTitle: p.seo.title ?? '', seoDescription: p.seo.description ?? '',
    image: image || images[0] || '', images, stock: p.totalInventory, priceMin: num(p.priceRangeV2.minVariantPrice.amount), priceMax: num(p.priceRangeV2.maxVariantPrice.amount),
    variants: p.variants.nodes.map(v => ({ id: v.id, title: v.title, sku: v.sku ?? '', price: num(v.price), compareAt: v.compareAtPrice == null ? null : num(v.compareAtPrice),
      stock: v.inventoryQuantity, inventoryItem: v.inventoryItem.id, cost: v.inventoryItem.unitCost ? num(v.inventoryItem.unitCost.amount) : null })),
    url: adminUrl(shop, `products/${tail(p.id)}`), onlineUrl: p.onlineStoreUrl ?? '',
  };
};
const productPage = (shop: ShopCreds, q: string, sort: string, reverse: boolean) => async (after: string | null, n: number): Promise<Page<ProductNode>> =>
  (await read<{ products: Page<ProductNode> }>(shop, `query($n: Int!, $after: String, $q: String) { products(first: $n, after: $after, query: $q, sortKey: ${sort}, reverse: ${reverse}) { nodes { ${PRODUCT} } ${PAGE} } }`, { n, after, q: q || null })).products;
/** Produits, modifiés en dernier d'abord (30 par défaut, 100 au plus ; lus par pages de 10). */
export async function products(shop: ShopCreds, o: { query?: string; first?: number } = {}): Promise<Product[]> {
  const nodes = await paged(count(o.first, 30, 100), 10, productPage(shop, search(o.query), 'UPDATED_AT', true));
  return nodes.map(n => toProduct(shop, n));
}
/** Un produit par son gid ou son handle. */
export async function product(shop: ShopCreds, idOrHandle: string): Promise<Product | null> {
  const v = idOrHandle.trim();
  if (v.startsWith('gid://')) {
    const d = await read<{ product: ProductNode | null }>(shop, `query($id: ID!) { product(id: $id) { ${PRODUCT} } }`, { id: v });
    return d.product ? toProduct(shop, d.product) : null;
  }
  const d = await read<{ products: { nodes: ProductNode[] } }>(shop, `query($q: String!) { products(first: 1, query: $q) { nodes { ${PRODUCT} } } }`, { q: `handle:${v}` });
  const n = d.products.nodes[0];
  return n ? toProduct(shop, n) : null;
}
/** Variantes dont le stock suivi est ≤ `threshold` (5 par défaut), parcourues du stock total le plus bas au plus haut (60 produits au plus). */
export async function lowStock(shop: ShopCreds, threshold = 5): Promise<{ product: Product; variant: Variant }[]> {
  const out: { product: Product; variant: Variant }[] = [], page = productPage(shop, '', 'INVENTORY_TOTAL', false);
  let after: string | null = null;
  for (let i = 0; i < 6; i++) {
    const p: Page<ProductNode> = await page(after, 10), before = out.length;
    for (const n of p.nodes) { const pr = toProduct(shop, n); for (const v of pr.variants) if (v.stock !== null && v.stock <= threshold) out.push({ product: pr, variant: v }); }
    if (!p.pageInfo.hasNextPage || !p.pageInfo.endCursor || (out.length === before && p.nodes.every(n => (n.totalInventory ?? 0) > threshold * 20))) break;
    after = p.pageInfo.endCursor;
  }
  return out;
}

// ---------- Clients et réductions ----------
export interface Customer { id: string; name: string; email: string; orders: number; spent: number; last: number | null; url: string }
interface CustomerNode { id: string; displayName: string; defaultEmailAddress: { emailAddress: string | null } | null; numberOfOrders: string | number; amountSpent: { amount: string }; lastOrder: { createdAt: string } | null }
/** Clients, mis à jour en dernier d'abord. Nécessite l'accès aux données protégées des clients (nom, e-mail) pour l'app. */
export async function customers(shop: ShopCreds, o: { query?: string; first?: number } = {}): Promise<Customer[]> {
  const q = search(o.query);
  const nodes = await paged<CustomerNode>(count(o.first, 50, 100), 50, async (after, n) =>
    (await read<{ customers: Page<CustomerNode> }>(shop, `query($n: Int!, $after: String, $q: String) { customers(first: $n, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) {
      nodes { id displayName defaultEmailAddress { emailAddress } numberOfOrders amountSpent { amount } lastOrder { createdAt } } ${PAGE} } }`, { n, after, q: q || null })).customers);
  return nodes.map(c => ({ id: c.id, name: c.displayName, email: c.defaultEmailAddress?.emailAddress ?? '', orders: num(c.numberOfOrders), spent: num(c.amountSpent.amount),
    last: c.lastOrder ? at(c.lastOrder.createdAt) || null : null, url: adminUrl(shop, `customers/${tail(c.id)}`) }));
}
export interface Discount { id: string; code: string; title: string; status: string; used: number; summary: string }
interface DiscountNode { id: string; discount: { title?: string; status?: string; summary?: string; asyncUsageCount?: number; codes?: { nodes: { code: string }[] } } }
/** Les 50 dernières réductions (codes et automatiques ; `code` est vide pour une réduction automatique). */
export async function discounts(shop: ShopCreds): Promise<Discount[]> {
  const code = 'title status summary asyncUsageCount codes(first: 1) { nodes { code } }', auto = 'title status summary asyncUsageCount';
  const d = await read<{ discountNodes: { nodes: DiscountNode[] } }>(shop, `query { discountNodes(first: 50, reverse: true) { nodes { id discount {
    ... on DiscountCodeBasic { ${code} } ... on DiscountCodeBxgy { ${code} } ... on DiscountCodeFreeShipping { ${code} }
    ... on DiscountAutomaticBasic { ${auto} } ... on DiscountAutomaticBxgy { ${auto} } ... on DiscountAutomaticFreeShipping { ${auto} } } } } }`);
  return d.discountNodes.nodes.map(n => ({ id: n.id, code: n.discount.codes?.nodes[0]?.code ?? '', title: n.discount.title ?? '', status: n.discount.status ?? '',
    used: n.discount.asyncUsageCount ?? 0, summary: n.discount.summary ?? '' }));
}

// ---------- Chiffres ----------
export type Range = 'today' | '7d' | '30d' | '90d' | 'month';
export interface Summary { range: Range; currency: string; sales: number; orders: number; aov: number; sessions: number | null; conversion: number | null;
  refunds: number; prev: { sales: number; orders: number; aov: number }; byDay: { date: string; sales: number; orders: number }[];
  top: { id: string; title: string; quantity: number; sales: number }[]; channels: { name: string; sales: number }[] }

const addDays = (s: string, n: number): string => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dayIn = (tz: string) => {
  let f: Intl.DateTimeFormat;
  try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  return (t: number | Date): string => f.format(t);
};
interface Table { columns: { name: string }[]; rows: unknown }
/** Requête ShopifyQL : lignes sous forme d'objets { colonne: valeur }. Lève si la requête est refusée ou mal formée. */
async function shopifyql(shop: ShopCreds, q: string): Promise<Record<string, unknown>[]> {
  const d = await gql<{ shopifyqlQuery: { tableData: Table | null; parseErrors: string[] } | null }>(shop,
    'query($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name dataType } rows } parseErrors } }', { q });
  const r = d.shopifyqlQuery;
  if (!r) throw new Error('ShopifyQL n’a rien répondu.');
  if (r.parseErrors?.length) throw new Error(r.parseErrors.join(' ; '));
  if (!r.tableData) throw new Error('ShopifyQL n’a pas rendu de tableau.');
  const cols = r.tableData.columns.map(c => c.name), rows = Array.isArray(r.tableData.rows) ? r.tableData.rows as unknown[] : [];
  return rows.map(row => Array.isArray(row) ? Object.fromEntries(cols.map((c, i) => [c, row[i]])) : (row && typeof row === 'object' ? row as Record<string, unknown> : {}));
}
const productGid = (v: unknown): string => { const s = String(v ?? ''); return /^\d+$/.test(s) ? `gid://shopify/Product/${s}` : s; };

interface Period { start: string; end: string; prevStart: string; days: string[] }
const period = (range: Range, today: string): Period => {
  const start = range === 'today' ? today : range === 'month' ? today.slice(0, 8) + '01' : addDays(today, -({ '7d': 6, '30d': 29, '90d': 89 }[range]));
  const len = Math.round((Date.parse(today) - Date.parse(start)) / 864e5) + 1;
  return { start, end: today, prevStart: addDays(start, -len), days: Array.from({ length: len }, (_, i) => addDays(start, i)) };
};
interface Daily { sales: number; orders: number }
const finish = (range: Range, currency: string, per: Period, daily: Map<string, Daily>, refunds: number, extra: Pick<Summary, 'sessions' | 'conversion' | 'top' | 'channels'>): Summary => {
  const prevEnd = addDays(per.start, -1), sum = (from: string, to: string): Daily => {
    const t: Daily = { sales: 0, orders: 0 };
    for (const [d, v] of daily) if (d >= from && d <= to) { t.sales += v.sales; t.orders += v.orders; }
    return t;
  };
  const cur = sum(per.start, per.end), prev = sum(per.prevStart, prevEnd), aov = (t: Daily) => t.orders ? t.sales / t.orders : 0;
  return { range, currency, sales: cur.sales, orders: cur.orders, aov: aov(cur), refunds, prev: { sales: prev.sales, orders: prev.orders, aov: aov(prev) },
    byDay: per.days.map(date => ({ date, sales: daily.get(date)?.sales ?? 0, orders: daily.get(date)?.orders ?? 0 })), ...extra };
};

/** Ventes de la période (fuseau de la boutique) comparées à la période précédente de même durée.
 *  ShopifyQL d'abord (droit read_reports) ; s'il est refusé, calcul d'après les commandes (~1000 au plus, sans sessions ni conversion). */
export function summary(shop: ShopCreds, range: Range, fresh = false): Promise<Summary> {
  return cached(shop, `summary:${range}`, async () => {
    const info = await read<{ shop: { currencyCode: string; ianaTimezone: string } }>(shop, 'query { shop { currencyCode ianaTimezone } }', undefined, fresh);
    const currency = info.shop.currencyCode, day = dayIn(info.shop.ianaTimezone), per = period(range, day(Date.now()));
    const win = `SINCE ${per.start} UNTIL ${per.end}`;
    try {
      const [series, top, channels, visits] = await Promise.all([
        shopifyql(shop, `FROM sales SHOW total_sales, orders, returns TIMESERIES day SINCE ${per.prevStart} UNTIL ${per.end}`),
        shopifyql(shop, `FROM sales SHOW total_sales, net_items_sold GROUP BY product_id, product_title ${win} ORDER BY total_sales DESC LIMIT 5`).catch(() => []),
        shopifyql(shop, `FROM sales SHOW total_sales GROUP BY sales_channel ${win} ORDER BY total_sales DESC LIMIT 8`).catch(() => []),
        shopifyql(shop, `FROM sessions SHOW sessions, conversion_rate ${win}`).catch(() => []),
      ]);
      const daily = new Map<string, Daily>(); let refunds = 0;
      for (const r of series) {
        const d = String(r.day ?? '').slice(0, 10); if (!d) continue;
        daily.set(d, { sales: num(r.total_sales), orders: num(r.orders) });
        if (d >= per.start && d <= per.end) refunds += Math.abs(num(r.returns));
      }
      const v = visits[0];
      return finish(range, currency, per, daily, refunds, {
        sessions: v && v.sessions != null ? num(v.sessions) : null, conversion: v && v.conversion_rate != null ? num(v.conversion_rate) : null,
        top: top.map(r => ({ id: productGid(r.product_id), title: String(r.product_title ?? ''), quantity: num(r.net_items_sold), sales: num(r.total_sales) })),
        channels: channels.map(r => ({ name: String(r.sales_channel ?? ''), sales: num(r.total_sales) })),
      });
    } catch { return summaryFromOrders(shop, range, currency, day, per); }
  }, fresh);
}

interface SumOrder { createdAt: string; cancelledAt: string | null; sourceName: string | null; totalPriceSet: Money; totalRefundedSet: Money;
  lineItems: { nodes: { title: string; quantity: number; product: { id: string } | null; discountedTotalSet: Money }[] } }
const CHANNEL: Record<string, string> = { web: 'Boutique en ligne', pos: 'Point de vente', shopify_draft_order: 'Commandes manuelles', iphone: 'Application mobile', android: 'Application mobile' };
/** Repli : ventes calculées d'après les commandes de la période et de la précédente (1000 au plus, les plus récentes). */
async function summaryFromOrders(shop: ShopCreds, range: Range, currency: string, day: (t: number) => string, per: Period): Promise<Summary> {
  const q = `created_at:>=${addDays(per.prevStart, -1)}`;
  const nodes = await paged<SumOrder>(1000, 40, async (after, n) =>
    (await gql<{ orders: Page<SumOrder> }>(shop, `query($n: Int!, $after: String, $q: String) { orders(first: $n, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes { createdAt cancelledAt sourceName totalPriceSet { ${MONEY} } totalRefundedSet { ${MONEY} }
      lineItems(first: 5) { nodes { title quantity product { id } discountedTotalSet { ${MONEY} } } } } ${PAGE} } }`, { n, after, q })).orders);
  const daily = new Map<string, Daily>(), tops = new Map<string, { id: string; title: string; quantity: number; sales: number }>(), chans = new Map<string, number>();
  let refunds = 0;
  for (const o of nodes) {
    if (o.cancelledAt) continue;
    const d = day(at(o.createdAt)), refunded = num(o.totalRefundedSet.shopMoney.amount), net = num(o.totalPriceSet.shopMoney.amount) - refunded;
    const t = daily.get(d) ?? { sales: 0, orders: 0 }; t.sales += net; t.orders++; daily.set(d, t);
    if (d < per.start || d > per.end) continue;
    refunds += refunded;
    const ch = CHANNEL[o.sourceName ?? ''] ?? (o.sourceName || 'Autre'); chans.set(ch, (chans.get(ch) ?? 0) + net);
    for (const li of o.lineItems.nodes) {
      const id = li.product?.id ?? li.title, e = tops.get(id) ?? { id: li.product?.id ?? '', title: li.title, quantity: 0, sales: 0 };
      e.quantity += li.quantity; e.sales += num(li.discountedTotalSet.shopMoney.amount); tops.set(id, e);
    }
  }
  return finish(range, currency, per, daily, refunds, {
    sessions: null, conversion: null,
    top: [...tops.values()].sort((a, b) => b.sales - a.sales).slice(0, 5),
    channels: [...chans].map(([name, sales]) => ({ name, sales })).sort((a, b) => b.sales - a.sales).slice(0, 8),
  });
}

// ---------- Écritures ----------
type UErr = { userErrors: { field?: string[] | null; message: string }[] };
/** Modifie un produit : titre, description (HTML), référencement, tags, statut. */
export async function updateProduct(shop: ShopCreds, id: string, patch: { title?: string; descriptionHtml?: string; seoTitle?: string; seoDescription?: string; tags?: string[]; status?: Product['status'] }): Promise<void> {
  const seo = patch.seoTitle !== undefined || patch.seoDescription !== undefined
    ? { seo: { ...(patch.seoTitle !== undefined ? { title: patch.seoTitle } : {}), ...(patch.seoDescription !== undefined ? { description: patch.seoDescription } : {}) } } : {};
  const input = { id, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.descriptionHtml !== undefined ? { descriptionHtml: patch.descriptionHtml } : {}),
    ...(patch.tags ? { tags: patch.tags } : {}), ...(patch.status ? { status: patch.status } : {}), ...seo };
  await write<{ productUpdate: UErr }>(shop, 'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }', { product: input }, d => d.productUpdate.userErrors);
}
/** Prix d'une variante ; `compareAt` : prix barré (`null` l'efface, absent = inchangé). */
export async function setPrice(shop: ShopCreds, productId: string, variantId: string, price: number, compareAt?: number | null): Promise<void> {
  if (!Number.isFinite(price) || price < 0) throw new Error('Prix invalide.');
  const v: Record<string, unknown> = { id: variantId, price: price.toFixed(2) };
  if (compareAt !== undefined) v.compareAtPrice = compareAt === null ? null : compareAt.toFixed(2);
  await write<{ productVariantsBulkUpdate: UErr }>(shop, 'mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } } }',
    { productId, variants: [v] }, d => d.productVariantsBulkUpdate.userErrors);
}
/** Stock « disponible » (quantité absolue) au premier emplacement actif. */
export async function setStock(shop: ShopCreds, inventoryItem: string, quantity: number): Promise<void> {
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error('La quantité doit être un entier positif ou nul.');
  const l = await gql<{ locations: { nodes: { id: string }[] } }>(shop, 'query { locations(first: 1) { nodes { id } } }');
  const loc = l.locations.nodes[0]?.id; if (!loc) throw new Error('Aucun emplacement actif sur la boutique.');
  // Depuis 2026-04 : `changeFromQuantity` doit être passé (null = sans contrôle) et la mutation demande une clé d'idempotence.
  const key = globalThis.crypto.randomUUID();
  await write<{ inventorySetQuantities: UErr }>(shop, `mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) @idempotent(key: "${key}") { userErrors { field message } } }`,
    { input: { name: 'available', reason: 'correction', quantities: [{ inventoryItemId: inventoryItem, locationId: loc, quantity, changeFromQuantity: null }] } }, d => d.inventorySetQuantities.userErrors);
}
/** Expédie tout ce qui reste à expédier de la commande ; le client est prévenu seulement si un numéro de suivi est donné. */
export async function fulfill(shop: ShopCreds, orderId: string, tracking?: { number?: string; company?: string; url?: string }): Promise<void> {
  const d = await gql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string }[] } } | null }>(shop,
    'query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status } } } }', { id: orderId });
  const open = (d.order?.fulfillmentOrders.nodes ?? []).filter(f => f.status === 'OPEN' || f.status === 'IN_PROGRESS');
  if (!d.order) throw new Error('Commande introuvable.');
  if (!open.length) throw new Error('Rien à expédier : cette commande n’a plus d’article en attente d’expédition.');
  const info = tracking && (tracking.number || tracking.company || tracking.url)
    ? { trackingInfo: { ...(tracking.number ? { number: tracking.number } : {}), ...(tracking.company ? { company: tracking.company } : {}), ...(tracking.url ? { url: tracking.url } : {}) } } : {};
  await write<{ fulfillmentCreate: UErr }>(shop, 'mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }',
    { f: { notifyCustomer: !!tracking?.number, lineItemsByFulfillmentOrder: open.map(f => ({ fulfillmentOrderId: f.id })), ...info } }, r => r.fulfillmentCreate.userErrors);
}
export async function setOrderNote(shop: ShopCreds, orderId: string, note: string): Promise<void> {
  await write<{ orderUpdate: UErr }>(shop, 'mutation($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }', { input: { id: orderId, note } }, d => d.orderUpdate.userErrors);
}
/** Code de réduction (pourcentage ou montant fixe sur la commande), valable pour tous les clients, dès maintenant. */
export async function createDiscount(shop: ShopCreds, d: { code: string; percent?: number; amount?: number; endsAt?: string; usageLimit?: number }): Promise<void> {
  const code = d.code.trim(); if (!code) throw new Error('Le code est vide.');
  let value: Record<string, unknown>;
  if (d.percent !== undefined) { if (!(d.percent > 0 && d.percent <= 100)) throw new Error('Le pourcentage doit être entre 0 et 100.'); value = { percentage: d.percent / 100 }; }
  else if (d.amount !== undefined) { if (!(d.amount > 0)) throw new Error('Le montant doit être positif.'); value = { discountAmount: { amount: d.amount.toFixed(2), appliesOnEachItem: false } }; }
  else throw new Error('Indique un pourcentage ou un montant de réduction.');
  const basicCodeDiscount = { title: code, code, startsAt: new Date().toISOString(), context: { all: 'ALL' }, customerGets: { value, items: { all: true } },
    ...(d.endsAt ? { endsAt: d.endsAt } : {}), ...(d.usageLimit ? { usageLimit: Math.floor(d.usageLimit) } : {}) };
  await write<{ discountCodeBasicCreate: UErr }>(shop, 'mutation($d: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } } }',
    { d: basicCodeDiscount }, r => r.discountCodeBasicCreate.userErrors);
}
