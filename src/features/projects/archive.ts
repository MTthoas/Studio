// Fils rangés (archivés) du Salon, par projet : retirés de la liste et de la barre latérale, jamais effacés.
// Sur cet appareil seulement (localStorage `studio.salon.archived` = { pid: { session: rangé le (ms) } }).
const KEY = 'studio.salon.archived', MAX = 400;
let all: Record<string, Record<string, number>> = (() => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '{}') as unknown; return v && typeof v === 'object' ? v as Record<string, Record<string, number>> : {}; } catch { return {}; }
})();
const subs = new Set<() => void>();
function save(): void {
  // Au-delà de MAX par projet, les plus anciennement rangés sont oubliés (ils réapparaissent, rien n'est perdu).
  for (const pid of Object.keys(all)) {
    const e = Object.entries(all[pid] ?? {});
    if (!e.length) delete all[pid];
    else if (e.length > MAX) all[pid] = Object.fromEntries(e.sort((a, b) => b[1] - a[1]).slice(0, MAX));
  }
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* plein */ }
  for (const f of subs) f();
}
export const isArchived = (pid: string, id: string): boolean => !!all[pid]?.[id];
export const count = (pid: string): number => Object.keys(all[pid] ?? {}).length;
export function archive(pid: string, ids: string[]): void {
  if (!ids.length) return;
  const m = all[pid] ?? (all[pid] = {}), now = Date.now();
  for (const id of ids) if (id && !id.startsWith('run:')) m[id] = now;
  save();
}
export function restore(pid: string, ids: string[]): void {
  const m = all[pid]; if (!m || !ids.length) return;
  for (const id of ids) delete m[id];
  save();
}
/** Appelé à chaque changement (barre latérale, Salon). */
export function onChange(f: () => void): void { subs.add(f); }
