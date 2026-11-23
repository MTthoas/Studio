// Jauge d'usage de l'IA, tous fournisseurs confondus : abonnement Claude Code, clés API, modèles locaux, et demain d'autres.
// Un « lecteur » par source : il rend une Source, ou null si elle n'est pas configurée. Ajouter un fournisseur = `register()`.
// Rien ici n'active quoi que ce soit tout seul : les limites de l'abonnement restent un opt-in (Réglages → IA, ou `enableLimits`).
import * as ai from './ai.ts';
import * as usage from './usage.ts';
import * as native from '../core/native.ts';
import * as vault from '../core/vault.ts';

/** Un compteur : `pct` = part utilisée (0-100), null = pas de plafond ; `resetsAt` en millisecondes. */
export interface Meter { key: string; label: string; pct: number | null; value?: string; resetsAt?: number }
export interface Source { id: string; name: string; kind: 'subscription' | 'api' | 'local'; active: boolean; meters: Meter[]; note?: string }
/** Un lecteur rend la source à jour. `cheap` : lecture locale instantanée (pas d'appel natif), refaite à chaque changement. */
export interface Reader { id: string; cheap?: boolean; read(force: boolean): Promise<Source | null> | Source | null }

const MIN_GAP = 30000;
const readers: Reader[] = [];
const cache = new Map<string, Source | null>();
const listeners = new Set<() => void>();
let stamp = 0, lastNative = 0, running: Promise<void> | null = null;

const emit = (): void => listeners.forEach(f => { try { f(); } catch { /* un écouteur fautif ne bloque pas les autres */ } });
const snap = (): string => JSON.stringify([...cache.values()]);

export function register(r: Reader): void {
  const i = readers.findIndex(x => x.id === r.id);
  if (i >= 0) readers[i] = r; else readers.push(r);
}
export const onChange = (fn: () => void): void => { listeners.add(fn); };
/** Instantané synchrone, [] tant que rien n'est lu. */
export const sources = (): Source[] => readers.map(r => cache.get(r.id) ?? null).filter((s): s is Source => !!s);
/** Date (ms) de la dernière lecture réussie, 0 si jamais. */
export const updatedAt = (): number => stamp;

async function run(rs: Reader[], force: boolean): Promise<void> {
  const before = snap();
  await Promise.all(rs.map(async r => {
    try { cache.set(r.id, await r.read(force)); } catch { /* garde la dernière valeur connue */ }
  }));
  if (rs.some(r => !r.cheap)) stamp = Date.now();
  if (before !== snap()) emit();
}

/** Relit toutes les sources. Les lectures natives ne se font pas plus d'une fois par 30 s, sauf `force`. Ne lève jamais. */
export function refresh(force = false): Promise<void> {
  if (running) return running;
  const now = Date.now(), nativeOk = force || now - lastNative >= MIN_GAP;
  const rs = nativeOk ? readers : readers.filter(r => r.cheap);
  if (nativeOk) lastNative = now;
  running = run(rs, force).catch(() => undefined).finally(() => { running = null; });
  return running;
}

/** Fenêtre de 5 h de l'abonnement : `known` faux tant qu'elle n'est pas lue (limites non activées, pas sur Mac…). */
export function fiveHour(): { known: boolean; pct: number; resetsAt: number | null; exhausted: boolean } {
  const m = cache.get('claudecode')?.meters.find(x => x.key === 'five_hour');
  if (!m || m.pct === null) return { known: false, pct: 0, resetsAt: null, exhausted: false };
  const resetsAt = m.resetsAt ?? null;
  return { known: true, pct: m.pct, resetsAt, exhausted: m.pct >= 100 && resetsAt !== null && resetsAt > Date.now() };
}

/** Active (ou coupe) l'affichage des limites de l'abonnement : à appeler seulement sur un geste explicite de l'utilisateur. */
export async function limits(op: 'enable' | 'disable'): Promise<void> {
  try { await ai.cc.limitsCall(op); } catch { /* sans effet */ }
  await refresh(true);
}

// ---------- Lecteurs ----------
const LABELS: Record<string, string> = { five_hour: 'Fenêtre de 5 h', seven_day: 'Semaine', seven_day_opus: 'Semaine · Opus', seven_day_sonnet: 'Semaine · Sonnet', seven_day_fable: 'Semaine · Fable', extra: 'Crédit supplémentaire' };
const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** Tokens locaux de Claude Code : le scan des journaux est coûteux, on le garde 5 minutes (relu avant sur `force`). */
let locCache: { at: number; v: Awaited<ReturnType<typeof ai.cc.usage>> | null } | null = null;
async function localTokens(force: boolean): Promise<Awaited<ReturnType<typeof ai.cc.usage>> | null> {
  if (!force && locCache && Date.now() - locCache.at < 300000) return locCache.v;
  const v = await ai.cc.usage().catch(() => null);
  if (v) locCache = { at: Date.now(), v };
  return v ?? locCache?.v ?? null;
}

const claudecode: Reader = {
  id: 'claudecode',
  async read(force) {
    const onMac = ai.cc.onMac();
    // iPhone lié : seules les limites passent. Web pur : rien.
    if (!onMac && !native.available()) return null;
    if (onMac && !ai.cc.usable() && !ai.cc.last) await ai.cc.status();
    if (onMac && !ai.cc.usable()) return null;
    const meters: Meter[] = [];
    let lim = ai.cc.limits;
    try {
      if (onMac) lim = await ai.cc.limitsCall(force && lim?.enabled ? 'refresh' : '');
      else { const r = await native.call('claude', 'limits', { op: '' }, 30000); if (r.ok) lim = r as unknown as ai.CcLimits; }
    } catch { /* garde l'ancien */ }
    const wins = lim?.enabled ? lim.windows ?? [] : [];
    for (const w of wins) meters.push({ key: w.key, label: LABELS[w.key] ?? w.key, pct: clamp(w.pct), resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined });
    let note: string | undefined;
    if (!lim?.enabled) note = 'limits-off';
    if (onMac && !wins.some(w => w.key === 'five_hour')) {
      const loc = await localTokens(force);
      if (loc) meters.unshift({ key: 'tokens_5h', label: 'Tokens des 5 dernières heures', pct: null, value: usage.fmt(usage.billable(loc.h5)) });
      if (loc && !wins.length) meters.push({ key: 'tokens_7d', label: 'Tokens des 7 derniers jours', pct: null, value: usage.fmt(usage.billable(loc.d7)) });
    }
    if (!meters.length) return null;
    return { id: 'claudecode', name: `Claude Code${ai.cc.plan(ai.cc.last) ? ` · ${ai.cc.plan(ai.cc.last)}` : ''}`, kind: 'subscription', active: ai.config().provider === 'claudecode', meters, note };
  },
};

/** Clé API : tokens du mois contre le budget mensuel fixé dans les réglages (le budget compte toutes les clés ensemble). */
const apiReader = (id: 'anthropic' | 'openai', name: string): Reader => ({
  id, cheap: true,
  read() {
    if (!vault.secret(id)) return null;
    const m = usage.month(), mine = m.rows.filter(([k]) => k.startsWith(`${id}:`)).reduce((n, [, c]) => n + usage.billable(c), 0);
    const budget = ai.config().budgetM * 1e6, total = usage.billable(m.total);
    const meters: Meter[] = [{ key: 'month', label: 'Tokens du mois', pct: budget > 0 ? clamp(total / budget * 100) : null, value: budget > 0 ? `${usage.fmt(mine)} · budget ${usage.fmt(budget)}` : usage.fmt(mine) }];
    return { id, name, kind: 'api', active: ai.config().provider === id, meters, note: budget > 0 ? (total !== mine ? `Le budget compte toutes les clés : ${usage.fmt(total)} utilisés.` : undefined) : 'Aucun budget fixé (Réglages → IA).' };
  },
});

/** Modèle local : pas de plafond ; on montre le modèle chargé si Studio pilote Ollama, rien s'il n'y en a pas. */
const local: Reader = {
  id: 'local',
  async read() {
    const c = ai.config();
    if (c.provider !== 'local' && !c.localVia) return null;
    let value = c.localModel || 'Modèle local';
    if (c.localVia && ai.cc.onMac()) {
      try {
        const r = await native.call('models', 'status', c.localVia === 'server' ? { project: c.localProject, server: c.localServer } : { project: '', server: '' }, 20000);
        const loaded = (r.loaded as { name: string; size: number }[] | undefined) ?? [];
        const bytes = loaded.reduce((n, l) => n + l.size, 0);
        if (r.ok) {
          if (!loaded.length) return null; // aucun modèle chargé : rien à montrer
          value = `${loaded.map(l => l.name).join(', ')} · ${(bytes / 2 ** 30).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`;
        }
      } catch { /* garde le nom configuré */ }
    } else if (!c.localModel) return null; // aucun modèle choisi
    return { id: 'local', name: 'Modèle local', kind: 'local', active: c.provider === 'local', meters: [{ key: 'loaded', label: 'En mémoire', pct: null, value }] };
  },
};

register(claudecode);
register(apiReader('anthropic', 'Claude (clé API)'));
register(apiReader('openai', 'OpenAI'));
register(local);

// Les clés API se lisent dans le stockage local : on suit leur consommation sans appel natif.
usage.onChange(() => { void run(readers.filter(r => r.cheap), false); });
vault.onChange(() => { void run(readers.filter(r => r.cheap), false); });
