// Socle e-commerce : ce que Studio sait d'une boutique, quel que soit son fournisseur.
// Un fournisseur (Shopify aujourd'hui : shopify.ts) traduit son API vers ces types ; les vues, les outils de l'IA et les
// automatisations ne connaissent qu'eux. Ajouter un fournisseur = écrire un `Provider`, rien d'autre ne bouge.
// Ce fichier ne dépend de rien (ni page, ni réseau) : les calculs se vérifient hors de l'app.
// Lecture seule : rien ici ne modifie une boutique. Aucune donnée de client n'est demandée ni gardée.

/** Paiement : payée, en attente, payée en partie, remboursée (en tout ou partie), annulée avant encaissement. */
export type Pay = 'paid' | 'pending' | 'partial' | 'refunded' | 'void';
/** Expédition : faite, à faire, en partie, en attente (retenue, planifiée). */
export type Ship = 'done' | 'todo' | 'partial' | 'hold';

export interface Line { title: string; qty: number }
export interface Order {
  id: string;
  /** Numéro affiché au client (« #1042 »). */
  name: string;
  /** Date de création, en millisecondes. */
  at: number;
  /** Total actuel dans la devise de la boutique : taxes et livraison comprises, remboursements déduits. */
  total: number;
  currency: string;
  pay: Pay;
  ship: Ship;
  cancelled: boolean;
  /** Commande d'essai : jamais comptée. */
  test: boolean;
  /** Premières lignes de la commande. */
  items: Line[];
  /** Page de la commande dans l'administration de la boutique. */
  url: string;
}
export interface Shop { domain: string; name: string; currency: string; /** Vitrine publique. */ url: string; /** Administration. */ admin: string }
export interface StockLine { product: string; variant: string; sku: string; qty: number; url: string }
export interface Snapshot {
  shop: Shop;
  /** Commandes de la période, de la plus récente à la plus ancienne. */
  orders: Order[];
  /** Nombre de jours couverts. */
  days: number;
  /** La période contient plus de commandes que Studio n'en a lues : les totaux sont des minimums. */
  partial: boolean;
  /** Commandes ouvertes à expédier, toutes dates confondues ; null si la boutique ne l'a pas donné. */
  toShip: number | null;
  /** Variantes suivies en stock au plus à `LOW` exemplaires ; null si illisible (`stockNote` dit pourquoi). */
  stock: StockLine[] | null;
  stockNote?: string;
  at: number;
}

/** Ce qui ouvre une boutique : un jeton d'accès, ou les identifiants d'une app (échangés contre un jeton temporaire). */
export type Conn = { token: string } | { id: string; secret: string };

export interface Provider {
  id: string;
  name: string;
  /** Adresse de boutique normalisée, ou null si ce n'est pas une boutique de ce fournisseur. */
  domain(input: string): string | null;
  /** Vérifie la connexion et rend la fiche de la boutique. */
  shop(domain: string, conn: Conn): Promise<Shop>;
  snapshot(domain: string, conn: Conn, days: number): Promise<Snapshot>;
  /** Les dernières commandes créées depuis `since` (au plus une dizaine), pour repérer les nouvelles. */
  latest(domain: string, conn: Conn, since: number): Promise<Order[]>;
}

/** Seuil du « stock bas ». */
export const LOW = 5;

export const PAY: Record<Pay, [label: string, hue: string]> = { paid: ['payée', 'green'], pending: ['paiement en attente', 'amber'], partial: ['payée en partie', 'amber'], refunded: ['remboursée', 'gray'], void: ['paiement annulé', 'gray'] };
export const SHIP: Record<Ship, [label: string, hue: string]> = { done: ['expédiée', 'green'], todo: ['à expédier', 'blue'], partial: ['expédiée en partie', 'amber'], hold: ['en attente', 'gray'] };

/** Commande qui compte dans le chiffre d'affaires : ni annulée, ni d'essai, ni au paiement annulé. */
export const counted = (o: Order): boolean => !o.cancelled && !o.test && o.pay !== 'void';
/** Commande à préparer : encaissée (au moins en partie) et pas encore partie en entier. */
export const toShip = (o: Order): boolean => counted(o) && (o.pay === 'paid' || o.pay === 'partial') && (o.ship === 'todo' || o.ship === 'partial');

/** Jour local d'une date, AAAA-MM-JJ (même format que ui/chart.ts). */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Minuit local, `back` jours avant aujourd'hui. */
export function dayStart(now: number, back = 0): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - back);
  return d.getTime();
}

export interface Period { revenue: number; orders: number }
export interface Stats {
  today: Period;
  /** Les 7 derniers jours, aujourd'hui compris, et les 7 d'avant. */
  d7: Period; prev7: Period;
  /** Toute la période lue. */
  all: Period;
  /** Panier moyen sur la période. */
  basket: number;
  /** Chiffre d'affaires et nombre de commandes par jour local. */
  revenueByDay: Record<string, number>;
  ordersByDay: Record<string, number>;
  /** Produits les plus vendus de la période, d'après les lignes lues. */
  top: Line[];
  /** Commandes de la période à expédier. */
  toShip: number;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Chiffres d'une liste de commandes. Les jours sont ceux de l'appareil, pas ceux de la boutique. */
export function stats(orders: Order[], now = Date.now()): Stats {
  const t0 = dayStart(now), t7 = dayStart(now, 6), t14 = dayStart(now, 13);
  const zero = (): Period => ({ revenue: 0, orders: 0 });
  const s: Stats = { today: zero(), d7: zero(), prev7: zero(), all: zero(), basket: 0, revenueByDay: {}, ordersByDay: {}, top: [], toShip: 0 };
  const sold = new Map<string, number>();
  const add = (p: Period, o: Order) => { p.revenue += o.total; p.orders += 1; };
  for (const o of orders) {
    if (!counted(o)) continue;
    add(s.all, o);
    if (o.at >= t0) add(s.today, o);
    if (o.at >= t7) add(s.d7, o); else if (o.at >= t14) add(s.prev7, o);
    const k = dayKey(o.at);
    s.revenueByDay[k] = (s.revenueByDay[k] ?? 0) + o.total;
    s.ordersByDay[k] = (s.ordersByDay[k] ?? 0) + 1;
    for (const l of o.items) if (l.title && l.qty > 0) sold.set(l.title, (sold.get(l.title) ?? 0) + l.qty);
    if (toShip(o)) s.toShip += 1;
  }
  for (const p of [s.today, s.d7, s.prev7, s.all]) p.revenue = round(p.revenue);
  for (const k of Object.keys(s.revenueByDay)) s.revenueByDay[k] = round(s.revenueByDay[k] ?? 0);
  s.basket = s.all.orders ? round(s.all.revenue / s.all.orders) : 0;
  s.top = [...sold].map(([title, qty]) => ({ title, qty })).sort((a, b) => b.qty - a.qty || a.title.localeCompare(b.title, 'fr')).slice(0, 8);
  return s;
}

/** Montant dans une devise, à la française (« 1 249,90 € »). */
export function money(amount: number, currency: string): string {
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: Number.isInteger(amount) && Math.abs(amount) >= 1000 ? 0 : 2 }).format(amount); }
  catch { return `${amount.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${currency}`; }
}
