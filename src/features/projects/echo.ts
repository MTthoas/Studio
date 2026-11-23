// Écho des messages envoyés : le message de l'utilisateur s'affiche dans le fil dès l'envoi, sans attendre
// que Claude Code l'écrive dans son journal (relu toutes les quelques secondes). Il disparaît, remplacé sans
// saut par le vrai, dès qu'une demande au même texte apparaît dans le fil (ou dans les messages en attente).
// Partagé par l'onglet Claude Code (sessions.ts), l'Espace agents (workspace.ts) et le Salon (salon.ts).
// S'y ajoutent l'agent « réveillé » dès l'envoi (`awake`, `active`, `move`) et la relecture accélérée (`hurry`).

export type EchoState = 'sending' | 'sent';
/** `at` : heure d'envoi, affichée ; `seen` : dernier changement d'état, pour les délais. */
export interface Echo { id: string; session: string; text: string; at: number; seen: number; state: EchoState; pics: number }

let list: Echo[] = [], seq = 0;
/** Demandes du journal (ou messages en attente) déjà associées à un écho : une demande n'en remplace qu'un, même entre deux rendus. */
const taken = new Set<string>();
const take = (k: string): void => { taken.add(k); if (taken.size > 300) taken.delete(taken.values().next().value as string); };
const subs = new Set<() => void>();
const emit = (): void => { for (const f of subs) { try { f(); } catch { /* un abonné défaillant ne bloque pas les autres */ } } };
/** Envoi récent par conversation : l'agent paraît au travail dès l'envoi, sans attendre que le Mac le dise (45 s au plus). */
const woke = new Map<string, number>();

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
  woke.set(session, Date.now());
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
  const e = list.find(x => x.id === id); if (!e) return;
  list = list.filter(x => x !== e);
  // L'agent n'est plus montré au travail s'il ne reste aucun autre envoi pour cette conversation.
  if (!list.some(x => x.session === e.session)) woke.delete(e.session);
  emit();
}
/** La conversation a reçu son identifiant (nouvel agent) : ses échos et son réveil passent de `from` à `to`. */
export function move(from: string, to: string): void {
  if (!from || !to || from === to) return;
  const w = woke.get(from); let changed = false;
  for (const e of list) if (e.session === from) { e.session = to; changed = true; }
  woke.delete(from); if (w) woke.set(to, w);
  if (changed) emit();
}
/** Des messages attendent encore leur version du Mac, ou l'agent vient d'être réveillé. */
export const active = (session: string): boolean => list.some(e => e.session === session) || woke.has(session);
/** L'agent est montré au travail : envoi récent, et rien n'est encore venu de lui depuis (`actions` : le fil connu). */
export function awake(session: string, actions: readonly { at: string; kind: string }[] = []): boolean {
  const at = woke.get(session); if (!at) return false;
  if (Date.now() - at > 45e3 || actions.some(a => a.kind !== 'prompt' && (Date.parse(a.at) || 0) > at + 1000)) { woke.delete(session); return false; }
  return true;
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

// ---------- Relecture accélérée ----------
let until = 0, timer: ReturnType<typeof setTimeout> | undefined;
const goers = new Set<() => boolean | void>();
/** Après un envoi : `go` est rappelée toutes les 0,9 s pendant 20 s (au lieu de 2,5 à 3 s), pour que la réponse apparaisse dès
 *  qu'elle existe. Un seul minuteur pour toute l'app, rien pendant que la fenêtre est cachée, `go` renvoie `false` quand sa page a disparu. */
export function hurry(go: () => boolean | void): void {
  until = Date.now() + 20e3; goers.add(go);
  if (timer) return;
  const tick = (): void => {
    timer = undefined;
    if (Date.now() > until) { goers.clear(); return; }
    if (!document.hidden) for (const g of [...goers]) if (g() === false) goers.delete(g);
    if (goers.size) timer = setTimeout(tick, 900); else goers.clear();
  };
  timer = setTimeout(tick, 400);
}
