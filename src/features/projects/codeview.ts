// Onglet « Code » de la vue Design du Salon (28 nov. 2026, « voir les modifs de code in realtime à la github », design B
// choisi) : en haut une bande d'activité (une puce par agent : étape, chrono) ; dessous, comme les « Files changed » de
// GitHub, l'arbre des fichiers modifiés à gauche (+n −n, point vert sur ceux en cours d'écriture, clic = aller au fichier)
// et le diff à droite : un bloc par fichier (chemin, +n −n, repliable), numéros de ligne ancien/nouveau, lignes ajoutées en
// vert, retirées en rouge, en-têtes `@@`. Volet étroit (< 720 px, requête de conteneur) : l'arbre passe au-dessus du diff.
// Styles `cv-` dans css/salon.css.
//   - Le diff vient du Mac (`project diff`, scope `working` de la copie ; `branch` quand il n'y a plus rien de non commité,
//     après une publication). Il est relu quand `sig` change (une écriture d'un agent), au plus toutes les 1,5 s, et toutes
//     les 8 s tant que l'équipe travaille (sous-agents dont on ne voit pas les actions).
//   - Un fichier nouveau non suivi n'est pas dans le patch : son contenu vient des écritures du fil (`writes`), sinon il est
//     seulement nommé.
//   - Les lignes ajoutées depuis la lecture précédente s'allument un instant (`cv-new`).
// Le Salon repeint toutes les secondes : `paint` passe par morphIfChanged, la position de lecture et les replis tiennent.
import * as native from '../../core/native.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, morphIfChanged } from '../../ui/kit.ts';
import type { Project } from './model.ts';

/** Ce que le Salon donne à l'onglet : copie du fil, signature des écritures, bande d'activité (HTML), contenus écrits par
 *  chemin absolu, fichiers touchés du plus récent au plus ancien, fichiers en cours d'écriture, équipe au travail. */
export interface CodeIn { wt: string; sig: string; tech: string; writes: Map<string, string>; touched: string[]; live: string[]; busy: boolean }
interface Line { t: '+' | '-' | ' ' | '@'; s: string; a: number; b: number }
interface File { path: string; add: number; del: number; lines: Line[]; isNew: boolean; gone: boolean; bin: boolean; more: number }
interface Read { sig: string; at: number; busy: boolean; files: File[] | null; err: string; scope: string; base: string; truncated: boolean; fresh: Set<string>; seen: Set<string> | null }

const reads = new Map<string, Read>();
/** Repli choisi à la main, par chemin (sinon : replié s'il est supprimé, binaire ou très long). */
const fold = new Map<string, boolean>();
const MAX = 400;
/** Fichier choisi dans l'arbre, par copie. */
const picked = new Map<string, string>();

/** Patch unifié → fichiers et lignes numérotées. */
function parse(patch: string): File[] {
  const out: File[] = [];
  let f: File | null = null, a = 0, b = 0, head = true;
  for (const l of patch.split('\n')) {
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      f = { path: m?.[2] ?? l.slice(11), add: 0, del: 0, lines: [], isNew: false, gone: false, bin: false, more: 0 }; out.push(f); head = true; continue;
    }
    if (!f) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { a = Number(h[1]); b = Number(h[2]); head = false; f.lines.push({ t: '@', s: l, a: 0, b: 0 }); continue; }
    if (head) {
      if (l.startsWith('new file')) f.isNew = true; else if (l.startsWith('deleted file')) f.gone = true; else if (l.startsWith('Binary files')) f.bin = true;
      continue;
    }
    if (l.startsWith('+')) { f.add++; f.lines.push({ t: '+', s: l.slice(1), a: 0, b: b++ }); }
    else if (l.startsWith('-')) { f.del++; f.lines.push({ t: '-', s: l.slice(1), a: a++, b: 0 }); }
    else if (l.startsWith(' ')) f.lines.push({ t: ' ', s: l.slice(1), a: a++, b: b++ });
  }
  return out;
}

/** Fichier nouveau non suivi : tout en ajout, d'après la dernière écriture du fil sur ce chemin. */
function untracked(path: string, c: CodeIn): File {
  const k = [...c.writes.keys()].find(w => w === path || w.endsWith('/' + path)), text = k ? c.writes.get(k) ?? '' : null;
  const rows = text === null ? [] : text.replace(/\n$/, '').split('\n');
  return { path, add: rows.length, del: 0, isNew: true, gone: false, bin: false, more: 0,
    lines: text === null ? [] : [{ t: '@', s: `@@ -0,0 +1,${rows.length} @@`, a: 0, b: 0 }, ...rows.map((s, i): Line => ({ t: '+', s, a: 0, b: i + 1 }))] };
}

function read(p: Project, c: CodeIn, again: () => void): Read {
  const k = `${p.id}|${c.wt}`, r = reads.get(k) ?? { sig: '', at: 0, busy: false, files: null, err: '', scope: 'working', base: '', truncated: false, fresh: new Set<string>(), seen: null };
  reads.set(k, r);
  const want = r.sig !== c.sig || (c.busy && Date.now() - r.at > 8000);
  if (!native.available() || r.busy || !want || Date.now() - r.at < 1500) return r;
  r.busy = true;
  const sig = c.sig, call = (scope: string) => native.call('project', 'diff', { project: p.id, scope, ...(c.wt ? { worktree: c.wt } : {}) }, 30000);
  void (async () => {
    let d = await call('working'), scope = 'working';
    if (d.ok && c.wt && !String(d.patch ?? '').trim() && !String(d.untracked ?? '').trim()) { const b = await call('branch'); if (b.ok && String(b.patch ?? '').trim()) { d = b; scope = 'branch'; } }
    if (!d.ok) { r.err = String(d.message ?? 'Impossible de lire les changements.'); return; }
    const files = parse(String(d.patch ?? ''));
    for (const u of String(d.untracked ?? '').split('\n').map(s => s.trim()).filter(Boolean)) if (!files.some(f => f.path === u)) files.push(untracked(u, c));
    // Plus récents d'abord (dernière écriture d'un agent), le reste par ordre alphabétique.
    const rank = (f: File): number => { const i = c.touched.findIndex(t => t === f.path || t.endsWith('/' + f.path)); return i < 0 ? 1e6 : i; };
    files.sort((x, y) => rank(x) - rank(y) || x.path.localeCompare(y.path));
    for (const f of files) if (f.lines.length > MAX) { f.more = f.lines.length - MAX; f.lines = f.lines.slice(0, MAX); }
    const now = new Set(files.flatMap(f => f.lines.filter(l => l.t === '+').map(l => `${f.path}\0${l.s}`)));
    r.fresh = r.seen ? new Set([...now].filter(x => !r.seen?.has(x))) : new Set();
    r.seen = now; r.files = files; r.err = ''; r.scope = scope; r.base = String(d.base ?? ''); r.truncated = !!d.truncated;
  })().catch(e => { r.err = e instanceof Error ? e.message : String(e); })
    .finally(() => { r.busy = false; r.at = Date.now(); r.sig = sig; again(); });
  return r;
}

/** Nombre de fichiers du dernier diff lu (pour l'onglet), ou -1 tant que rien n'est lu. */
export function count(p: Project, wt: string): number { return reads.get(`${p.id}|${wt}`)?.files?.length ?? -1; }

/** Nouveau fichier au contenu inconnu : ni +0 ni −0, seulement « nouveau ». */
const blind = (f: File): boolean => f.isNew && !f.lines.length && !f.bin;
const gain = (add: number, del: number): string => `<span class="cv-gain"><b class="add">+${add}</b><b class="del">−${del}</b></span>`;
/** Les cinq carrés de GitHub : part des ajouts et des retraits. */
function bar(add: number, del: number): string {
  const n = add + del, g = n ? Math.round(add / n * 5) : 0, r = n ? Math.min(5 - g, Math.round(del / n * 5)) : 0;
  return `<span class="cv-bar" aria-hidden="true">${'<i class="add"></i>'.repeat(g)}${'<i class="del"></i>'.repeat(r)}${'<i></i>'.repeat(5 - g - r)}</span>`;
}

function fileHTML(f: File, r: Read): string {
  const shut = fold.get(f.path) ?? (f.gone || f.bin || f.lines.length > 300), tag = f.isNew ? 'Nouveau' : f.gone ? 'Supprimé' : '';
  const rows = f.lines.map(l => l.t === '@'
    ? `<div class="cv-l hunk"><i></i><i></i><code>${esc(l.s)}</code></div>`
    : `<div class="cv-l${l.t === '+' ? ' add' : l.t === '-' ? ' del' : ''}${l.t === '+' && r.fresh.has(`${f.path}\0${l.s}`) ? ' cv-new' : ''}"><i>${l.a || ''}</i><i>${l.b || ''}</i><code><s>${l.t === ' ' ? ' ' : l.t === '-' ? '−' : '+'}</s>${esc(l.s) || ' '}</code></div>`).join('');
  const body = f.bin ? '<p class="cv-note">Fichier binaire.</p>' : !f.lines.length ? `<p class="cv-note">${f.isNew ? 'Nouveau fichier, contenu non lu (écrit par un sous-agent ou hors du fil).' : 'Aucune ligne à montrer.'}</p>` : `<div class="cv-code">${rows}</div>${f.more ? `<p class="cv-note">et ${f.more} lignes de plus</p>` : ''}`;
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '', name = f.path.slice(dir.length);
  return `<article class="cv-file${shut ? ' shut' : ''}" data-cv-path="${esc(f.path)}"><header><button type="button" class="cv-fold" data-dz="cv-fold" data-path="${esc(f.path)}" aria-expanded="${!shut}" aria-label="${shut ? 'Déplier' : 'Replier'} ${esc(f.path)}">${icon('chevron')}</button><code title="${esc(f.path)}"><span>${esc(dir)}</span>${esc(name)}</code>${tag ? `<em>${tag}</em>` : ''}${blind(f) ? '' : gain(f.add, f.del) + bar(f.add, f.del)}</header>${shut ? '' : body}</article>`;
}

const match = (list: string[], path: string): boolean => list.some(t => t === path || t.endsWith('/' + path));

/** Arbre des fichiers : dossiers imbriqués, ceux à un seul enfant fusionnés (`src/features/`), dossiers avant fichiers. */
interface Dir { dirs: Map<string, Dir>; files: File[] }
function treeHTML(r: Read, c: CodeIn, on: string): string {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of r.files ?? []) {
    let d = root; const parts = f.path.split('/'); parts.pop();
    for (const x of parts) { if (!d.dirs.has(x)) d.dirs.set(x, { dirs: new Map(), files: [] }); d = d.dirs.get(x) as Dir; }
    d.files.push(f);
  }
  const walk = (d: Dir, depth: number): string => [...d.dirs].sort((x, y) => x[0].localeCompare(y[0])).map(([n, sub]) => {
    let name = n, x = sub;
    while (!x.files.length && x.dirs.size === 1) { const [k, v] = [...x.dirs][0]; name += '/' + k; x = v; }
    return `<div class="cv-dir" style="--d:${depth}">${icon('folder')}<span>${esc(name)}</span></div>${walk(x, depth + 1)}`;
  }).join('') + [...d.files].sort((x, y) => x.path.localeCompare(y.path)).map(f => {
    const st = f.isNew ? ['A', 'Ajouté'] : f.gone ? ['D', 'Supprimé'] : ['M', 'Modifié'], live = c.busy && match(c.live, f.path);
    return `<button type="button" class="cv-jump${f.path === on ? ' on' : ''}${live ? ' live' : ''}" style="--d:${depth}" data-dz="cv-go" data-path="${esc(f.path)}" title="${esc(f.path)}${live ? ' · en cours d’écriture' : ''}"><code>${esc(f.path.slice(f.path.lastIndexOf('/') + 1))}</code>${live ? '<i class="cv-live" aria-label="en cours"></i>' : ''}${blind(f) ? '' : gain(f.add, f.del)}<em class="st-${st[0]}" title="${st[1]}">${st[0]}</em></button>`;
  }).join('');
  return walk(root, 0);
}

function sumHTML(r: Read): string {
  if (!r.files?.length) return '';
  const add = r.files.reduce((n, f) => n + f.add, 0), del = r.files.reduce((n, f) => n + f.del, 0);
  return `<div class="cv-sum"><b>${r.files.length} fichier${r.files.length > 1 ? 's' : ''}</b>${gain(add, del)}<span>${r.scope === 'branch' ? `branche, par rapport à ${esc(r.base || 'main')}` : 'non commités'}${r.truncated ? ' · tronqué' : ''}</span>${r.busy ? '<span class="spin"></span>' : ''}<button type="button" class="cv-all" data-dz="cv-all">${r.files.every(f => fold.get(f.path)) ? 'Tout déplier' : 'Tout replier'}</button></div>`;
}

function diffHTML(r: Read): string {
  if (!native.available()) return `<p class="cv-note">Le diff se lit depuis l’app Studio pour Mac.</p>`;
  if (r.err) return `<p class="cv-note err">${esc(r.err)}</p>`;
  if (!r.files) return '<p class="cv-note"><span class="spin"></span> Lecture des changements…</p>';
  if (!r.files.length) return `<div class="cv-none">${icon('code')}<p>Aucun changement dans la copie pour l’instant. Les modifications des agents s’affichent ici au fil de l’eau.</p></div>`;
  return r.files.map(f => fileHTML(f, r)).join('');
}

/** Peint l'onglet dans `box` (`[data-cv]`, posé une fois par design.ts). */
export function paint(box: HTMLElement, p: Project, c: CodeIn, again: () => void): void {
  const r = read(p, c, again), many = (r.files?.length ?? 0) > 1;
  morphIfChanged(box, `${c.tech ? `<div class="cv-strip" aria-label="Activité des agents">${c.tech}</div>` : ''}${sumHTML(r)}
    <div class="cv-body${many ? '' : ' solo'}">${many ? `<nav class="cv-tree" aria-label="Fichiers modifiés">${treeHTML(r, c, picked.get(c.wt) ?? '')}</nav>` : ''}<section class="cv-diff" aria-label="Changements de code">${diffHTML(r)}</section></div>`);
}

/** Clic dans l'onglet (`data-dz="cv-…"`). Rend vrai s'il faut repeindre. */
export function click(b: HTMLElement, box: HTMLElement, p: Project, wt: string): boolean {
  const act = b.dataset.dz, path = b.dataset.path ?? '';
  if (act === 'cv-fold') { const el = b.closest('.cv-file'); fold.set(path, !el?.classList.contains('shut')); return true; }
  if (act === 'cv-all') { const fs = reads.get(`${p.id}|${wt}`)?.files ?? [], shut = !fs.every(f => fold.get(f.path)); for (const f of fs) fold.set(f.path, shut); return true; }
  if (act === 'cv-go') {
    picked.set(wt, path);
    const el = [...box.querySelectorAll<HTMLElement>('.cv-file')].find(x => x.dataset.cvPath === path);
    if (el?.classList.contains('shut')) { fold.set(path, false); requestAnimationFrame(() => [...box.querySelectorAll<HTMLElement>('.cv-file')].find(x => x.dataset.cvPath === path)?.scrollIntoView({ block: 'start' })); return true; }
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return true;
  }
  return false;
}
