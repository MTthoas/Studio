// Shopify, premier fournisseur du socle e-commerce (core.ts). API Admin en GraphQL, en lecture seule.
// Les requêtes partent de l'app native (native/Shared/Commerce.swift) : Shopify refuse celles d'une page web.
// Deux façons d'ouvrir une boutique :
//   - les identifiants d'une app du Dev Dashboard (Client ID + secret), échangés contre un jeton valable 24 h et
//     renouvelé tout seul : la voie des apps créées depuis 2026 ;
//   - un jeton d'accès Admin (`shpat_…`) d'une app personnalisée créée auparavant dans l'administration.
// Droits utiles, tous en lecture : read_orders, read_products, read_inventory. Sans read_all_orders, Shopify ne
// donne que les 60 derniers jours de commandes : la période lue (30 jours) tient dedans.
// Aucune donnée de client (nom, adresse, e-mail) n'est demandée.
import * as native from '../../core/native.ts';
import { LOW } from './core.ts';
import type { Conn, Order, Pay, Provider, Ship, Shop, Snapshot, StockLine } from './core.ts';

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?\.myshopify\.com$/;
/** `ma-boutique`, `ma-boutique.myshopify.com`, ou l'adresse de son administration : rend `ma-boutique.myshopify.com`. */
export function domain(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/^https?:\/\//, '');
  const admin = s.match(/^admin\.shopify\.com\/store\/([a-z0-9-]+)/);
  s = admin ? admin[1] ?? '' : (s.split(/[/?#]/)[0] ?? '');
  if (s && !s.includes('.')) s += '.myshopify.com';
  return DOMAIN_RE.test(s) ? s : null;
}
const handle = (d: string): string => d.replace(/\.myshopify\.com$/, '');
const adminUrl = (d: string, path = ''): string => `https://admin.shopify.com/store/${handle(d)}${path}`;
/** `gid://shopify/Order/123` → `123`. */
const num = (gid: string): string => gid.split('/').pop()?.replace(/\D.*$/, '') ?? '';

// ---------- Jetons ----------
// Jetons obtenus par échange d'identifiants : gardés en mémoire seulement, redemandés 5 minutes avant leur fin.
const minted = new Map<string, { token: string; exp: number }>();
const wait = (ms: number) => new Promise(ok => setTimeout(ok, ms));

const TOKEN_ERR: Record<string, string> = {
  shop_not_permitted: 'cette app et cette boutique ne sont pas dans la même organisation Shopify (Dev Dashboard)',
  invalid_client: 'Client ID ou secret refusé',
  application_cannot_be_found: 'app introuvable : vérifie le Client ID',
  invalid_request: 'l’app n’est pas installée sur cette boutique',
};

async function token(d: string, conn: Conn): Promise<string> {
  if ('token' in conn) return conn.token;
  const hit = minted.get(d);
  if (hit && hit.exp - Date.now() > 300e3) return hit.token;
  const r = await native.call('commerce', 'token', { shop: d, clientId: conn.id, secret: conn.secret }, 30000);
  if (!r.ok) throw new Error(r.message ?? 'Shopify est injoignable.');
  const b = (r.body ?? {}) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (r.status === 404) throw new Error('boutique introuvable : vérifie son nom (« nom.myshopify.com »)');
  if (r.status !== 200 || !b.access_token) throw new Error(TOKEN_ERR[b.error ?? ''] ?? b.error_description ?? b.error ?? `Shopify a répondu ${String(r.status)} à la demande de jeton`);
  minted.set(d, { token: b.access_token, exp: Date.now() + (b.expires_in ?? 86399) * 1000 });
  return b.access_token;
}

// ---------- Requêtes ----------
interface GqlError { message?: string; extensions?: { code?: string } }
const HTTP_ERR: Record<number, string> = {
  402: 'boutique gelée : un paiement est en attente côté Shopify',
  403: 'accès refusé : il manque un droit à l’app',
  404: 'boutique introuvable : vérifie son nom (« nom.myshopify.com »)',
  423: 'boutique verrouillée par Shopify',
};

async function gql<T>(d: string, conn: Conn, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    const r = await native.call('commerce', 'graphql', { shop: d, token: await token(d, conn), query, variables }, 40000);
    if (!r.ok) throw new Error(r.message ?? 'Shopify est injoignable.');
    const status = Number(r.status), body = (r.body ?? {}) as { data?: T; errors?: GqlError[] | string };
    const errors = Array.isArray(body.errors) ? body.errors : [];
    // Jeton temporaire périmé plus tôt que prévu : un seul nouvel échange.
    if (status === 401 && !('token' in conn) && !renewed) { renewed = true; minted.delete(d); continue; }
    if (status === 401) throw new Error('token' in conn ? 'jeton refusé : il a été révoqué, ou l’app désinstallée' : 'identifiants de l’app refusés');
    if (status === 429 || errors.some(e => e.extensions?.code === 'THROTTLED')) {
      if (attempt >= 3) throw new Error('Shopify limite le débit : réessaie dans une minute');
      await wait(Math.min(8000, (Number(r.retryAfter) || 2) * 1000));
      continue;
    }
    if (HTTP_ERR[status]) throw new Error(HTTP_ERR[status]);
    if (errors.length) {
      const e = errors[0], msg = e?.message ?? 'erreur';
      // « Access denied for orders field. Required access: `read_orders` access scope. »
      const scope = msg.match(/`(read_[a-z_]+)`/)?.[1];
      throw new Error(e?.extensions?.code === 'ACCESS_DENIED' || scope ? `droit manquant${scope ? ` : ${scope}` : ''} (à ajouter à l’app, puis réinstaller)` : `Shopify : ${msg.slice(0, 200)}`);
    }
    if (typeof body.errors === 'string') throw new Error(`Shopify : ${body.errors.slice(0, 200)}`);
    if (status !== 200 || !body.data) throw new Error(`Shopify a répondu ${String(status)}`);
    return body.data;
  }
}

// ---------- Traduction vers le socle ----------
const PAYS: Record<string, Pay> = { PAID: 'paid', PENDING: 'pending', AUTHORIZED: 'pending', PARTIALLY_PAID: 'partial', PARTIALLY_REFUNDED: 'refunded', REFUNDED: 'refunded', VOIDED: 'void', EXPIRED: 'void' };
const SHIPS: Record<string, Ship> = { FULFILLED: 'done', UNFULFILLED: 'todo', OPEN: 'todo', PENDING_FULFILLMENT: 'todo', IN_PROGRESS: 'todo', RESTOCKED: 'done', PARTIALLY_FULFILLED: 'partial', ON_HOLD: 'hold', SCHEDULED: 'hold', REQUEST_DECLINED: 'todo' };

interface RawOrder {
  id: string; name: string; createdAt: string; cancelledAt: string | null; test: boolean;
  displayFinancialStatus: string | null; displayFulfillmentStatus: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems?: { nodes: { title: string; quantity: number }[] };
}
const ORDER_FIELDS = 'id name createdAt cancelledAt test displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 8) { nodes { title quantity } }';
const order = (d: string, o: RawOrder): Order => ({
  id: o.id, name: o.name, at: Date.parse(o.createdAt),
  total: Number(o.currentTotalPriceSet.shopMoney.amount) || 0, currency: o.currentTotalPriceSet.shopMoney.currencyCode,
  pay: PAYS[o.displayFinancialStatus ?? ''] ?? 'pending', ship: SHIPS[o.displayFulfillmentStatus ?? ''] ?? 'todo',
  cancelled: !!o.cancelledAt, test: !!o.test,
  items: (o.lineItems?.nodes ?? []).map(l => ({ title: l.title, qty: l.quantity })),
  url: adminUrl(d, `/orders/${num(o.id)}`),
});

const SHOP = '{ shop { name currencyCode primaryDomain { url } } }';
// 50 commandes par page : avec leurs lignes, une page coûte environ 550 points sur les 1 000 permis par requête.
const PAGE = 50, MAX_PAGES = 20;
const ORDERS = `query($first: Int!, $after: String, $q: String!) { orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } } }`;
const COUNT = 'query($q: String!) { ordersCount(query: $q) { count } }';
const STOCK = 'query($q: String!) { productVariants(first: 60, query: $q, sortKey: INVENTORY_QUANTITY) { nodes { id title sku inventoryQuantity inventoryItem { tracked } product { id title status } } } }';

async function shop(d: string, conn: Conn): Promise<Shop> {
  const r = await gql<{ shop: { name: string; currencyCode: string; primaryDomain?: { url?: string } | null } }>(d, conn, SHOP);
  return { domain: d, name: r.shop.name, currency: r.shop.currencyCode, url: r.shop.primaryDomain?.url || `https://${d}`, admin: adminUrl(d) };
}

const since = (ts: number): string => `created_at:>='${new Date(ts).toISOString()}'`;

async function orders(d: string, conn: Conn, from: number): Promise<{ list: Order[]; partial: boolean }> {
  const list: Order[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r: { orders: { nodes: RawOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(d, conn, ORDERS, { first: PAGE, after, q: since(from) });
    list.push(...r.orders.nodes.map(o => order(d, o)));
    if (!r.orders.pageInfo.hasNextPage) return { list, partial: false };
    after = r.orders.pageInfo.endCursor;
  }
  return { list, partial: true };
}

interface RawVariant { id: string; title: string; sku: string | null; inventoryQuantity: number | null; inventoryItem?: { tracked: boolean } | null; product: { id: string; title: string; status: string } }
async function stock(d: string, conn: Conn): Promise<StockLine[]> {
  const r = await gql<{ productVariants: { nodes: RawVariant[] } }>(d, conn, STOCK, { q: `inventory_quantity:<=${String(LOW)}` });
  return r.productVariants.nodes
    .filter(v => v.inventoryItem?.tracked !== false && v.product.status === 'ACTIVE' && (v.inventoryQuantity ?? 0) <= LOW)
    .map(v => ({ product: v.product.title, variant: v.title === 'Default Title' ? '' : v.title, sku: v.sku ?? '', qty: v.inventoryQuantity ?? 0, url: adminUrl(d, `/products/${num(v.product.id)}`) }));
}

async function snapshot(d: string, conn: Conn, days: number): Promise<Snapshot> {
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - days + 1);
  // La fiche et les commandes sont indispensables ; le reste manque sans casser la vue (droit absent, champ refusé).
  const [s, o, count, st] = await Promise.all([
    shop(d, conn),
    orders(d, conn, from.getTime()),
    gql<{ ordersCount: { count: number } }>(d, conn, COUNT, { q: 'status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)' }).then(r => r.ordersCount.count, () => null),
    stock(d, conn).then(list => ({ list, note: '' }), (e: unknown) => ({ list: null, note: e instanceof Error ? e.message : String(e) })),
  ]);
  return { shop: s, orders: o.list, days, partial: o.partial, toShip: count, stock: st.list, ...(st.note ? { stockNote: st.note } : {}), at: Date.now() };
}

async function latest(d: string, conn: Conn, from: number): Promise<Order[]> {
  const r = await gql<{ orders: { nodes: RawOrder[] } }>(d, conn, ORDERS, { first: 10, after: null, q: since(from) });
  return r.orders.nodes.map(o => order(d, o));
}

export const shopify: Provider = { id: 'shopify', name: 'Shopify', domain, shop, snapshot, latest };
