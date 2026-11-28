// Widget de terminal (contrat C) : affiche un `Terminal` (lib/vt.ts) et lui envoie le clavier, le collage et la souris.
//
// Rendu : une `div` par ligne visible, un `span` par série de cellules de même style (couleurs via les variables --tm-*
// de css/termview.css), repeint en requestAnimationFrame et seulement quand le HTML d'une ligne change. Le curseur est une
// cellule habillée (bloc, barre, souligné), son clignotement est du CSS (au focus seulement, coupé si mouvement réduit).
// Saisie : un textarea caché (focusable, IME, collage) ; `encodeKey` traduit les touches spéciales, le texte imprimable
// passe par l'événement input. ⌘ n'est jamais consommé sauf ⌘C avec sélection, ⌘V, ⌘A et ⌘K (effacer) : le reste remonte.
// Molette : historique ; en écran alternatif sans souris, flèches ; avec le mode souris du programme, événements souris.
// Sélection à la souris (glisser, double-clic mot, triple-clic ligne logique), ancrée en numéros de ligne absolus.
// Liens : OSC 8 et adresses http(s) du texte, ⌘-clic → onLink.
// L'élément racine `el` est créé une fois et peut être déplacé dans le DOM ; il porte data-no-i18n (l'i18n traduit à la volée).
import { Terminal, BOLD, DIM, ITALIC, UNDER, INVERSE, INVIS, STRIKE, encodeKey } from '../lib/vt.ts';
import type { Mark } from '../lib/vt.ts';

export interface TermViewOptions {
  onData(data: string): void;
  onResize(cols: number, rows: number): void;
  onTitle?(title: string): void;
  onCwd?(path: string): void;
  onMark?(m: Mark): void;
  onLine?(text: string): void;
  onLink?(url: string): void;
  onBell?(): void;
}

interface Pos { l: number; c: number }                       // l = ligne absolue (Terminal.base + v), c = colonne
const URL_RE = /https?:\/\/[^\s<>"'` ]+/g;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const hex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
/** Couleur CSS d'une couleur de cellule (0-15 : variables du thème ; 16-255 : cube et gris xterm ; truecolor). */
function css(c: number, dflt: string): string {
  if (c < 0) return dflt;
  if (c >= 0x1000000) return hex(c);
  if (c < 16) return `var(--tm-${c})`;
  if (c >= 232) { const v = 8 + (c - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = c - 16, lv = (k: number) => (k ? 55 + k * 40 : 0);
  return `rgb(${lv(Math.floor(i / 36))},${lv(Math.floor(i / 6) % 6)},${lv(i % 6)})`;
}
const isWordCh = (ch: string) => ch !== ' ' && ch !== '' && !/["'()[\]{}<>,;|]/.test(ch);

export class TermView {
  readonly el: HTMLElement;
  private t: Terminal;
  private o: TermViewOptions;
  private rowsEl: HTMLElement; private ta: HTMLTextAreaElement; private bar: HTMLElement; private probe: HTMLElement;
  private rowEls: HTMLElement[] = []; private cache: string[] = [];
  private cw = 8; private ch = 18;
  private off = 0;                                           // lignes d'historique remontées (0 = en bas)
  private sel: { a: Pos; b: Pos } | null = null; private drag: 'char' | 'word' | 'line' | null = null; private selDirty = false;
  private styleCss: string[] = [];
  private raf = 0; private full = true; private ro: ResizeObserver | null = null;
  private lastCur = ''; private lastEpoch = -1; private lastSb = 0;
  private composing = false; private wheelAcc = 0; private pressed = -1; private meta = false;
  private fitRaf = 0; private disposed = false; private lastFocus = false;

  constructor(host: HTMLElement, opts: TermViewOptions) {
    this.o = opts;
    this.t = new Terminal(80, 24, {
      respond: d => opts.onData(d), title: x => opts.onTitle?.(x), cwd: x => opts.onCwd?.(x), mark: m => opts.onMark?.(m),
      line: x => opts.onLine?.(x), bell: () => opts.onBell?.(), change: () => this.schedule(),
    });
    const el = this.el = document.createElement('div');
    el.className = 'tv tv-cur-block'; el.setAttribute('data-no-i18n', ''); el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Terminal');
    el.innerHTML = '<div class="tv-rows" aria-hidden="true"></div><div class="tv-bar" aria-hidden="true"></div><div class="tv-probe" aria-hidden="true"></div>'
      + '<textarea class="tv-in" aria-label="Saisie du terminal" autocomplete="off" autocapitalize="off" spellcheck="false" rows="1"></textarea>';
    this.rowsEl = el.querySelector('.tv-rows') as HTMLElement; this.bar = el.querySelector('.tv-bar') as HTMLElement;
    this.probe = el.querySelector('.tv-probe') as HTMLElement; this.ta = el.querySelector('.tv-in') as HTMLTextAreaElement;
    this.probe.textContent = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    {
      const ta = this.ta;
      ta.addEventListener('keydown', e => this.keydown(e));
      ta.addEventListener('keyup', e => this.setMeta(e.metaKey));
      ta.addEventListener('input', () => { if (this.composing) return; this.flushInput(); });
      ta.addEventListener('compositionstart', () => { this.composing = true; this.placeInput(); });
      ta.addEventListener('compositionend', () => { this.composing = false; this.flushInput(); });
      ta.addEventListener('paste', e => { e.preventDefault(); const x = e.clipboardData?.getData('text/plain') ?? ''; if (x) this.send(this.t.paste(x)); });
      ta.addEventListener('focus', () => this.focusChanged(true));
      ta.addEventListener('blur', () => this.focusChanged(false));
    }
    el.addEventListener('mousedown', e => this.mousedown(e));
    el.addEventListener('mousemove', e => this.mousemove(e));
    el.addEventListener('wheel', e => this.wheel(e), { passive: false });
    el.addEventListener('contextmenu', () => { this.ta.focus({ preventScroll: true }); });
    host.appendChild(el);
    this.buildRows(); this.measure();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => { if (this.fitRaf) return; this.fitRaf = requestAnimationFrame(() => { this.fitRaf = 0; if (!this.disposed) this.fit(); }); });
      this.ro.observe(el);
    }
    document.fonts?.ready.then(() => { if (!this.disposed) this.fit(); }, () => undefined);
  }

  get cols() { return this.t.cols; }
  get rows() { return this.t.rows; }

  write(data: Uint8Array | string) {
    const before = this.t.sbTotal;
    this.t.write(data);
    if (this.off > 0) { this.off = Math.min(this.t.sb.length, this.off + (this.t.sbTotal - before)); }
    if (this.sel && this.t.sb.length === 0 && this.t.base > this.sel.a.l) this.sel = null;
  }
  focus() { this.ta.focus({ preventScroll: true }); }
  hasFocus() { return document.activeElement === this.ta; }
  selection(): string {
    const r = this.selRange(); if (!r) return '';
    const base = this.t.base; return this.t.rangeText(r[0].l - base, r[0].c, r[1].l - base, r[1].c);
  }
  tail(lines: number) { return this.t.tail(lines); }
  clear() { this.sel = null; this.off = 0; this.t.clearAll(); this.full = true; this.schedule(); }
  dispose() {
    this.disposed = true; this.ro?.disconnect(); if (this.raf) cancelAnimationFrame(this.raf); if (this.fitRaf) cancelAnimationFrame(this.fitRaf);
    this.stopDrag(); this.el.remove();
  }

  /** Recalcule colonnes et lignes d'après la taille de `el` ; appelle onResize si elles changent. */
  fit(): { cols: number; rows: number } {
    this.measure();
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (w > 0 && h > 0) {
      const cs = getComputedStyle(this.el), px = (v: string) => parseFloat(v) || 0;
      const iw = w - px(cs.paddingLeft) - px(cs.paddingRight), ih = h - px(cs.paddingTop) - px(cs.paddingBottom);
      const cols = Math.max(2, Math.floor(iw / this.cw)), rows = Math.max(1, Math.floor(ih / this.ch));
      if (cols !== this.t.cols || rows !== this.t.rows) {
        this.t.resize(cols, rows); this.sel = null; this.off = Math.min(this.off, this.t.sb.length);
        this.buildRows(); this.full = true; this.schedule(); this.o.onResize(cols, rows);
      }
    }
    return { cols: this.t.cols, rows: this.t.rows };
  }

  // ---------- mesure et construction ----------
  private measure() {
    const r = this.probe.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const cw = r.width / this.probe.textContent!.length, ch = r.height;
      if (Math.abs(cw - this.cw) > 0.001 || Math.abs(ch - this.ch) > 0.001) { this.cw = cw; this.ch = ch; this.el.style.setProperty('--tv-cw', cw + 'px'); this.full = true; }
    }
  }
  private buildRows() {
    this.rowsEl.textContent = ''; this.rowEls = []; this.cache = [];
    for (let y = 0; y < this.t.rows; y++) { const d = document.createElement('div'); d.className = 'tv-r'; this.rowsEl.appendChild(d); this.rowEls.push(d); this.cache.push(''); }
  }

  // ---------- rendu ----------
  private schedule() { if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }
  private styleOf(id: number): string {
    let s = this.styleCss[id]; if (s !== undefined) return s;
    const st = this.t.styles[id]; let fg = css(st.fg, 'var(--tm-fg)'), bg = st.bg < 0 ? '' : css(st.bg, ''), cl = '';
    if (st.at & INVERSE) { const f = st.fg < 0 ? 'var(--tm-fg)' : fg; fg = st.bg < 0 ? 'var(--tm-bg)' : bg; bg = f; }
    if (st.at & INVIS) fg = 'transparent';
    if (st.at & BOLD) cl += ' tv-b'; if (st.at & DIM) cl += ' tv-d'; if (st.at & ITALIC) cl += ' tv-i'; if (st.at & UNDER) cl += ' tv-u'; if (st.at & STRIKE) cl += ' tv-s';
    if (st.link) cl += ' tv-lk';
    const style = (st.fg >= 0 || st.at & (INVERSE | INVIS) ? `color:${fg};` : '') + (bg ? `background:${bg};` : '');
    s = (cl ? ` class="${cl.trim()}"` : '') + (style ? ` style="${style}"` : ''); this.styleCss[id] = s; return s;
  }
  private selRange(): [Pos, Pos] | null {
    const s = this.sel; if (!s) return null; const { a, b } = s;
    return a.l < b.l || (a.l === b.l && a.c <= b.c) ? [a, b] : [b, a];
  }
  /** Plages d'URL (indices de cellules) dans le texte d'une ligne. */
  private urls(text: string, map: number[]): [number, number, string][] {
    const out: [number, number, string][] = []; URL_RE.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text))) {
      const u = m[0].replace(/[.,;:!?)\]}>]+$/, ''); if (u.length < 9) continue;
      out.push([map[m.index], map[m.index + u.length - 1], u]);
    }
    return out;
  }
  private rowHtml(v: number, cur: number): string {
    const t = this.t, ln = t.vline(v), n = ln.ch.length, base = t.base, abs = base + v;
    let text = '', map: number[] = [];
    for (let x = 0; x < n; x++) { const c = ln.ch[x]; if (c === '') continue; for (let k = 0; k < c.length; k++) map.push(x); text += c; }
    const urls = text.includes('http') ? this.urls(text, map) : [];
    const sr = this.selRange(); let s0 = -1, s1 = -1;
    if (sr && abs >= sr[0].l && abs <= sr[1].l) { s0 = abs === sr[0].l ? sr[0].c : 0; s1 = abs === sr[1].l ? sr[1].c : n; }
    let len = n; while (len > 0 && ln.ch[len - 1] === ' ' && ln.st[len - 1] === 0) len--;
    len = Math.max(len, s1 > 0 ? Math.min(s1, n) : 0, cur >= 0 ? cur + 1 : 0);
    let html = '', run = '', key = '', attrs = '';
    const flush = () => { if (!run) return; html += key === '' ? run : `<span${attrs}>${run}</span>`; run = ''; };
    for (let x = 0; x < len; x++) {
      const c = ln.ch[x]; if (c === '') continue;
      const wide = ln.ch[x + 1] === '' && x + 1 < n && c !== ' ';
      const sel = x >= s0 && x < s1, url = urls.some(u => x >= u[0] && x <= u[1]), id = ln.st[x];
      const body = wide ? `<span class="tv-w">${esc(c)}</span>` : esc(c);
      if (x === cur) {
        flush(); html += `<span class="tv-cur${sel ? ' tv-sel' : ''}${wide ? ' tv-cw2' : ''}"${this.styleOf(id).replace(/^ class="[^"]*"/, '')}>${body}</span>`; continue;
      }
      const k = id + '|' + (sel ? 1 : 0) + '|' + (url ? 1 : 0);
      const plain = id === 0 && !sel && !url;
      const nk = plain ? '' : k;
      if (nk !== key) { flush(); key = nk; if (!plain) { const a = this.styleOf(id), extra = (sel ? ' tv-sel' : '') + (url ? ' tv-url' : ''); attrs = extra ? (a.includes('class="') ? a.replace('class="', `class="${extra.trim()} `) : ` class="${extra.trim()}"` + a) : a; } }
      run += body;
    }
    flush(); return html;
  }
  private render() {
    if (this.disposed) return;
    const t = this.t, rows = t.rows;
    if (this.off > t.sb.length) this.off = t.sb.length;
    const top = t.sb.length - this.off;
    const cur = t.cursorVisible && this.off === 0 ? t.s.cy : -1, curX = t.s.cx;
    const curKey = `${cur}:${curX}:${t.cursorShape}:${t.cursorBlink}`;
    const all = this.full || this.selDirty || t.epoch !== this.lastEpoch || this.off > 0 || t.sb.length !== this.lastSb;
    const oldCur = this.lastCur.split(':')[0]; const oldY = oldCur === '' ? -1 : +oldCur;
    this.el.classList.toggle('tv-cur-block', t.cursorShape === 'block'); this.el.classList.toggle('tv-cur-under', t.cursorShape === 'underline');
    this.el.classList.toggle('tv-cur-bar', t.cursorShape === 'bar'); this.el.classList.toggle('tv-blink', t.cursorBlink);
    for (let y = 0; y < rows; y++) {
      if (!all && !t.dirty[y] && y !== cur && y !== oldY) continue;
      const html = this.rowHtml(top + y, y === cur ? curX : -1);
      if (html !== this.cache[y]) { this.rowEls[y].innerHTML = html; this.cache[y] = html; }
    }
    this.lastCur = curKey; this.lastEpoch = t.epoch; this.lastSb = t.sb.length; this.full = false; this.selDirty = false; t.clean();
    this.placeInput(); this.paintBar();
  }
  private paintBar() {
    const t = this.t, total = t.sb.length + t.rows, show = this.off > 0 && t.sb.length > 0;
    this.bar.classList.toggle('on', show);
    if (show) { this.bar.style.height = Math.max(8, (t.rows / total) * 100) + '%'; this.bar.style.top = ((t.sb.length - this.off) / total) * 100 + '%'; }
  }
  private placeInput() {
    const pad = this.rowsEl.offsetLeft, top = this.rowsEl.offsetTop, t = this.t;
    this.ta.style.left = pad + t.s.cx * this.cw + 'px'; this.ta.style.top = top + t.s.cy * this.ch + 'px'; this.ta.style.height = this.ch + 'px';
  }

  // ---------- entrée ----------
  private send(d: string) { if (!d) return; this.sel = null; this.selDirty = true; this.toBottom(); this.o.onData(d); }
  private toBottom() { if (this.off) { this.off = 0; this.full = true; this.schedule(); } }
  private flushInput() { const v = this.ta.value; this.ta.value = ''; if (v) this.send(v.replace(/\r\n|\n/g, '\r')); }
  private focusChanged(on: boolean) {
    if (on === this.lastFocus) return; this.lastFocus = on; this.el.classList.toggle('tv-focus', on);
    const r = this.t.focusReport(on); if (r) this.o.onData(r); this.full = true; this.schedule();
  }
  private setMeta(m: boolean) { if (m !== this.meta) { this.meta = m; this.el.classList.toggle('tv-meta', m); } }
  private copy() {
    const s = this.selection(); if (!s) return false;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(s).catch(() => undefined);
    return true;
  }
  private keydown(e: KeyboardEvent) {
    this.setMeta(e.metaKey);
    if (e.isComposing || e.keyCode === 229) return;
    if (e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'c' && this.copy()) { e.preventDefault(); }
      else if (k === 'a') { e.preventDefault(); this.selectAll(); }
      else if (k === 'k') { e.preventDefault(); this.clear(); }
      return;                                                                                // ⌘V : l'événement paste s'en charge ; le reste remonte
    }
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !this.t.altOn && ['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); const page = Math.max(1, this.t.rows - 1);
      this.scrollBy(e.key === 'PageUp' ? page : e.key === 'PageDown' ? -page : e.key === 'Home' ? 1e9 : -1e9); return;
    }
    const d = encodeKey({ key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: false }, { appCursor: this.t.appCursor, appKeypad: this.t.appKeypad });
    if (d !== null) { e.preventDefault(); this.send(d); }
  }
  private selectAll() {
    const t = this.t; this.sel = { a: { l: t.base, c: 0 }, b: { l: t.base + t.total - 1, c: t.cols } }; this.selDirty = true; this.schedule();
  }
  private scrollBy(n: number) {
    const t = this.t, o = Math.max(0, Math.min(t.sb.length, this.off + n)); if (o === this.off) return;
    this.off = o; this.full = true; this.schedule();
  }

  // ---------- souris ----------
  private cell(e: MouseEvent, clamp = true): { x: number; y: number } {
    const r = this.rowsEl.getBoundingClientRect();
    let x = Math.floor((e.clientX - r.left) / this.cw), y = Math.floor((e.clientY - r.top) / this.ch);
    if (clamp) { x = Math.max(0, Math.min(this.t.cols - 1, x)); y = Math.max(0, Math.min(this.t.rows - 1, y)); }
    return { x, y };
  }
  private linkAt(x: number, y: number): string {
    const t = this.t, v = t.sb.length - this.off + y, ln = t.vline(v);
    let cx = x; while (cx > 0 && ln.ch[cx] === '') cx--;
    const id = t.styles[ln.st[cx]]?.link; if (id) return t.links[id];
    let text = '', map: number[] = [];
    for (let i = 0; i < ln.ch.length; i++) { const c = ln.ch[i]; if (c === '') continue; for (let k = 0; k < c.length; k++) map.push(i); text += c; }
    if (!text.includes('http')) return '';
    return this.urls(text, map).find(u => cx >= u[0] && cx <= u[1])?.[2] ?? '';
  }
  private mouseOn(e: MouseEvent) { return this.t.mouse !== 0 && !e.shiftKey; }
  private report(type: 'down' | 'up' | 'move' | 'wheel', button: number, e: MouseEvent) {
    const { x, y } = this.cell(e), r = this.t.mouseReport({ type, button, x, y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey });
    if (r) this.o.onData(r);
  }
  private mousedown(e: MouseEvent) {
    if (e.button === 2) { return; }
    e.preventDefault(); this.focus();
    const { x, y } = this.cell(e);
    if (e.metaKey && e.button === 0) { const u = this.linkAt(x, y); if (u) { this.o.onLink?.(u); return; } }
    if (this.mouseOn(e)) {
      this.pressed = e.button; this.report('down', e.button, e);
      const up = (u: MouseEvent) => { this.report('up', this.pressed, u); this.pressed = -1; document.removeEventListener('mouseup', up, true); document.removeEventListener('mousemove', mv, true); };
      const mv = (m: MouseEvent) => this.report('move', this.pressed, m);
      document.addEventListener('mouseup', up, true); document.addEventListener('mousemove', mv, true); return;
    }
    if (e.button !== 0) return;
    const t = this.t, v = t.sb.length - this.off + y, p: Pos = { l: t.base + v, c: x };
    const n = Math.min(3, e.detail || 1);
    if (n === 2) { const [a, b] = this.wordAt(v, x); this.sel = { a: { l: p.l, c: a }, b: { l: p.l, c: b } }; this.drag = 'word'; }
    else if (n === 3) { const [a, b] = t.logicalRange(v); this.sel = { a: { l: t.base + a, c: 0 }, b: { l: t.base + b, c: t.cols } }; this.drag = 'line'; }
    else { this.sel = e.shiftKey && this.sel ? { a: this.sel.a, b: p } : { a: p, b: p }; this.drag = 'char'; }
    this.selDirty = true; this.schedule();
    document.addEventListener('mousemove', this.dragMove, true); document.addEventListener('mouseup', this.dragEnd, true);
  }
  private wordAt(v: number, x: number): [number, number] {
    const ln = this.t.vline(v); let a = x, b = x; while (a > 0 && ln.ch[a] === '') a--;
    if (!isWordCh(ln.ch[a])) return [a, a + 1];
    while (a > 0 && isWordCh(ln.ch[a - 1])) a--;
    b = x; while (b < ln.ch.length && (isWordCh(ln.ch[b]) || ln.ch[b] === '')) b++;
    return [a, b];
  }
  private dragMove = (e: MouseEvent) => {
    if (!this.sel || this.drag !== 'char') return;
    const r = this.rowsEl.getBoundingClientRect();
    if (e.clientY < r.top) this.scrollBy(1); else if (e.clientY > r.bottom) this.scrollBy(-1);
    const { x, y } = this.cell(e), t = this.t;
    this.sel = { a: this.sel.a, b: { l: t.base + t.sb.length - this.off + y, c: x + 1 > t.cols ? t.cols : x } };
    const a = this.sel.a, b = this.sel.b; if (b.l > a.l || (b.l === a.l && b.c >= a.c)) this.sel.b.c = Math.min(t.cols, b.c + 1);
    this.selDirty = true; this.schedule();
  };
  private dragEnd = () => { this.stopDrag(); const s = this.sel; if (s && s.a.l === s.b.l && s.a.c === s.b.c && this.drag === 'char') { this.sel = null; this.selDirty = true; this.schedule(); } this.drag = null; };
  private stopDrag() { document.removeEventListener('mousemove', this.dragMove, true); document.removeEventListener('mouseup', this.dragEnd, true); }
  private mousemove(e: MouseEvent) {
    this.setMeta(e.metaKey);
    if (e.metaKey) { const { x, y } = this.cell(e); this.el.classList.toggle('tv-hot', !!this.linkAt(x, y)); } else this.el.classList.remove('tv-hot');
    if (this.mouseOn(e) && this.t.mouse === 1003 && this.pressed < 0) this.report('move', -1, e);
  }
  private wheel(e: WheelEvent) {
    const t = this.t; e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * this.ch : e.deltaMode === 2 ? e.deltaY * this.ch * t.rows : e.deltaY;
    this.wheelAcc += px / this.ch; const n = Math.trunc(this.wheelAcc); if (!n) return; this.wheelAcc -= n;
    const k = Math.abs(n);
    if (this.mouseOn(e)) { for (let i = 0; i < Math.min(k, 10); i++) this.report('wheel', n < 0 ? -1 : 1, e); return; }
    if (t.altOn) { const f = n < 0 ? 'A' : 'B', d = t.appCursor ? '\x1bO' + f : '\x1b[' + f; this.o.onData(d.repeat(Math.min(k, 10))); return; }
    this.scrollBy(-n);
  }
}
