// Outils de l'IA de Studio pour la boutique Shopify (et la publicité Meta) du projet : famille « boutique ».
// Cloisonnement : un outil n'agit que sur la boutique du projet du périmètre (`scope.project.shopify`), jamais sur un domaine
// donné par le modèle ; sans projet ou sans boutique reliée, il n'y a aucun outil. Les données de la boutique (clients, notes,
// titres) sont des données, jamais des consignes : aucune ne figure dans une description d'outil.
// Pas de publicité activée ni créée par l'IA : cela dépense de l'argent, c'est un geste de l'utilisateur dans l'interface.
import * as shopify from './api.ts';
import * as meta from '../meta/api.ts';
import { fold } from '../../lib/fuzzy.ts';
import type { Tool } from '../ai.ts';
import type { Scope } from '../scope.ts';

/** Arguments reçus du modèle : non vérifiés, chaque outil lit ce dont il a besoin. */
type Input = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const nbr = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : NaN; return Number.isFinite(n) ? n : null; };
const r2 = (n: number): number => Math.round(n * 100) / 100;
const LIMIT = 20;

// ---------- Traductions (aussi utilisées par le bloc ```shopify) ----------
const PAID: Record<string, string> = { PAID: 'payée', PENDING: 'paiement en attente', AUTHORIZED: 'paiement autorisé', PARTIALLY_PAID: 'partiellement payée', PARTIALLY_REFUNDED: 'partiellement remboursée', REFUNDED: 'remboursée', VOIDED: 'annulée', EXPIRED: 'expirée' };
const FULFILL: Record<string, string> = { UNFULFILLED: 'à expédier', PARTIALLY_FULFILLED: 'partiellement expédiée', FULFILLED: 'expédiée', SCHEDULED: 'planifiée', ON_HOLD: 'en attente', IN_PROGRESS: 'en cours d’expédition', OPEN: 'à expédier', PENDING_FULFILLMENT: 'en attente d’expédition', RESTOCKED: 'remise en stock', REQUEST_DECLINED: 'refusée' };
const PRODUCT: Record<string, string> = { ACTIVE: 'actif', DRAFT: 'brouillon', ARCHIVED: 'archivé' };
const word = (m: Record<string, string>, v: string): string => m[v] ?? v.toLowerCase().replace(/_/g, ' ');
export const paidFr = (v: string): string => word(PAID, v);
export const fulfillFr = (v: string): string => word(FULFILL, v);
export const productStatusFr = (v: string): string => word(PRODUCT, v);

// ---------- Périmètre ----------
/** Boutique du projet du périmètre (et rien d'autre), ou null. */
function shopOf(scope: Scope): shopify.ShopCreds | null {
  return scope.project && shopify.supported() ? shopify.shopOf(scope.project) : null;
}
export const hasShop = (scope: Scope): boolean => !!shopOf(scope);
function need(scope: Scope): shopify.ShopCreds {
  const s = shopOf(scope);
  if (!s) throw new Error('Ce projet n’a pas de boutique Shopify reliée.');
  return s;
}
const adAccount = (scope: Scope): string | null => (meta.supported() && meta.connected() ? scope.project?.meta ?? null : null);

// Dernières lectures, pour que `describe` et `preview` (synchrones) montrent « valeur actuelle → nouvelle ».
const seen = new Map<string, shopify.Product | shopify.Order>();
function remember(key: string, v: shopify.Product | shopify.Order): void {
  seen.delete(key); seen.set(key, v);
  if (seen.size > 120) { const old = seen.keys().next().value; if (old !== undefined) seen.delete(old); }
}
const known = <T extends shopify.Product | shopify.Order>(key: string): T | undefined => seen.get(key) as T | undefined;
const orderRef = (v: unknown): string => str(v).replace(/^#/, '');
const handleOf = (v: unknown): string => str(v).toLowerCase();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const price = (shop: shopify.ShopCreds, n: number): string => shopify.money(n, shop.currency || 'EUR');
const pctChange = (cur: number, prev: number): number | null => (prev > 0 ? Math.round((cur - prev) / prev * 100) : null);

const RANGES: Record<string, shopify.Range> = { aujourdhui: 'today', today: 'today', '1j': 'today', '7j': '7d', '30j': '30d', '90j': '90d', mois: 'month' };
const rangeOf = (v: unknown, def: shopify.Range = '30d'): shopify.Range => RANGES[fold(str(v)).replace(/['’\s]/g, '')] ?? def;
const RANGE_PROP = (list: string[]) => ({ type: 'string', enum: list, description: 'Période ; 30j par défaut' });

function pickVariant(p: shopify.Product, wanted: string): shopify.Variant {
  const w = fold(wanted);
  if (!w) {
    if (p.variants.length === 1 && p.variants[0]) return p.variants[0];
    throw new Error(`« ${p.title} » a ${p.variants.length} variantes : précise laquelle (${p.variants.slice(0, 10).map(v => v.title).join(', ')}).`);
  }
  const hit = p.variants.find(v => fold(v.sku) === w || fold(v.title) === w) ?? p.variants.filter(v => fold(v.title).includes(w) || (v.sku && fold(v.sku).includes(w)))[0];
  if (!hit) throw new Error(`Variante « ${wanted} » introuvable sur « ${p.title} » (${p.variants.slice(0, 10).map(v => v.title).join(', ')}).`);
  return hit;
}
async function productOf(scope: Scope, handle: string): Promise<{ shop: shopify.ShopCreds; p: shopify.Product }> {
  const shop = need(scope), h = handleOf(handle);
  if (!h) throw new Error('Indique le handle du produit (visible dans boutique_produits).');
  const p = await shopify.product(shop, h);
  if (!p) throw new Error(`Produit « ${h} » introuvable dans la boutique.`);
  remember(`${shop.domain}|p|${p.handle}`, p);
  return { shop, p };
}
async function orderOf(scope: Scope, ref: unknown): Promise<{ shop: shopify.ShopCreds; o: shopify.Order }> {
  const shop = need(scope), n = orderRef(ref);
  if (!/^\d{1,10}$/.test(n)) throw new Error('Indique le numéro de commande, par exemple #1042.');
  const o = await shopify.order(shop, n);
  if (!o) throw new Error(`Commande #${n} introuvable.`);
  remember(`${shop.domain}|o|${n}`, o);
  return { shop, o };
}
const seenProduct = (scope: Scope, handle: unknown): shopify.Product | undefined => { const s = shopOf(scope); return s ? known<shopify.Product>(`${s.domain}|p|${handleOf(handle)}`) : undefined; };
const seenOrder = (scope: Scope, ref: unknown): shopify.Order | undefined => { const s = shopOf(scope); return s ? known<shopify.Order>(`${s.domain}|o|${orderRef(ref)}`) : undefined; };
const compactOrder = (o: shopify.Order) => ({ numero: o.name, date: new Date(o.at).toISOString().slice(0, 10), client: o.customer || null, total: r2(o.total), devise: o.currency, paiement: paidFr(o.paid), expedition: fulfillFr(o.fulfillment),
  ...(o.risk === 'INVESTIGATE' || o.risk === 'CANCEL' ? { risque: o.risk === 'CANCEL' ? 'élevé' : 'à vérifier' } : {}), articles: o.items.reduce((n, i) => n + i.quantity, 0), url: o.url });
const compactProduct = (shop: shopify.ShopCreds, p: shopify.Product) => ({ titre: p.title, handle: p.handle, statut: productStatusFr(p.status), prix: p.priceMin === p.priceMax ? price(shop, p.priceMin) : `${price(shop, p.priceMin)} à ${price(shop, p.priceMax)}`, stock: p.stock, variantes: p.variants.length, url: p.url });

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

// ---------- Outils ----------
export function shopTools(scope: Scope): Tool[] {
  if (!hasShop(scope)) return [];
  const read: Tool[] = [
    { name: 'boutique_chiffres', description: 'Chiffres de la boutique Shopify du projet sur une période : ventes, commandes, panier moyen, conversion, évolution par rapport à la période précédente, produits les plus vendus et canaux de vente.',
      schema: obj({ periode: RANGE_PROP(['aujourdhui', '7j', '30j', '90j', 'mois']) }),
      run: async (i: Input) => {
        const s = await shopify.summary(need(scope), rangeOf(i['periode']));
        return { periode: s.range, devise: s.currency, ventes: r2(s.sales), commandes: s.orders, panier_moyen: r2(s.aov), conversion_pct: s.conversion === null ? null : r2(s.conversion * 100), sessions: s.sessions, remboursements: r2(s.refunds),
          periode_precedente: { ventes: r2(s.prev.sales), commandes: s.prev.orders, panier_moyen: r2(s.prev.aov) }, evolution_pct: { ventes: pctChange(s.sales, s.prev.sales), commandes: pctChange(s.orders, s.prev.orders) },
          top_produits: s.top.slice(0, 5).map(t => ({ titre: t.title, quantite: t.quantity, ventes: r2(t.sales) })), canaux: s.channels.slice(0, 5).map(c => ({ canal: c.name, ventes: r2(c.sales) })) };
      } },
    { name: 'boutique_commandes', description: 'Liste les commandes récentes de la boutique (20 au plus), les plus récentes d’abord. Filtre : toutes, à expédier, impayées. Recherche facultative (numéro, nom ou e-mail du client).',
      schema: obj({ filtre: { type: 'string', enum: ['toutes', 'a_expedier', 'impayees'] }, recherche: { type: 'string' } }),
      run: async (i: Input) => {
        const f = fold(str(i['filtre'])), q = [f.startsWith('a_exp') || f.startsWith('a exp') ? 'fulfillment_status:unfulfilled status:open' : f.startsWith('impay') ? 'financial_status:unpaid status:open' : '', str(i['recherche'])].filter(Boolean).join(' ');
        return (await shopify.orders(need(scope), { query: q, first: LIMIT })).map(compactOrder);
      } },
    { name: 'boutique_commande', description: 'Détail d’une commande de la boutique à partir de son numéro (ex. 1042) : articles, statuts, montant, client, note.',
      schema: obj({ numero: { type: 'string', description: 'Numéro de commande, ex. #1042' } }, ['numero']),
      run: async (i: Input) => {
        const { o } = await orderOf(scope, i['numero']);
        return { ...compactOrder(o), email: o.email || null, note: o.note || null, articles_detail: o.items.map(a => ({ titre: a.title, quantite: a.quantity, sku: a.sku || null })) };
      } },
    { name: 'boutique_produits', description: 'Liste les produits de la boutique (20 au plus, modifiés en dernier d’abord), avec une recherche facultative sur le titre ou les tags. Donne le handle à utiliser dans les autres outils.',
      schema: obj({ recherche: { type: 'string' } }),
      run: async (i: Input) => {
        const shop = need(scope), list = (await shopify.products(shop, { query: str(i['recherche']), first: LIMIT })).slice(0, LIMIT);
        for (const p of list) remember(`${shop.domain}|p|${p.handle}`, p);
        return list.map(p => compactProduct(shop, p));
      } },
    { name: 'boutique_produit', description: 'Fiche complète d’un produit de la boutique à partir de son handle : description, variantes (titre, SKU, prix, stock), référencement (SEO), tags, statut.',
      schema: obj({ handle: { type: 'string' } }, ['handle']),
      run: async (i: Input) => {
        const { shop, p } = await productOf(scope, str(i['handle']));
        return { ...compactProduct(shop, p), fournisseur: p.vendor || null, type: p.type || null, tags: p.tags, description: clip(p.description, 1500), seo: { titre: p.seoTitle || null, description: p.seoDescription || null },
          variantes_detail: p.variants.slice(0, LIMIT).map(v => ({ titre: v.title, sku: v.sku || null, prix: r2(v.price), prix_barre: v.compareAt === null ? null : r2(v.compareAt), stock: v.stock })), url_boutique: p.onlineUrl || null };
      } },
    { name: 'boutique_stock_bas', description: 'Variantes dont le stock est inférieur ou égal à un seuil (5 par défaut), 20 au plus.',
      schema: obj({ seuil: { type: 'number' } }),
      run: async (i: Input) => {
        const n = nbr(i['seuil']), t = n === null ? 5 : Math.max(0, Math.floor(n));
        const low = await shopify.lowStock(need(scope), t);
        return { seuil: t, total: low.length, variantes: low.slice(0, LIMIT).map(({ product, variant }) => ({ produit: product.title, handle: product.handle, variante: variant.title, sku: variant.sku || null, stock: variant.stock })) };
      } },
    { name: 'boutique_clients', description: 'Clients récents de la boutique (20 au plus) : nombre de commandes, montant dépensé, dernière commande. Recherche facultative.',
      schema: obj({ recherche: { type: 'string' } }),
      run: async (i: Input) => (await shopify.customers(need(scope), { query: str(i['recherche']), first: LIMIT })).slice(0, LIMIT)
        .map(c => ({ nom: c.name, email: c.email || null, commandes: c.orders, depense: r2(c.spent), derniere_commande: c.last ? new Date(c.last).toISOString().slice(0, 10) : null })) },
    { name: 'boutique_reductions', description: 'Réductions de la boutique (codes et automatiques, 20 au plus) : statut, utilisations, résumé.',
      schema: obj({}),
      run: async () => (await shopify.discounts(need(scope))).slice(0, LIMIT).map(d => ({ code: d.code || null, titre: d.title, statut: d.status.toLowerCase(), utilisations: d.used, resume: d.summary })) },
  ];

  const ads: Tool[] = adAccount(scope) ? [
    { name: 'pub_chiffres', description: 'Chiffres publicitaires Meta du compte du projet sur une période : dépense, clics, achats, chiffre d’affaires attribué, ROAS, emplacements les plus dépensiers.',
      schema: obj({ periode: RANGE_PROP(['aujourdhui', '7j', '30j']) }),
      run: async (i: Input) => {
        const account = adAccount(scope); if (!account) throw new Error('Meta n’est pas accessible dans ce projet.');
        const r = await meta.insights(account, rangeOf(i['periode'], '7d') === 'today' ? 'today' : rangeOf(i['periode'], '7d') === '7d' ? '7d' : '30d'), t = r.total;
        return { devise: r.currency, depense: r2(t.spend), impressions: t.impressions, clics: t.clicks, ctr_pct: r2(t.ctr), cpc: r2(t.cpc), achats: t.purchases, chiffre_affaires: r2(t.revenue), roas: t.roas === null ? null : r2(t.roas),
          emplacements: r.byPlacement.slice(0, 5).map(p => ({ emplacement: p.placement, depense: r2(p.spend), clics: p.clicks })) };
      } },
    { name: 'pub_campagnes', description: 'Campagnes publicitaires Meta du compte du projet (20 au plus) : statut, budget par jour, dépense, clics, achats, ROAS.',
      schema: obj({ periode: RANGE_PROP(['aujourdhui', '7j', '30j']) }),
      run: async (i: Input) => {
        const account = adAccount(scope); if (!account) throw new Error('Meta n’est pas accessible dans ce projet.');
        const r = rangeOf(i['periode'], '7d');
        return (await meta.campaigns(account, r === 'today' ? 'today' : r === '7d' ? '7d' : '30d')).slice(0, LIMIT)
          .map(c => ({ id: c.id, nom: c.name, statut: c.status.toLowerCase(), objectif: c.objective, budget_jour: c.dailyBudget, depense: r2(c.stats.spend), clics: c.stats.clicks, achats: c.stats.purchases, roas: c.stats.roas === null ? null : r2(c.stats.roas) }));
      } },
  ] : [];

  const write: Tool[] = [
    { name: 'boutique_modifier_produit', write: true, description: 'Modifie un produit de la boutique : titre, description (HTML), référencement (titre et description SEO), tags, statut (actif, brouillon, archivé). Seuls les champs donnés changent. Demande l’accord de l’utilisateur.',
      schema: obj({ handle: { type: 'string' }, titre: { type: 'string' }, description_html: { type: 'string' }, seo_titre: { type: 'string' }, seo_description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, statut: { type: 'string', enum: ['actif', 'brouillon', 'archive'] } }, ['handle']),
      describe: (i: Input) => `Modifier le produit « ${seenProduct(scope, i['handle'])?.title ?? str(i['handle'])} » : ${['titre', 'description_html', 'seo_titre', 'seo_description', 'tags', 'statut'].filter(k => i[k] !== undefined).map(k => k.replace('_html', '').replace('_', ' ')).join(', ') || 'aucun champ'}`,
      preview: (i: Input) => {
        const p = seenProduct(scope, i['handle']), line = (label: string, old: string | undefined, now: string): string => `- **${label}** : ${old === undefined ? '' : `${clip(old, 200) || '(vide)'} → `}${clip(now, 400) || '(vide)'}`;
        const out: string[] = [];
        if (i['titre'] !== undefined) out.push(line('Titre', p?.title, str(i['titre'])));
        if (i['description_html'] !== undefined) out.push(line('Description', p?.descriptionHtml, str(i['description_html'])));
        if (i['seo_titre'] !== undefined) out.push(line('Titre SEO', p?.seoTitle, str(i['seo_titre'])));
        if (i['seo_description'] !== undefined) out.push(line('Description SEO', p?.seoDescription, str(i['seo_description'])));
        if (Array.isArray(i['tags'])) out.push(line('Tags', p?.tags.join(', '), i['tags'].map(t => str(t)).filter(Boolean).join(', ')));
        if (i['statut'] !== undefined) out.push(line('Statut', p ? productStatusFr(p.status) : undefined, str(i['statut'])));
        return out.join('\n');
      },
      run: async (i: Input) => {
        const { shop, p } = await productOf(scope, str(i['handle']));
        const patch: Parameters<typeof shopify.updateProduct>[2] = {};
        if (i['titre'] !== undefined) { if (!str(i['titre'])) throw new Error('Le titre ne peut pas être vide.'); patch.title = str(i['titre']); }
        if (typeof i['description_html'] === 'string') patch.descriptionHtml = i['description_html'];
        if (typeof i['seo_titre'] === 'string') patch.seoTitle = i['seo_titre'];
        if (typeof i['seo_description'] === 'string') patch.seoDescription = i['seo_description'];
        if (Array.isArray(i['tags'])) patch.tags = i['tags'].map(t => str(t)).filter(Boolean);
        const st = fold(str(i['statut']));
        if (st) { const m = st.startsWith('act') ? 'ACTIVE' : st.startsWith('brou') ? 'DRAFT' : st.startsWith('arch') ? 'ARCHIVED' : null; if (!m) throw new Error('Statut inconnu : actif, brouillon ou archive.'); patch.status = m; }
        if (!Object.keys(patch).length) throw new Error('Aucun champ à modifier.');
        await shopify.updateProduct(shop, p.id, patch); shopify.forget(shop.domain); seen.delete(`${shop.domain}|p|${p.handle}`);
        return { modifie: p.handle, champs: Object.keys(patch) };
      } },
    { name: 'boutique_prix', write: true, description: 'Change le prix d’une variante d’un produit de la boutique (et facultativement son prix barré ; 0 l’efface). Demande l’accord de l’utilisateur.',
      schema: obj({ handle: { type: 'string' }, variante: { type: 'string', description: 'Titre ou SKU de la variante ; facultatif si le produit n’en a qu’une' }, prix: { type: 'number' }, prix_barre: { type: 'number' } }, ['handle', 'prix']),
      describe: (i: Input) => `Changer le prix de « ${seenProduct(scope, i['handle'])?.title ?? str(i['handle'])} »${str(i['variante']) ? ` (${str(i['variante'])})` : ''} à ${nbr(i['prix']) ?? '?'}`,
      preview: (i: Input) => {
        const p = seenProduct(scope, i['handle']), shop = shopOf(scope); if (!p || !shop) return `Nouveau prix : ${nbr(i['prix']) ?? '?'}`;
        let v: shopify.Variant | undefined; try { v = pickVariant(p, str(i['variante'])); } catch { v = undefined; }
        const compare = nbr(i['prix_barre']);
        return `- **${p.title}${v && v.title !== 'Default Title' ? ` · ${v.title}` : ''}** : ${v ? `${price(shop, v.price)} → ` : ''}${price(shop, nbr(i['prix']) ?? 0)}${compare !== null ? `\n- **Prix barré** : ${v?.compareAt != null ? `${price(shop, v.compareAt)} → ` : ''}${compare > 0 ? price(shop, compare) : '(supprimé)'}` : ''}`;
      },
      run: async (i: Input) => {
        const { shop, p } = await productOf(scope, str(i['handle'])), v = pickVariant(p, str(i['variante'])), n = nbr(i['prix']), c = nbr(i['prix_barre']);
        if (n === null || n < 0) throw new Error('Prix invalide.');
        await shopify.setPrice(shop, p.id, v.id, n, c === null ? undefined : c > 0 ? c : null); shopify.forget(shop.domain); seen.delete(`${shop.domain}|p|${p.handle}`);
        return { produit: p.handle, variante: v.title, ancien_prix: r2(v.price), nouveau_prix: r2(n) };
      } },
    { name: 'boutique_stock', write: true, description: 'Fixe la quantité en stock (disponible) d’une variante d’un produit de la boutique, au premier emplacement. Demande l’accord de l’utilisateur.',
      schema: obj({ handle: { type: 'string' }, variante: { type: 'string', description: 'Titre ou SKU de la variante ; facultatif si le produit n’en a qu’une' }, quantite: { type: 'number' } }, ['handle', 'quantite']),
      describe: (i: Input) => `Fixer le stock de « ${seenProduct(scope, i['handle'])?.title ?? str(i['handle'])} »${str(i['variante']) ? ` (${str(i['variante'])})` : ''} à ${nbr(i['quantite']) ?? '?'}`,
      preview: (i: Input) => {
        const p = seenProduct(scope, i['handle']); if (!p) return `Nouvelle quantité : ${nbr(i['quantite']) ?? '?'}`;
        let v: shopify.Variant | undefined; try { v = pickVariant(p, str(i['variante'])); } catch { v = undefined; }
        return `- **${p.title}${v && v.title !== 'Default Title' ? ` · ${v.title}` : ''}** : ${v ? `${v.stock ?? 'non suivi'} → ` : ''}${nbr(i['quantite']) ?? '?'}`;
      },
      run: async (i: Input) => {
        const { shop, p } = await productOf(scope, str(i['handle'])), v = pickVariant(p, str(i['variante'])), n = nbr(i['quantite']);
        if (n === null || !Number.isInteger(n) || n < 0) throw new Error('La quantité doit être un entier positif ou nul.');
        await shopify.setStock(shop, v.inventoryItem, n); shopify.forget(shop.domain); seen.delete(`${shop.domain}|p|${p.handle}`);
        return { produit: p.handle, variante: v.title, ancien_stock: v.stock, nouveau_stock: n };
      } },
    { name: 'boutique_expedier', write: true, description: 'Marque une commande de la boutique comme expédiée, avec un numéro de suivi facultatif (le client est alors prévenu par e-mail). Demande l’accord de l’utilisateur.',
      schema: obj({ numero: { type: 'string', description: 'Numéro de commande, ex. #1042' }, suivi: { type: 'string', description: 'Numéro de suivi' }, transporteur: { type: 'string' }, lien_suivi: { type: 'string' } }, ['numero']),
      describe: (i: Input) => `Expédier la commande #${orderRef(i['numero'])}${str(i['suivi']) ? ` (suivi ${str(i['suivi'])}, le client est prévenu par e-mail)` : ' (sans suivi, le client n’est pas prévenu)'}`,
      preview: (i: Input) => {
        const o = seenOrder(scope, i['numero']);
        return [o ? `${o.name} · ${o.customer || 'client inconnu'} · ${shopify.money(o.total, o.currency)} · ${fulfillFr(o.fulfillment)} → expédiée` : `Commande #${orderRef(i['numero'])} → expédiée`,
          o ? o.items.map(a => `- ${a.quantity} × ${a.title}`).join('\n') : '', str(i['suivi']) ? `Suivi : ${str(i['suivi'])}${str(i['transporteur']) ? ` (${str(i['transporteur'])})` : ''}` : ''].filter(Boolean).join('\n');
      },
      run: async (i: Input) => {
        const { shop, o } = await orderOf(scope, i['numero']), number = str(i['suivi']), company = str(i['transporteur']), url = str(i['lien_suivi']);
        if (url && !/^https:\/\//.test(url)) throw new Error('Le lien de suivi doit commencer par https://.');
        await shopify.fulfill(shop, o.id, { ...(number ? { number } : {}), ...(company ? { company } : {}), ...(url ? { url } : {}) }); shopify.forget(shop.domain); seen.delete(`${shop.domain}|o|${orderRef(i['numero'])}`);
        return { expediee: o.name, client_prevenu: !!number };
      } },
    { name: 'boutique_note_commande', write: true, description: 'Remplace la note interne d’une commande de la boutique (invisible du client). Reprends l’ancienne note si tu veux la garder. Demande l’accord de l’utilisateur.',
      schema: obj({ numero: { type: 'string', description: 'Numéro de commande, ex. #1042' }, note: { type: 'string' } }, ['numero', 'note']),
      describe: (i: Input) => `Changer la note de la commande #${orderRef(i['numero'])}`,
      preview: (i: Input) => { const o = seenOrder(scope, i['numero']); return `${o ? `Note actuelle : ${clip(o.note, 400) || '(vide)'}\n\n` : ''}Nouvelle note : ${clip(str(i['note']), 800)}`; },
      run: async (i: Input) => {
        const { shop, o } = await orderOf(scope, i['numero']);
        await shopify.setOrderNote(shop, o.id, str(i['note'])); shopify.forget(shop.domain); seen.delete(`${shop.domain}|o|${orderRef(i['numero'])}`);
        return { commande: o.name, note: 'mise à jour' };
      } },
    { name: 'boutique_creer_reduction', write: true, description: 'Crée un code de réduction dans la boutique (pourcentage OU montant fixe sur la commande, tous les clients, valable dès maintenant), avec une date de fin et une limite d’utilisations facultatives. Demande l’accord de l’utilisateur.',
      schema: obj({ code: { type: 'string' }, pourcentage: { type: 'number', description: 'Entre 1 et 100' }, montant: { type: 'number', description: 'Montant fixe dans la devise de la boutique' }, fin: { type: 'string', description: 'Date de fin ISO, ex. 2026-12-31' }, limite: { type: 'number', description: 'Nombre d’utilisations maximum' } }, ['code']),
      describe: (i: Input) => `Créer le code de réduction « ${str(i['code'])} » (${nbr(i['pourcentage']) !== null ? `${nbr(i['pourcentage'])} %` : nbr(i['montant']) !== null ? `${nbr(i['montant'])} de remise` : 'valeur à préciser'})`,
      preview: (i: Input) => [`- **Code** : ${str(i['code'])}`, nbr(i['pourcentage']) !== null ? `- **Remise** : ${nbr(i['pourcentage'])} % sur la commande` : `- **Remise** : ${nbr(i['montant']) ?? '?'} sur la commande`, '- **Clients** : tous, dès maintenant', str(i['fin']) ? `- **Fin** : ${str(i['fin'])}` : '', nbr(i['limite']) !== null ? `- **Limite** : ${nbr(i['limite'])} utilisation(s)` : ''].filter(Boolean).join('\n'),
      run: async (i: Input) => {
        const shop = need(scope), percent = nbr(i['pourcentage']), amount = nbr(i['montant']), limit = nbr(i['limite']), end = str(i['fin']);
        if ((percent === null) === (amount === null)) throw new Error('Donne soit un pourcentage, soit un montant (un seul des deux).');
        if (!str(i['code'])) throw new Error('Le code est vide.');
        let endsAt: string | undefined;
        if (end) { const t = Date.parse(end.length === 10 ? `${end}T23:59:59` : end); if (!Number.isFinite(t)) throw new Error('Date de fin invalide (ex. 2026-12-31).'); endsAt = new Date(t).toISOString(); }
        await shopify.createDiscount(shop, { code: str(i['code']), ...(percent !== null ? { percent } : {}), ...(amount !== null ? { amount } : {}), ...(endsAt ? { endsAt } : {}), ...(limit !== null && limit > 0 ? { usageLimit: limit } : {}) });
        shopify.forget(shop.domain);
        return { code: str(i['code']), cree: true };
      } },
  ];

  const pause: Tool[] = adAccount(scope) ? [
    { name: 'pub_pause', write: true, description: 'Met en pause une campagne publicitaire Meta du compte du projet (identifiant donné par pub_campagnes). Ne peut ni activer ni créer de campagne : cela dépense de l’argent et reste un geste de l’utilisateur. Demande l’accord de l’utilisateur.',
      schema: obj({ campagne: { type: 'string', description: 'Identifiant de la campagne' } }, ['campagne']),
      describe: (i: Input) => `Mettre en pause la campagne Meta ${str(i['campagne'])}`,
      preview: (i: Input) => `La campagne ${str(i['campagne'])} ne dépensera plus rien tant que tu ne la réactives pas dans le Gestionnaire de publicités.`,
      run: async (i: Input) => {
        const account = adAccount(scope), id = str(i['campagne']);
        if (!account) throw new Error('Meta n’est pas accessible dans ce projet.');
        const c = (await meta.campaigns(account, '7d')).find(x => x.id === id); // cloisonnement : seulement une campagne du compte du projet
        if (!c) throw new Error('Cette campagne n’appartient pas au compte publicitaire du projet.');
        await meta.setStatus(c.id, 'PAUSED'); meta.forget();
        return { campagne: c.name, statut: 'en pause' };
      } },
  ] : [];

  return [...read, ...ads, ...write, ...pause];
}
