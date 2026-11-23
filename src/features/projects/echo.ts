// Écho des messages envoyés : le message de l'utilisateur s'affiche dans le fil dès l'envoi, sans attendre
// que Claude Code l'écrive dans son journal (relu toutes les quelques secondes). Il disparaît, remplacé sans
// saut par le vrai, dès qu'une demande au même texte apparaît dans le fil (ou dans les messages en attente).
// Partagé par l'onglet Claude Code (sessions.ts), l'Espace agents (workspace.ts) et le Salon (salon.ts).

export type EchoState = 'sending' | 'sent';
/** `at` : heure d'envoi, affichée ; `seen` : dernier changement d'état, pour les délais. */
export interface Echo { id: string; session: string; text: string; at: number; seen: number; state: EchoState; pics: number }

let list: Echo[] = [], seq = 0;
/** Demandes du journal (ou messages en attente) déjà associées à un écho : une demande n'en remplace qu'un, même entre deux rendus. */
const taken = new Set<string>();
const take = (k: string): void => { taken.add(k); if (taken.size > 300) taken.delete(taken.values().next().value as string); };
const subs = new Set<() => void>();
const emit = (): void => { for (const f of subs) { try { f(); } catch { /* un abonné défaillant ne bloque pas les autres */ } } };

/** Un message reçu par le Mac mais jamais lu dans le journal (agent sur un serveur, journal illisible) : retiré au bout de ce délai. */
const SENT_TTL = 3 * 60e3;
/** Un envoi sans réponse du Mac (l'appel abandonne à 120 s au plus) : retiré au bout de ce délai. */
const SENDING_TTL = 150e3;
/** Une demande du journal plus ancienne que l'envoi (moins cette marge, pour les horloges décalées) n'est pas celle-ci. */
const SKEW = 90e3;

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();
/** Même message : l'un contient le début de l'autre (le journal peut porter une consigne complétée par Studio). */
function same(a: string, b: string): boolean {
  const x = norm(a), y = norm(b); if (!x || !y) return false;
  // Un texte court (« Oui », « ok ») doit être identique : sinon il se retrouverait dans n'importe quelle demande.
  if (x.length < 24 || y.length < 24) return x === y;
  return x.includes(y.slice(0, 120)) || y.includes(x.slice(0, 120));
}

/** S'abonner aux changements (ajout, envoi confirmé, retrait) ; rend la fonction de désabonnement. */
export function onChange(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

/** Montre le message tout de suite ; rend son identifiant pour `sent` / `drop`. */
export function add(session: string, text: string, pics = 0): string {
  const id = `e${++seq}`, t = text.trim();
  if (!t) return ''; // rien à montrer (notes jointes seules) : pas de bulle vide
  list.push({ id, session, text: t, at: Date.now(), seen: Date.now(), state: 'sending', pics });
  emit(); return id;
}
/** Le Mac a reçu le message : il reste affiché (« transmis ») jusqu'à ce que le journal le contienne. */
export function sent(id: string, session = ''): void {
  const e = list.find(x => x.id === id); if (!e) return;
  e.state = 'sent'; e.seen = Date.now(); if (session) e.session = session;
  emit();
}
/** Envoi refusé ou abandonné : le message disparaît (le texte revient dans le champ, côté appelant). */
export function drop(id: string): void {
  const n = list.length; list = list.filter(x => x.id !== id);
  if (list.length !== n) emit();
}

/**
 * Échos encore à montrer pour cette conversation. Ceux que le fil contient désormais (demande au même texte, envoyée
 * après eux) ou que le Mac a mis en attente sont retirés au passage, comme ceux qui ont trop attendu.
 */
export function pending(session: string, actions: readonly { kind: string; text: string; at: string }[] = [], waiting: readonly { text: string }[] = []): Echo[] {
  if (!session || !list.length) return [];
  const now = Date.now(), out: Echo[] = [];
  let changed = false;
  list = list.filter(e => {
    if (e.session !== session) return true;
    if (now - e.seen > (e.state === 'sent' ? SENT_TTL : SENDING_TTL)) { changed = true; return false; }
    // Chaque demande ne remplace qu'un écho (deux « Oui » envoyés à la suite restent deux messages).
    const a = actions.find(x => x.kind === 'prompt' && (Date.parse(x.at) || now) >= e.at - SKEW && !taken.has(`${session}|a|${x.at}|${x.text}`) && same(x.text, e.text));
    if (a) { take(`${session}|a|${a.at}|${a.text}`); changed = true; return false; }
    const q = waiting.find(x => !taken.has(`${session}|q|${x.text}|${(x as { id?: string }).id ?? ''}`) && same(x.text, e.text));
    if (q) { take(`${session}|q|${q.text}|${(q as { id?: string }).id ?? ''}`); changed = true; return false; }
    out.push(e); return true;
  });
  // Retrait signalé au prochain tour : on est au milieu d'un rendu.
  if (changed) queueMicrotask(emit);
  return out;
}

/** Libellé d'état, commun aux trois fils. */
export const stateLabel = (e: Echo): string => e.state === 'sending' ? 'Envoi…' : 'Transmis';
