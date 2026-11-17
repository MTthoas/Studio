// Meta (Facebook / Instagram) : publicité par la Marketing API, Graph API v25.0.
// Tout passe par le pont natif `commerce` / `meta` (Mac seulement) : jamais de fetch depuis la page (CORS, CSP).
// Il n'existe PAS d'API publique pour publier une annonce Marketplace de particulier : Marketplace n'est ici qu'un
// EMPLACEMENT de diffusion d'une pub payante. Tout ce qui est créé l'est en PAUSE : l'utilisateur active lui-même.
import * as vault from '../../core/vault.ts';
import * as native from '../../core/native.ts';

/** `page` = identifiant de la Page Facebook (nécessaire pour créer des pubs) ; `pixel` = pixel Meta (objectif ventes) ;
 *  `dsa` = nom déclaré comme bénéficiaire et payeur pour cibler l'UE (sinon : réglages du compte, puis nom de la Page). */
export interface MetaCreds { token: string; name?: string; page?: string; pixel?: string; dsa?: string }
export const supported = (): boolean => native.available();
export const creds = (): MetaCreds | null => { const c = vault.secret<MetaCreds>('meta'); return c?.token ? c : null; };
export const connected = (): boolean => !!creds();

export interface AdStats { spend: number; impressions: number; clicks: number; ctr: number; cpc: number; purchases: number; revenue: number; roas: number | null }
export interface Campaign { id: string; name: string; status: string; objective: string; dailyBudget: number | null; stats: AdStats; url: string }
export interface AdDraft { name: string; link: string; primaryText: string; headline: string; description?: string; imageUrl?: string; dailyBudget: number;
  countries: string[]; ageMin?: number; ageMax?: number; placements: 'auto' | 'marketplace' | 'feeds'; cta?: string }
type Range = '7d' | '30d' | 'today';
type Json = Record<string, unknown>;

// ---------- Appels ----------
/** Erreur de Meta avec son code : les appelants peuvent distinguer jeton expiré (190) et droit manquant. */
export class MetaError extends Error { constructor(message: string, readonly code = 0, readonly status = 0) { super(message); } }

const PERMS = ['ads_management', 'ads_read', 'business_management', 'pages_read_engagement', 'pages_show_list'];
function explain(message: string, code: number, status: number): string {
  const m = message || `HTTP ${status}`;
  if (status === 0 && !code && message) return message; // échec réseau : déjà un message français du pont
  if (code === 190 || status === 401 || /access token|session has (expired|been invalidated)/i.test(m) && code !== 200)
    return 'Ton jeton Meta est expiré ou invalide : crée-en un nouveau (utilisateur système → Générer un jeton) et remplace-le dans Réglages → Boutiques.';
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80004)
    return 'Meta limite les requêtes pour l’instant : réessaie dans quelques minutes.';
  if (code === 200 || code === 10 || code === 283 || (code >= 200 && code < 300) || /permission/i.test(m)) {
    const named = PERMS.find(p => m.includes(p));
    return `Ton jeton Meta n’a pas le droit nécessaire (${named ?? 'ads_management pour écrire, ads_read pour lire'}) : régénère-le avec ces droits et attribue-lui le compte publicitaire (Meta Business Suite → Utilisateurs système → Ajouter des actifs). Meta : ${m}`;
  }
  if (code === 100 && /dsa_|DSA/.test(m)) return `Meta exige une déclaration pour cibler l’UE (bénéficiaire et payeur de la pub) : renseigne le nom dans Réglages → Boutiques → Meta. Meta : ${m}`;
  return `Meta a répondu : ${m}`;
}

const REUSE = 60e3, CACHE_MAX = 200;
const cache = new Map<string, { at: number; data: Json }>(), inflight = new Map<string, Promise<Json>>();
const clear = (): void => { cache.clear(); };
/** Vide le cache de lecture (bouton Actualiser). */
export const forget = clear;

async function send(token: string, method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>): Promise<Json> {
  if (!native.available()) throw new Error('La publicité Meta est disponible dans l’app Studio pour Mac.');
  const r = await native.call('commerce', 'meta', params ? { token, method, path, params } : { token, method, path }, 45000);
  const data = (r['data'] ?? {}) as Json;
  if (!r.ok) {
    const err = (data['error'] ?? {}) as { message?: string; code?: number };
    const code = typeof r['code'] === 'number' ? r['code'] : err.code ?? 0;
    throw new MetaError(explain(r.message ?? err.message ?? '', code, typeof r['status'] === 'number' ? r['status'] : 0), code);
  }
  return data;
}

function token(): string {
  if (!vault.isOpen() && vault.enabled()) throw new Error('Le coffre est verrouillé : déverrouille-le pour utiliser Meta.');
  const c = creds();
  if (!c) throw new Error('Meta n’est pas connecté (Réglages → Boutiques → Meta).');
  return c.token;
}

/** Lecture (cache ~60 s, requêtes identiques simultanées partagées). */
function get(path: string, params: Record<string, unknown> = {}, tok = token()): Promise<Json> {
  const key = `${tok} ${path} ${JSON.stringify(params)}`, hit = cache.get(key), running = inflight.get(key);
  if (running) return running;
  if (hit && Date.now() - hit.at < REUSE) return Promise.resolve(hit.data);
  const p = send(tok, 'GET', path, params).then(data => {
    cache.set(key, { at: Date.now(), data });
    if (cache.size > CACHE_MAX) { const old = cache.keys().next().value; if (old !== undefined) cache.delete(old); }
    return data;
  }).finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}
/** Écriture : vide le cache de lecture. */
async function write(method: 'POST' | 'DELETE', path: string, params?: Record<string, unknown>): Promise<Json> {
  try { return await send(token(), method, path, params); } finally { clear(); }
}
/** Toutes les pages d'une liste (5 pages au plus). */
async function list(path: string, params: Record<string, unknown>): Promise<Json[]> {
  const out: Json[] = [];
  let after = '';
  for (let i = 0; i < 5; i++) {
    const d = await get(path, after ? { ...params, after } : params);
    out.push(...((d['data'] as Json[] | undefined) ?? []));
    const paging = d['paging'] as { next?: string; cursors?: { after?: string } } | undefined;
    after = paging?.next ? paging.cursors?.after ?? '' : '';
    if (!after) break;
  }
  return out;
}

// ---------- Connexion ----------
export async function connect(c: MetaCreds): Promise<MetaCreds> {
  if (!vault.isOpen()) throw new Error(vault.enabled() ? 'Le coffre est verrouillé : déverrouille-le pour enregistrer le jeton.' : 'Active d’abord le coffre (Réglages → Coffre) : le jeton Meta y est gardé chiffré.');
  const tok = c.token.trim();
  if (!tok) throw new Error('Colle d’abord le jeton Meta.');
  const me = await send(tok, 'GET', '/me', { fields: 'name' });
  const out: MetaCreds = { token: tok, name: String(me['name'] ?? '') };
  if (c.page?.trim()) out.page = c.page.trim();
  if (c.pixel?.trim()) out.pixel = c.pixel.trim();
  if (c.dsa?.trim()) out.dsa = c.dsa.trim();
  await vault.setSecret('meta', out);
  clear();
  return out;
}
export async function disconnect(): Promise<void> { await vault.setSecret('meta', null); clear(); }

const actId = (a: string): string => a.startsWith('act_') ? a : `act_${a}`;
export async function accounts(): Promise<{ id: string; name: string; currency: string }[]> {
  const rows = await list('/me/adaccounts', { fields: 'id,name,currency,account_status', limit: 100 });
  return rows.map(r => ({ id: String(r['id'] ?? ''), name: String(r['name'] ?? r['id'] ?? ''), currency: String(r['currency'] ?? '') })).filter(a => a.id);
}
/** Pages Facebook que le jeton peut voir (vide si le droit pages_show_list manque). */
export async function pages(): Promise<{ id: string; name: string }[]> {
  try {
    const rows = await list('/me/accounts', { fields: 'id,name', limit: 100 });
    return rows.map(r => ({ id: String(r['id'] ?? ''), name: String(r['name'] ?? '') })).filter(a => a.id);
  } catch { return []; }
}

// ---------- Montants ----------
/** Devises sans décimales : Meta attend le montant tel quel, pas en centimes (liste à confirmer dans la doc des devises). */
const NO_DECIMALS = new Set(['CLP', 'COP', 'CRC', 'IDR', 'ISK', 'JPY', 'KRW', 'PYG', 'VND']);
const minor = (cur: string): number => NO_DECIMALS.has(cur.toUpperCase()) ? 1 : 100;
const toMinor = (n: number, cur: string): number => Math.round(n * minor(cur));
const fromMinor = (v: unknown, cur: string): number | null => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n / minor(cur); };
const currencies = new Map<string, string>();
async function currencyOf(account: string): Promise<string> {
  const k = actId(account), known = currencies.get(k);
  if (known) return known;
  const d = await get(`/${k}`, { fields: 'currency' });
  const cur = String(d['currency'] ?? 'EUR');
  currencies.set(k, cur);
  return cur;
}

// ---------- Statistiques ----------
const FIELDS = 'spend,impressions,clicks,ctr,cpc,actions,action_values,purchase_roas';
const PRESET: Record<Range, string> = { today: 'today', '7d': 'last_7d', '30d': 'last_30d' };
const emptyStats = (): AdStats => ({ spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, purchases: 0, revenue: 0, roas: null });
const nb = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** Valeur d'une liste d'actions Meta (`[{ action_type, value }]`) : achats comptés une fois (omni_purchase, sinon purchase). */
function action(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  for (const t of ['omni_purchase', 'purchase']) {
    const a = (v as { action_type?: string; value?: string }[]).find(x => x.action_type === t);
    if (a) return nb(a.value);
  }
  return null;
}
function stats(r: Json): AdStats {
  const spend = nb(r['spend']), purchases = action(r['actions']) ?? 0, revenue = action(r['action_values']) ?? 0;
  const roas = action(r['purchase_roas']) ?? (spend > 0 && revenue > 0 ? revenue / spend : null);
  return { spend, impressions: nb(r['impressions']), clicks: nb(r['clicks']), ctr: nb(r['ctr']), cpc: nb(r['cpc']), purchases, revenue, roas };
}

export async function insights(account: string, range: Range): Promise<{ currency: string; total: AdStats; byDay: (AdStats & { date: string })[]; byPlacement: (AdStats & { placement: string })[] }> {
  const a = actId(account), base = { date_preset: PRESET[range], limit: 100 };
  const [tot, day, plc] = await Promise.all([
    get(`/${a}/insights`, { ...base, level: 'account', fields: `${FIELDS},account_currency` }),
    get(`/${a}/insights`, { ...base, level: 'account', fields: `${FIELDS},date_start`, time_increment: 1 }),
    get(`/${a}/insights`, { ...base, level: 'account', fields: `${FIELDS},publisher_platform,platform_position`, breakdowns: 'publisher_platform,platform_position' }),
  ]);
  const rows = (d: Json): Json[] => (d['data'] as Json[] | undefined) ?? [];
  const first = rows(tot)[0];
  const currency = first ? String(first['account_currency'] ?? '') || await currencyOf(a) : await currencyOf(a);
  return {
    currency,
    total: first ? stats(first) : emptyStats(),
    byDay: rows(day).map(r => ({ ...stats(r), date: String(r['date_start'] ?? '') })).sort((x, y) => x.date.localeCompare(y.date)),
    byPlacement: rows(plc).map(r => ({ ...stats(r), placement: `${r['publisher_platform'] ?? ''}/${r['platform_position'] ?? ''}` })).sort((x, y) => y.spend - x.spend),
  };
}

export const adsUrl = (account: string, campaign?: string): string =>
  `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${actId(account).slice(4)}${campaign ? `&selected_campaign_ids=${campaign}` : ''}`;

export async function campaigns(account: string, range: Range): Promise<Campaign[]> {
  const a = actId(account);
  const [cur, rows, ins] = await Promise.all([
    currencyOf(a),
    list(`/${a}/campaigns`, { fields: 'id,name,status,effective_status,objective,daily_budget,adsets.limit(25){daily_budget}', limit: 100 }),
    list(`/${a}/insights`, { date_preset: PRESET[range], level: 'campaign', fields: `campaign_id,${FIELDS}`, limit: 200 }),
  ]);
  const byId = new Map(ins.map(r => [String(r['campaign_id']), stats(r)]));
  return rows.map(r => {
    const id = String(r['id'] ?? ''), adsets = ((r['adsets'] as { data?: Json[] } | undefined)?.data ?? []);
    let budget = fromMinor(r['daily_budget'], cur);
    if (budget == null || budget === 0) { // budget au niveau des ensembles de pubs : somme
      const sum = adsets.map(s => fromMinor(s['daily_budget'], cur)).filter((x): x is number => x != null);
      budget = sum.length ? sum.reduce((x, y) => x + y, 0) : null;
    }
    return { id, name: String(r['name'] ?? ''), status: String(r['effective_status'] ?? r['status'] ?? ''), objective: String(r['objective'] ?? ''), dailyBudget: budget, stats: byId.get(id) ?? emptyStats(), url: adsUrl(a, id) };
  }).sort((x, y) => (x.status === 'ACTIVE' ? 0 : 1) - (y.status === 'ACTIVE' ? 0 : 1) || y.stats.spend - x.stats.spend);
}

// ---------- Écritures ----------
export async function setStatus(id: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
  await write('POST', `/${id}`, { status });
}
/** Budget par jour (unité de la devise). Au niveau de la campagne si elle porte son budget, sinon de son unique ensemble de pubs. */
export async function setBudget(id: string, daily: number): Promise<void> {
  if (!(daily > 0)) throw new Error('Le budget par jour doit être supérieur à 0.');
  const c = await get(`/${id}`, { fields: 'account_id,daily_budget,adsets.limit(25){id,daily_budget}' });
  const cur = await currencyOf(String(c['account_id'] ?? ''));
  const amount = toMinor(daily, cur);
  if (nb(c['daily_budget']) > 0) { await write('POST', `/${id}`, { daily_budget: amount }); return; }
  const sets = ((c['adsets'] as { data?: Json[] } | undefined)?.data ?? []);
  if (sets.length !== 1) throw new Error(sets.length ? 'Cette campagne a plusieurs ensembles de pubs, chacun avec son budget : change-les dans le Gestionnaire de publicités.' : 'Cette campagne n’a pas de budget à modifier ici.');
  await write('POST', `/${String(sets[0]?.['id'])}`, { daily_budget: amount });
}

const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

/** Emplacements. Meta exige `feed` avec `marketplace` : Marketplace seul n'est pas permis. */
function placements(k: AdDraft['placements']): Json {
  if (k === 'marketplace') return { publisher_platforms: ['facebook'], facebook_positions: ['feed', 'marketplace'] };
  if (k === 'feeds') return { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'], instagram_positions: ['stream'] };
  return {}; // auto : emplacements Advantage+ (Meta choisit, Marketplace compris)
}

export async function createCampaign(account: string, d: AdDraft): Promise<{ campaign: string; url: string }> {
  const c = creds(), a = actId(account);
  if (!c) throw new Error('Meta n’est pas connecté (Réglages → Boutiques → Meta).');
  if (!c.page) throw new Error('Renseigne ta Page Facebook (Réglages → Boutiques → Meta) : une pub est toujours publiée au nom d’une Page.');
  const name = d.name.trim(), link = d.link.trim(), countries = d.countries.map(x => x.trim().toUpperCase()).filter(Boolean);
  if (!name) throw new Error('Donne un nom à la campagne.');
  if (!/^https?:\/\//i.test(link)) throw new Error('Le lien de la pub doit commencer par https://.');
  if (!d.primaryText.trim() || !d.headline.trim()) throw new Error('Le texte principal et le titre sont obligatoires.');
  if (!(d.dailyBudget > 0)) throw new Error('Le budget par jour doit être supérieur à 0.');
  if (!countries.length) throw new Error('Choisis au moins un pays.');
  const ageMin = Math.min(65, Math.max(18, Math.round(d.ageMin ?? 18))), ageMax = Math.min(65, Math.max(ageMin, Math.round(d.ageMax ?? 65)));
  const cur = await currencyOf(a), sales = !!c.pixel;
  const created: string[] = [];
  const make = async (edge: string, params: Json): Promise<string> => {
    const r = await write('POST', `/${a}/${edge}`, params);
    const id = String(r['id'] ?? '');
    if (!id) throw new Error('Meta n’a pas renvoyé d’identifiant.');
    created.push(id);
    return id;
  };
  try {
    const campaign = await make('campaigns', { name, objective: sales ? 'OUTCOME_SALES' : 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false });
    const targeting: Json = { geo_locations: { countries }, age_min: ageMin, age_max: ageMax, targeting_automation: { advantage_audience: 0 }, ...placements(d.placements) };
    const adset: Json = {
      name: `${name} · ensemble`, campaign_id: campaign, status: 'PAUSED', daily_budget: toMinor(d.dailyBudget, cur),
      billing_event: 'IMPRESSIONS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', targeting,
      optimization_goal: sales ? 'OFFSITE_CONVERSIONS' : 'LINK_CLICKS',
    };
    if (sales) adset['promoted_object'] = { pixel_id: c.pixel, custom_event_type: 'PURCHASE' };
    if (countries.some(x => EU.has(x))) { // déclarations DSA : réglages du compte s'ils existent, sinon nom saisi, sinon nom de la Page
      const acc = await get(`/${a}`, { fields: 'default_dsa_beneficiary,default_dsa_payor' }).catch(() => ({} as Json));
      if (!(acc['default_dsa_beneficiary'] && acc['default_dsa_payor'])) {
        let who = c.dsa?.trim() ?? '';
        if (!who) who = String((await get(`/${c.page}`, { fields: 'name' }).catch(() => ({} as Json)))['name'] ?? '');
        if (!who) throw new Error('Pour cibler l’UE, Meta exige le bénéficiaire et le payeur de la pub : renseigne un nom dans Réglages → Boutiques → Meta.');
        adset['dsa_beneficiary'] = who; adset['dsa_payor'] = who;
      }
    }
    const adsetId = await make('adsets', adset);
    const linkData: Json = { link, message: d.primaryText.trim(), name: d.headline.trim(), ...(d.cta === 'NO_BUTTON' ? {} : { call_to_action: { type: d.cta || 'SHOP_NOW', value: { link } } }) };
    if (d.description?.trim()) linkData['description'] = d.description.trim();
    if (d.imageUrl?.trim()) linkData['picture'] = d.imageUrl.trim();
    const creative = await make('adcreatives', { name: `${name} · créatif`, object_story_spec: { page_id: c.page, link_data: linkData } });
    await make('ads', { name: `${name} · pub`, adset_id: adsetId, creative: { creative_id: creative }, status: 'PAUSED' });
    return { campaign, url: adsUrl(a, campaign) };
  } catch (e) {
    for (const id of created.reverse()) { try { await write('DELETE', `/${id}`); } catch { /* meilleur effort */ } }
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`La campagne n’a pas pu être créée${created.length ? ' (ce qui avait été créé a été supprimé)' : ''}. ${why}`);
  }
}
