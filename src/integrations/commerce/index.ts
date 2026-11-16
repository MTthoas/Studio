// Boutiques des projets. Une boutique appartient à UN projet (champ « boutique: » de son bloc ```projet), comme un
// dépôt GitHub ou un projet Linear : ses chiffres ne sortent jamais de ce projet (integrations/scope.ts).
// - L'adresse de la boutique est dans la note du projet ; ses identifiants sont dans le coffre de l'appareil
//   (secret « commerce », rangés par adresse) et n'en sortent que vers l'app native, le temps d'un appel.
// - Les chiffres viennent du fournisseur (shopify.ts) au format du socle (core.ts), gardés deux minutes en mémoire.
// - Toutes les trois minutes, les nouvelles commandes sont annoncées : notification, et événement « commande »
//   pour les automatisations du projet.
// Lecture seule. Disponible dans l'app (Mac, iPhone) : un navigateur ne peut pas joindre l'API d'une boutique.
import * as native from '../../core/native.ts';
import * as vault from '../../core/vault.ts';
import * as events from '../../core/events.ts';
import * as model from '../../features/projects/model.ts';
import { shopify } from './shopify.ts';
import { counted, money } from './core.ts';
import type { Conn, Order, Provider, Shop, Snapshot } from './core.ts';
import type { Project } from '../../features/projects/model.ts';

export * from './core.ts';

/** Le fournisseur d'une boutique. Un seul aujourd'hui ; le prochain se reconnaîtra à l'adresse (`Provider.domain`). */
const PROVIDERS: Provider[] = [shopify];
const providerOf = (domain: string): Provider => PROVIDERS.find(p => p.domain(domain) === domain) ?? shopify;
/** Adresse de boutique lisible par un fournisseur, normalisée ; null sinon. */
export const normalize = (input: string): string | null => { for (const p of PROVIDERS) { const d = p.domain(input); if (d) return d; } return null; };

/** Période lue pour les chiffres : 30 jours (Shopify n'en donne que 60 sans droit supplémentaire). */
export const DAYS = 30;
const SECRET = 'commerce';
const conns = (): Record<string, Conn> => vault.secret<Record<string, Conn>>(SECRET) ?? {};

export const supported = (): boolean => native.available();
/** Le projet a une boutique, et cet appareil en a les identifiants (coffre ouvert). */
export const ready = (p: Project | null | undefined): p is Project & { shop: string } => !!p?.shop && supported() && !!conns()[p.shop];

const listeners = new Set<(domain: string) => void>();
/** Prévenu quand les chiffres d'une boutique ont changé (nouvelle commande, connexion, déconnexion). */
export const onChange = (f: (domain: string) => void): (() => void) => { listeners.add(f); return () => listeners.delete(f); };
const changed = (domain: string): void => { cache.delete(domain); for (const f of listeners) { try { f(domain); } catch (e) { console.error('commerce', e); } } };

/** Relie une boutique au projet : la connexion est vérifiée avant d'être gardée. */
export async function connect(p: Project, input: string, conn: Conn): Promise<Shop> {
  if (!supported()) throw new Error('La boutique se relie depuis l’app Studio (Mac ou iPhone).');
  if (!vault.isOpen()) throw new Error('Ouvre d’abord le coffre : les identifiants de la boutique y sont gardés.');
  const domain = normalize(input);
  if (!domain) throw new Error('Adresse de boutique invalide : attendu « nom.myshopify.com ».');
  const other = model.projects().find(x => x.id !== p.id && x.shop === domain);
  if (other) throw new Error(`Cette boutique est déjà reliée au projet « ${other.name} ».`);
  const shop = await providerOf(domain).shop(domain, conn);
  await vault.setSecret(SECRET, { ...conns(), [domain]: conn });
  if (p.shop !== domain) await model.setField(p, 'boutique', domain);
  changed(domain);
  return shop;
}

/** Détache la boutique du projet et efface ses identifiants de cet appareil. */
export async function disconnect(p: Project): Promise<void> {
  const domain = p.shop; if (!domain) return;
  if (vault.isOpen() && conns()[domain]) { const all = { ...conns() }; delete all[domain]; await vault.setSecret(SECRET, Object.keys(all).length ? all : null); }
  await model.setField(p, 'boutique', '');
  forget(domain); changed(domain);
}

// ---------- Chiffres ----------
const REUSE = 120e3;
const cache = new Map<string, { at: number; snap: Snapshot }>(), inflight = new Map<string, Promise<Snapshot>>();

/** Chiffres de la boutique du projet. Une même boutique demandée par plusieurs vues ne part qu'une fois. */
export function snapshot(p: Project, { fresh = false } = {}): Promise<Snapshot> {
  const domain = p.shop, conn = domain ? conns()[domain] : undefined;
  if (!domain || !conn) return Promise.reject(new Error('Ce projet n’a pas de boutique reliée sur cet appareil.'));
  const hit = cache.get(domain), running = inflight.get(domain);
  if (running) return running;
  if (!fresh && hit && Date.now() - hit.at < REUSE) return Promise.resolve(hit.snap);
  const run = providerOf(domain).snapshot(domain, conn, DAYS)
    .then(snap => { cache.set(domain, { at: Date.now(), snap }); return snap; })
    .finally(() => inflight.delete(domain));
  inflight.set(domain, run);
  return run;
}
/** Derniers chiffres déjà lus, sans rien demander (affichage immédiat). */
export const cached = (p: Project): Snapshot | null => (p.shop ? cache.get(p.shop)?.snap ?? null : null);

// ---------- Nouvelles commandes ----------
// Par boutique : les commandes déjà vues et l'heure de la plus récente. À la première lecture rien n'est annoncé.
const SEEN = 'studio.commerce.seen', EVERY = 180e3;
interface Seen { at: number; ids: string[] }
function seen(): Record<string, Seen> {
  try { const v = JSON.parse(localStorage.getItem(SEEN) || '{}') as Record<string, Seen>; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const saveSeen = (s: Record<string, Seen>): void => { try { localStorage.setItem(SEEN, JSON.stringify(s)); } catch { /* stockage plein */ } };
function forget(domain: string): void { const s = seen(); delete s[domain]; saveSeen(s); }

/** Texte d'une commande pour une notification ou une automatisation : numéro, montant, articles. Aucun nom de client. */
export const orderText = (o: Order): string => `${o.name} · ${money(o.total, o.currency)}${o.items.length ? ` · ${o.items.map(l => `${l.qty > 1 ? `${String(l.qty)} × ` : ''}${l.title}`).join(', ')}` : ''}`;

function announce(p: Project, o: Order): void {
  const text = orderText(o);
  events.emit('commande', `Nouvelle commande sur la boutique du projet « ${p.name} » : ${text}`, { shop: p.shop ?? '' });
  window.webkit?.messageHandlers?.carnet?.postMessage({ type: 'notify', title: `Nouvelle commande · ${p.name}`, body: text, url: '' });
}

let polling = false;
async function poll(): Promise<void> {
  if (polling || !supported() || !vault.isOpen()) return;
  polling = true;
  try {
    for (const p of model.projects()) {
      if (!ready(p)) continue;
      const domain = p.shop, conn = conns()[domain]; if (!conn) continue;
      const all = seen(), mine = all[domain];
      try {
        const list = await providerOf(domain).latest(domain, conn, mine ? mine.at - 60e3 : Date.now() - 864e5);
        const known = new Set(mine?.ids ?? []), fresh = list.filter(o => !known.has(o.id));
        // Relue juste avant d'écrire : une autre boucle (autre fenêtre) a pu passer entre-temps.
        const now = seen();
        now[domain] = { at: Math.max(mine?.at ?? 0, ...list.map(o => o.at)), ids: [...new Set([...list.map(o => o.id), ...(mine?.ids ?? [])])].slice(0, 60) };
        saveSeen(now);
        if (mine && fresh.length) { for (const o of fresh.filter(counted).reverse()) announce(p, o); changed(domain); }
      } catch (e) { console.error('commerce', domain, e); }
    }
  } finally { polling = false; }
}

/** À appeler une fois au démarrage : surveille les nouvelles commandes des projets reliés. */
export function init(): void {
  setInterval(() => void poll(), EVERY);
  vault.onChange(() => { if (vault.isOpen()) void poll(); else cache.clear(); });
  setTimeout(() => void poll(), 8000);
}
