// Émulateur de terminal (VT100/xterm) maison, sans DOM ni dépendance : le modèle derrière `ui/termview.ts`.
//
// Ce qu'il fait : analyseur de séquences (machine d'états ground/escape/csi/osc/chaînes ignorées, UTF-8 en flux),
// écran de cellules (largeur 1 ou 2, attributs, couleurs 16/256/truecolor, liens OSC 8), curseur, marges de défilement
// (DECSTBM), écran alternatif (47/1047/1049), historique borné, réenroulement au redimensionnement, tabulations,
// insertion/suppression, effacements, modes (DECAWM, DECCKM, DECKPAM, collage encadré, focus, souris), réponses
// DA1/DA2/DSR, titre (OSC 0/2), dossier (OSC 7), intégration shell (OSC 133, contrat B), et deux encodeurs vers le pty :
// `encodeKey` (touche → octets) et `Terminal.mouseReport` / `paste` / `focusReport`.
//
// Modèle : `lines` de l'écran actif + `sb` (historique, écran principal seulement). Une « ligne virtuelle » v indexe
// sb puis l'écran (v = sb.length + y). Une cellule est un caractère (« » = moitié droite d'un caractère large) et un
// numéro de style (table `styles`, interné, 0 = défaut). `wrap` d'une ligne = elle continue sur la suivante (enroulement
// automatique), ce qui permet de recoller les lignes (`logical`, `rangeText`, `tail`) et de les réenrouler (`resize`).
// Rendu incrémental : `dirty[y]` (lignes de l'écran modifiées) et `epoch` (les lignes ont changé de place : tout repeindre).
// Pas d'enum, pas de propriété de paramètre : Node exécute ce fichier tel quel (tests).

export const BOLD = 1, DIM = 2, ITALIC = 4, UNDER = 8, BLINK = 16, INVERSE = 32, INVIS = 64, STRIKE = 128;

/** Couleur : -1 = défaut, 0-255 = palette, sinon 0x1000000 | 0xRRGGBB. */
export interface Style { fg: number; bg: number; at: number; link: number }
export interface Line { ch: string[]; st: number[]; wrap: boolean }
export type Mark = { kind: 'prompt' } | { kind: 'start'; cmd: string } | { kind: 'end'; code: number };
export interface VtHandlers {
  respond?(data: string): void;   // réponses DA/DSR… à renvoyer au pty
  title?(t: string): void;
  cwd?(path: string): void;
  mark?(m: Mark): void;
  line?(text: string): void;      // ligne terminée par LF (écran principal), texte brut
  bell?(): void;
  change?(): void;                // fin de chaque write() : de quoi planifier un rendu
}
interface Saved { cx: number; cy: number; wrapNext: boolean; pen: Style; origin: boolean; g: string[]; gl: number }
interface Screen { lines: Line[]; cx: number; cy: number; wrapNext: boolean; top: number; bottom: number; saved: Saved | null }

const DEC_GFX = ' ◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·'; // 0x5f…0x7e
const ZERO: [number, number][] = [[0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd], [0x610, 0x61a], [0x64b, 0x65f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064],
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0xe0100, 0xe01ef], [0x1f3fb, 0x1f3ff]];
const WIDE: [number, number][] = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
  [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fac6], [0x1face, 0x1fadc], [0x1fae0, 0x1fae9], [0x1faf0, 0x1faf8],
  [0x20000, 0x3fffd]];
const inRanges = (cp: number, t: [number, number][]) => { for (const [a, b] of t) { if (cp < a) return false; if (cp <= b) return true; } return false; };
/** Largeur d'un point de code en colonnes : 0 (combinant), 1 ou 2. */
export function width(cp: number): 0 | 1 | 2 {
  if (cp < 0x300) return 1;
  if (cp < 0x1100) return inRanges(cp, ZERO) ? 0 : 1;
  if (inRanges(cp, ZERO)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

const mkLine = (cols: number, st = 0): Line => ({ ch: new Array<string>(cols).fill(' '), st: new Array<number>(cols).fill(st), wrap: false });
const isBlank = (l: Line) => { for (let i = 0; i < l.ch.length; i++) if (l.ch[i] !== ' ' || l.st[i] !== 0) return false; return true; };
const rowText = (l: Line, c0: number, c1: number, trim: boolean) => {
  let s = ''; for (let x = c0; x < c1 && x < l.ch.length; x++) s += l.ch[x];
  return trim ? s.replace(/ +$/, '') : s;
};

// États de l'analyseur.
const GROUND = 0, ESCAPE = 1, ESC_INT = 2, CSI = 3, OSC = 4, SKIP = 5;

export class Terminal {
  cols: number; rows: number;
  readonly styles: Style[] = [{ fg: -1, bg: -1, at: 0, link: 0 }];
  readonly links: string[] = [''];
  sb: Line[] = []; sbTotal = 0; sbMax = 5000;
  epoch = 0;
  main: Screen; alt: Screen; s: Screen; altOn = false;
  dirty: Uint8Array; dirtyAny = true;
  tabs: boolean[] = [];
  title = ''; cwd = '';
  appCursor = false; appKeypad = false; autowrap = true; origin = false; insert = false; lnm = false;
  cursorVisible = true; cursorShape: 'block' | 'underline' | 'bar' = 'block'; cursorBlink = true;
  bracketed = false; focusEvents = false; mouse = 0; mouseSgr = false;
  private pen: Style = { fg: -1, bg: -1, at: 0, link: 0 }; private penId = 0;
  private g = ['B', 'B']; private gl = 0;
  private state = GROUND; private buf = ''; private inter = ''; private str = '';
  private lastCh = '';
  private styleMap = new Map<string, number>([['-1,-1,0,0', 0]]);
  private linkMap = new Map<string, number>();
  private dec = new TextDecoder('utf-8');
  private h: VtHandlers;

  constructor(cols: number, rows: number, h: VtHandlers = {}) {
    this.h = h; this.cols = Math.max(2, cols | 0); this.rows = Math.max(1, rows | 0);
    this.main = this.mkScreen(); this.alt = this.mkScreen(); this.s = this.main;
    this.dirty = new Uint8Array(this.rows).fill(1); this.resetTabs();
  }
  private mkScreen(): Screen {
    return { lines: Array.from({ length: this.rows }, () => mkLine(this.cols)), cx: 0, cy: 0, wrapNext: false, top: 0, bottom: this.rows - 1, saved: null };
  }
  private resetTabs() { this.tabs = Array.from({ length: this.cols }, (_, i) => i % 8 === 0 && i > 0); }

  // ---------- accès pour le rendu ----------
  get total() { return this.sb.length + this.rows; }
  /** Numéro absolu de sb[0] : stable quand l'historique glisse (sélection, ancrage). */
  get base() { return this.sbTotal - this.sb.length; }
  vline(v: number): Line { return v < this.sb.length ? this.sb[v] : this.s.lines[v - this.sb.length] ?? this.s.lines[this.rows - 1]; }
  /** À appeler par la vue après un rendu. */
  clean() { this.dirty.fill(0); this.dirtyAny = false; }
  private mark(y: number) { if (y >= 0 && y < this.rows) { this.dirty[y] = 1; this.dirtyAny = true; } }
  private markAll() { this.dirty.fill(1); this.dirtyAny = true; }
  private markRange(a: number, b: number) { for (let y = a; y <= b; y++) this.dirty[y] = 1; this.dirtyAny = true; }

  // ---------- styles ----------
  private intern(fg: number, bg: number, at: number, link: number) {
    const k = fg + ',' + bg + ',' + at + ',' + link; let id = this.styleMap.get(k);
    if (id === undefined) { id = this.styles.length; this.styles.push({ fg, bg, at, link }); this.styleMap.set(k, id); }
    return id;
  }
  private penUpdate() { const p = this.pen; this.penId = this.intern(p.fg, p.bg, p.at, p.link); }
  private blank() { return this.pen.bg < 0 ? 0 : this.intern(-1, this.pen.bg, 0, 0); }
  private linkId(url: string) {
    if (!url) return 0; let id = this.linkMap.get(url);
    if (id === undefined) { id = this.links.length; this.links.push(url); this.linkMap.set(url, id); }
    return id;
  }

  // ---------- entrée ----------
  write(data: Uint8Array | string) {
    const s = typeof data === 'string' ? data : this.dec.decode(data, { stream: true });
    this.parse(s); this.h.change?.();
  }

  private parse(s: string) {
    for (let i = 0; i < s.length;) {
      const c = s.charCodeAt(i);
      if (this.state === GROUND) {
        if (c >= 0x20 && c !== 0x7f) {
          const cp = s.codePointAt(i) as number; i += cp > 0xffff ? 2 : 1; this.print(cp); continue;
        }
        i++; if (c === 0x1b) { this.state = ESCAPE; this.inter = ''; } else this.control(c);
        continue;
      }
      i++;
      if (c === 0x18 || c === 0x1a) { this.state = GROUND; continue; }                       // CAN, SUB
      if (this.state === OSC || this.state === SKIP) {
        if (c === 0x1b) { if (this.state === OSC) this.osc(this.str); this.state = ESCAPE; this.inter = ''; }
        else if (c === 7 && this.state === OSC) { this.osc(this.str); this.state = GROUND; }
        else if (this.state === OSC && this.str.length < 65536) this.str += s[i - 1];
        continue;
      }
      if (c === 0x1b) { this.state = ESCAPE; this.inter = ''; continue; }
      if (c < 0x20) { this.control(c); continue; }                                            // C0 dans une séquence : exécuté
      if (this.state === ESCAPE) {
        if (c === 0x5b) { this.state = CSI; this.buf = ''; }
        else if (c === 0x5d) { this.state = OSC; this.str = ''; }
        else if (c === 0x50 || c === 0x5f || c === 0x5e || c === 0x58) this.state = SKIP;    // DCS APC PM SOS : ignorés jusqu'à ST
        else if (c >= 0x20 && c <= 0x2f) { this.inter += s[i - 1]; this.state = ESC_INT; }
        else { this.state = GROUND; this.esc(s[i - 1], ''); }
      } else if (this.state === ESC_INT) {
        if (c >= 0x20 && c <= 0x2f) this.inter += s[i - 1];
        else { this.state = GROUND; this.esc(s[i - 1], this.inter); }
      } else if (this.state === CSI) {
        if (c >= 0x40 && c <= 0x7e) { this.state = GROUND; this.csi(this.buf, s[i - 1]); }
        else if (this.buf.length < 256) this.buf += s[i - 1]; else this.buf = '\u0000';        // trop long : ignoré
      }
    }
  }

  private control(c: number) {
    switch (c) {
      case 7: this.h.bell?.(); break;
      case 8: this.setCx(Math.max(0, this.s.cx - 1)); break;
      case 9: this.tab(1); break;
      case 10: case 11: case 12: this.lineFeed(); break;
      case 13: this.setCx(0); break;
      case 14: this.gl = 1; break;
      case 15: this.gl = 0; break;
      default: break;
    }
  }
  private setCx(x: number) { this.s.cx = x; this.s.wrapNext = false; }

  // ---------- impression ----------
  private print(cp: number) {
    if (this.g[this.gl] === '0' && cp >= 0x5f && cp <= 0x7e) cp = DEC_GFX.charCodeAt(cp - 0x5f);
    const w = width(cp), ch = String.fromCodePoint(cp), s = this.s;
    if (w === 0) {                                                                            // combinant : s'ajoute à la cellule précédente
      let x = s.wrapNext ? s.cx : s.cx - 1; const ln = s.lines[s.cy];
      while (x > 0 && ln.ch[x] === '') x--;
      if (x >= 0 && ln.ch[x] !== ' ') { ln.ch[x] += ch; this.mark(s.cy); }
      return;
    }
    this.lastCh = ch;
    if (s.wrapNext) { if (this.autowrap) { s.lines[s.cy].wrap = true; s.cx = 0; this.index(); } s.wrapNext = false; }
    if (w === 2 && s.cx >= this.cols - 1) {
      if (!this.autowrap) return;
      const pad = s.lines[s.cy]; this.eraseCells(pad, s.cx, this.cols, this.blank()); pad.ch[this.cols - 1] = ''; pad.wrap = true; s.cx = 0; this.index();  // « » : case de bourrage, absente du texte
    }
    const ln = s.lines[s.cy], x = s.cx;
    if (this.insert) {
      ln.ch.splice(x, 0, ...new Array<string>(w).fill(' ')); ln.st.splice(x, 0, ...new Array<number>(w).fill(this.penId));
      ln.ch.length = this.cols; ln.st.length = this.cols;
    }
    this.eraseCells(ln, x, x + w, this.penId);                                                // casse proprement une paire large
    ln.ch[x] = ch; ln.st[x] = this.penId;
    if (w === 2) { ln.ch[x + 1] = ''; ln.st[x + 1] = this.penId; }
    this.mark(s.cy);
    s.cx += w; if (s.cx >= this.cols) { s.cx = this.cols - 1; s.wrapNext = this.autowrap; }
  }
  /** Efface [x0,x1) d'une ligne avec le style st, sans laisser de moitié de caractère large. */
  private eraseCells(ln: Line, x0: number, x1: number, st: number) {
    x1 = Math.min(x1, this.cols);
    if (x0 > 0 && ln.ch[x0] === '') { ln.ch[x0 - 1] = ' '; }
    if (x1 < this.cols && ln.ch[x1] === '') { ln.ch[x1] = ' '; }
    for (let x = x0; x < x1; x++) { ln.ch[x] = ' '; ln.st[x] = st; }
  }

  // ---------- défilement ----------
  private pushSb(l: Line) {
    this.sb.push(l); this.sbTotal++;
    if (this.sb.length > this.sbMax + 256) this.sb.splice(0, this.sb.length - this.sbMax);
  }
  scrollUp(n: number) {
    const s = this.s, { top, bottom } = s; n = Math.min(n, bottom - top + 1); const st = this.blank();
    for (let k = 0; k < n; k++) {
      const gone = s.lines.splice(top, 1)[0];
      if (top === 0 && !this.altOn) this.pushSb(gone);
      s.lines.splice(bottom, 0, mkLine(this.cols, st));
    }
    this.markRange(top, bottom);
  }
  scrollDown(n: number) {
    const s = this.s, { top, bottom } = s; n = Math.min(n, bottom - top + 1); const st = this.blank();
    for (let k = 0; k < n; k++) { s.lines.splice(bottom, 1); s.lines.splice(top, 0, mkLine(this.cols, st)); }
    this.markRange(top, bottom);
  }
  private index() { const s = this.s; if (s.cy === s.bottom) this.scrollUp(1); else if (s.cy < this.rows - 1) s.cy++; }
  private reverseIndex() { const s = this.s; if (s.cy === s.top) this.scrollDown(1); else if (s.cy > 0) s.cy--; }
  private lineFeed() {
    if (!this.altOn && this.h.line) this.h.line(this.logical(this.sb.length + this.s.cy));
    this.index(); this.s.wrapNext = false; if (this.lnm) this.s.cx = 0;
  }
  private tab(n: number) { const s = this.s; let x = s.cx; while (n-- > 0) { x++; while (x < this.cols - 1 && !this.tabs[x]) x++; } this.setCx(Math.min(x, this.cols - 1)); }
  private backTab(n: number) { const s = this.s; let x = s.cx; while (n-- > 0) { x--; while (x > 0 && !this.tabs[x]) x--; } this.setCx(Math.max(0, x)); }

  // ---------- curseur ----------
  private moveTo(row: number, col: number) {            // 0-based ; row relatif aux marges si DECOM
    const s = this.s;
    if (this.origin) s.cy = Math.min(s.bottom, Math.max(s.top, row + s.top)); else s.cy = Math.min(this.rows - 1, Math.max(0, row));
    this.setCx(Math.min(this.cols - 1, Math.max(0, col)));
  }
  private save() { const s = this.s; s.saved = { cx: s.cx, cy: s.cy, wrapNext: s.wrapNext, pen: { ...this.pen }, origin: this.origin, g: [...this.g], gl: this.gl }; }
  private restore() {
    const s = this.s, v = s.saved;
    if (!v) { s.cx = 0; s.cy = 0; s.wrapNext = false; this.origin = false; this.pen = { fg: -1, bg: -1, at: 0, link: 0 }; this.penUpdate(); return; }
    s.cx = Math.min(v.cx, this.cols - 1); s.cy = Math.min(v.cy, this.rows - 1); s.wrapNext = v.wrapNext;
    this.pen = { ...v.pen }; this.penUpdate(); this.origin = v.origin; this.g = [...v.g]; this.gl = v.gl;
  }

  // ---------- séquences ESC ----------
  private esc(c: string, inter: string) {
    if (inter === '') {
      switch (c) {
        case '7': this.save(); break;
        case '8': this.restore(); break;
        case 'D': this.index(); this.s.wrapNext = false; break;
        case 'E': this.index(); this.setCx(0); break;
        case 'H': this.tabs[this.s.cx] = true; break;
        case 'M': this.reverseIndex(); this.s.wrapNext = false; break;
        case 'c': this.reset(); break;
        case '=': this.appKeypad = true; break;
        case '>': this.appKeypad = false; break;
        default: break;
      }
    } else if (inter === '(' || inter === ')') this.g[inter === '(' ? 0 : 1] = c === '0' ? '0' : 'B';
    else if (inter === '#' && c === '8') {                                                    // DECALN
      for (let y = 0; y < this.rows; y++) { const l = this.s.lines[y]; l.ch.fill('E'); l.st.fill(0); l.wrap = false; }
      this.markAll();
    }
  }

  /** RIS : remet tout à zéro (historique et titre compris). */
  reset() {
    this.altOn = false; this.main = this.mkScreen(); this.alt = this.mkScreen(); this.s = this.main;
    this.sb = []; this.epoch++; this.pen = { fg: -1, bg: -1, at: 0, link: 0 }; this.penUpdate();
    this.g = ['B', 'B']; this.gl = 0; this.appCursor = false; this.appKeypad = false; this.autowrap = true; this.origin = false; this.insert = false; this.lnm = false;
    this.cursorVisible = true; this.cursorShape = 'block'; this.bracketed = false; this.focusEvents = false; this.mouse = 0; this.mouseSgr = false;
    this.resetTabs(); this.markAll();
  }
  /** ⌘K : efface écran et historique, curseur en haut à gauche. */
  clearAll() {
    this.sb = []; this.epoch++; const s = this.s; s.lines = Array.from({ length: this.rows }, () => mkLine(this.cols));
    s.cx = 0; s.cy = 0; s.wrapNext = false; this.markAll(); this.h.change?.();
  }

  // ---------- séquences CSI ----------
  private csi(buf: string, f: string) {
    const m = /^([<=>?]?)([0-9;:]*)([ -/]*)$/.exec(buf); if (!m) return;
    const pre = m[1], pstr = m[2], inter = m[3], ps = pstr === '' ? [] : pstr.split(';');
    const n = (i: number, d = 1) => { const v = parseInt(ps[i] ?? '', 10); return Number.isNaN(v) || v === 0 ? d : Math.min(v, 65535); };
    const r = (i: number) => { const v = parseInt(ps[i] ?? '', 10); return Number.isNaN(v) ? 0 : v; };
    const s = this.s, cols = this.cols, rows = this.rows;
    if (pre === '' && inter === '') {
      switch (f) {
        case '@': this.ich(n(0)); break;
        case 'A': { const lim = s.cy >= s.top ? s.top : 0; s.cy = Math.max(lim, s.cy - n(0)); s.wrapNext = false; break; }
        case 'B': case 'e': { const lim = s.cy <= s.bottom ? s.bottom : rows - 1; s.cy = Math.min(lim, s.cy + n(0)); s.wrapNext = false; break; }
        case 'C': case 'a': this.setCx(Math.min(cols - 1, s.cx + n(0))); break;
        case 'D': this.setCx(Math.max(0, s.cx - n(0))); break;
        case 'E': s.cy = Math.min(rows - 1, s.cy + n(0)); this.setCx(0); break;
        case 'F': s.cy = Math.max(0, s.cy - n(0)); this.setCx(0); break;
        case 'G': case '`': this.setCx(Math.min(cols - 1, n(0) - 1)); break;
        case 'H': case 'f': this.moveTo(n(0) - 1, n(1) - 1); break;
        case 'I': this.tab(n(0)); break;
        case 'J': this.ed(r(0)); break;
        case 'K': this.el(r(0)); break;
        case 'L': this.il(n(0)); break;
        case 'M': this.dl(n(0)); break;
        case 'P': this.dch(n(0)); break;
        case 'S': this.scrollUp(n(0)); break;
        case 'T': this.scrollDown(n(0)); break;
        case 'X': { const ln = s.lines[s.cy]; this.eraseCells(ln, s.cx, Math.min(cols, s.cx + n(0)), this.blank()); this.mark(s.cy); break; }
        case 'Z': this.backTab(n(0)); break;
        case 'b': { const c = this.lastCh; if (c) for (let k = Math.min(n(0), 4096); k > 0; k--) this.print(c.codePointAt(0) as number); break; }
        case 'c': this.reply('\x1b[?62;22c'); break;
        case 'd': this.moveTo(n(0) - 1, s.cx); break;
        case 'g': if (r(0) === 3) this.tabs.fill(false); else if (r(0) === 0) this.tabs[s.cx] = false; break;
        case 'h': case 'l': for (const p of ps) { if (p === '4') this.insert = f === 'h'; else if (p === '20') this.lnm = f === 'h'; } break;
        case 'm': this.sgr(pstr); break;
        case 'n': {
          const v = r(0);
          if (v === 5) this.reply('\x1b[0n');
          else if (v === 6) this.reply(`\x1b[${s.cy - (this.origin ? s.top : 0) + 1};${s.cx + 1}R`);
          break;
        }
        case 'r': {
          const t = n(0) - 1, b = ps[1] === undefined || r(1) === 0 ? rows - 1 : r(1) - 1;
          if (t < b && b < rows) { s.top = t; s.bottom = b; this.moveTo(0, 0); }
          break;
        }
        case 's': this.save(); break;
        case 'u': this.restore(); break;
        case 't': if (r(0) === 18) this.reply(`\x1b[8;${rows};${cols}t`); break;
        default: break;
      }
    } else if (pre === '' && inter === ' ' && f === 'q') {                                    // DECSCUSR
      const v = r(0); this.cursorBlink = v === 0 || v % 2 === 1; this.cursorShape = v <= 2 ? 'block' : v <= 4 ? 'underline' : 'bar'; this.mark(s.cy);
    } else if (pre === '' && inter === '!' && f === 'p') {                                    // DECSTR
      this.pen = { fg: -1, bg: -1, at: 0, link: 0 }; this.penUpdate(); this.origin = false; this.insert = false; this.autowrap = true;
      this.appCursor = false; this.appKeypad = false; this.cursorVisible = true; s.top = 0; s.bottom = rows - 1; this.g = ['B', 'B']; this.gl = 0;
    } else if (pre === '?' && (f === 'h' || f === 'l')) { for (const p of ps) this.mode(parseInt(p, 10), f === 'h'); }
    else if (pre === '?' && inter === '$' && f === 'p') {                                     // DECRQM
      const v = r(0), on = this.modeOf(v);
      this.reply(`\x1b[?${v};${on === null ? 0 : on ? 1 : 2}$y`);
    } else if (pre === '?' && f === 'n') { if (r(0) === 6) this.reply(`\x1b[?${s.cy - (this.origin ? s.top : 0) + 1};${s.cx + 1}R`); else if (r(0) === 15) this.reply('\x1b[?10n'); }
    else if (pre === '>' && f === 'c') this.reply('\x1b[>0;276;0c');
    else if (pre === '>' && f === 'q') this.reply('\x1bP>|Studio\x1b\\');
  }
  private reply(s: string) { this.h.respond?.(s); }

  private modeOf(n: number): boolean | null {
    switch (n) {
      case 1: return this.appCursor; case 6: return this.origin; case 7: return this.autowrap; case 25: return this.cursorVisible;
      case 47: case 1047: case 1049: return this.altOn; case 1000: case 1002: case 1003: return this.mouse === n;
      case 1004: return this.focusEvents; case 1006: return this.mouseSgr; case 2004: return this.bracketed; case 12: return this.cursorBlink;
      default: return null;
    }
  }
  private mode(n: number, on: boolean) {
    const s = this.s;
    switch (n) {
      case 1: this.appCursor = on; break;
      case 6: this.origin = on; this.moveTo(0, 0); break;
      case 7: this.autowrap = on; if (!on) s.wrapNext = false; break;
      case 12: this.cursorBlink = on; break;
      case 25: this.cursorVisible = on; this.mark(s.cy); break;
      case 47: case 1047: case 1049: this.altScreen(on, n); break;
      case 1000: case 1002: case 1003: this.mouse = on ? n : this.mouse === n ? 0 : this.mouse; break;
      case 1004: this.focusEvents = on; break;
      case 1006: this.mouseSgr = on; break;
      case 2004: this.bracketed = on; break;
      default: break;                                                                         // 3 (DECCOLM), 5, 2026… : sans effet
    }
  }
  private altScreen(on: boolean, n: number) {
    if (on === this.altOn) return;
    if (on) {
      if (n === 1049) this.save();
      const from = this.s; this.altOn = true; this.s = this.alt;
      this.s.lines = Array.from({ length: this.rows }, () => mkLine(this.cols)); this.s.top = 0; this.s.bottom = this.rows - 1;
      this.s.cx = from.cx; this.s.cy = from.cy; this.s.wrapNext = false;
    } else {
      if (n === 1047) this.alt.lines = Array.from({ length: this.rows }, () => mkLine(this.cols));
      this.altOn = false; this.s = this.main; if (n === 1049) this.restore();
    }
    this.epoch++; this.markAll();
  }

  private sgr(pstr: string) {
    const gs = pstr === '' ? ['0'] : pstr.split(';'), p = this.pen;
    const col = (v: number) => (v < 0 || v > 255 ? null : v);
    const rgb = (r: number, g: number, b: number) => 0x1000000 | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      if (g.includes(':')) {                                                                  // sous-paramètres : 38:2::r:g:b, 38:5:n, 4:3…
        const sub = g.split(':').map(x => (x === '' ? 0 : parseInt(x, 10) || 0)), k = sub[0];
        if (k === 4) { if (sub[1] === 0) p.at &= ~UNDER; else p.at |= UNDER; }
        else if (k === 38 || k === 48) {
          let c: number | null = null;
          if (sub[1] === 5) { const v = col(sub[2]); c = v; } else if (sub[1] === 2) { const a = sub.length >= 6 ? 3 : 2; c = rgb(sub[a], sub[a + 1], sub[a + 2]); }
          if (c !== null) { if (k === 38) p.fg = c; else p.bg = c; }
        }
        continue;
      }
      const v = g === '' ? 0 : parseInt(g, 10);
      if (v === 38 || v === 48) {
        const mode = parseInt(gs[i + 1] ?? '', 10); let c: number | null = null;
        if (mode === 5) { c = col(parseInt(gs[i + 2] ?? '', 10)); i += 2; }
        else if (mode === 2) { c = rgb(parseInt(gs[i + 2] ?? '0', 10) || 0, parseInt(gs[i + 3] ?? '0', 10) || 0, parseInt(gs[i + 4] ?? '0', 10) || 0); i += 4; }
        else i += 1;
        if (c !== null) { if (v === 38) p.fg = c; else p.bg = c; }
        continue;
      }
      if (v === 58) { const mode = parseInt(gs[i + 1] ?? '', 10); i += mode === 5 ? 2 : mode === 2 ? 4 : 1; continue; }
      if (v === 0) { p.fg = -1; p.bg = -1; p.at = 0; }
      else if (v === 1) p.at |= BOLD; else if (v === 2) p.at |= DIM; else if (v === 3) p.at |= ITALIC; else if (v === 4) p.at |= UNDER;
      else if (v === 5 || v === 6) p.at |= BLINK; else if (v === 7) p.at |= INVERSE; else if (v === 8) p.at |= INVIS; else if (v === 9) p.at |= STRIKE;
      else if (v === 21) p.at |= UNDER; else if (v === 22) p.at &= ~(BOLD | DIM); else if (v === 23) p.at &= ~ITALIC; else if (v === 24) p.at &= ~UNDER;
      else if (v === 25) p.at &= ~BLINK; else if (v === 27) p.at &= ~INVERSE; else if (v === 28) p.at &= ~INVIS; else if (v === 29) p.at &= ~STRIKE;
      else if (v >= 30 && v <= 37) p.fg = v - 30; else if (v === 39) p.fg = -1;
      else if (v >= 40 && v <= 47) p.bg = v - 40; else if (v === 49) p.bg = -1;
      else if (v >= 90 && v <= 97) p.fg = v - 90 + 8; else if (v >= 100 && v <= 107) p.bg = v - 100 + 8;
    }
    this.penUpdate();
  }

  // ---------- édition ----------
  private ed(mode: number) {
    const s = this.s, st = this.blank();
    if (mode === 0) { this.el(0); for (let y = s.cy + 1; y < this.rows; y++) { s.lines[y] = mkLine(this.cols, st); this.mark(y); } }
    else if (mode === 1) { for (let y = 0; y < s.cy; y++) { s.lines[y] = mkLine(this.cols, st); this.mark(y); } this.el(1); }
    else if (mode === 2) { for (let y = 0; y < this.rows; y++) s.lines[y] = mkLine(this.cols, st); this.markAll(); }
    else if (mode === 3) { this.sb = []; this.epoch++; }
  }
  private el(mode: number) {
    const s = this.s, ln = s.lines[s.cy], st = this.blank();
    if (mode === 0) { this.eraseCells(ln, s.cx, this.cols, st); ln.wrap = false; }
    else if (mode === 1) this.eraseCells(ln, 0, s.cx + 1, st);
    else if (mode === 2) { this.eraseCells(ln, 0, this.cols, st); ln.wrap = false; }
    this.mark(s.cy);
  }
  private ich(k: number) {
    const s = this.s, ln = s.lines[s.cy]; k = Math.min(k, this.cols - s.cx); const st = this.blank();
    ln.ch.splice(s.cx, 0, ...new Array<string>(k).fill(' ')); ln.st.splice(s.cx, 0, ...new Array<number>(k).fill(st));
    ln.ch.length = this.cols; ln.st.length = this.cols; if (ln.ch[s.cx + k] === '') ln.ch[s.cx + k] = ' '; if (ln.ch[s.cx] === '') ln.ch[s.cx] = ' ';
    s.wrapNext = false; this.mark(s.cy);
  }
  private dch(k: number) {
    const s = this.s, ln = s.lines[s.cy]; k = Math.min(k, this.cols - s.cx); const st = this.blank();
    if (ln.ch[s.cx] === '' && s.cx > 0) ln.ch[s.cx - 1] = ' ';
    ln.ch.splice(s.cx, k); ln.st.splice(s.cx, k); for (let i = 0; i < k; i++) { ln.ch.push(' '); ln.st.push(st); }
    if (ln.ch[s.cx] === '') ln.ch[s.cx] = ' ';
    s.wrapNext = false; this.mark(s.cy);
  }
  private il(k: number) {
    const s = this.s; if (s.cy < s.top || s.cy > s.bottom) return;
    k = Math.min(k, s.bottom - s.cy + 1); const st = this.blank();
    s.lines.splice(s.bottom - k + 1, k); for (let i = 0; i < k; i++) s.lines.splice(s.cy, 0, mkLine(this.cols, st));
    this.setCx(0); this.markRange(s.cy, s.bottom);
  }
  private dl(k: number) {
    const s = this.s; if (s.cy < s.top || s.cy > s.bottom) return;
    k = Math.min(k, s.bottom - s.cy + 1); const st = this.blank();
    s.lines.splice(s.cy, k); for (let i = 0; i < k; i++) s.lines.splice(s.bottom - k + 1, 0, mkLine(this.cols, st));
    this.setCx(0); this.markRange(s.cy, s.bottom);
  }

  // ---------- OSC ----------
  private osc(str: string) {
    const i = str.indexOf(';'), cmd = i < 0 ? str : str.slice(0, i), arg = i < 0 ? '' : str.slice(i + 1);
    switch (cmd) {
      case '0': case '2': this.title = arg; this.h.title?.(arg); break;
      case '7': {
        const m = /^file:\/\/[^/]*(\/.*)$/.exec(arg); if (!m) break;
        let p = m[1]; try { p = decodeURIComponent(p); } catch { /* chemin laissé tel quel */ }
        this.cwd = p; this.h.cwd?.(p); break;
      }
      case '8': { const j = arg.indexOf(';'); const url = j < 0 ? '' : arg.slice(j + 1); this.pen.link = this.linkId(url); this.penUpdate(); break; }
      case '133': {
        const k = arg[0];
        if (k === 'A') this.h.mark?.({ kind: 'prompt' });
        else if (k === 'C') this.h.mark?.({ kind: 'start', cmd: b64(arg.slice(2)) });
        else if (k === 'D') { const code = parseInt(arg.slice(2), 10); this.h.mark?.({ kind: 'end', code: Number.isNaN(code) ? 0 : code }); }
        break;
      }
      default: break;                                                                         // 52 (presse-papiers) et le reste : ignorés
    }
  }

  // ---------- redimensionnement ----------
  resize(cols: number, rows: number) {
    cols = Math.max(2, cols | 0); rows = Math.max(1, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    const oldCols = this.cols; this.cols = cols; this.rows = rows;
    this.reflow(oldCols);
    const a = this.alt; a.lines = a.lines.slice(0, rows);
    while (a.lines.length < rows) a.lines.push(mkLine(cols));
    for (const l of a.lines) { if (l.ch.length > cols) { l.ch.length = cols; l.st.length = cols; } while (l.ch.length < cols) { l.ch.push(' '); l.st.push(0); } }
    for (const sc of [this.main, this.alt]) {
      sc.top = 0; sc.bottom = rows - 1; sc.cx = Math.min(sc.cx, cols - 1); sc.cy = Math.min(sc.cy, rows - 1); sc.wrapNext = false;
      if (sc.saved) { sc.saved.cx = Math.min(sc.saved.cx, cols - 1); sc.saved.cy = Math.min(sc.saved.cy, rows - 1); }
    }
    const old = this.tabs; this.tabs = Array.from({ length: cols }, (_, i) => (i < old.length ? old[i] : i % 8 === 0));
    this.dirty = new Uint8Array(rows).fill(1); this.dirtyAny = true; this.epoch++;
  }
  /** Réenroule historique + écran principal à la nouvelle largeur, curseur suivi ; sans perte de texte. */
  private reflow(oldCols: number) {
    const m = this.main, cols = this.cols, rows = this.rows, sbn = this.sb.length, base = this.sbTotal - sbn;
    let lines = this.sb.concat(m.lines); const curV = sbn + m.cy;
    let last = lines.length - 1; while (last > curV && isBlank(lines[last])) last--;
    lines = lines.slice(0, last + 1);
    let out: Line[] = lines, ncv = curV, ncx = m.cx;
    if (cols !== oldCols) {
      out = []; let i = 0;
      while (i < lines.length) {
        let j = i; while (j < lines.length - 1 && lines[j].wrap) j++;
        const chs: string[] = [], sts: number[] = []; let curOff = -1;
        for (let k = i; k <= j; k++) {
          const ln = lines[k]; let len = ln.ch.length;
          if (k === j) while (len > 0 && ln.ch[len - 1] === ' ' && ln.st[len - 1] === 0) len--;
          if (k === curV) { curOff = chs.length + m.cx; len = Math.max(len, m.cx + 1); }
          for (let x = 0; x < len; x++) { chs.push(ln.ch[x]); sts.push(ln.st[x]); }
        }
        let row = mkLine(cols), x = 0, p = 0;
        while (p < chs.length) {
          if (chs[p] === '') { if (p === curOff) { ncv = out.length; ncx = Math.max(0, x - 1); } p++; continue; }
          const w = chs[p + 1] === '' ? 2 : 1;
          if (x + w > cols) { row.wrap = true; if (w === 2 && x === cols - 1) row.ch[x] = ''; out.push(row); row = mkLine(cols); x = 0; }
          if (p === curOff) { ncv = out.length; ncx = x; }
          row.ch[x] = chs[p]; row.st[x] = sts[p];
          if (w === 2) { row.ch[x + 1] = ''; row.st[x + 1] = sts[p + 1]; }
          x += w; p += w;
        }
        out.push(row); i = j + 1;
      }
    }
    let start = Math.max(0, out.length - rows); if (start > ncv) start = ncv;
    const screen = out.slice(start, start + rows); while (screen.length < rows) screen.push(mkLine(cols));
    let sb = out.slice(0, start); if (sb.length > this.sbMax) sb = sb.slice(sb.length - this.sbMax);
    this.sb = sb; this.sbTotal = base + sb.length;
    m.lines = screen; m.cy = Math.min(rows - 1, Math.max(0, ncv - start)); m.cx = Math.min(ncx, cols - 1); m.wrapNext = false;
  }

  // ---------- texte ----------
  /** Ligne logique (lignes enroulées recollées) contenant la ligne virtuelle v. */
  logical(v: number): string {
    let a = v; while (a > 0 && this.vline(a - 1).wrap) a--;
    let b = v; while (b < this.total - 1 && this.vline(b).wrap) b++;
    return this.rangeText(a, 0, b, this.cols);
  }
  /** Texte brut de (v0,c0) à (v1,c1) exclu ; blancs de fin retirés, lignes enroulées recollées. */
  rangeText(v0: number, c0: number, v1: number, c1: number): string {
    let out = '';
    for (let v = v0; v <= v1; v++) {
      const ln = this.vline(v), a = v === v0 ? c0 : 0, e = v === v1 ? c1 : this.cols;
      out += rowText(ln, a, e, !(ln.wrap && e >= this.cols));
      if (v < v1 && !ln.wrap) out += '\n';
    }
    return out;
  }
  /** Les n dernières lignes logiques non vides en fin d'écran, texte brut. */
  tail(n: number): string {
    let end = this.total - 1; while (end >= 0 && isBlank(this.vline(end))) end--;
    if (end < 0) return '';
    const parts: string[] = []; let v = end;
    while (v >= 0 && parts.length < n) {
      let a = v; while (a > 0 && this.vline(a - 1).wrap) a--;
      parts.unshift(this.rangeText(a, 0, v, this.cols)); v = a - 1;
    }
    return parts.join('\n');
  }
  /** Bornes (lignes virtuelles) de la ligne logique de v. */
  logicalRange(v: number): [number, number] {
    let a = v; while (a > 0 && this.vline(a - 1).wrap) a--;
    let b = v; while (b < this.total - 1 && this.vline(b).wrap) b++;
    return [a, b];
  }

  // ---------- vers le pty ----------
  /** Collage : retours à la ligne en CR, encadré par 200~/201~ si le programme l'a demandé. */
  paste(text: string): string {
    const t = text.replace(/\r\n|\n/g, '\r');
    return this.bracketed ? '\x1b[200~' + t.replace(/\x1b\[20[01]~/g, '') + '\x1b[201~' : t;
  }
  focusReport(on: boolean): string { return this.focusEvents ? (on ? '\x1b[I' : '\x1b[O') : ''; }
  /** Événement souris (cellules en base 0) → séquence, ou null si le programme n'écoute pas ce type d'événement. */
  mouseReport(e: { type: 'down' | 'up' | 'move' | 'wheel'; button: number; x: number; y: number; shift?: boolean; alt?: boolean; ctrl?: boolean }): string | null {
    if (!this.mouse) return null;
    let b: number;
    if (e.type === 'wheel') b = e.button < 0 ? 64 : 65;
    else if (e.type === 'move') { if (this.mouse === 1000 || (this.mouse === 1002 && e.button < 0)) return null; b = (e.button < 0 ? 3 : e.button) + 32; }
    else if (e.type === 'up') b = this.mouseSgr ? e.button : 3;
    else b = e.button;
    b += (e.shift ? 4 : 0) + (e.alt ? 8 : 0) + (e.ctrl ? 16 : 0);
    if (this.mouseSgr) return `\x1b[<${b};${e.x + 1};${e.y + 1}${e.type === 'up' ? 'm' : 'M'}`;
    if (e.x > 222 || e.y > 222) return null;
    return '\x1b[M' + String.fromCharCode(32 + b, 33 + e.x, 33 + e.y);
  }
}

const b64 = (s: string) => { try { const bin = atob(s); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); } catch { return ''; } };

// ---------- touches ----------
export interface KeyIn { key: string; code?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }
const FKEYS: Record<string, number> = { F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const PAD: Record<string, string> = { Numpad0: 'p', Numpad1: 'q', Numpad2: 'r', Numpad3: 's', Numpad4: 't', Numpad5: 'u', Numpad6: 'v', Numpad7: 'w', Numpad8: 'x', Numpad9: 'y',
  NumpadEnter: 'M', NumpadAdd: 'l', NumpadSubtract: 'm', NumpadMultiply: 'j', NumpadDivide: 'o', NumpadDecimal: 'n' };
/**
 * Touche (KeyboardEvent simplifié) → octets pour le pty, ou null quand le caractère doit passer par la saisie (texte
 * imprimable sans Ctrl/Alt, IME) ou que la touche n'est pas pour le terminal (⌘ : jamais consommée).
 * Alt/Option préfixe ESC ; Backspace = DEL ; Entrée = CR ; Shift-Tab = CSI Z.
 */
export function encodeKey(e: KeyIn, modes: { appCursor?: boolean; appKeypad?: boolean } = {}): string | null {
  if (e.meta) return null;
  const mod = 1 + (e.shift ? 1 : 0) + (e.alt ? 2 : 0) + (e.ctrl ? 4 : 0), k = e.key, plain = mod === 1;
  const cursor = (f: string) => (plain ? (modes.appCursor ? '\x1bO' + f : '\x1b[' + f) : `\x1b[1;${mod}${f}`);
  const tilde = (n: number) => (plain ? `\x1b[${n}~` : `\x1b[${n};${mod}~`);
  switch (k) {
    case 'ArrowUp': return cursor('A');
    case 'ArrowDown': return cursor('B');
    case 'ArrowRight': return cursor('C');
    case 'ArrowLeft': return cursor('D');
    case 'Home': return cursor('H');
    case 'End': return cursor('F');
    case 'PageUp': return tilde(5);
    case 'PageDown': return tilde(6);
    case 'Insert': return tilde(2);
    case 'Delete': return tilde(3);
    case 'F1': case 'F2': case 'F3': case 'F4': { const f = 'PQRS'[+k[1] - 1]; return plain ? '\x1bO' + f : `\x1b[1;${mod}${f}`; }
    case 'Enter': if (modes.appKeypad && e.code === 'NumpadEnter' && plain) return '\x1bOM'; return e.alt ? '\x1b\r' : e.ctrl ? '\n' : '\r';
    case 'Tab': return e.shift ? '\x1b[Z' : e.alt ? '\x1b\t' : e.ctrl ? null : '\t';
    case 'Backspace': return e.ctrl ? (e.alt ? '\x1b\x08' : '\x08') : e.alt ? '\x1b\x7f' : '\x7f';
    case 'Escape': return e.alt ? '\x1b\x1b' : '\x1b';
    default: break;
  }
  if (FKEYS[k]) return tilde(FKEYS[k]);
  if (modes.appKeypad && plain && e.code && PAD[e.code]) return '\x1bO' + PAD[e.code];
  if ([...k].length !== 1) return null;                                                       // Shift, Dead, Process, F13…
  if (e.alt && !e.ctrl) return null;                                                           // Option seule compose ({ [ | @ ~ en AZERTY) : le texte passe par l'input, comme Terminal.app
  let c = k;
  if (e.alt && e.code && !e.shift) {                                                          // Ctrl+Option : la lettre physique, pas le caractère composé
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code); if (m) c = (m[1] ?? m[2]).toLowerCase();
  }
  if (e.ctrl) {
    const lo = c.toLowerCase(), cp = lo.charCodeAt(0); let code = -1;
    if (cp >= 97 && cp <= 122) code = cp - 96;
    else if (c === '@' || c === ' ' || c === '2') code = 0;
    else if (c === '[' || c === '3') code = 27; else if (c === '\\' || c === '4') code = 28; else if (c === ']' || c === '5') code = 29;
    else if (c === '^' || c === '6') code = 30; else if (c === '_' || c === '/' || c === '7') code = 31; else if (c === '?' || c === '8') code = 127;
    if (code < 0) return null;
    return (e.alt ? '\x1b' : '') + String.fromCharCode(code);
  }
  return null;
}
