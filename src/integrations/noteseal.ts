// Notes scellées : le contenu des notes liées à un agent Claude Code ne voyage jamais en clair.
// La page chiffre le texte (AES-256-GCM) avec une clé aléatoire à usage unique, et ne laisse dans la consigne que
// les titres. Le Mac, qui reçoit `{ iv, ct, key }` avec la demande, déchiffre au seul moment de lancer `claude` ;
// la clé reste en mémoire et n'est écrite nulle part. Rien d'autre que la consigne n'est donc gardé ou renvoyé à la page.
//
// Format exact de `sealed` (tout en base64 standard, avec « = ») :
//   key : 32 octets bruts (clé AES-256)
//   iv  : 12 octets (nonce GCM)
//   ct  : texte UTF-8 chiffré, immédiatement suivi du tag GCM de 16 octets (ce que rend WebCrypto ; CryptoKit :
//         `AES.GCM.SealedBox(nonce:, ciphertext: ct[..<n-16], tag: ct[(n-16)...])`), sans données associées.
// Le clair (sans la consigne, que le Mac a déjà) a la mise en forme de la consigne jointe d'origine : le Mac l'ajoute à la fin.
import * as store from '../core/store.ts';
import * as tuning from './tuning.ts';
import * as ai from './ai.ts';
import { b64, random } from '../core/crypto.ts';
import type { Project } from '../features/projects/model.ts';

export interface Sealed { iv: string; ct: string; key: string }

const titleOf = (id: string): string => store.get(id)?.title.trim() || 'Sans titre';

/**
 * `prompt` : consigne de l'utilisateur ; `ids` : notes liées.
 * `text` : la consigne + une ligne avec les titres (jamais le contenu) ; `sealed` : le contenu chiffré, absent s'il n'y a aucune note ;
 * `refused` : titres des notes non jointes (fermées à l'IA, chiffrées, #privé, introuvables, ou au-delà des limites de Réglages → Consignes).
 * Interrupteur général coupé : toutes les notes sont refusées.
 */
export async function seal(prompt: string, ids: string[], ctxOf: Project | null = null): Promise<{ text: string; refused: string[]; sealed?: Sealed }> {
  const parts: string[] = [], titles: string[] = [], refused: string[] = [];
  let total = 0;
  const MAX_NOTE = tuning.num('ctx.attach'), MAX_ALL = tuning.num('ctx.attachAll');
  for (const id of ids) {
    const n = store.get(id), body = n ? store.getBody(n) : null;
    if (!n || body == null || !ai.shareable(n)) { refused.push(titleOf(id)); continue; }
    const chunk = body.length > MAX_NOTE ? body.slice(0, MAX_NOTE) + '\n…(tronquée)' : body;
    if (total + chunk.length > MAX_ALL) { refused.push(titleOf(id)); continue; }
    total += chunk.length; titles.push(titleOf(id)); parts.push(`## Note « ${titleOf(id)} »\n\n${chunk}`);
  }
  const head = prompt || (parts.length === 1 ? 'Réalise ce que décrit la note jointe.' : 'Réalise ce que décrivent les notes jointes.');
  // Contextes IA du projet (notes #contexte-ia, nouvelle conversation seulement) : ce sont des notes, ils partent scellés eux aussi.
  // Sans consigne ni note jointe, ils ne suffisent pas à lancer un agent.
  const ctx = parts.length || prompt.trim() ? ai.projectContext(ctxOf, ids) : { text: '', used: [] };
  if (!parts.length && !ctx.text) return { text: head, refused };
  const plain = [parts.length ? `---\nNotes du projet jointes par l’utilisateur (contexte et cahier des charges) :\n\n${parts.join('\n\n')}` : '', ctx.text ? `---\n${ctx.text}` : ''].filter(Boolean).join('\n\n');
  titles.push(...ctx.used.map(titleOf));
  const raw = random(32), iv = random(12);
  // Clé non exportable côté page une fois importée : seul `raw` (ci-dessous) est remis au Mac.
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  const n = titles.length;
  return { text: `${head}\n\n(${n} note${n > 1 ? 's' : ''} liée${n > 1 ? 's' : ''}, scellée${n > 1 ? 's' : ''} : ${titles.join(', ')})`, refused, sealed: { iv: b64(iv), ct: b64(ct), key: b64(raw) } };
}
