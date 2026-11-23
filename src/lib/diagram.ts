// Schémas Mermaid rendus en SVG inline, sans dépendance ni canvas (CSP stricte, pas de CDN).
// Gère `flowchart`/`graph`, `sequenceDiagram` et `stateDiagram`(-v2). Tout le reste, ou toute erreur d'analyse,
// retombe sur le bloc de code habituel avec une petite mention.
// Le HTML produit est déterministe pour un même source (aucun identifiant aléatoire) : `syncFeed` compare le HTML
// et ne redessine pas un schéma qui n'a pas changé. Les écouteurs sont délégués sur `document` par `init()`.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, c => ESC[c] ?? c);
const f = (v: number): string => String(Math.round(v * 10) / 10);

// ---------------------------------------------------------------- Mesure du texte (sans canvas)

/** Largeur approchée d'un texte en px : largeur moyenne par classe de caractère. */
function tw(s: string, size = 13): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 0x2e80 ? 1.0
      : /[il.,:;'|!`]/.test(ch) ? 0.3
      : /[ftrj()[\]\\/ -]/.test(ch) ? 0.4
      : /[mwMW@%]/.test(ch) ? 0.95
      : /[A-Z0-9]/.test(ch) ? 0.66
      : 0.54;
  }
  return w * size * 1.03;
}

/** Texte brut d'un libellé : guillemets, <br>, balises HTML légères et entités courantes. */
function clean(t: string): string {
  return t.trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^`([\s\S]*)`$/, '$1')
    .replace(/<br\s*\/?>/gi, '\n').replace(/\\n/g, '\n').replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/#quot;/g, '"').replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? '')
    .trim();
}

/** Coupe les lignes trop longues aux espaces (les retours à la ligne explicites sont gardés). */
function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= max) { out.push(line); continue; }
    let cur = '';
    for (const w of line.split(/\s+/)) {
      if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
    }
    out.push(cur);
  }
  return out.length ? out : [''];
}

// ---------------------------------------------------------------- Modèle des organigrammes

type Shape = 'rect' | 'round' | 'stadium' | 'diamond' | 'circle' | 'cyl' | 'hex' | 'start' | 'end' | 'bar';
type Dir = 'TD' | 'LR' | 'BT' | 'RL';
interface GNode { id: string; text: string; shape: Shape; sub: string | null; lines: string[]; w: number; h: number }
interface GEdge { from: string; to: string; text: string; line: 'solid' | 'dotted' | 'thick' | 'none'; head: 'arrow' | 'none' | 'circle' | 'cross'; tail: boolean }
interface GSub { id: string; title: string; parent: string | null }
interface Graph { dir: Dir; nodes: Map<string, GNode>; edges: GEdge[]; subs: Map<string, GSub> }

const MAX_NODES = 140;
/** Bornes de mise en page : au-delà, repli sur le code (la réduction de croisements est quadratique par couche). */
const MAX_EDGES = 300, MAX_VERTS = 1500;

/** Max / min d'un tableau par boucle (le `Math.max(...t)` plante sur de très grands tableaux). */
function maxOf(t: number[]): number { let m = -Infinity; for (const x of t) if (x > m) m = x; return m; }
function minOf(t: number[]): number { let m = Infinity; for (const x of t) if (x < m) m = x; return m; }
const ID_RE = /[\p{L}\p{N}_$]+/uy;
const SHAPES: [string, string[], Shape][] = [
  ['((', ['))'], 'circle'], ['([', ['])'], 'stadium'], ['[(', [')]'], 'cyl'], ['[[', [']]'], 'rect'],
  ['[/', ['/]', '\\]'], 'rect'], ['[\\', ['\\]', '/]'], 'rect'], ['{{', ['}}'], 'hex'], ['[', [']'], 'rect'],
  ['(', [')'], 'round'], ['{', ['}'], 'diamond'], ['>', [']'], 'rect'],
];
const AT_SHAPES: Record<string, Shape> = { rect: 'rect', rounded: 'round', stadium: 'stadium', diamond: 'diamond', decision: 'diamond', circle: 'circle', 'sm-circ': 'start', cyl: 'cyl', cylinder: 'cyl', db: 'cyl', hex: 'hex', hexagon: 'hex', circ: 'circle', 'fr-circ': 'end', fork: 'bar', join: 'bar' };

interface ParsedNode { id: string; text?: string; shape?: Shape; i: number }

/** Lit « id », « id[texte] », « id((texte)) »… à partir de `i`. */
function readNode(s: string, i: number): ParsedNode | null {
  ID_RE.lastIndex = i;
  const m = ID_RE.exec(s);
  if (!m) return null;
  let j = i + m[0].length;
  let text: string | undefined, shape: Shape | undefined;
  const at = /^@\{([^}]*)\}/.exec(s.slice(j));
  if (at) {
    j += at[0].length;
    const sh = /shape\s*:\s*"?([\w-]+)"?/.exec(at[1] ?? ''), lb = /label\s*:\s*"([^"]*)"/.exec(at[1] ?? '');
    if (sh) shape = AT_SHAPES[sh[1] ?? ''] ?? 'rect';
    if (lb) text = clean(lb[1] ?? '');
  } else {
    for (const [open, closers, sh] of SHAPES) {
      if (!s.startsWith(open, j)) continue;
      let k = j + open.length, t: string;
      if (s[k] === '"') {
        const q = s.indexOf('"', k + 1);
        if (q < 0) return null;
        t = s.slice(k + 1, q); k = q + 1;
        while (s[k] === ' ') k++;
        const c = closers.find(c => s.startsWith(c, k));
        if (!c) return null;
        k += c.length;
      } else if (open.length === 1 && open !== '>') {
        const close = closers[0] ?? '';
        let depth = 1, e = k;
        for (; e < s.length; e++) {
          if (s[e] === open) depth++;
          else if (s[e] === close && --depth === 0) break;
        }
        if (depth) return null;
        t = s.slice(k, e); k = e + 1;
      } else {
        let best = -1, bl = 0;
        for (const c of closers) { const p = s.indexOf(c, k); if (p >= 0 && (best < 0 || p < best)) { best = p; bl = c.length; } }
        if (best < 0) return null;
        t = s.slice(k, best); k = best + bl;
      }
      text = clean(t); shape = sh; j = k;
      break;
    }
  }
  const cls = /^:::[\w-]+/.exec(s.slice(j));
  if (cls) j += cls[0].length;
  return { id: m[0], text, shape, i: j };
}

interface ParsedOp { line: GEdge['line']; head: GEdge['head']; tail: boolean; text: string; i: number }

/** Lit une flèche (`-->`, `-.->`, `==>`, `-- texte -->`, `-->|texte|`…) à partir de `i`. */
function readOp(s: string, i: number): ParsedOp | null {
  const r = s.slice(i);
  let m: RegExpExecArray | null;
  let line: GEdge['line'] = 'solid', head: GEdge['head'] = 'arrow', tail = false, text = '', len = 0;
  const headOf = (h: string): GEdge['head'] => h.endsWith('>') ? 'arrow' : h.endsWith('o') ? 'circle' : h.endsWith('x') ? 'cross' : 'none';
  if ((m = /^(<)?--\s+(.+?)\s+(--+>|-{3,}|--[ox])(?=\s|$)/.exec(r))) { tail = !!m[1]; text = m[2] ?? ''; head = headOf(m[3] ?? ''); len = m[0].length; }
  else if ((m = /^(<)?-\.\s+(.+?)\s+(\.+->|\.+-)(?=\s|$)/.exec(r))) { line = 'dotted'; tail = !!m[1]; text = m[2] ?? ''; head = headOf(m[3] ?? ''); len = m[0].length; }
  else if ((m = /^(<)?==\s+(.+?)\s+(=+>|={3,}|==[ox])(?=\s|$)/.exec(r))) { line = 'thick'; tail = !!m[1]; text = m[2] ?? ''; head = headOf(m[3] ?? ''); len = m[0].length; }
  else if ((m = /^(<)?-\.+-(>)?/.exec(r))) { line = 'dotted'; tail = !!m[1]; head = m[2] ? 'arrow' : 'none'; len = m[0].length; }
  else if ((m = /^(<)?(-{2,})(>|[ox](?=[\s|]|$))?/.exec(r))) { tail = !!m[1]; head = m[3] ? headOf(m[3]) : 'none'; len = m[0].length; }
  else if ((m = /^(<)?={2,}(>|[ox](?=[\s|]|$))?/.exec(r))) { line = 'thick'; tail = !!m[1]; head = m[2] ? headOf(m[2]) : 'none'; len = m[0].length; }
  else if ((m = /^~{3,}/.exec(r))) { line = 'none'; head = 'none'; len = m[0].length; }
  else return null;
  let j = i + len;
  const lab = /^\s*\|([^|]*)\|/.exec(s.slice(j));
  if (lab) { text = lab[1] ?? ''; j += lab[0].length; }
  return { line, head, tail, text: clean(text), i: j };
}

/** Découpe les instructions : retours à la ligne et « ; » hors guillemets. */
function statements(code: string): string[] {
  const out: string[] = [];
  for (const raw of code.split(/\r?\n/)) {
    let cur = '', q = false;
    for (const ch of raw) {
      if (ch === '"') q = !q;
      if (ch === ';' && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
  }
  return out.map(l => l.trim()).filter(l => l && !l.startsWith('%%'));
}

/** Retire l'en-tête YAML (`---` … `---`) éventuel. */
function stripFront(code: string): string {
  const m = /^\s*---\s*\n[\s\S]*?\n---\s*(\n|$)/.exec(code);
  return m ? code.slice(m[0].length) : code;
}

function newGraph(dir: Dir): Graph { return { dir, nodes: new Map(), edges: [], subs: new Map() }; }

function declare(g: Graph, id: string, cur: string | null, text?: string, shape?: Shape, force = false): void {
  let n = g.nodes.get(id);
  if (!n) { n = { id, text: id, shape: 'rect', sub: cur, lines: [], w: 0, h: 0 }; g.nodes.set(id, n); }
  else if (cur && (force || !n.sub)) n.sub = cur;
  if (text !== undefined) n.text = text;
  if (shape) n.shape = shape;
}

const IGNORED = /^(classDef|class|style|linkStyle|click|accTitle|accDescr|direction|callback|link)\s/;

function parseFlow(code: string, dir: Dir): Graph {
  const g = newGraph(dir);
  const stack: string[] = [];
  let skipBlock = false, anon = 0;
  for (const s of statements(code)) {
    if (skipBlock) { if (s.includes('}')) skipBlock = false; continue; }
    if (/^accDescr\s*\{/.test(s) && !s.includes('}')) { skipBlock = true; continue; }
    if (IGNORED.test(s + ' ') || /^accDescr/.test(s)) continue;
    let m: RegExpExecArray | null;
    if ((m = /^subgraph\s+(.*)$/.exec(s))) {
      const rest = (m[1] ?? '').trim();
      let id: string, title: string;
      const mm = /^([\p{L}\p{N}_$]+)\s*\[(.*)\]$/u.exec(rest);
      if (mm) { id = mm[1] ?? ''; title = clean(mm[2] ?? ''); }
      else { title = clean(rest); id = title || `sg${anon++}`; }
      if (g.subs.has(id)) id += `#${anon++}`;
      g.subs.set(id, { id, title: title || id, parent: stack[stack.length - 1] ?? null });
      stack.push(id);
      continue;
    }
    if (s === 'end') { stack.pop(); continue; }
    const cur = stack[stack.length - 1] ?? null;
    let i = 0;
    const ws = () => { while (i < s.length && /\s/.test(s[i] ?? '')) i++; };
    const group = (bare: boolean): string[] => {
      const ids: string[] = [];
      for (;;) {
        ws();
        const n = readNode(s, i);
        if (!n) throw new Error('nœud attendu');
        i = n.i;
        declare(g, n.id, cur, n.text, n.shape, bare);
        ids.push(n.id);
        ws();
        if (s[i] === '&') { i++; continue; }
        return ids;
      }
    };
    let prev = group(false), hadOp = false;
    for (;;) {
      ws();
      if (i >= s.length) break;
      const op = readOp(s, i);
      if (!op) throw new Error('flèche attendue');
      i = op.i; hadOp = true;
      const next = group(false);
      for (const a of prev) for (const b of next) g.edges.push({ from: a, to: b, text: op.text, line: op.line, head: op.head, tail: op.tail });
      prev = next;
    }
    // Un nœud seul dans un cadre lui appartient, même s'il a déjà été cité plus haut.
    if (!hadOp) for (const id of prev) declare(g, id, cur, undefined, undefined, true);
  }
  return g;
}

function parseState(code: string): Graph {
  const g = newGraph('TD');
  const stack: string[] = [];
  let note = false, anon = 0;
  const cur = () => stack[stack.length - 1] ?? null;
  const ref = (raw: string, role: 's' | 'e'): string => {
    if (raw === '[*]') {
      const id = `[*]${cur() ?? ''}:${role}`;
      declare(g, id, cur(), '', role === 's' ? 'start' : 'end');
      return id;
    }
    declare(g, raw, cur(), undefined, 'round');
    return raw;
  };
  for (const s of statements(code)) {
    let m: RegExpExecArray | null;
    if (note) { if (/^end\s+note$/i.test(s)) note = false; continue; }
    if (/^note\s/i.test(s)) { if (!s.includes(':')) note = true; continue; }
    if ((m = /^direction\s+(TB|TD|LR|RL|BT)$/.exec(s))) { g.dir = m[1] === 'TB' ? 'TD' : m[1] as Dir; continue; }
    if (/^(classDef|class|style|accTitle|accDescr|hide|scale)\s/.test(s) || s === '--') continue;
    if ((m = /^state\s+(?:"([^"]+)"\s+as\s+)?([\p{L}\p{N}_.-]+)\s*\{$/u.exec(s))) {
      const id = m[2] ?? `st${anon++}`;
      g.subs.set(id, { id, title: clean(m[1] ?? id), parent: cur() });
      stack.push(id);
      continue;
    }
    if (s === '}') { stack.pop(); continue; }
    if ((m = /^state\s+([\p{L}\p{N}_.-]+)\s+<<(choice|fork|join)>>$/u.exec(s))) { declare(g, m[1] ?? '', cur(), '', m[2] === 'choice' ? 'diamond' : 'bar', true); continue; }
    if ((m = /^state\s+"([^"]+)"\s+as\s+([\p{L}\p{N}_.-]+)$/u.exec(s))) { declare(g, m[2] ?? '', cur(), clean(m[1] ?? ''), 'round', true); continue; }
    if ((m = /^state\s+([\p{L}\p{N}_.-]+)$/u.exec(s))) { declare(g, m[1] ?? '', cur(), undefined, 'round', true); continue; }
    if ((m = /^(\[\*\]|[\p{L}\p{N}_.-]+)\s*-->\s*(\[\*\]|[\p{L}\p{N}_.-]+)\s*(?::\s*(.*))?$/u.exec(s))) {
      const a = ref(m[1] ?? '', 's'), b = ref(m[2] ?? '', 'e');
      g.edges.push({ from: a, to: b, text: clean(m[3] ?? ''), line: 'solid', head: 'arrow', tail: false });
      continue;
    }
    if ((m = /^([\p{L}\p{N}_.-]+)\s*:\s*(.+)$/u.exec(s))) {
      declare(g, m[1] ?? '', cur(), undefined, 'round');
      const n = g.nodes.get(m[1] ?? '');
      if (n) n.text += '\n' + clean(m[2] ?? '');
      continue;
    }
    throw new Error('instruction inconnue');
  }
  // Un état composite est son cadre, pas un nœud de plus.
  for (const id of g.subs.keys()) g.nodes.delete(id);
  return g;
}

// ---------------------------------------------------------------- Mise en page des organigrammes

const LAB_SIZE = 11.5;

function measure(n: GNode): void {
  n.lines = n.text ? wrap(n.text, 30) : [];
  const tW = Math.max(0, ...n.lines.map(l => tw(l))), tH = n.lines.length * 17;
  switch (n.shape) {
    case 'start': n.w = n.h = 16; break;
    case 'end': n.w = n.h = 22; break;
    case 'bar': n.w = 56; n.h = 7; break;
    case 'diamond':
      if (!n.lines.length) { n.w = n.h = 26; break; }
      n.h = Math.max(52, tH * 2 + 16); n.w = Math.max(84, tW / (1 - tH / n.h) + 10); break;
    case 'circle': { const d = Math.max(44, Math.hypot(tW, tH) + 16); n.w = n.h = d; break; }
    case 'cyl': n.w = Math.max(56, tW + 36); n.h = Math.max(46, tH + 32); break;
    case 'hex': n.w = Math.max(64, tW + 52); n.h = Math.max(38, tH + 20); break;
    case 'stadium': n.w = Math.max(60, tW + 44); n.h = Math.max(36, tH + 18); break;
    default: n.w = Math.max(48, tW + 32); n.h = Math.max(36, tH + 18);
  }
}

interface V { a: number; b: number; layer: number; q: number; p: number; dummy: boolean; path: string[] }
interface Chain { e: number; ids: number[]; rev: boolean; hop: number }
interface Pt { x: number; y: number }

/** Régression isotone (PAV) : valeurs croissantes au plus proches de `t` au sens des moindres carrés. */
function isotonic(t: number[]): number[] {
  const blocks: { sum: number; n: number }[] = [];
  for (const v of t) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (!a || !b || a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(b.sum / b.n);
  return out;
}

function renderFlow(g: Graph): { svg: string; w: number; h: number } {
  const ids = [...g.nodes.keys()];
  if (!ids.length) throw new Error('vide');
  if (ids.length > MAX_NODES) throw new Error('trop grand');
  const horiz = g.dir === 'LR' || g.dir === 'RL';
  const idx = new Map(ids.map((id, i) => [id, i]));
  const nodes = ids.map(id => g.nodes.get(id) as GNode);
  nodes.forEach(measure);
  const N = nodes.length;

  // Une flèche vers un cadre (subgraph) vise son premier nœud.
  const subPath = (id: string | null): string[] => { const p: string[] = []; for (let s = id; s; s = g.subs.get(s)?.parent ?? null) p.unshift(s); return p; };
  const resolve = (id: string): number | undefined => {
    const k = idx.get(id);
    if (k !== undefined) return k;
    if (!g.subs.has(id)) return undefined;
    const inside = (n: GNode) => subPath(n.sub).includes(id);
    const j = nodes.findIndex(n => inside(n) && n.shape !== 'start' && n.shape !== 'end');
    const j2 = j < 0 ? nodes.findIndex(inside) : j;
    return j2 < 0 ? undefined : j2;
  };
  interface E { u: number; v: number; g: GEdge }
  const edges: E[] = [];
  for (const e of g.edges) { const u = resolve(e.from), v = resolve(e.to); if (u !== undefined && v !== undefined) edges.push({ u, v, g: e }); }

  // 1. Cycles cassés par DFS : les arêtes de retour sont inversées pour le calcul des couches.
  const out: number[][] = nodes.map(() => []);
  edges.forEach((e, k) => { if (e.u !== e.v) (out[e.u] as number[]).push(k); });
  const color: number[] = new Array(N).fill(0), rev: boolean[] = new Array(edges.length).fill(false);
  const dfs = (u: number): void => {
    color[u] = 1;
    for (const k of out[u] as number[]) {
      const v = (edges[k] as E).v;
      if (color[v] === 1) rev[k] = true; else if (color[v] === 0) dfs(v);
    }
    color[u] = 2;
  };
  for (let u = 0; u < N; u++) if (color[u] === 0) dfs(u);
  const dag = edges.map((e, k) => ({ k, a: rev[k] ? e.v : e.u, b: rev[k] ? e.u : e.v })).filter(d => d.a !== d.b);

  // 2. Couches par plus long chemin, puis les sources sont rapprochées de leurs successeurs.
  const succ: number[][] = nodes.map(() => []), pred: number[][] = nodes.map(() => []);
  for (const d of dag) { (succ[d.a] as number[]).push(d.b); (pred[d.b] as number[]).push(d.a); }
  const layer: number[] = new Array(N).fill(0), indeg = pred.map(p => p.length), queue: number[] = [], topo: number[] = [];
  indeg.forEach((d, i) => { if (!d) queue.push(i); });
  while (queue.length) {
    const u = queue.shift() as number;
    topo.push(u);
    for (const v of succ[u] as number[]) {
      layer[v] = Math.max(layer[v] as number, (layer[u] as number) + 1);
      indeg[v] = (indeg[v] as number) - 1;
      if (indeg[v] === 0) queue.push(v);
    }
  }
  for (const u of [...topo].reverse()) {
    if ((pred[u] as number[]).length || !(succ[u] as number[]).length) continue;
    layer[u] = minOf((succ[u] as number[]).map(v => layer[v] as number)) - 1;
  }
  const minLayer = minOf(layer);
  for (let i = 0; i < N; i++) layer[i] = (layer[i] as number) - minLayer;

  // 3. Nœuds fictifs sur les arêtes qui traversent plusieurs couches.
  const V: V[] = nodes.map((n, i) => ({ a: horiz ? n.w : n.h, b: horiz ? n.h : n.w, layer: layer[i] as number, q: 0, p: 0, dummy: false, path: subPath(n.sub) }));
  const down: number[][] = V.map(() => []), up: number[][] = V.map(() => []);
  const addHop = (a: number, b: number) => { while (down.length < V.length) { down.push([]); up.push([]); } (down[a] as number[]).push(b); (up[b] as number[]).push(a); };
  const chains: Chain[] = [];
  const labelW = (e: GEdge) => e.text ? maxOf(wrap(e.text, 24).map(l => tw(l, LAB_SIZE))) + 14 : 0;
  const labelH = (e: GEdge) => e.text ? wrap(e.text, 24).length * 14 + 6 : 0;
  const gapExtra: number[] = [];
  if (dag.length > MAX_EDGES) throw new Error('trop d’arêtes');
  for (const d of dag) {
    const e = edges[d.k] as E;
    const A = V[d.a] as V, B = V[d.b] as V;
    const chain = [d.a];
    let cp = 0;
    while (cp < A.path.length && cp < B.path.length && A.path[cp] === B.path[cp]) cp++;
    for (let l = A.layer + 1; l < B.layer; l++) {
      if (V.length >= MAX_VERTS) throw new Error('trop de sommets');
      V.push({ a: 0, b: 8, layer: l, q: 0, p: 0, dummy: true, path: A.path.slice(0, cp) });
      chain.push(V.length - 1);
    }
    chain.push(d.b);
    const hop = Math.floor((chain.length - 1) / 2);
    for (let k = 0; k + 1 < chain.length; k++) addHop(chain[k] as number, chain[k + 1] as number);
    if (e.g.text) {
      const lw = horiz ? labelH(e.g) + 8 : labelW(e.g) + 8;
      for (const id of [chain[hop] as number, chain[hop + 1] as number]) { const v = V[id] as V; if (v.dummy) v.b = Math.max(v.b, lw); }
      const l = (V[chain[hop] as number] as V).layer;
      gapExtra[l] = Math.max(gapExtra[l] ?? 0, horiz ? labelW(e.g) + 4 : labelH(e.g) + 4);
    }
    chains.push({ e: d.k, ids: chain, rev: rev[d.k] as boolean, hop });
  }
  while (down.length < V.length) { down.push([]); up.push([]); }
  if (V.length > MAX_VERTS) throw new Error('trop de sommets');

  // 4. Ordre dans les couches : parcours initial, puis barycentres (cadres gardés d'un seul tenant).
  const nl = maxOf(V.map(v => v.layer)) + 1;
  const order: number[] = new Array(V.length).fill(-1);
  let counter = 0;
  const visit = (u: number): void => { if (order[u] !== -1) return; order[u] = counter++; for (const v of down[u] as number[]) visit(v); };
  for (let u = 0; u < V.length; u++) if (!(up[u] as number[]).length) visit(u);
  for (let u = 0; u < V.length; u++) visit(u);
  let layers: number[][] = Array.from({ length: nl }, () => []);
  V.forEach((v, i) => (layers[v.layer] as number[]).push(i));
  layers.forEach(l => l.sort((x, y) => (order[x] as number) - (order[y] as number)));
  const pos: number[] = new Array(V.length).fill(0);
  const setPos = () => layers.forEach(l => l.forEach((v, i) => { pos[v] = i; }));
  setPos();
  const sortLayer = (items: number[], key: (v: number) => number, depth: number): number[] => {
    interface Grp { k: number; n: number; items: number[]; lab: string | null }
    const groups: Grp[] = [], by = new Map<string, Grp>();
    for (const v of items) {
      const lab = (V[v] as V).path[depth];
      if (lab === undefined) { groups.push({ k: key(v), n: 1, items: [v], lab: null }); continue; }
      let gp = by.get(lab);
      if (!gp) { gp = { k: 0, n: 0, items: [], lab }; by.set(lab, gp); groups.push(gp); }
      gp.items.push(v); gp.k += key(v); gp.n++;
    }
    groups.forEach(gp => { if (gp.lab !== null) gp.k /= gp.n; });
    groups.sort((x, y) => x.k - y.k);
    return groups.flatMap(gp => gp.lab === null ? gp.items : sortLayer(gp.items, key, depth + 1));
  };
  const crossings = (): number => {
    let c = 0;
    for (let l = 0; l + 1 < nl; l++) {
      const es: [number, number][] = [];
      for (const u of layers[l] as number[]) for (const v of down[u] as number[]) es.push([pos[u] as number, pos[v] as number]);
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
        const x = es[i] as [number, number], y = es[j] as [number, number];
        if ((x[0] - y[0]) * (x[1] - y[1]) < 0) c++;
      }
    }
    return c;
  };
  let best = layers.map(l => [...l]), bestC = crossings();
  for (let it = 0; it < 8 && bestC > 0; it++) {
    const downward = it % 2 === 0;
    const ls = downward ? Array.from({ length: nl - 1 }, (_, i) => i + 1) : Array.from({ length: nl - 1 }, (_, i) => nl - 2 - i);
    for (const l of ls) {
      const ref = downward ? up : down;
      layers[l] = sortLayer(layers[l] as number[], v => { const r = ref[v] as number[]; return r.length ? r.reduce((s, x) => s + (pos[x] as number), 0) / r.length : (pos[v] as number); }, 0);
      (layers[l] as number[]).forEach((v, i) => { pos[v] = i; });
    }
    const c = crossings();
    if (c < bestC) { bestC = c; best = layers.map(l => [...l]); }
  }
  layers = best; setPos();

  // 5. Coordonnées : positions voulues (moyenne des voisins) puis séparations minimales par PAV.
  const sepOf = (u: number, v: number): number => {
    const A = V[u] as V, B = V[v] as V;
    const base = A.dummy && B.dummy ? 14 : A.dummy || B.dummy ? 22 : 34;
    let cp = 0;
    while (cp < A.path.length && cp < B.path.length && A.path[cp] === B.path[cp]) cp++;
    return (A.b + B.b) / 2 + base + (A.path.length - cp + B.path.length - cp) * (horiz ? 28 : 18);
  };
  const solve = (l: number, want: (v: number) => number | null): void => {
    const L = layers[l] as number[];
    if (!L.length) return;
    const off: number[] = [0];
    for (let i = 1; i < L.length; i++) off.push((off[i - 1] as number) + sepOf(L[i - 1] as number, L[i] as number));
    const t = L.map((v, i) => (want(v) ?? (V[v] as V).q) - (off[i] as number));
    isotonic(t).forEach((y, i) => { (V[L[i] as number] as V).q = y + (off[i] as number); });
  };
  for (let l = 0; l < nl; l++) {
    const L = layers[l] as number[]; let x = 0;
    L.forEach((v, i) => { if (i) x += sepOf(L[i - 1] as number, v); (V[v] as V).q = x; });
    const mid = x / 2; L.forEach(v => { (V[v] as V).q -= mid; });
  }
  const mean = (ns: number[]): number | null => ns.length ? ns.reduce((s, x) => s + (V[x] as V).q, 0) / ns.length : null;
  for (let it = 0; it < 6; it++) {
    const mode = it % 3;
    if (it % 2 === 0) { for (let l = 1; l < nl; l++) solve(l, v => mean(mode < 2 ? up[v] as number[] : [...up[v] as number[], ...down[v] as number[]])); }
    else { for (let l = nl - 2; l >= 0; l--) solve(l, v => mean(mode < 2 ? down[v] as number[] : [...up[v] as number[], ...down[v] as number[]])); }
  }
  for (let l = 1; l < nl; l++) solve(l, v => mean([...up[v] as number[], ...down[v] as number[]]));

  // 5 bis. Les cadres frères (et les nœuds libres) qui se recouvrent sur l'axe des couches sont écartés sur l'axe transversal.
  const maxDepth = Math.max(0, ...V.map(v => v.path.length));
  for (let d = 0; d < maxDepth; d++) {
    for (let pass = 0; pass < 6; pass++) {
      interface Item { key: string; vs: number[]; lo: number; hi: number; l0: number; l1: number; mid: number }
      const items = new Map<string, Item>();
      V.forEach((v, i) => {
        if (v.path.length < d) return;
        const par = v.path.slice(0, d).join('/'), key = par + '|' + (v.path[d] ?? `#${i}`);
        let it = items.get(key);
        if (!it) { it = { key, vs: [], lo: Infinity, hi: -Infinity, l0: Infinity, l1: -Infinity, mid: 0 }; items.set(key, it); }
        const clustered = v.path[d] !== undefined, padLo = clustered ? (horiz ? 36 : 16) : 0, padHi = clustered ? 16 : 0;
        it.vs.push(i); it.lo = Math.min(it.lo, v.q - v.b / 2 - padLo); it.hi = Math.max(it.hi, v.q + v.b / 2 + padHi);
        it.l0 = Math.min(it.l0, v.layer); it.l1 = Math.max(it.l1, v.layer);
      });
      let moved = false;
      const byParent = new Map<string, Item[]>();
      for (const it of items.values()) { const par = it.key.slice(0, it.key.indexOf('|')); byParent.set(par, [...(byParent.get(par) ?? []), it]); }
      for (const sibs of byParent.values()) {
        sibs.forEach(it => { it.mid = (it.lo + it.hi) / 2; });
        sibs.sort((a, b) => a.mid - b.mid);
        const placed: Item[] = [];
        for (const it of sibs) {
          if (it.vs.length === 1 && (V[it.vs[0] as number] as V).path[d] === undefined) { placed.push(it); continue; }
          let shift = 0;
          for (const o of placed) {
            if (o.l1 < it.l0 || o.l0 > it.l1) continue;
            if (!(o.vs.length > 1 || (V[o.vs[0] as number] as V).path[d] !== undefined) && !(it.vs.length > 1 || (V[it.vs[0] as number] as V).path[d] !== undefined)) continue;
            if (it.lo + shift < o.hi + 10 && it.hi + shift > o.lo - 10) shift = Math.max(shift, o.hi + 10 - it.lo);
          }
          if (shift > 0.5) { for (const i of it.vs) (V[i] as V).q += shift; it.lo += shift; it.hi += shift; moved = true; }
          placed.push(it);
        }
        // Un nœud libre posé dans l'emprise d'un cadre est poussé de l'autre côté.
        for (const it of sibs) {
          if (!(it.vs.length === 1 && (V[it.vs[0] as number] as V).path[d] === undefined)) continue;
          const v = V[it.vs[0] as number] as V;
          for (const o of sibs) {
            if (o === it || (o.vs.length === 1 && (V[o.vs[0] as number] as V).path[d] === undefined)) continue;
            if (v.layer < o.l0 || v.layer > o.l1) continue;
            if (v.q + v.b / 2 > o.lo - 10 && v.q - v.b / 2 < o.hi + 10) { v.q = o.hi + 10 + v.b / 2; moved = true; }
          }
        }
      }
      if (!moved) break;
    }
  }

  // 6. Position sur l'axe des couches.
  const subGap = g.subs.size ? 22 : 0, baseGap = (horiz ? 50 : 38) + subGap;
  let p = 0;
  for (let l = 0; l < nl; l++) {
    const th = Math.max(0, ...(layers[l] as number[]).map(v => (V[v] as V).a));
    if (l) p += baseGap + (gapExtra[l - 1] ?? 0);
    for (const v of layers[l] as number[]) (V[v] as V).p = p + th / 2;
    p += th;
  }
  const at = (v: V): Pt => g.dir === 'TD' ? { x: v.q, y: v.p } : g.dir === 'BT' ? { x: v.q, y: -v.p } : g.dir === 'LR' ? { x: v.p, y: v.q } : { x: -v.p, y: v.q };
  const fx = g.dir === 'LR' ? 1 : g.dir === 'RL' ? -1 : 0, fy = g.dir === 'TD' ? 1 : g.dir === 'BT' ? -1 : 0;
  const centers: Pt[] = V.map(at);

  // 7. Cadres des sous-graphes (du plus profond au plus haut).
  interface Box { x0: number; y0: number; x1: number; y1: number }
  const frames = new Map<string, Box>();
  const depthOf = (id: string) => subPath(id).length;
  for (const sid of [...g.subs.keys()].sort((a, b) => depthOf(b) - depthOf(a))) {
    let box: Box | null = null;
    const add = (b: Box) => { box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : { ...b }; };
    nodes.forEach((n, i) => { if (n.sub === sid) { const c = centers[i] as Pt; add({ x0: c.x - n.w / 2, y0: c.y - n.h / 2, x1: c.x + n.w / 2, y1: c.y + n.h / 2 }); } });
    for (const [cid, c] of g.subs) if (c.parent === sid && frames.has(cid)) add(frames.get(cid) as Box);
    if (!box) continue;
    const b = box as Box, title = (g.subs.get(sid) as GSub).title;
    const x1 = Math.max(b.x1 + 14, b.x0 - 14 + tw(title, 11.5) + 28);
    frames.set(sid, { x0: b.x0 - 14, y0: b.y0 - 34, x1, y1: b.y1 + 14 });
  }

  // 8. Ports : les arêtes d'un même côté s'étalent le long du bord (formes à bords droits seulement).
  const real = (i: number) => i < N;
  const spread = (i: number) => real(i) && !['diamond', 'circle', 'hex', 'start', 'end'].includes((nodes[i] as GNode).shape);
  interface Slot { ci: number; end: 's' | 'e'; ref: number }
  const slots = new Map<string, Slot[]>();
  const route = chains.map(c => (c.rev ? [...c.ids].reverse() : c.ids));
  const cross = (i: number) => (V[i] as V).q;
  route.forEach((r, ci) => {
    if (r.length < 2) return;
    const s = r[0] as number, e = r[r.length - 1] as number;
    const sSide = (V[r[1] as number] as V).layer > (V[s] as V).layer ? 'a' : 'b';
    const eSide = (V[e] as V).layer > (V[r[r.length - 2] as number] as V).layer ? 'b' : 'a';
    (slots.get(`${s}${sSide}`) ?? slots.set(`${s}${sSide}`, []).get(`${s}${sSide}`) as Slot[]).push({ ci, end: 's', ref: cross(r[1] as number) });
    (slots.get(`${e}${eSide}`) ?? slots.set(`${e}${eSide}`, []).get(`${e}${eSide}`) as Slot[]).push({ ci, end: 'e', ref: cross(r[r.length - 2] as number) });
  });
  const portOff = new Map<string, number>();
  for (const [key, list] of slots) {
    list.sort((x, y) => x.ref - y.ref || x.ci - y.ci);
    const node = parseInt(key, 10);
    list.forEach((s, i) => portOff.set(`${s.ci}${s.end}`, spread(node) && list.length > 1 ? ((i + 1) / (list.length + 1) - 0.5) * (V[node] as V).b * 0.8 : 0));
  }
  const port = (ci: number, end: 's' | 'e'): Pt => {
    const r = route[ci] as number[];
    const node = end === 's' ? r[0] as number : r[r.length - 1] as number;
    const nb = end === 's' ? r[1] as number : r[r.length - 2] as number;
    // Le voisin est plus loin sur l'axe des couches : on sort ou on entre par le côté « après », sinon par « avant ».
    const sign = (V[nb] as V).layer > (V[node] as V).layer ? 1 : -1;
    const c = centers[node] as Pt, a = (V[node] as V).a / 2, o = portOff.get(`${ci}${end}`) ?? 0;
    return { x: c.x + fx * sign * a + (fy ? o : 0), y: c.y + fy * sign * a + (fx ? o : 0) };
  };

  // 9. Arêtes, têtes et libellés.
  let bb: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (x0: number, y0: number, x1 = x0, y1 = y0) => { bb = { x0: Math.min(bb.x0, x0), y0: Math.min(bb.y0, y0), x1: Math.max(bb.x1, x1), y1: Math.max(bb.y1, y1) }; };
  nodes.forEach((n, i) => { const c = centers[i] as Pt; grow(c.x - n.w / 2, c.y - n.h / 2, c.x + n.w / 2, c.y + n.h / 2); });
  frames.forEach(b => grow(b.x0, b.y0, b.x1, b.y1));
  const headSvg = (kind: GEdge['head'], t: Pt, d: Pt): string => {
    const nx = -d.y, ny = d.x;
    if (kind === 'arrow') return `<path class="dg-h" d="M${f(t.x)} ${f(t.y)}L${f(t.x - d.x * 10 + nx * 4.6)} ${f(t.y - d.y * 10 + ny * 4.6)}L${f(t.x - d.x * 10 - nx * 4.6)} ${f(t.y - d.y * 10 - ny * 4.6)}Z"/>`;
    if (kind === 'circle') return `<circle class="dg-h o" cx="${f(t.x - d.x * 4.5)}" cy="${f(t.y - d.y * 4.5)}" r="4"/>`;
    const c = { x: t.x - d.x * 5.5, y: t.y - d.y * 5.5 };
    return `<path class="dg-h x" d="M${f(c.x + (d.x + nx) * 3.8)} ${f(c.y + (d.y + ny) * 3.8)}L${f(c.x - (d.x + nx) * 3.8)} ${f(c.y - (d.y + ny) * 3.8)}M${f(c.x + (d.x - nx) * 3.8)} ${f(c.y + (d.y - ny) * 3.8)}L${f(c.x - (d.x - nx) * 3.8)} ${f(c.y - (d.y - ny) * 3.8)}"/>`;
  };
  let edgeSvg = '', labSvg = '';
  const placeLabel = (text: string, cx: number, cy: number, d: number): void => {
    const lines = wrap(text, 24), w = maxOf(lines.map(l => tw(l, LAB_SIZE))) + 12, h = lines.length * 14 + 4;
    grow(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
    labSvg += `<g class="dg-lab" style="--d:${d}"><rect x="${f(cx - w / 2)}" y="${f(cy - h / 2)}" width="${f(w)}" height="${f(h)}" rx="4"/>${lines.map((l, i) => `<text x="${f(cx)}" y="${f(cy + (i - (lines.length - 1) / 2) * 14)}" dy=".35em">${esc(l)}</text>`).join('')}</g>`;
  };
  route.forEach((r, ci) => {
    const ch = chains[ci] as Chain, e = edges[ch.e] as E;
    if (r.length < 2) return;
    const pts: Pt[] = r.map((v, k) => k === 0 ? port(ci, 's') : k === r.length - 1 ? port(ci, 'e') : centers[v] as Pt);
    let dstr = `M${f((pts[0] as Pt).x)} ${f((pts[0] as Pt).y)}`, labelAt: Pt | null = null, t0: Pt = { x: 0, y: 0 }, t1: Pt = { x: 0, y: 0 };
    const hopShown = ch.rev ? r.length - 2 - ch.hop : ch.hop;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k] as Pt, b = pts[k + 1] as Pt;
      const sg = ((b.x - a.x) * fx + (b.y - a.y) * fy) >= 0 ? 1 : -1;
      const kk = Math.max(8, Math.abs((b.x - a.x) * fx + (b.y - a.y) * fy) * 0.5);
      const c1 = { x: a.x + fx * sg * kk, y: a.y + fy * sg * kk }, c2 = { x: b.x - fx * sg * kk, y: b.y - fy * sg * kk };
      dstr += `C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}`;
      if (k === 0) t0 = { x: fx * sg, y: fy * sg };
      if (k === pts.length - 2) t1 = { x: fx * sg, y: fy * sg };
      if (k === hopShown) labelAt = { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 };
      grow(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    }
    const d0 = 80 + Math.min((V[r[0] as number] as V).layer, 9) * 60;
    const kind = e.g.line;
    if (kind !== 'none') {
      edgeSvg += `<g class="dg-edge ${kind}" style="--d:${d0}"><path class="dg-e" pathLength="1" d="${dstr}"/>`;
      if (e.g.head !== 'none') edgeSvg += headSvg(e.g.head, pts[pts.length - 1] as Pt, t1);
      if (e.g.tail) edgeSvg += headSvg(e.g.head === 'none' ? 'arrow' : e.g.head, pts[0] as Pt, { x: -t0.x, y: -t0.y });
      edgeSvg += '</g>';
      if (e.g.text && labelAt) placeLabel(e.g.text, labelAt.x, labelAt.y, d0 + 160);
    }
  });
  // Boucles (un nœud relié à lui-même) : à droite du nœud.
  edges.forEach((e, k) => {
    if (e.u !== e.v) return;
    const n = nodes[e.u] as GNode, c = centers[e.u] as Pt, rx = c.x + n.w / 2, d0 = 80 + Math.min((V[e.u] as V).layer, 9) * 60;
    edgeSvg += `<g class="dg-edge ${e.g.line === 'none' ? 'solid' : e.g.line}" style="--d:${d0}"><path class="dg-e" pathLength="1" d="M${f(rx)} ${f(c.y - 7)}C${f(rx + 38)} ${f(c.y - 24)} ${f(rx + 38)} ${f(c.y + 24)} ${f(rx)} ${f(c.y + 7)}"/>${e.g.head !== 'none' ? headSvg(e.g.head, { x: rx, y: c.y + 7 }, { x: -0.93, y: -0.37 }) : ''}</g>`;
    grow(rx + 38, c.y - 20, rx + 40, c.y + 20);
    if (e.g.text) placeLabel(e.g.text, rx + 40 + (tw(e.g.text, LAB_SIZE) + 12) / 2, c.y, d0 + 160);
    void k;
  });

  // 10. Nœuds et cadres.
  let frameSvg = '';
  for (const sid of [...g.subs.keys()].sort((a, b) => depthOf(a) - depthOf(b))) {
    const b = frames.get(sid);
    if (!b) continue;
    frameSvg += `<g class="dg-frame" style="--d:${Math.min(depthOf(sid), 4) * 40}"><rect x="${f(b.x0)}" y="${f(b.y0)}" width="${f(b.x1 - b.x0)}" height="${f(b.y1 - b.y0)}" rx="8"/><text x="${f(b.x0 + 12)}" y="${f(b.y0 + 17)}">${esc((g.subs.get(sid) as GSub).title)}</text></g>`;
  }
  let nodeSvg = '';
  nodes.forEach((n, i) => {
    const c = centers[i] as Pt, x = c.x - n.w / 2, y = c.y - n.h / 2, w = n.w, h = n.h;
    let shape: string;
    switch (n.shape) {
      case 'diamond': shape = `<path class="dg-sh" d="M${f(c.x)} ${f(y)}L${f(x + w)} ${f(c.y)}L${f(c.x)} ${f(y + h)}L${f(x)} ${f(c.y)}Z"/>`; break;
      case 'circle': shape = `<ellipse class="dg-sh" cx="${f(c.x)}" cy="${f(c.y)}" rx="${f(w / 2)}" ry="${f(h / 2)}"/>`; break;
      case 'start': shape = `<circle class="dg-sh solid" cx="${f(c.x)}" cy="${f(c.y)}" r="8"/>`; break;
      case 'end': shape = `<circle class="dg-sh" cx="${f(c.x)}" cy="${f(c.y)}" r="10"/><circle class="dg-sh solid" cx="${f(c.x)}" cy="${f(c.y)}" r="5.5"/>`; break;
      case 'bar': shape = `<rect class="dg-sh solid" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="2"/>`; break;
      case 'stadium': shape = `<rect class="dg-sh" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(h / 2)}"/>`; break;
      case 'round': shape = `<rect class="dg-sh" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="12"/>`; break;
      case 'hex': shape = `<path class="dg-sh" d="M${f(x + 14)} ${f(y)}H${f(x + w - 14)}L${f(x + w)} ${f(c.y)}L${f(x + w - 14)} ${f(y + h)}H${f(x + 14)}L${f(x)} ${f(c.y)}Z"/>`; break;
      case 'cyl': shape = `<path class="dg-sh" d="M${f(x)} ${f(y + 8)}A${f(w / 2)} 8 0 0 1 ${f(x + w)} ${f(y + 8)}V${f(y + h - 8)}A${f(w / 2)} 8 0 0 1 ${f(x)} ${f(y + h - 8)}Z"/><path class="dg-sh-l" d="M${f(x)} ${f(y + 8)}A${f(w / 2)} 8 0 0 0 ${f(x + w)} ${f(y + 8)}"/>`; break;
      default: shape = `<rect class="dg-sh" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="6"/>`;
    }
    const ty = n.shape === 'cyl' ? c.y + 4 : c.y;
    const text = n.lines.map((l, k) => `<text x="${f(c.x)}" y="${f(ty + (k - (n.lines.length - 1) / 2) * 17)}" dy=".35em">${esc(l)}</text>`).join('');
    const d = Math.min((V[i] as V).layer, 9) * 60 + Math.min(order[i] as number, 12) * 8;
    nodeSvg += `<g class="dg-n k-${n.shape}" style="--d:${d}">${shape}${text}</g>`;
  });

  const pad = 14;
  if (!isFinite(bb.x0)) throw new Error('vide');
  const ox = pad - bb.x0, oy = pad - bb.y0, W = Math.ceil(bb.x1 - bb.x0 + pad * 2), H = Math.ceil(bb.y1 - bb.y0 + pad * 2);
  const svg = `<svg class="dg-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="--dg-w:${W}px" role="img" aria-label="Schéma"><g transform="translate(${f(ox)} ${f(oy)})">${frameSvg}${edgeSvg}${nodeSvg}${labSvg}</g></svg>`;
  return { svg, w: W, h: H };
}

// ---------------------------------------------------------------- Diagrammes de séquence

interface Part { id: string; label: string; actor: boolean }
type Ev =
  | { t: 'msg'; from: string; to: string; text: string; dash: boolean; head: 'arrow' | 'open' | 'cross' | 'none' }
  | { t: 'note'; side: 'over' | 'left' | 'right'; a: string; b: string; text: string }
  | { t: 'open'; kind: string; text: string; hidden: boolean }
  | { t: 'else'; kind: string; text: string }
  | { t: 'close' };

const MSG_RE = /^(\S+?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?\s*(\S+?)\s*(?::\s*(.*))?$/;
const FRAMES = new Set(['loop', 'alt', 'opt', 'par', 'critical', 'break', 'rect', 'box']);
const ELSES: Record<string, string> = { else: 'else', and: 'and', option: 'option' };

function parseSeq(code: string): { parts: Part[]; evs: Ev[] } {
  const parts: Part[] = [], evs: Ev[] = [];
  const known = (id: string) => { if (!parts.some(p => p.id === id)) parts.push({ id, label: id, actor: false }); };
  const open: boolean[] = [];
  let auto = 0, numbering = false;
  for (const s of statements(code)) {
    let m: RegExpExecArray | null;
    if (s === 'autonumber' || /^autonumber\s/.test(s)) { numbering = true; continue; }
    if (/^(activate|deactivate|destroy|title|accTitle|accDescr|link|links)\b/.test(s)) continue;
    if ((m = /^(?:create\s+)?(participant|actor)\s+("[^"]+"|\S+?)(?:\s+as\s+(.+))?$/.exec(s))) {
      const id = clean(m[2] ?? ''), label = clean(m[3] ?? m[2] ?? '');
      const p = parts.find(x => x.id === id);
      if (p) { p.label = label; p.actor = m[1] === 'actor'; } else parts.push({ id, label, actor: m[1] === 'actor' });
      continue;
    }
    if ((m = /^note\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$/i.exec(s))) {
      const ids = (m[2] ?? '').split(',').map(x => x.trim()).filter(Boolean);
      for (const id of ids) known(id);
      const side = (m[1] ?? '').toLowerCase().startsWith('over') ? 'over' : (m[1] ?? '').toLowerCase().startsWith('left') ? 'left' : 'right';
      evs.push({ t: 'note', side, a: ids[0] ?? '', b: ids[1] ?? ids[0] ?? '', text: clean(m[3] ?? '') });
      continue;
    }
    if ((m = /^(\w+)(?:\s+(.*))?$/.exec(s)) && FRAMES.has((m[1] ?? '').toLowerCase())) {
      const hidden = m[1] === 'rect' || m[1] === 'box';
      open.push(true);
      evs.push({ t: 'open', kind: (m[1] ?? '').toLowerCase(), text: hidden ? '' : clean(m[2] ?? ''), hidden });
      continue;
    }
    if ((m = /^(else|and|option)(?:\s+(.*))?$/.exec(s))) { evs.push({ t: 'else', kind: ELSES[m[1] ?? ''] ?? 'else', text: clean(m[2] ?? '') }); continue; }
    if (s === 'end') { if (open.pop()) evs.push({ t: 'close' }); continue; }
    if ((m = MSG_RE.exec(s))) {
      const op = m[2] ?? '', from = m[1] ?? '', to = m[3] ?? '';
      known(from); known(to);
      const num = numbering ? `${++auto}. ` : '';
      evs.push({ t: 'msg', from, to, text: num + clean(m[4] ?? ''), dash: op.startsWith('--'), head: op.endsWith('>>') ? 'arrow' : op.endsWith(')') ? 'open' : op.endsWith('x') ? 'cross' : 'none' });
      continue;
    }
    throw new Error('instruction inconnue');
  }
  if (!parts.length) throw new Error('vide');
  return { parts, evs };
}

function renderSeq(code: string): { svg: string; w: number; h: number } {
  const { parts, evs } = parseSeq(code);
  if (evs.length > 400) throw new Error('trop grand');
  const n = parts.length, ix = new Map(parts.map((p, i) => [p.id, i]));
  const at = (id: string) => ix.get(id) ?? 0;
  const pl = parts.map(p => clean(p.label).split('\n'));
  const pw = pl.map(l => Math.max(84, maxOf(l.map(x => tw(x))) + 28)), ph = 34 + (maxOf(pl.map(l => l.length)) - 1) * 16;
  const lines = (t: string, max = 34) => wrap(t, max);

  // Écarts entre colonnes : chaque libellé doit tenir entre ses deux colonnes.
  const gap = parts.map((_, k) => k < n - 1 ? ((pw[k] as number) + (pw[k + 1] as number)) / 2 + 28 : 0);
  const need: { i: number; j: number; w: number }[] = [];
  const single = (k: number, w: number) => { if (k >= 0 && k < n - 1) gap[k] = Math.max(gap[k] as number, w); };
  for (const e of evs) {
    if (e.t === 'msg') {
      const w = Math.max(0, ...lines(e.text, 44).map(l => tw(l, 12)));
      const i = at(e.from), j = at(e.to);
      if (i === j) single(i, w + 52); else need.push({ i: Math.min(i, j), j: Math.max(i, j), w: w + 36 });
    } else if (e.t === 'note') {
      const W = Math.max(0, ...lines(e.text, 30).map(l => tw(l, 12))) + 22, i = at(e.a), j = at(e.b);
      if (e.side === 'left') single(i - 1, W + 26);
      else if (e.side === 'right') single(i, W + 26);
      else if (i === j) { single(i - 1, W / 2 + 14); single(i, W / 2 + 14); } else need.push({ i: Math.min(i, j), j: Math.max(i, j), w: W - 24 });
    }
  }
  need.sort((a, b) => (a.j - a.i) - (b.j - b.i));
  for (const nd of need) {
    let sum = 0;
    for (let k = nd.i; k < nd.j; k++) sum += gap[k] as number;
    if (sum < nd.w) for (let k = nd.i; k < nd.j; k++) gap[k] = (gap[k] as number) + (nd.w - sum) / (nd.j - nd.i);
  }
  const xs: number[] = [];
  parts.forEach((_, k) => xs.push(k ? (xs[k - 1] as number) + (gap[k - 1] as number) : (pw[0] as number) / 2));

  let minX = Infinity, maxX = -Infinity;
  const ext = (a: number, b: number) => { minX = Math.min(minX, a); maxX = Math.max(maxX, b); };
  interface Fr { kind: string; text: string; hidden: boolean; y0: number; x0: number; x1: number; elses: { y: number; kind: string; text: string }[] }
  const stack: Fr[] = [], doneFr: (Fr & { y1: number })[] = [];
  const touch = (a: number, b: number) => { ext(a, b); const t = stack[stack.length - 1]; if (t) { t.x0 = Math.min(t.x0, a); t.x1 = Math.max(t.x1, b); } };
  pw.forEach((w, k) => ext((xs[k] as number) - w / 2, (xs[k] as number) + w / 2));
  let y = ph + 22, svg = '', idx = 0;
  const msgs: string[] = [];
  const heads = (kind: string, x: number, yy: number, dir: number): string => {
    if (kind === 'arrow') return `<path class="dg-h" d="M${f(x)} ${f(yy)}L${f(x - dir * 10)} ${f(yy - 4.6)}L${f(x - dir * 10)} ${f(yy + 4.6)}Z"/>`;
    if (kind === 'open') return `<path class="dg-h o" d="M${f(x - dir * 9)} ${f(yy - 5)}L${f(x)} ${f(yy)}L${f(x - dir * 9)} ${f(yy + 5)}"/>`;
    if (kind === 'cross') return `<path class="dg-h x" d="M${f(x - dir * 9)} ${f(yy - 4.5)}L${f(x - dir * 0)} ${f(yy + 4.5)}M${f(x - dir * 9)} ${f(yy + 4.5)}L${f(x)} ${f(yy - 4.5)}"/>`;
    return '';
  };
  const text = (ls: string[], x: number, yy: number, lh: number, cls: string, anchor = 'middle') => ls.map((l, i) => `<text class="${cls}" x="${f(x)}" y="${f(yy + i * lh)}" text-anchor="${anchor}" dy=".35em">${esc(l)}</text>`).join('');
  for (const e of evs) {
    const d = 160 + Math.min(idx, 30) * 55;
    if (e.t === 'msg') {
      const ls = e.text ? lines(e.text, 44) : [], i = at(e.from), j = at(e.to), x1 = xs[i] as number, x2 = xs[j] as number;
      const cls = `dg-msg${e.dash ? ' dash' : ''}`;
      if (i === j) {
        const h = Math.max(18, ls.length * 15), ay = y + 8;
        msgs.push(`<g class="${cls}" style="--d:${d}"><path class="dg-e" pathLength="1" d="M${f(x1)} ${f(ay)}H${f(x1 + 30)}V${f(ay + 18)}H${f(x1 + 1)}"/>${heads(e.head === 'none' ? 'none' : e.head, x1, ay + 18, -1)}${text(ls, x1 + 38, ay + 9 - (ls.length - 1) * 7.5, 15, 'dg-ml', 'start')}</g>`);
        touch(x1 - 4, x1 + 38 + Math.max(0, ...ls.map(l => tw(l, 12))) + 4);
        y = ay + Math.max(h, 18) + 14;
      } else {
        const dir = x2 > x1 ? 1 : -1, ay = y + (ls.length ? ls.length * 15 + 12 : 10);
        msgs.push(`<g class="${cls}" style="--d:${d}"><path class="dg-e" pathLength="1" d="M${f(x1)} ${f(ay)}H${f(x2)}"/>${heads(e.head, x2, ay, dir)}${text(ls, (x1 + x2) / 2, y + 7, 15, 'dg-ml')}</g>`);
        touch(Math.min(x1, x2) - 2, Math.max(x1, x2) + 2);
        y = ay + 18;
      }
    } else if (e.t === 'note') {
      const ls = lines(e.text, 30), W0 = Math.max(0, ...ls.map(l => tw(l, 12))) + 22, h = ls.length * 15 + 12;
      const a = xs[at(e.a)] as number, b = xs[at(e.b)] as number;
      let x0: number, W = W0;
      if (e.side === 'left') x0 = a - 12 - W;
      else if (e.side === 'right') x0 = a + 12;
      else { W = Math.max(W0, Math.abs(b - a) + 24); x0 = (a + b) / 2 - W / 2; }
      y += 6;
      msgs.push(`<g class="dg-note" style="--d:${d}"><rect x="${f(x0)}" y="${f(y)}" width="${f(W)}" height="${f(h)}" rx="4"/>${text(ls, x0 + W / 2, y + h / 2 - (ls.length - 1) * 7.5, 15, 'dg-nl')}</g>`);
      touch(x0, x0 + W);
      y += h + 12;
    } else if (e.t === 'open') {
      stack.push({ kind: e.kind, text: e.text, hidden: e.hidden, y0: y + 2, x0: Infinity, x1: -Infinity, elses: [] });
      y += e.hidden ? 6 : 30;
    } else if (e.t === 'else') {
      const t = stack[stack.length - 1];
      if (t) { t.elses.push({ y: y + 4, kind: e.kind, text: e.text }); y += 26; }
    } else {
      const t = stack.pop();
      if (t) {
        const pad = t.hidden ? 0 : 12;
        if (!isFinite(t.x0)) { t.x0 = (xs[0] as number) - 20; t.x1 = (xs[n - 1] as number) + 20; }
        if (!t.hidden) t.x1 = Math.max(t.x1 + pad, t.x0 - pad + tw(t.kind, 11) + 24 + tw(t.text ? `[${t.text}]` : '', 11.5) + 16);
        t.x0 -= pad;
        doneFr.push({ ...t, y1: y + 2 });
        touch(t.x0, t.x1);
        y += t.hidden ? 4 : 14;
      }
    }
    idx++;
  }
  const endY = y + 8;
  // Cadres (au-dessous des messages).
  let frames = '';
  for (const t of doneFr) {
    if (t.hidden) continue;
    const tabW = tw(t.kind, 11) + 20;
    frames += `<g class="dg-fr" style="--d:100"><rect x="${f(t.x0)}" y="${f(t.y0)}" width="${f(t.x1 - t.x0)}" height="${f(t.y1 - t.y0)}" rx="4"/><path class="tab" d="M${f(t.x0)} ${f(t.y0)}H${f(t.x0 + tabW)}V${f(t.y0 + 11)}L${f(t.x0 + tabW - 8)} ${f(t.y0 + 20)}H${f(t.x0)}Z"/><text class="kind" x="${f(t.x0 + 9)}" y="${f(t.y0 + 10.5)}" dy=".35em">${esc(t.kind)}</text>${t.text ? `<text class="cond" x="${f(t.x0 + tabW + 8)}" y="${f(t.y0 + 10.5)}" dy=".35em">${esc(`[${t.text}]`)}</text>` : ''}`;
    for (const el of t.elses) frames += `<path class="sep" d="M${f(t.x0)} ${f(el.y)}H${f(t.x1)}"/>${el.text || el.kind !== 'else' ? `<text class="cond" x="${f(t.x0 + 9)}" y="${f(el.y + 13)}" dy=".35em">${esc(`[${el.text || el.kind}]`)}</text>` : ''}`;
    frames += '</g>';
  }
  const box = (k: number, yy: number) => {
    const p = parts[k] as Part, w = pw[k] as number, x = (xs[k] as number) - w / 2, l = pl[k] as string[];
    return `<g class="dg-n k-${p.actor ? 'stadium' : 'rect'}" style="--d:0"><rect class="dg-sh" x="${f(x)}" y="${f(yy)}" width="${f(w)}" height="${f(ph)}" rx="${p.actor ? f(ph / 2) : 6}"/>${l.map((s, i) => `<text x="${f(xs[k] as number)}" y="${f(yy + ph / 2 + (i - (l.length - 1) / 2) * 16)}" dy=".35em">${esc(s)}</text>`).join('')}</g>`;
  };
  const life = parts.map((_, k) => `<path class="dg-life" d="M${f(xs[k] as number)} ${ph}V${f(endY)}"/>`).join('');
  const bottoms = parts.map((_, k) => box(k, endY)).join('');
  const tops = parts.map((_, k) => box(k, 0)).join('');
  svg = `${life}${frames}${msgs.join('')}${tops}${bottoms}`;
  const pad = 14, W = Math.ceil(maxX - minX + pad * 2), H = Math.ceil(endY + ph + pad * 2);
  return { svg: `<svg class="dg-svg dg-seq" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="--dg-w:${W}px" role="img" aria-label="Schéma de séquence"><g transform="translate(${f(pad - minX)} ${pad})">${svg}</g></svg>`, w: W, h: H };
}

// ---------------------------------------------------------------- Point d'entrée

/** Langues de blocs prises en charge (alias de `mermaid`). */
const LANGS = new Set(['mermaid', 'mmd']);
/** Cache par source (LRU simple, Map ordonnée). Une entrée présente = déjà rendue une fois (animations d'entrée déjà jouées). */
interface Hit { html: string; still: string }
const cache = new Map<string, Hit>();
const CACHE_MAX = 60;

const note = (src: string, why: string): string =>
  `<div class="dg-fb"><pre><code>${esc(src)}</code></pre><p class="dg-why">${esc(why)}</p></div>`;

function build(code: string): string {
  const src = stripFront(code).replace(/^\s*\n/, '');
  const lines = statements(src), first = lines[0] ?? '';
  const body = lines.slice(1).join('\n');
  let m: RegExpExecArray | null;
  try {
    let res: { svg: string; w: number; h: number };
    let kind: string;
    if ((m = /^(?:flowchart|graph)(?:-elk)?(?:\s+(TD|TB|LR|RL|BT))?\s*$/i.exec(first))) {
      const d = (m[1] ?? 'TD').toUpperCase();
      res = renderFlow(parseFlow(body, d === 'TB' ? 'TD' : d as Dir)); kind = 'flow';
    } else if (/^sequenceDiagram\s*$/.test(first)) { res = renderSeq(body); kind = 'seq'; }
    else if (/^stateDiagram(-v2)?\s*$/.test(first)) { res = renderFlow(parseState(body)); kind = 'state'; }
    else return note(code, 'Ce type de schéma n’est pas pris en charge ici : voici le code.');
    return `<div class="dg" data-kind="${kind}"><div class="dg-bar"><button type="button" class="dg-btn" data-dg="zoom" title="Ouvrir en plein écran">Agrandir</button><button type="button" class="dg-btn" data-dg="code" title="Voir le code du schéma">Code</button><button type="button" class="dg-btn" data-dg="copy" title="Copier le code du schéma">Copier</button></div><div class="dg-view">${res.svg}</div><pre class="dg-src"><code>${esc(code.replace(/\s+$/, ''))}</code></pre></div>`;
  } catch {
    return note(code, 'Schéma non affiché (syntaxe non reconnue) : voici le code.');
  }
}

/** Bloc de code ```mermaid (ou mmd) → schéma SVG, ou `null` si la langue n'est pas la sienne.
 *  Premier rendu d'un source : avec les animations d'entrée ; ensuite : version `dg-still` (sans animation),
 *  identique à chaque appel (un seul changement de HTML, jamais d'alternance). */
export function fence(lang: string, code: string): string | null {
  const l = lang.toLowerCase();
  if (!LANGS.has(l)) return null;
  init();
  let hit = cache.get(code);
  if (hit === undefined) {
    const html = build(code);
    hit = { html, still: html.replace('<div class="dg" ', '<div class="dg dg-still" ') };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(code, hit);
    return hit.html;
  }
  cache.delete(code); cache.set(code, hit); // récemment utilisé
  return hit.still;
}

/** Texte brut d'un conteneur : chaque schéma redevient son bloc ```mermaid (sans libellés de boutons ni de SVG). */
export function plainText(root: Element): string {
  const c = root.cloneNode(true) as Element;
  c.querySelectorAll('.dg').forEach(d => {
    const src = d.querySelector('.dg-src code')?.textContent ?? '';
    const pre = document.createElement('pre');
    pre.textContent = '```mermaid\n' + src + '\n```';
    d.replaceWith(pre);
  });
  // `innerText` ne connaît les sauts de ligne des blocs que si le clone est rendu : on l'accroche hors écran le temps de la lecture.
  if (!root.parentNode) return c.textContent ?? '';
  const h = c as HTMLElement;
  h.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px;opacity:0;pointer-events:none';
  h.setAttribute('aria-hidden', 'true');
  root.parentNode.insertBefore(h, root.nextSibling);
  const out = h.innerText;
  h.remove();
  return out;
}

// ---------------------------------------------------------------- Interactions (déléguées sur document)

interface Full { el: HTMLElement; layer: HTMLElement; w: number; h: number; k: number; x: number; y: number; opener: HTMLElement | null; ptrs: Map<number, Pt>; pinch: number; drag: boolean }
let full: Full | null = null, ready = false;

const stage = (): { w: number; h: number } => ({ w: full?.el.clientWidth ?? 0, h: full?.el.clientHeight ?? 0 });
function paint(): void {
  if (!full) return;
  full.layer.style.transform = `translate(${full.x}px,${full.y}px) scale(${full.k})`;
  const z = full.el.querySelector('[data-dg="fit"]');
  if (z) z.textContent = `${Math.round(full.k * 100)} %`;
}
function fit(): void {
  if (!full) return;
  const s = stage();
  full.k = Math.max(0.2, Math.min((s.w - 64) / full.w, (s.h - 120) / full.h, 2));
  full.x = (s.w - full.w * full.k) / 2; full.y = (s.h - full.h * full.k) / 2 + 12;
  paint();
}
function zoomAt(cx: number, cy: number, factor: number): void {
  if (!full) return;
  const k = Math.max(0.15, Math.min(8, full.k * factor)), r = k / full.k;
  full.x = cx - (cx - full.x) * r; full.y = cy - (cy - full.y) * r; full.k = k;
  paint();
}
function zoomCenter(factor: number): void { const s = stage(); zoomAt(s.w / 2, s.h / 2, factor); }

function openFull(fig: HTMLElement, opener: HTMLElement): void {
  const svg = fig.querySelector('.dg-view svg');
  if (!svg || full) return;
  const w = +(svg.getAttribute('width') ?? 0), h = +(svg.getAttribute('height') ?? 0);
  const el = document.createElement('div');
  el.className = 'dg-full dg-still';
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Schéma en plein écran');
  el.innerHTML = '<div class="dg-fbar"><span class="dg-hint">Molette pour zoomer, glisser pour déplacer</span><button type="button" class="dg-btn" data-dg="zout" aria-label="Zoom arrière">−</button><button type="button" class="dg-btn dg-pct" data-dg="fit" title="Ajuster à l’écran">100 %</button><button type="button" class="dg-btn" data-dg="zin" aria-label="Zoom avant">+</button><button type="button" class="dg-btn" data-dg="close">Fermer (Échap)</button></div><div class="dg-stage"><div class="dg-layer"></div></div>';
  const layer = el.querySelector('.dg-layer') as HTMLElement;
  layer.appendChild(svg.cloneNode(true));
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('dblclick', onDbl);
  document.body.appendChild(el);
  full = { el, layer, w, h, k: 1, x: 0, y: 0, opener, ptrs: new Map(), pinch: 0, drag: false };
  fit();
  el.focus({ preventScroll: true });
}
function closeFull(): void {
  if (!full) return;
  const { el, opener } = full;
  full = null;
  el.remove();
  if (opener?.isConnected) opener.focus({ preventScroll: true });
}

function onClick(e: MouseEvent): void {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const b = t.closest<HTMLElement>('button[data-dg]');
  if (!b) return;
  e.preventDefault();
  const act = b.dataset.dg, fig = b.closest<HTMLElement>('.dg');
  switch (act) {
    case 'zoom': if (fig) openFull(fig, b); break;
    case 'code': if (fig) { const on = fig.classList.toggle('show-src'); b.textContent = on ? 'Schéma' : 'Code'; b.title = on ? 'Revenir au schéma' : 'Voir le code du schéma'; } break;
    case 'copy': {
      const src = fig?.querySelector('.dg-src code')?.textContent ?? '';
      const done = (txt: string) => { b.textContent = txt; setTimeout(() => { if (b.isConnected) b.textContent = 'Copier'; }, 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText(src).then(() => done('Copié'), () => done('Copie impossible')); else done('Copie impossible');
      break;
    }
    case 'close': closeFull(); break;
    case 'zin': zoomCenter(1.25); break;
    case 'zout': zoomCenter(0.8); break;
    case 'fit': fit(); break;
  }
}
function onKey(e: KeyboardEvent): void {
  if (!full) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeFull(); }
  else if (e.key === 'Tab') {
    // Piège à focus : on reste dans le calque.
    const f = [...full.el.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const first = f[0], last = f[f.length - 1], a = document.activeElement;
    if (!first || !last) e.preventDefault();
    else if (!full.el.contains(a) || a === full.el) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCenter(1.25); }
  else if (e.key === '-') { e.preventDefault(); zoomCenter(0.8); }
  else if (e.key === '0') { e.preventDefault(); fit(); }
}
const inStage = (t: EventTarget | null): boolean => !!full && t instanceof Element && !!t.closest('.dg-stage') && full.el.contains(t);
function onWheel(e: WheelEvent): void {
  if (!full || !inStage(e.target)) return;
  e.preventDefault();
  const r = full.el.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
}
function onDown(e: PointerEvent): void {
  if (!full || !inStage(e.target)) return;
  full.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
  full.drag = true; full.el.classList.add('grab');
  full.pinch = full.ptrs.size === 2 ? pinchDist() : 0;
}
const pinchDist = (): number => { const [a, b] = [...(full?.ptrs.values() ?? [])]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
function onMove(e: PointerEvent): void {
  if (!full || !full.ptrs.has(e.pointerId)) return;
  const prev = full.ptrs.get(e.pointerId) as Pt;
  full.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (full.ptrs.size === 2) {
    const d = pinchDist(), r = full.el.getBoundingClientRect(), [a, b] = [...full.ptrs.values()] as [Pt, Pt];
    if (full.pinch) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / full.pinch);
    full.pinch = d;
  } else if (full.ptrs.size === 1) { full.x += e.clientX - prev.x; full.y += e.clientY - prev.y; paint(); }
}
function onUp(e: PointerEvent): void {
  if (!full) return;
  full.ptrs.delete(e.pointerId);
  full.pinch = 0;
  if (!full.ptrs.size) full.el.classList.remove('grab');
}
function onDbl(e: MouseEvent): void { if (inStage(e.target)) fit(); }

/** Pose les écouteurs une seule fois (`click` et `keydown` délégués sur `document` ; le reste est posé sur le calque plein écran). Appelée aussi à la première utilisation de `fence`. */
export function init(): void {
  if (ready || typeof document === 'undefined') return;
  ready = true;
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
}
