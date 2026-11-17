// Notes liées à une boutique : retrouver, dans les notes d'un projet, celles qui parlent d'un produit, d'une commande ou
// d'un client, et créer la note de travail d'un produit. Une note est liée si son texte contient l'adresse d'admin de
// l'objet, son nom (« #1042 »), son handle, un lien [[Titre]], ou une ligne dans un bloc ```shopify :
//
//   ```shopify
//   produit: sac-cabas-lin        (ou  commande: #1042  /  client: marie@exemple.fr)
//   boutique: nom.myshopify.com   (facultatif)
//   ```
import * as store from '../../core/store.ts';
import * as model from '../projects/model.ts';
import { fold } from '../../lib/fuzzy.ts';
import type { Project } from '../projects/model.ts';
import type { Product } from '../../integrations/shopify/api.ts';
import type { Note } from '../../types.ts';

export interface Ref { kind: 'product' | 'order' | 'customer'; id: string; name: string; handle?: string; email?: string }

const SEG = { product: 'products', order: 'orders', customer: 'customers' } as const;
const tail = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Le mot entier (lettres, chiffres, soulignement, et tiret pour un handle). */
const word = (s: string, dash = false): RegExp => new RegExp(`(?<![\\p{L}\\d_${dash ? '-' : ''}])${reEsc(s)}(?![\\p{L}\\d_${dash ? '-' : ''}])`, 'iu');
const FENCE_RE = /^```shopify[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

/** Lignes « clé: valeur » des blocs ```shopify d'un texte (clé sans accent ni casse). */
function fenced(body: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of body.matchAll(FENCE_RE)) {
    for (const line of (m[1] ?? '').split('\n')) {
      const kv = line.match(/^\s*([\p{L}]+)\s*:\s*(.*?)\s*$/u);
      if (kv) out.push([fold(kv[1] ?? ''), kv[2] ?? '']);
    }
  }
  return out;
}
/** Notes du projet qu'on peut lire : ni chiffrées, ni dans la corbeille, ni la liste de tâches. */
function readable(p: Project): { n: Note; body: string }[] {
  const out: { n: Note; body: string }[] = [], seen = new Set<string>();
  for (const n of [...model.notesOf(p), ...model.linkedTo(p)]) {
    if (seen.has(n.id) || n.deletedAt || n.enc || n.todo) continue;
    seen.add(n.id);
    const body = store.getBody(n);
    if (body) out.push({ n, body });
  }
  return out;
}
const norm = (v: string): string => fold(v.trim().replace(/^#/, ''));

/** Notes du projet qui mentionnent l'objet, les plus récemment modifiées d'abord. */
export function notesFor(p: Project, ref: Ref): Note[] {
  const id = tail(ref.id), name = ref.name.trim(), handle = (ref.handle ?? '').trim(), email = (ref.email ?? '').trim();
  const tests: ((b: string) => boolean)[] = [];
  if (/^\d+$/.test(id)) { const re = new RegExp(`(?:shopify\\.com|myshopify\\.com)[^\\s)\\]]*/${SEG[ref.kind]}/${id}(?!\\d)`, 'i'); tests.push(b => re.test(b)); }
  if (ref.kind === 'order' && name) { const re = word(name); tests.push(b => re.test(b)); }
  if (ref.kind === 'product' && handle) { const re = word(handle, true); tests.push(b => re.test(b)); }
  if (ref.kind === 'customer' && email) { const re = word(email, true); tests.push(b => re.test(b)); }
  if (name && ref.kind !== 'order') { const re = new RegExp(`\\[\\[\\s*${reEsc(name)}\\s*(?:[|#][^\\]]*)?\\]\\]`, 'i'); tests.push(b => re.test(b)); }
  const keys = ref.kind === 'product' ? ['produit', 'product'] : ref.kind === 'order' ? ['commande', 'order'] : ['client', 'customer'];
  const wanted = [handle, ref.kind === 'order' ? name : '', ref.kind === 'customer' ? email : '', ref.kind === 'customer' ? name : ''].filter(Boolean).map(norm);
  if (wanted.length) tests.push(b => fenced(b).some(([k, v]) => keys.includes(k) && wanted.includes(norm(v))));
  if (!tests.length) return [];
  return readable(p).filter(x => tests.some(t => t(x.body))).map(x => x.n).sort((a, b) => b.updated - a.updated);
}

const pending = new Map<string, Promise<Note>>();
/** Note de travail d'un produit : celle du projet qui porte `produit: <handle>` dans un bloc ```shopify, sinon créée
 *  (titre du produit, bloc ```shopify, rubriques vides, tag du projet). */
export function noteFor(p: Project, product: Product): Promise<Note> {
  const handle = fold(product.handle.trim());
  const hit = readable(p).find(x => fenced(x.body).some(([k, v]) => (k === 'produit' || k === 'product') && fold(v.trim()) === handle));
  if (hit) return Promise.resolve(hit.n);
  const key = `${p.id}\u0000${handle}`, running = pending.get(key);
  if (running) return running;
  const body = ['```shopify', `produit: ${product.handle}`, ...(p.shopify ? [`boutique: ${p.shopify}`] : []), '```', '',
    '## Fournisseur', '', '## Idées', '', '## Tests de prix', '', '## Retours clients', '', `#${p.tag}`, ''].join('\n');
  const made = store.createNote({ title: product.title.trim().slice(0, 120) || product.handle, body }).finally(() => pending.delete(key));
  pending.set(key, made);
  return made;
}
