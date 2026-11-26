// Langue de l'interface. Le code reste écrit en français ; en anglais (la langue par défaut), une couche posée sur le
// DOM remplace à la volée les textes connus des dictionnaires i18n/dict-*.ts, sans toucher aux vues une par une.
// Format d'une clé : le texte tel qu'affiché entre deux balises (espaces de bord retirés, espaces internes réduits à un),
// ou la valeur d'un attribut de ATTRS. Les morceaux variables s'écrivent {0}, {1}… dans la clé et dans la traduction.
// Jamais traduits : le contenu de l'utilisateur (.md, champs, éditables, code) et tout ce qui est sous [data-no-i18n].
import dictA from './i18n/dict-a.ts';
import dictB from './i18n/dict-b.ts';
import dictC from './i18n/dict-c.ts';
import dictD from './i18n/dict-d.ts';

export type Lang = 'en' | 'fr';
const KEY = 'studio.lang';
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip'];
/** Sous-arbres jamais touchés (contenu de l'utilisateur, code) ; dans LEAF, seuls les attributs sont traduits, pas la valeur. */
const SKIP = 'script, style, code, pre, .md, [contenteditable], [data-no-i18n]';
const LEAF = 'textarea, input';

export function lang(): Lang {
  try { return localStorage.getItem(KEY) === 'fr' ? 'fr' : 'en'; } catch { return 'en'; }
}

/** Change de langue : enregistre les notes en cours, puis recharge (les textes déjà traduits ne se « détraduisent » pas). */
export async function setLang(l: Lang): Promise<void> {
  if (l === lang()) return;
  localStorage.setItem(KEY, l);
  try { await window.carnet?.flush(); } catch { /* rien à enregistrer */ }
  location.reload();
}

const exact = new Map<string, string>();
// weak : clé à peine écrite ('{0} et {1}', 'sur {0}') ; elle ne s'applique que si chaque morceau variable est un nombre
// ou un texte connu, sinon elle traduirait un titre de note quelconque (« Réunion sur le budget »).
type Template = { re: RegExp; out: string; lit: string; weak: boolean };
const templates: Template[] = [];
const memo = new Map<string, string | null>();
/** Vrai pour un texte de l'utilisateur (titre de note…) : jamais traduit, même s'il ressemble à un libellé. */
let mine: (k: string) => boolean = () => false;
export function guard(f: (k: string) => boolean): void { mine = f; }
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function load(): void {
  for (const d of [dictA, dictB, dictC, dictD] as Record<string, string>[]) {
    for (const [fr, en] of Object.entries(d)) {
      const k = norm(fr);
      if (!/\{\d\}/.test(k)) { exact.set(k, en); continue; }
      const parts = k.split(/\{(\d)\}/), order: number[] = [];
      let src = '^', lit = '';
      parts.forEach((p, i) => {
        if (i % 2) { order.push(Number(p)); src += '(.+?)'; } else { src += escRe(p); if (p.length > lit.length) lit = p; }
      });
      // Les captures sont numérotées dans l'ordre de la clé ; la traduction les cite par leur numéro.
      let out = en;
      order.forEach((n, i) => { out = out.split(`{${n}}`).join(`\u0000${i}\u0000`); });
      if (!lit.trim()) continue; // '{0}' seul : rien à reconnaître
      const weak = (parts.filter((_, i) => !(i % 2)).join('').match(/\p{L}/gu)?.length ?? 0) < 5;
      templates.push({ re: new RegExp(src + '$', 's'), out, lit, weak });
    }
  }
  templates.sort((a, b) => b.lit.length - a.lit.length); // la plus précise d'abord
}

/** Traduit un texte (clé normalisée) ; null s'il n'est pas connu. */
function lookup(k: string): string | null {
  const hit = exact.get(k);
  if (hit !== undefined) return hit;
  const m = memo.get(k);
  if (m !== undefined) return m;
  let res: string | null = null;
  for (const t of templates) {
    if (t.lit && !k.includes(t.lit)) continue;
    const g = t.re.exec(k);
    if (!g || (t.weak && g.slice(1).some(v => !/\d/.test(v) && lookup(v) === null))) continue;
    res = t.out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => { const v = g[Number(i) + 1] ?? ''; return mine(v) ? v : lookup(v) ?? v; });
    break;
  }
  if (memo.size > 8000) memo.clear();
  memo.set(k, res);
  return res;
}

/** Pour le code qui affiche hors du DOM (notifications, titre…) : la traduction si elle existe, sinon le texte. */
export function t(s: string): string {
  if (lang() === 'fr' || !s) return s;
  return lookup(norm(s)) ?? s;
}

function text(n: Text): void {
  const v = n.data, k = norm(v);
  if (!k || !/\p{L}/u.test(k)) return;
  const en = lookup(k);
  if (en === null || en === k || mine(k)) return;
  const lead = v.match(/^\s*/)?.[0] ?? '', tail = v.match(/\s*$/)?.[0] ?? '';
  n.data = lead + en + tail;
}

function attrs(e: Element): void {
  for (const a of ATTRS) {
    const v = e.getAttribute(a);
    if (!v) continue;
    const en = lookup(norm(v));
    if (en !== null && en !== v) e.setAttribute(a, en);
  }
}

const skipped = (e: Element | null) => !!e?.closest(SKIP);
const textSkipped = (e: Element | null) => !e || e.matches(LEAF) || skipped(e);

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) { if (!textSkipped(root.parentElement)) text(root as Text); return; }
  if (!(root instanceof Element) || skipped(root)) return;
  attrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => n instanceof Element && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType !== Node.TEXT_NODE) attrs(n as Element);
    else if (!n.parentElement?.matches(LEAF)) text(n as Text);
  }
}

/** À appeler avant le premier rendu : en anglais, traduit la page puis tout ce qui s'y ajoute. */
export function init(): void {
  // L'app Mac règle ses menus sur la même langue.
  window.webkit?.messageHandlers?.carnet?.postMessage({ type: 'lang', lang: lang() });
  if (lang() === 'fr') return;
  document.documentElement.lang = 'en';
  localeEnglish();
  load();
  walk(document.documentElement);
  // Le rappel passe avant l'affichage : le français ne s'affiche jamais, même un instant.
  new MutationObserver(recs => {
    for (const r of recs) {
      if (r.type === 'childList') r.addedNodes.forEach(walk);
      else if (r.type === 'characterData') { if (!textSkipped(r.target.parentElement)) text(r.target as Text); }
      else if (r.target instanceof Element && !skipped(r.target)) attrs(r.target);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** Les dates et nombres sont formatés en 'fr-FR' dans tout le code : en anglais, on les remplace par 'en-GB'. */
function localeEnglish(): void {
  const swap = (l: unknown) => (l === 'fr-FR' || l === 'fr' || (Array.isArray(l) && l[0] === 'fr') ? 'en-GB' : l) as Intl.LocalesArgument;
  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
    const orig = Date.prototype[name];
    Date.prototype[name] = function (this: Date, l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) { return Reflect.apply(orig, this, [swap(l), o]) as string; };
  }
  const num = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (this: number, l?: Intl.LocalesArgument, o?: Intl.NumberFormatOptions) { return Reflect.apply(num, this, [swap(l), o]) as string; };
  for (const name of ['DateTimeFormat', 'NumberFormat', 'RelativeTimeFormat', 'DisplayNames', 'PluralRules', 'ListFormat'] as const) {
    const Orig = Intl[name] as unknown as new (l?: unknown, o?: unknown) => object;
    if (!Orig) continue;
    const Wrapped = function (this: unknown, l?: unknown, o?: unknown) { return new Orig(swap(l), o); } as unknown as typeof Orig;
    Object.defineProperty(Wrapped, 'prototype', { value: Orig.prototype });
    Object.defineProperty(Wrapped, 'supportedLocalesOf', { value: (Orig as unknown as { supportedLocalesOf: unknown }).supportedLocalesOf });
    (Intl as unknown as Record<string, unknown>)[name] = Wrapped;
  }
}
