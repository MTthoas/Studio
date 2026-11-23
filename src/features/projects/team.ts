// Rendu de l'équipe d'agents, sans état : des fonctions qui prennent des données et rendent du HTML (ou des blocs
// pour `syncFeed`). Trois morceaux :
//   - `diffHTML` : ce qu'une écriture a changé dans un fichier (fil de l'onglet Claude Code et de l'Espace agents) ;
//   - `teamHTML` : la bande « équipe » d'une vue (une ligne repliée par défaut, puis une ligne par sous-agent) ;
//   - `exchangeBlocks` : le fil « Échanges » (consignes, délégations, comptes rendus, messages du tableau).
// Tout ce qui vient du Mac passe par `esc()`. Les styles sont dans css/team.css (préfixe `tm-`).
import { diff } from '../../lib/diff.ts';
import { esc, renderMarkdown } from '../../lib/markdown.ts';
import { icon } from '../../ui/kit.ts';
import type { Action, Block, SubAgent } from './sessions.ts';

// ---------- Diff d'une écriture ----------
const WRITES: Record<string, string> = { Edit: 'Modifié', MultiEdit: 'Modifié', NotebookEdit: 'Modifié', Write: 'Écrit' };
/** Au-delà, le diff est replié : une écriture longue ne doit pas pousser le reste du fil hors de la vue. */
const OPEN_MAX = 10;
const sign = (n: number, c: string): string => `${c}${n}`;
const count = (v: unknown): number | null => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };

/** Vrai quand l'action est une écriture dont le Mac a joint le texte (`new`, et `old` sauf pour Write). */
export const hasDiff = (a: Action): boolean => /^tool:(Edit|MultiEdit|NotebookEdit|Write)$/.test(a.kind) && typeof a.new === 'string' && !!a.file;

/** Diff compact d'une écriture : seules les lignes changées, un « ⋯ » pour les passages inchangés entre deux changements.
 *  `path` : chemin déjà raccourci pour l'affichage. Déplié jusqu'à une dizaine de lignes, replié au-delà. */
export function diffHTML(a: Action, path: string): string {
  const before = a.old ? a.old.split('\n') : [], after = a.new ? a.new.split('\n') : [];
  const ops = diff(before, after);
  const rows: string[] = []; let gap = false, shown = 0, add = 0, del = 0;
  for (const o of ops) {
    if (o.t === '=') { gap = shown > 0; continue; }
    if (gap) { rows.push('<span class="tm-l gap" aria-hidden="true"><i></i><code>⋯</code></span>'); gap = false; }
    if (o.t === '+') add++; else del++;
    shown++;
    rows.push(`<span class="tm-l ${o.t === '+' ? 'add' : 'del'}"><i aria-hidden="true">${o.t === '+' ? '+' : '−'}</i><code>${esc(o.s) || ' '}</code></span>`);
  }
  // Les extraits sont tronqués à 1500 caractères : les totaux de l'action, quand le Mac les donne, sont les vrais.
  const na = count(a.add) ?? add, nd = count(a.del) ?? del, verb = WRITES[a.kind.slice(5)] ?? 'Modifié';
  const body = rows.length ? rows.join('') : '<span class="tm-l gap"><i></i><code>Aucun changement de texte</code></span>';
  return `<details class="tm-diff"${shown <= OPEN_MAX ? ' open' : ''}><summary><span class="tm-verb">${verb}</span><code class="tm-path" title="${esc(a.file ?? '')}">${esc(path)}</code><span class="tm-n"><b class="tm-add">${sign(na, '+')}</b><b class="tm-del">${sign(nd, '−')}</b></span>${icon('chevron')}</summary><div class="tm-lines" role="group" aria-label="Lignes changées dans ${esc(path)}">${body}</div></details>`;
}

// ---------- Bande « équipe » ----------
const plural = (n: number, w: string): string => `${n} ${w}${n > 1 ? 's' : ''}`;
const ageMs = (iso: string): number => Date.now() - (Date.parse(iso) || 0);

/** Dernière action d'un sous-agent en une ligne : « Edit src/a.ts », ou le début de sa dernière phrase. */
function lastLine(a: SubAgent, shorten: (p: string) => string): string {
  const l = a.last; if (!l) return '';
  const text = l.text.replace(/\s+/g, ' ').trim();
  return l.kind.startsWith('tool:') ? `${l.kind.slice(5)} ${shorten(text)}`.trim() : text;
}

/** Une ligne par sous-agent, ceux qui travaillent d'abord. `fold` : seule la ligne de résumé est montrée (c'est l'état par défaut).
 *  `shown` : sous-agents déjà dans une vue (un clic y ramène au lieu d'en ouvrir une autre). */
export function teamHTML(subs: SubAgent[], o: { fold: boolean; shown: Set<string>; shorten: (p: string) => string }): string {
  if (!subs.length) return '';
  const list = [...subs].sort((a, b) => Number(b.live) - Number(a.live) || (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0));
  const run = subs.filter(s => s.live).length;
  const add = subs.reduce((n, s) => n + (s.lines?.add ?? 0), 0), del = subs.reduce((n, s) => n + (s.lines?.del ?? 0), 0);
  const head = `<button type="button" class="tm-head" data-w="teamfold" aria-expanded="${!o.fold}" aria-label="Équipe : ${plural(subs.length, 'sous-agent')}${run ? `, ${run} au travail` : ''}">${icon('chevron')}<span class="tm-sum"><b class="tm-title">Équipe</b> · ${plural(subs.length, 'sous-agent')}${run ? ` · ${run} au travail` : ''}</span>${add || del ? `<span class="tm-n"><b class="tm-add">+${add}</b><b class="tm-del">−${del}</b></span>` : ''}</button>`;
  if (o.fold) return head;
  const rows = list.map(a => {
    const name = a.type || a.title || 'Sous-agent', files = a.files ?? [];
    const state = a.live ? 'au travail' : 'fini', last = lastLine(a, o.shorten);
    const n = a.lines ? `<span class="tm-n"><b class="tm-add">+${a.lines.add}</b><b class="tm-del">−${a.lines.del}</b></span>` : '<span class="tm-n"></span>';
    const sel = o.shown.has(a.id);
    return `<button type="button" class="tm-row${a.live ? ' live' : ''}${sel ? ' shown' : ''}" data-w="subview" data-sa="${esc(a.id)}" aria-label="${esc(`${sel ? 'Aller à' : 'Ouvrir'} ${name}, ${state}${last ? `, ${last}` : ''}`)}" title="${esc([a.title, ...files.map(f => f.path)].join('\n'))}">
      <i class="tm-dot${a.live ? ' live' : ''}" aria-hidden="true"></i>
      <span class="tm-name"><b>${esc(name)}</b>${a.type && a.title && a.title !== a.type ? `<em>${esc(a.title)}</em>` : ''}</span>
      <span class="tm-last">${esc(last)}</span>${n}</button>`;
  }).join('');
  return `${head}<div class="tm-rows">${rows}</div>`;
}

/** Un sous-agent fini depuis plus d'une minute : sa vue peut être rendue (Auto). */
export const settled = (a: SubAgent): boolean => !a.live && ageMs(a.updated) > 6e4;

// ---------- Échanges ----------
/** Message du tableau d'équipe (`agent board`, champ `messages`). */
export interface BoardMsg { at: number; from: string; to: string; text: string }
export interface Entry { at: number; from: string; to: string; text: string; body?: string; kind: 'user' | 'delegate' | 'report' | 'board' }

const who = (n: string): string => {
  const b = n.replace(/\.md$/, ''), m = /^agent-(\d+)(?:-(.+))?$/.exec(b);
  return b === 'utilisateur' ? 'Toi' : m ? `Agent ${m[1]}${m[2] ? ` · ${m[2]}` : ''}` : b;
};
const hm = (at: number): string => {
  const d = new Date(at), today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('fr-FR', today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const oneLine = (s: string, n = 140): string => { const t = s.replace(/[#>*`]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Au-delà, une entrée est repliée : seule sa première ligne se lit sans clic. */
const FOLD_AT = 280;

/** Tout ce qui se dit dans l'équipe, du plus ancien au plus récent : consignes de l'utilisateur, délégations de l'agent
 *  principal, comptes rendus des sous-agents, messages du tableau. Rien n'est inventé : chaque entrée vient d'une donnée du Mac. */
export function exchanges(actions: Action[], subs: SubAgent[], messages: BoardMsg[]): Entry[] {
  const out: Entry[] = [];
  for (const a of actions) {
    const at = Date.parse(a.at) || 0;
    if (a.kind === 'prompt') out.push({ at, from: 'Toi', to: 'principal', text: a.text, kind: 'user' });
    else if ((a.kind === 'tool:Agent' || a.kind === 'tool:Task') && (a.body || a.to)) out.push({ at, from: 'principal', to: a.to || 'sous-agent', text: a.text, body: a.body, kind: 'delegate' });
  }
  for (const s of subs) if (!s.live && s.report) out.push({ at: Date.parse(s.updated) || 0, from: s.type || s.title || 'sous-agent', to: 'principal', text: s.report, kind: 'report' });
  for (const m of messages) out.push({ at: m.at, from: who(m.from), to: m.to ? who(m.to) : '', text: m.text, kind: 'board' });
  return out.sort((a, b) => a.at - b.at).slice(-150);
}

/** Les échanges en blocs pour `syncFeed` : une entrée longue est un `<details>` de premier niveau (l'ouverture survit aux relectures). */
export function exchangeBlocks(list: Entry[]): Block[] {
  const seen = new Map<string, number>();
  return list.map(e => {
    const k0 = `${e.kind}|${e.at}|${e.from}|${e.to}`, n = seen.get(k0) ?? 0; seen.set(k0, n + 1);
    const key = n ? `${k0}|${n}` : k0;
    const head = `<span class="tm-who"><b>${esc(e.from)}</b>${e.to ? `<span role="img" aria-label="vers">→</span><b>${esc(e.to)}</b>` : ''}</span><time>${esc(hm(e.at))}</time>`;
    // Délégation : la description reste visible, la consigne complète se déplie.
    if (e.kind === 'delegate') {
      const desc = e.text ? `<p class="tm-line">${esc(e.text)}</p>` : '';
      return { key, html: e.body
        ? `<details class="tm-x delegate"><summary>${head}${icon('chevron')}</summary>${desc}<div class="tm-brief"><p class="tm-cap">Consigne</p><div class="tm-pre">${esc(e.body)}</div></div></details>`
        : `<article class="tm-x delegate"><header>${head}</header>${desc}</article>` };
    }
    const long = e.text.length > FOLD_AT || e.text.split('\n').length > 6;
    // Consigne de l'utilisateur : texte brut, tel qu'il l'a écrit.
    if (e.kind === 'user') return { key, html: long
      ? `<details class="tm-x user"><summary>${head}${icon('chevron')}<span class="tm-first">${esc(oneLine(e.text))}</span></summary><div class="tm-pre">${esc(e.text)}</div></details>`
      : `<article class="tm-x user"><header>${head}</header><p class="tm-line">${esc(e.text)}</p></article>` };
    const md = `<div class="md tm-md">${renderMarkdown(e.text)}</div>`;
    return { key, html: long
      ? `<details class="tm-x ${e.kind}"><summary>${head}${icon('chevron')}<span class="tm-first">${esc(oneLine(e.text))}</span></summary>${md}</details>`
      : `<article class="tm-x ${e.kind}"><header>${head}</header>${md}</article>` };
  });
}
