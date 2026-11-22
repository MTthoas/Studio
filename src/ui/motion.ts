// Mouvement : le système d'animation de toute l'application (css/motion.css pour les jetons et le CSS pur, ce fichier pour le reste).
//
// API (tout est sans effet et sans erreur si l'élément est absent, déconnecté, ou si le mouvement est coupé) :
//   init()                        à appeler une fois au démarrage : niveau, observateurs, écoutes déléguées. Idempotente.
//   view(root, kind?, id?)        après chaque changement de vue (root = #main) : sortie de l'ancien contenu (fantôme), entrée du
//                                 nouveau dans le sens de la navigation, cascade des blocs. Ignorée si (kind, id) n'a pas changé.
//   transition(update, back?)     enveloppe optionnelle d'un rendu dans une View Transition (Safari 18+) ; sinon appelle update().
//   level() / setLevel(l)         'full' | 'subtle' | 'off', gardé dans localStorage (studio.motion) et posé en data-motion sur <html>.
//   enter(el, opts?)              entrée d'un élément (fondu + montée) ; opts : dx, dy, delay, scale.
//   leave(el): Promise<void>      sortie (fondu + léger retrait) ; résout à la fin, tout de suite si le mouvement est coupé.
//                                 L'élément reste estompé : c'est à l'appelant de le retirer ensuite.
//   flip(els, mutate)             déplacement fluide : mesure, appelle mutate() (qui change le DOM), puis glisse chaque élément.
//   pulse(el)                     confirmation brève (petit gonflement).        shake(el)   erreur (secousse horizontale).
//   slide(el, dir)                entrée latérale d'un panneau (dir : +1 vient de la droite, -1 de la gauche).
//   count(el, from, to)           fait rouler un chiffre (data-mo="count" le fait seul quand le texte change).
//
// Attributs reconnus dans le HTML des autres modules : data-mo="in" | "list" | "count", data-mo-key, data-mo-drop / .mo-drop,
// .mo-fold, .mo-work (voir css/motion.css). Rien ici ne joue d'animation en boucle ; rien ne retarde une action : les entrées ne
// bloquent pas le clic, les sorties (menus, fenêtres, toasts) rejouent un CLONE du calque déjà retiré par kit.ts.
//
// Anti-clignotement : les zones repeintes périodiquement (paintIfChanged) ne rejouent rien. Une entrée n'a lieu que pour une vraie
// apparition : changement de vue, ou élément portant une clé (data-k, data-mo-key, data-id…) jamais vue dans son conteneur.

export type Level = 'full' | 'subtle' | 'off';
type Opts = { dx?: number; dy?: number; delay?: number; scale?: number; duration?: number };

const STORE = 'studio.motion';
const OUT = 'cubic-bezier(.2, .8, .2, 1)';
const IN = 'cubic-bezier(.4, 0, 1, 1)';
const IN_OUT = 'cubic-bezier(.45, 0, .2, 1)';
const SPRING_LINEAR = 'linear(0, 0.042 4.2%, 0.143 8.3%, 0.275 12.5%, 0.415 16.7%, 0.55 20.8%, 0.672 25%, 0.775 29.2%, 0.858 33.3%, 0.922 37.5%, 0.969 41.7%, 1.001 45.8%, 1.022 50%, 1.033 54.2%, 1.038 58.3%, 1.038 62.5%, 1.035 66.7%, 1.03 70.8%, 1.025 75%, 1.02 79.2%, 1.015 83.3%, 1.01 87.5%, 1.007 91.7%, 1.004 95.8%, 1)';
const SPRING_FALLBACK = 'cubic-bezier(.3, 1.25, .5, 1)';
const STAGGER = 24, MAX_CASCADE = 12, MAX_FRESH = 8;

const html = document.documentElement;
const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const hasAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
let lvl: Level = 'full';
let started = false;
let spring = SPRING_FALLBACK;
try { if (typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', SPRING_LINEAR)) spring = SPRING_LINEAR; } catch { /* repli */ }

function readLevel(): Level {
  try { const v = localStorage.getItem(STORE); return v === 'subtle' || v === 'off' || v === 'full' ? v : 'full'; } catch { return 'full'; }
}
lvl = readLevel();
html.dataset.motion = lvl;

export const level = (): Level => lvl;
export function setLevel(l: Level): void {
  lvl = l === 'subtle' || l === 'off' ? l : 'full';
  html.dataset.motion = lvl;
  try { localStorage.setItem(STORE, lvl); } catch { /* stockage indisponible */ }
}
/** Vrai si une animation peut être jouée : niveau ≠ off, pas de préférence système « réduire les animations », WAAPI présente. */
const on = (): boolean => hasAnimate && lvl !== 'off' && !(reduce && reduce.matches);
const k = (): number => lvl === 'subtle' ? .7 : 1;
const dxMax = (): number => lvl === 'subtle' ? 0 : 14;
const dy = (px: number): number => lvl === 'subtle' ? Math.min(3, px) : px;

/** element.animate protégé : null si mouvement coupé, élément absent ou erreur (courbe inconnue : on retente en cubic-bezier). */
function play(el: Element | null | undefined, frames: Keyframe[], o: KeyframeAnimationOptions & { pseudoElement?: string }): Animation | null {
  if (!el || !el.isConnected || !on()) return null;
  try { return el.animate(frames, o); } catch {
    try { return el.animate(frames, { ...o, easing: OUT }); } catch { return null; }
  }
}

// ---------- Aides publiques ----------

export function enter(el: Element | null | undefined, o: Opts = {}): void {
  const x = o.dx ?? 0, y = dy(o.dy ?? 8), s = o.scale ?? 1;
  play(el, [{ opacity: 0, translate: `${x}px ${y}px`, scale: String(s) }, { opacity: 1, translate: '0 0', scale: '1' }],
    { duration: (o.duration ?? 240) * k(), delay: (o.delay ?? 0) * k(), easing: spring === SPRING_LINEAR && !o.dx ? spring : OUT, fill: 'backwards' });
}

export function leave(el: Element | null | undefined): Promise<void> {
  const a = play(el, [{ opacity: 1, translate: '0 0', scale: '1' }, { opacity: 0, translate: `0 ${dy(4)}px`, scale: lvl === 'subtle' ? '1' : '.98' }],
    { duration: 140 * k(), easing: IN, fill: 'forwards' });
  if (!a) return Promise.resolve();
  return new Promise<void>(res => {
    const done = (): void => { res(); window.setTimeout(() => { try { a.cancel(); } catch { /* déjà fini */ } }, 1500); };
    a.finished.then(done, () => res());
    window.setTimeout(res, 400);
  });
}

export function slide(el: Element | null | undefined, dir: number): void {
  enter(el, { dx: Math.sign(dir) * dxMax(), dy: dxMax() ? 0 : 3, duration: 260 });
}

export function pulse(el: Element | null | undefined): void {
  play(el, [{ scale: '1' }, { scale: '1.045', offset: .4 }, { scale: '1' }], { duration: 300 * k(), easing: OUT });
}

export function shake(el: Element | null | undefined): void {
  play(el, [{ translate: '0 0' }, { translate: '-5px 0', offset: .2 }, { translate: '4px 0', offset: .45 }, { translate: '-2px 0', offset: .7 }, { translate: '0 0' }],
    { duration: 320 * k(), easing: IN_OUT });
}

/** Fait rouler un chiffre : l'ancien repart d'où il vient, le nouveau arrive du sens de la variation. */
export function count(el: Element | null | undefined, from: number, to: number): void {
  if (from === to) return;
  const y = to > from ? 8 : -8;
  play(el, [{ opacity: 0, translate: `0 ${dy(y)}px` }, { opacity: 1, translate: '0 0' }], { duration: 240 * k(), easing: OUT });
}

/** FLIP : mesure les éléments, laisse `mutate` changer le DOM, puis les fait glisser de l'ancienne vers la nouvelle position. */
export function flip(els: Iterable<Element | null | undefined>, mutate: () => void): void {
  const list = Array.from(els).filter((e): e is Element => !!e && e.isConnected).slice(0, 80);
  if (!on() || !list.length) { mutate(); return; }
  const before = list.map(e => e.getBoundingClientRect());
  mutate();
  list.forEach((e, i) => {
    const a = before[i]; if (!a || !e.isConnected) return;
    const b = e.getBoundingClientRect(), x = a.left - b.left, y = a.top - b.top;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) return;
    play(e, [{ translate: `${x}px ${y}px` }, { translate: '0 0' }], { duration: 260 * k(), easing: IN_OUT });
  });
}

// ---------- Clés déjà vues (entrées des seuls nouveaux venus) ----------

const FEED = '[data-k], [data-mo-key], .side-item[data-pj-session], .side-tree[data-open-note], .kb-card[data-id]';
const SCOPE = '#sidebar, #list, #main, [data-mo-scope]';
const seen = new WeakMap<Element, Set<string>>();

function keyOf(el: HTMLElement): string {
  const d = el.dataset;
  if (d.k) return 'k:' + d.k;
  if (d.moKey) return 'm:' + d.moKey;
  if (d.pjSession) return 's:' + d.pjSession + '/' + (d.pjServer ?? '') + '/' + (d.pjTab ?? '');
  if (d.openNote) return 'n:' + d.openNote;
  if (d.id) return 'i:' + d.id;
  return el.id ? '#' + el.id : '';
}
const scopeOf = (el: Element): Element => el.closest(SCOPE) ?? document.body;

/** Inscrit en silence tout ce qui est déjà affiché dans le conteneur. */
function seed(scope: Element): Set<string> {
  const set = new Set<string>();
  scope.querySelectorAll<HTMLElement>(FEED).forEach(e => { const kk = keyOf(e); if (kk) set.add(kk); });
  seen.set(scope, set);
  return set;
}

// ---------- Observation des changements du DOM ----------

const SKIP = '.lv-clock, textarea, input, .mo-ghost, .mo-pane-ghost, .md, .cm-editor, canvas, pre';
let queued = false;
let added: Element[] = [];
let removedNodes = new Set<Node>();
let counts = new Set<HTMLElement>();
let slideDirty = false;
let obs: MutationObserver | null = null;

function onMutations(recs: MutationRecord[]): void {
  for (const r of recs) {
    if (r.type === 'attributes') { slideDirty = true; continue; }
    const t = r.target as Element;
    if (t.closest?.(SKIP)) continue;
    slideDirty = true;
    if (t instanceof HTMLElement && t.dataset.mo === 'count') counts.add(t);
    r.removedNodes.forEach(n => { if (n.nodeType === 1 && removedNodes.size < 400) removedNodes.add(n); });
    r.addedNodes.forEach(n => { if (n.nodeType === 1 && added.length < 400 && !(n as Element).matches('.mo-ghost, .mo-pane-ghost')) added.push(n as Element); });
  }
  schedule();
}

function schedule(): void {
  if (queued) return;
  queued = true;
  if (document.hidden) window.setTimeout(() => flush(false), 0); else requestAnimationFrame(() => flush(true));
}

function flush(visible: boolean): void {
  queued = false;
  const go = visible && on();
  const nodes = added, moved = removedNodes, cs = counts;
  added = []; removedNodes = new Set(); counts = new Set();
  try { feeds(nodes, moved, go); } catch { /* jamais bloquant */ }
  try { rolls(nodes, cs, go); } catch { /* idem */ }
  try { if (slideDirty || nodes.length) trackers(go); } catch { /* idem */ }
  slideDirty = false;
}

/** Nouveaux venus d'un fil ou d'une liste : seules les clés jamais vues dans leur conteneur entrent. */
function feeds(nodes: Element[], moved: Set<Node>, go: boolean): void {
  const fresh: HTMLElement[] = [];
  const seenNow = new Set<Element>();
  for (const n of nodes) {
    if (!n.isConnected) continue;
    const found: HTMLElement[] = [];
    if (n.matches(FEED)) found.push(n as HTMLElement);
    n.querySelectorAll<HTMLElement>(FEED).forEach(e => { if (found.length < 400) found.push(e); });
    for (const el of found) {
      if (seenNow.has(el)) continue; seenNow.add(el);
      if (go && moved.has(el) && el.matches('.kb-card')) { pulse(el); continue; }
      const key = keyOf(el); if (!key) continue;
      const scope = scopeOf(el);
      let set = seen.get(scope);
      if (!set) { seed(scope); continue; }
      if (set.has(key)) continue;
      if (set.size > 4000) { seen.delete(scope); seed(scope); continue; }
      set.add(key);
      fresh.push(el);
    }
  }
  if (!go || !fresh.length || fresh.length > MAX_FRESH) return; // chargement massif (changement de fil) : rien à animer
  let i = 0;
  for (const el of fresh) {
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    enter(el, { dy: 8, delay: i++ * 30, duration: 260 });
  }
}

/** Chiffres qui roulent (data-mo="count") quand leur texte change. */
const lastCount = new WeakMap<Element, string>();
const lastByKey = new Map<string, string>();
function rolls(nodes: Element[], cs: Set<HTMLElement>, go: boolean): void {
  const list = new Set<HTMLElement>(cs);
  for (const n of nodes) {
    if (!n.isConnected) continue;
    if (n instanceof HTMLElement && n.dataset.mo === 'count') list.add(n);
    n.querySelectorAll<HTMLElement>('[data-mo="count"]').forEach(e => list.add(e));
  }
  for (const el of list) {
    const txt = (el.textContent ?? '').trim(), key = el.dataset.moKey;
    const prev = key ? lastByKey.get(key) : lastCount.get(el);
    lastCount.set(el, txt);
    if (key) { lastByKey.set(key, txt); if (lastByKey.size > 500) lastByKey.clear(); }
    if (!go || prev === undefined || prev === txt) continue;
    const a = parseFloat(prev.replace(/\s/g, '').replace(',', '.')), b = parseFloat(txt.replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(a) && Number.isFinite(b)) count(el, a, b);
  }
}

// ---------- Indicateurs glissants (ligne ou onglet actif) ----------

interface Mem { key: string; x: number; y: number; w: number; h: number; i: number }
interface Group { name: string; sel: string; box: string; pseudo: '::before' | '::after'; line?: boolean; single?: boolean; main?: boolean; panel?: string }
const GROUPS: Group[] = [
  { name: 'side', sel: '#sidebar .side-item.sel', box: '#sidebar', pseudo: '::before', single: true },
  { name: 'pj', sel: '.pj-tabs button.sel', box: '.pj-tabs', pseudo: '::after', line: true, single: true, main: true, panel: '.pj-body' },
  { name: 'lv', sel: '.lv-tabs:not(.pj-tabs) button.sel', box: '.lv-tabs', pseudo: '::after', line: true, main: true },
  { name: 'set', sel: '.set-nav button[aria-current]', box: '.set-nav', pseudo: '::before', single: true, main: true, panel: '.set-scroll' },
  { name: 'seg', sel: '.ag-seg input:checked + span', box: '.ag-seg', pseudo: '::before' },
  { name: 'pal', sel: '.pal-item.sel', box: '.pal-list', pseudo: '::before', single: true },
  { name: 'hist', sel: '.hist-item.sel', box: '.hist-scroll', pseudo: '::before', single: true },
];
const mems = new WeakMap<Element, Mem>();
const lastOf = new Map<string, Mem>();

function keyEl(el: HTMLElement): string {
  return Object.values(el.dataset).join('|') + '#' + (el.textContent ?? '').trim().slice(0, 40);
}

function trackers(go: boolean): void {
  for (const g of GROUPS) {
    const done = new Set<Element>();
    document.querySelectorAll<HTMLElement>(g.sel).forEach(el => {
      const box = el.closest(g.box); if (!box || done.has(box)) return;
      done.add(box);
      const r = el.getBoundingClientRect(); if (r.width === 0) return;
      const sibs = el.parentElement ? Array.from(el.parentElement.children) : [];
      const now: Mem = { key: keyEl(el), x: r.left, y: r.top, w: r.width, h: r.height, i: sibs.indexOf(el) };
      const old = mems.get(box) ?? (g.single ? lastOf.get(g.name) : undefined);
      mems.set(box, now); if (g.single) lastOf.set(g.name, now);
      if (!old || old.key === now.key || !go) return;
      const x = old.x - now.x, y = old.y - now.y, sx = old.w / now.w, sy = g.line ? 1 : old.h / now.h;
      if (Math.abs(x) < 1 && Math.abs(y) < 1 && Math.abs(sx - 1) < .01 && Math.abs(sy - 1) < .01) return;
      const dist = Math.hypot(x, y);
      play(el, [{ transformOrigin: '0 0', transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: 'none' }],
        { duration: Math.min(340, 170 + dist * .35) * k(), easing: OUT, pseudoElement: g.pseudo });
      if (g.panel && old.i !== now.i) { // le contenu glisse dans le sens de l'onglet choisi
        const panel = box.closest('#main')?.querySelector(g.panel);
        if (panel) slide(panel, now.i > old.i ? 1 : -1);
      }
    });
  }
}

// ---------- Vues ----------

let lastSig: string | null = null, lastDepth = 1, vtActive = false;
const IMPLICIT = '.pj-sec, .hm-sec, .hm-notes > *, .lv-projs > *, .au-card, .au-tpl > *, .kb-col, .hp-grid > *';

/** Entrée de la vue qui vient d'être posée dans `root` (#main). À appeler après chaque changement de vue. */
export function view(root: HTMLElement | null | undefined, kind = '', id = ''): void {
  try {
    if (!root || !root.isConnected) return;
    const recs = obs ? obs.takeRecords() : [];
    if (recs.length) onMutations(recs);
    const sig = kind + '|' + id;
    if (sig === lastSig) return;
    const first = lastSig === null;
    lastSig = sig;
    seed(scopeOf(root));
    for (const g of GROUPS) if (g.main) lastOf.delete(g.name); // les barres d'onglets d'une autre vue ne glissent pas vers celles-ci
    const deep = id ? 2 : root.querySelector('.pj-head, .ag-detail, .ss-dhead') ? 2 : kind === 'home' ? 0 : 1;
    const dir = Math.sign(deep - lastDepth);
    lastDepth = deep;
    if (first || !on() || document.hidden) return;
    const booting = html.hasAttribute('data-mo-boot');
    const gone = Array.from(removedNodes).filter(n => n.parentNode === null || n.parentNode === root);
    const dx = dir * dxMax();
    if (!booting && !vtActive && lvl === 'full') ghost(root, recs, gone);
    if (!booting && !vtActive) {
      for (const c of Array.from(root.children)) {
        if (c.classList.contains('mo-pane-ghost') || c.matches('.toolbar')) continue;
        enter(c, { dx, dy: dx ? 0 : 6, duration: 240 });
      }
    }
    cascade(root);
  } catch { /* le mouvement ne doit jamais casser une vue */ }
}

/** Rejoue en sortie l'ancien contenu de `root` (les nœuds retirés par le rendu), au-dessus du nouveau, puis le détruit. */
function ghost(root: HTMLElement, recs: MutationRecord[], gone: Node[]): void {
  const olds: Element[] = [];
  for (const r of recs) if (r.target === root) r.removedNodes.forEach(n => { if (n.nodeType === 1 && !(n as Element).classList.contains('mo-pane-ghost')) olds.push(n as Element); });
  if (!olds.length && gone.length) gone.forEach(n => { if (n.nodeType === 1) olds.push(n as Element); });
  if (!olds.length || olds.length > 6) return;
  const g = document.createElement('div');
  g.className = 'mo-pane-ghost'; g.setAttribute('aria-hidden', 'true'); g.setAttribute('inert', '');
  for (const o of olds) { o.querySelectorAll('[id]').forEach(e => e.removeAttribute('id')); o.removeAttribute('id'); g.append(o); }
  root.append(g);
  const a = play(g, [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: `0 ${dy(4)}px` }], { duration: 150 * k(), easing: IN, fill: 'forwards' });
  const kill = (): void => g.remove();
  if (a) { a.finished.then(kill, kill); window.setTimeout(kill, 600); } else kill();
}

/** Cascade des blocs : data-mo="list" (enfants), data-mo="in" (bloc), puis les structures connues, dans la limite de 12 visibles. */
function cascade(root: HTMLElement): void {
  const picked: HTMLElement[] = [], has = new Set<Element>();
  const add = (e: HTMLElement): void => { if (picked.length < MAX_CASCADE && !has.has(e) && !e.closest('.mo-pane-ghost')) { has.add(e); picked.push(e); } };
  root.querySelectorAll<HTMLElement>('[data-mo="list"]').forEach(l => { Array.from(l.children).slice(0, MAX_CASCADE).forEach(c => add(c as HTMLElement)); });
  root.querySelectorAll<HTMLElement>('[data-mo="in"]').forEach(add);
  if (picked.length < 3) root.querySelectorAll<HTMLElement>(IMPLICIT).forEach(e => { if (!e.closest('[data-mo="list"]')) add(e); });
  let i = 0;
  for (const e of picked) {
    const r = e.getBoundingClientRect();
    if (r.height === 0 || r.top > innerHeight) continue;
    enter(e, { dy: 8, delay: 40 + i++ * STAGGER, duration: 280 });
  }
}

/** Rend le rendu `update` dans une View Transition (Safari 18+ / Chromium) ; sinon l'appelle simplement. `back` : sens inverse. */
export function transition(update: () => void, back = false): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<unknown> } };
  let ran = false;
  const once = (): void => { if (ran) return; ran = true; update(); };
  if (!on() || lvl !== 'full' || document.hidden || typeof doc.startViewTransition !== 'function') { once(); return; }
  try {
    vtActive = true; html.dataset.moVt = back ? 'back' : 'fwd';
    const t = doc.startViewTransition(once);
    const end = (): void => { vtActive = false; delete html.dataset.moVt; };
    t.finished.then(end, end);
    window.setTimeout(end, 1200);
  } catch { vtActive = false; delete html.dataset.moVt; once(); }
}

// ---------- Calques : origine des menus, sorties par clone fantôme, toasts ----------

let pt: { x: number; y: number; t: number; el: Element | null } | null = null;
let lastUser = 0;

function menuOrigin(m: HTMLElement): void {
  if (!pt || performance.now() - pt.t > 900) return;
  const trig = pt.el?.closest('button, a, [role="button"], .icon-btn');
  const tr = trig ? trig.getBoundingClientRect() : null;
  const cx = tr ? tr.left + tr.width / 2 : pt.x, cy = tr ? tr.top + tr.height / 2 : pt.y;
  const r = m.getBoundingClientRect();
  const ox = Math.max(0, Math.min(r.width, cx - r.left));
  const oy = cy <= r.top ? 0 : cy >= r.bottom ? r.height : Math.max(0, Math.min(r.height, cy - r.top));
  m.style.setProperty('--mo-ox', ox.toFixed(0) + 'px'); m.style.setProperty('--mo-oy', oy.toFixed(0) + 'px');
}

function ghostOf(n: Element, keepRect?: DOMRect): void {
  const host = document.getElementById('layer') ?? document.body;
  const c = n.cloneNode(true) as HTMLElement;
  c.classList.add('mo-ghost'); c.setAttribute('aria-hidden', 'true'); c.setAttribute('inert', '');
  c.removeAttribute('id'); c.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
  const from = n.querySelectorAll<HTMLInputElement>('input, textarea'), to = c.querySelectorAll<HTMLInputElement>('input, textarea');
  from.forEach((f, i) => { const t = to[i]; if (t) t.value = f.value; });
  if (keepRect) { c.style.position = 'fixed'; c.style.margin = '0'; c.style.left = keepRect.left + 'px'; c.style.top = keepRect.top + 'px'; c.style.width = keepRect.width + 'px'; c.style.bottom = 'auto'; }
  if (keepRect) c.style.zIndex = '80';
  host.prepend(c);
  window.setTimeout(() => c.remove(), 420);
}

function onLayer(recs: MutationRecord[]): void {
  if (!on()) return;
  for (const r of recs) {
    r.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      const e = n as HTMLElement;
      if (e.classList.contains('menu-backdrop') && !e.classList.contains('mo-ghost')) { const m = e.querySelector<HTMLElement>('.menu'); if (m) menuOrigin(m); }
    });
    r.removedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      const e = n as HTMLElement;
      if (e.classList.contains('mo-ghost') || e.classList.contains('mo-pane-ghost')) return;
      if (e.classList.contains('backdrop') || e.classList.contains('menu-backdrop')) ghostOf(e);
    });
  }
}

const toastPos = new WeakMap<Element, number>();
function toastGap(t: HTMLElement, box: HTMLElement): number { return box.offsetHeight - (t.offsetTop + t.offsetHeight); }
const toastRect = new WeakMap<Element, DOMRect>();
function onToasts(recs: MutationRecord[]): void {
  const box = document.getElementById('toasts'); if (!box) return;
  if (on()) {
    for (const r of recs) r.removedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      const e = n as HTMLElement, rect = toastRect.get(e);
      if (e.classList.contains('mo-ghost') || e.classList.contains('out') || !rect) return;
      ghostOf(e, rect); // retiré sans animation de kit.ts (action cliquée) : on le fait sortir
    });
  }
  Array.from(box.children).forEach(c => {
    if (!(c instanceof HTMLElement) || c.classList.contains('mo-ghost')) return;
    const gap = toastGap(c, box), old = toastPos.get(c);
    toastPos.set(c, gap);
    if (old === undefined) window.setTimeout(() => { if (c.isConnected) toastRect.set(c, c.getBoundingClientRect()); }, 450); else toastRect.set(c, c.getBoundingClientRect());
    if (old !== undefined && Math.abs(gap - old) > 1) play(c, [{ translate: `0 ${gap - old}px` }, { translate: '0 0' }], { duration: 260 * k(), easing: IN_OUT });
  });
}

// ---------- Écoutes déléguées ----------

function onToggle(e: Event): void {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open || !on() || performance.now() - lastUser > 500) return;
  const s = d.querySelector(':scope > summary'); if (!s) return;
  const cs = getComputedStyle(d), full = d.offsetHeight;
  const closed = s.getBoundingClientRect().height + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  if (!(full - closed > 8)) return;
  const prev = d.style.overflow; d.style.overflow = 'hidden';
  const a = play(d, [{ height: closed + 'px' }, { height: full + 'px' }], { duration: Math.min(300, 160 + (full - closed) * .25) * k(), easing: OUT });
  const end = (): void => { d.style.overflow = prev; };
  if (a) a.finished.then(end, end); else end();
  Array.from(d.children).forEach(c => { if (c !== s) play(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 * k(), delay: 50 * k(), easing: OUT, fill: 'backwards' }); });
}

function onSubmit(e: Event): void {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || !f.matches('.ag-compose, [data-mo-send]') || !on()) return;
  const btn = f.querySelector<HTMLElement>('[type="submit"], .btn-primary');
  const ta = f.querySelector<HTMLElement>('textarea');
  window.setTimeout(() => {
    pulse(btn);
    play(ta, [{ opacity: .35 }, { opacity: 1 }], { duration: 260 * k(), easing: OUT });
  }, 30);
}

/** Démarre le système : niveau, observateurs et écoutes déléguées. Idempotente. */
export function init(): void {
  if (started) return;
  started = true;
  lvl = readLevel(); html.dataset.motion = lvl;
  try { reduce?.addEventListener('change', () => { /* on() relit la préférence à chaque appel */ }); } catch { /* ancien WebKit */ }
  if (on()) { html.setAttribute('data-mo-boot', ''); window.setTimeout(() => html.removeAttribute('data-mo-boot'), 1100); }
  const mark = (e: Event): void => { lastUser = performance.now(); if (e instanceof MouseEvent) pt = { x: e.clientX, y: e.clientY, t: lastUser, el: e.target instanceof Element ? e.target : null }; };
  document.addEventListener('pointerdown', mark, true);
  document.addEventListener('contextmenu', mark, true);
  document.addEventListener('keydown', () => { lastUser = performance.now(); const a = document.activeElement; if (a) { const r = a.getBoundingClientRect(); pt = { x: r.left + r.width / 2, y: r.bottom, t: lastUser, el: a }; } }, true);
  document.addEventListener('toggle', onToggle, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('change', () => { slideDirty = true; schedule(); }, true);
  document.addEventListener('scroll', () => { slideDirty = true; schedule(); }, { capture: true, passive: true });
  addEventListener('resize', () => { slideDirty = true; schedule(); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { slideDirty = true; schedule(); } });
  obs = new MutationObserver(onMutations);
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-current'] });
  const layer = document.getElementById('layer');
  if (layer) new MutationObserver(onLayer).observe(layer, { childList: true });
  const toasts = document.getElementById('toasts');
  if (toasts) new MutationObserver(onToasts).observe(toasts, { childList: true });
  slideDirty = true; schedule();
}
