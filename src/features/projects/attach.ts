// Images jointes à une consigne d'agent : coller, glisser-déposer ou choisir un fichier ; vignettes, visionneuse, envoi.
// Commun à la page projet (sessions.ts) et à l'Espace agents (workspace.ts). Côté Mac : `AgentImages` (Agents.swift).
// Les images restent en mémoire, par formulaire, jusqu'à un envoi réussi : jamais dans les brouillons (localStorage).
import * as bridge from '../../integrations/remote.ts';
import { esc } from '../../lib/markdown.ts';
import { toast } from '../../ui/kit.ts';
// tr : le texte tel que l'interface l'affiche (traduit en anglais), pour comparer avec ce qui est déjà posé.
import { t as tr } from '../../ui/i18n.ts';

export const MAX_COUNT = 6, MAX_BYTES = 8 * 1024 * 1024, MAX_TOTAL = 24 * 1024 * 1024, MAX_SIDE = 2000;
export const DEFAULT_PROMPT = 'Regarde les images jointes.';
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const LIMITS = `${MAX_COUNT} images au plus, ${MAX_BYTES / 1048576} Mo chacune`;

export interface Pic { id: string; name: string; type: string; data: string; bytes: number; url: string }
export interface Payload { name: string; type: string; data: string }

const pics = new Map<string, Pic[]>();
const busy = new Set<string>();
let seq = 0;

const keyOf = (f: Element): string => (f as HTMLElement).dataset.atKey || (f as HTMLElement).dataset.draft || '';
const list = (f: Element): Pic[] => pics.get(keyOf(f)) ?? [];
const plural = (n: number, one: string, many: string): string => n > 1 ? many : one;
export const size = (b: number): string => b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} Ko` : `${(b / 1048576).toFixed(1).replace('.', ',')} Mo`;

// ---------- Ce qui est possible ici ----------
/** Raison pour laquelle les images ne peuvent pas partir depuis ce formulaire ('' : elles peuvent). */
export function blocked(f?: Element | null): string {
  const w = bridge.where();
  if (!w) return 'Les images passent par l’app Studio pour Mac : ouvre Studio sur le Mac.';
  if (w.kind === 'remote') return 'Les images ne se joignent pas depuis un appareil lié : envoie-les depuis Studio sur le Mac.';
  if (f) {
    const sel = (f as HTMLFormElement).elements?.namedItem('machine') as HTMLSelectElement | null;
    const m = sel?.value ?? (f as HTMLElement).dataset.machine ?? '';
    if (m.startsWith('server') || f.classList.contains('on-server')) return 'Les images ne partent pas vers un serveur : lance l’agent sur le Mac.';
  }
  return '';
}

// ---------- Rendu du formulaire ----------
const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8 8"/></svg>';
/** Zone des vignettes, à placer sous le champ de consigne. */
export const stripHTML = (): string => '<div class="at-strip" data-at-strip hidden></div>';
/** Bouton « Joindre des images » et son sélecteur de fichiers, à placer près du micro. */
export const buttonHTML = (): string => `<button type="button" class="icon-btn at-add" data-at-pick title="Joindre des images (${LIMITS})" aria-label="Joindre des images">${ICON}</button><input type="file" class="at-file" data-at-file accept="${TYPES.join(',')}" multiple hidden tabindex="-1" aria-hidden="true">`;

const own = new WeakMap<Element, { text: string; was: string }>();

/** Remet à jour vignettes, bouton « Joindre », bouton d'envoi et aide de `f` (idempotent : sans changement, rien n'est touché). */
export function sync(f: Element): void {
  const strip = f.querySelector<HTMLElement>('[data-at-strip]'); if (!strip) return;
  const items = list(f), n = items.length, why = blocked(f);
  const sig = `${items.map(p => p.id).join(',')}|${why}|${busy.has(keyOf(f)) ? 'b' : ''}`;
  if (strip.dataset.at !== sig) {
    strip.dataset.at = sig;
    strip.hidden = !n && !busy.has(keyOf(f));
    strip.innerHTML = `<ul class="at-list" aria-label="Images jointes">${items.map(p => `<li class="at-item"><button type="button" class="at-thumb" data-at-zoom="${esc(p.id)}" title="Agrandir" aria-label="Agrandir ${esc(p.name)}"><img src="${esc(p.url)}" alt=""></button><span class="at-meta"><span class="at-name" title="${esc(p.name)}">${esc(p.name)}</span><span class="at-size">${size(p.bytes)}</span></span><button type="button" class="at-rm" data-at-rm="${esc(p.id)}" title="Retirer" aria-label="Retirer ${esc(p.name)}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></li>`).join('')}${busy.has(keyOf(f)) ? '<li class="at-item at-wait" role="status">Préparation…</li>' : ''}</ul>${n && why ? `<p class="at-note at-warn" role="status">${esc(why)} Retire-les pour envoyer.</p>` : n ? `<p class="at-note">${n} sur ${MAX_COUNT} · ${MAX_BYTES / 1048576} Mo au plus chacune</p>` : ''}`;
  }
  const add = f.querySelector<HTMLElement>('[data-at-pick]');
  if (add) {
    const t = why || `Joindre des images (${LIMITS})`;
    if (add.title !== tr(t)) { add.title = t; add.setAttribute('aria-label', why ? `Images indisponibles : ${why}` : 'Joindre des images'); }
    const off = why ? 'true' : 'false'; if (add.getAttribute('aria-disabled') !== off) add.setAttribute('aria-disabled', off);
    add.classList.toggle('at-off', !!why);
  }
  const btn = f.querySelector<HTMLElement>('button.btn-primary');
  if (btn?.hasAttribute('data-at-bare')) { const t = n ? `Envoyer avec ${n} image${plural(n, '', 's')}` : ''; if (t && btn.title !== tr(t)) { btn.dataset.atTitle = btn.dataset.atTitle ?? btn.title; btn.title = t; } else if (!t && btn.dataset.atTitle) { btn.title = btn.dataset.atTitle; delete btn.dataset.atTitle; } }
  else if (btn) {
    const want = n ? `+ ${n} image${plural(n, '', 's')}` : '', cur = btn.querySelector('.at-count');
    if (!want && cur) cur.remove();
    else if (want && cur?.textContent !== tr(want)) {
      cur?.remove();
      const s = document.createElement('span'); s.className = 'at-count'; s.textContent = want;
      const kbd = btn.querySelector('kbd'); btn.insertBefore(s, kbd); if (!kbd) btn.appendChild(s);
    }
  }
  const hint = f.querySelector<HTMLElement>('[data-hint]');
  if (hint) {
    const mine = own.get(hint), text = `${n} image${plural(n, '', 's')} jointe${plural(n, '', 's')} : Claude ${plural(n, 'la', 'les')} lira avec ta consigne.`;
    if (n) {
      if (hint.textContent !== tr(text)) { own.set(hint, { text: tr(text), was: mine ? mine.was : hint.innerHTML }); hint.textContent = text; }
    } else if (mine && hint.textContent === mine.text) { hint.innerHTML = mine.was; own.delete(hint); }
  }
}
const syncAll = (root: ParentNode): void => root.querySelectorAll('[data-at-strip]').forEach(s => { const f = s.closest('form'); if (f) sync(f); });

// ---------- État ----------
export const count = (f: Element): number => list(f).length;
/** Images à envoyer avec la consigne. */
export const payload = (f: Element): Payload[] => list(f).map(({ name, type, data }) => ({ name, type, data }));
/** À appeler après un envoi réussi seulement. */
export function clear(f: Element): void {
  for (const p of list(f)) URL.revokeObjectURL(p.url);
  pics.delete(keyOf(f)); sync(f);
}
function remove(f: Element, id: string): void {
  const all = list(f), hit = all.find(p => p.id === id); if (!hit) return;
  URL.revokeObjectURL(hit.url); pics.set(keyOf(f), all.filter(p => p.id !== id)); sync(f);
}
/** Le Mac répond `images: <n>` : sans lui, l'app est trop ancienne et l'agent n'a pas vu les images. */
export function confirmed(reply: Record<string, unknown>, n: number): boolean { return n === 0 || reply.images === n; }
export const OLD_APP = 'Les images n’ont pas été transmises : mets à jour l’app Studio pour Mac.';

// ---------- Ajout ----------
const decodeB64 = (data: string): Blob => { const s = atob(data), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Blob([u]); };
const readB64 = (b: Blob): Promise<string> => new Promise((ok, ko) => { const r = new FileReader(); r.onerror = () => ko(r.error); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.readAsDataURL(b); });
const toBlob = (c: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> => new Promise(ok => c.toBlob(ok, type, q));
const withExt = (name: string, type: string): string => `${name.replace(/\.[A-Za-z0-9]+$/, '')}.${EXT[type] ?? 'png'}`;

/** Réduit une image trop grande (côté > 2000 px) ou trop lourde ; un GIF n'est jamais retouché (animation). `null` : impossible sous la limite. */
async function fit(file: File, type: string): Promise<{ blob: Blob; type: string } | null> {
  const same = { blob: file as Blob, type };
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { return file.size <= MAX_BYTES ? same : null; }
  const big = Math.max(bmp.width, bmp.height);
  if (type === 'image/gif' || (big <= MAX_SIDE && file.size <= MAX_BYTES)) { bmp.close(); return file.size <= MAX_BYTES ? same : null; }
  const k = Math.min(1, MAX_SIDE / big), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext('2d'); if (!g) { bmp.close(); return null; }
  const draw = (jpeg: boolean) => { g.clearRect(0, 0, c.width, c.height); if (jpeg) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); } g.drawImage(bmp, 0, 0, c.width, c.height); };
  const first = type === 'image/png' || type === 'image/webp' ? type : 'image/jpeg';
  draw(first === 'image/jpeg');
  let out = await toBlob(c, first, 0.92), t = first;
  if ((!out || out.size > MAX_BYTES) && first !== 'image/jpeg') { draw(true); out = await toBlob(c, 'image/jpeg', 0.85); t = 'image/jpeg'; }
  bmp.close();
  return out && out.size <= MAX_BYTES ? { blob: out, type: t } : null;
}

const GENERIC = /^(image|capture|screenshot|blob|unnamed)?\.?(png|jpe?g|webp|gif)?$/i;
/** Ajoute des fichiers au formulaire `f`, en disant clairement ce qui est refusé. */
export async function add(f: Element, files: File[]): Promise<void> {
  const why = blocked(f); if (why) { toast(why); return; }
  const key = keyOf(f); if (!key || !files.length) return;
  busy.add(key); sync(f);
  const skipped: string[] = [], odd: string[] = [], heavy: string[] = [];
  let over = false, total = list(f).reduce((s, p) => s + p.bytes, 0);
  try {
    for (const file of files) {
      const lower = file.name.toLowerCase();
      let type = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
      if (!type && /\.(png|jpe?g|webp|gif)$/.test(lower)) type = lower.endsWith('png') ? 'image/png' : lower.endsWith('webp') ? 'image/webp' : lower.endsWith('gif') ? 'image/gif' : 'image/jpeg';
      if (!TYPES.includes(type)) { (type.startsWith('image/') || /\.(heic|heif|tiff?|svg|bmp|avif)$/.test(lower) ? odd : skipped).push(file.name || 'fichier'); continue; }
      if (list(f).length >= MAX_COUNT) { over = true; break; }
      const fitted = await fit(file, type).catch(() => null);
      if (!fitted) { heavy.push(file.name || 'image'); continue; }
      if (total + fitted.blob.size > MAX_TOTAL) { heavy.push(file.name || 'image'); continue; }
      const stem = GENERIC.test(file.name) ? `image-${list(f).length + 1}` : file.name, name = withExt(stem, fitted.type);
      const pic: Pic = { id: `p${++seq}`, name, type: fitted.type, data: await readB64(fitted.blob), bytes: fitted.blob.size, url: URL.createObjectURL(fitted.blob) };
      total += pic.bytes; pics.set(key, [...list(f), pic]);
      sync(f);
    }
  } finally { busy.delete(key); sync(f); }
  if (odd.length) toast(`Format non pris en charge : ${odd.join(', ')}. Joins des images PNG, JPEG, WebP ou GIF (une capture d’écran ou un export JPEG convient).`);
  if (skipped.length) toast(`${skipped.join(', ')} n’${skipped.length > 1 ? 'étaient pas des images' : 'est pas une image'} : ${skipped.length > 1 ? 'ignorés' : 'ignoré'}.`);
  if (heavy.length) toast(`Trop lourde${heavy.length > 1 ? 's' : ''} même réduite${heavy.length > 1 ? 's' : ''} (${MAX_BYTES / 1048576} Mo au plus chacune, ${MAX_TOTAL / 1048576} Mo en tout) : ${heavy.join(', ')}.`);
  if (over) toast(`${MAX_COUNT} images au plus par consigne : les suivantes n’ont pas été jointes.`);
}

// ---------- Visionneuse ----------
let viewer: HTMLElement | null = null, back: HTMLElement | null = null;
function closeView(): void { viewer?.remove(); viewer = null; document.removeEventListener('keydown', onKey, true); back?.focus?.(); back = null; }
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeView(); }
  else if (e.key === 'Tab') { e.preventDefault(); viewer?.querySelector<HTMLElement>('button')?.focus(); }
}
/** Affiche une image en grand ; Échap, un clic à côté ou le bouton la referment. */
export function view(src: string, label = 'Image jointe'): void {
  closeView();
  back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const el = document.createElement('div');
  el.className = 'at-view'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', label);
  el.innerHTML = `<img src="${esc(src)}" alt="${esc(label)}"><button type="button" class="at-close" aria-label="Fermer l’image" title="Fermer (Échap)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
  el.addEventListener('click', e => { if ((e.target as HTMLElement).tagName !== 'IMG') closeView(); });
  document.body.appendChild(el); viewer = el;
  document.addEventListener('keydown', onKey, true);
  el.querySelector<HTMLElement>('.at-close')?.focus();
}

// ---------- Fil : images d'un message déjà envoyé ----------
type Cached = { url: string; at: number } | { gone: true; at: number };
const cache = new Map<string, Cached>(), flying = new Map<string, Promise<Cached>>();
/** Garde la vignette, et libère les plus anciennes au-delà de 150 : une longue journée de fils ne retient pas toutes ses images en mémoire. */
function keep(k: string, v: Cached): Cached {
  cache.delete(k); cache.set(k, v);
  for (const [old, c] of cache) { if (cache.size <= 150) break; if ('url' in c) URL.revokeObjectURL(c.url); cache.delete(old); }
  return v;
}
/** Vignettes d'un message du fil (chemins renvoyés par le Mac) ; `hydrate` les remplit au fur et à mesure. */
export function galleryHTML(paths: string[] | undefined): string {
  if (!paths?.length) return '';
  return `<div class="at-gal">${paths.map((p, i) => `<button type="button" class="at-gthumb" data-at-path="${esc(p)}" aria-label="Agrandir l’image ${i + 1}" title="Agrandir"><span class="at-ph" aria-hidden="true"></span></button>`).join('')}</div>`;
}
function load(project: string, path: string): Promise<Cached> {
  const k = `${project}|${path}`, hit = cache.get(k);
  if (hit && ('url' in hit || Date.now() - hit.at < 20000)) return Promise.resolve(hit);
  let p = flying.get(k);
  if (!p) {
    p = bridge.call('agent', 'image', { project, path }, 20000).then((r): Cached => {
      const ok = r.ok && typeof r.data === 'string' && typeof r.type === 'string' && TYPES.includes(r.type);
      const v: Cached = ok ? { url: URL.createObjectURL(new Blob([decodeB64(r.data as string)], { type: r.type as string })), at: Date.now() } : { gone: true, at: Date.now() };
      return keep(k, v);
    }).catch((): Cached => keep(k, { gone: true, at: Date.now() })).finally(() => { flying.delete(k); });
    flying.set(k, p);
  }
  return p;
}
function paintThumb(b: HTMLElement, v: Cached): void {
  if ('url' in v) {
    if (b.querySelector('img')?.getAttribute('src') === v.url) return;
    b.classList.remove('at-gone'); b.innerHTML = `<img src="${esc(v.url)}" alt="" loading="lazy">`;
  } else if (!b.classList.contains('at-gone')) {
    b.classList.add('at-gone'); b.setAttribute('disabled', ''); b.title = 'Image indisponible'; b.innerHTML = '<span>image indisponible</span>';
  }
}
/** Charge (une seule fois, puis depuis le cache) les vignettes du fil présentes dans `root`. */
export function hydrate(root: ParentNode, project: string): void {
  root.querySelectorAll<HTMLElement>('[data-at-path]').forEach(b => {
    const path = b.dataset.atPath ?? '', hit = cache.get(`${project}|${path}`);
    if (hit && ('url' in hit)) { paintThumb(b, hit); return; }
    if (b.dataset.atTry === '1' && !hit) return;
    b.dataset.atTry = '1';
    void load(project, path).then(v => { if (b.isConnected) paintThumb(b, v); });
  });
}

// ---------- Branchement ----------
const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
const formOf = (t: EventTarget | null): HTMLFormElement | null => { const f = (t as HTMLElement | null)?.closest?.<HTMLFormElement>('form'); return f?.querySelector('[data-at-strip]') ? f : null; };

/** Écoute coller, glisser-déposer, bouton, vignettes et fil sous `root` (une seule fois par racine). */
export function bind(root: HTMLElement): void {
  if (root.dataset.atBound) { syncAll(root); return; }
  root.dataset.atBound = '1';
  syncAll(root);
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; if (root.isConnected) syncAll(root); }); }).observe(root, { childList: true, subtree: true });

  root.addEventListener('paste', e => {
    const f = formOf(e.target); if (!f) return;
    const files = Array.from(e.clipboardData?.files ?? []); if (!files.length) return;
    e.preventDefault(); void add(f, files);
  });
  const over = (e: DragEvent) => { const f = formOf(e.target); if (!f || !hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = blocked(f) ? 'none' : 'copy'; f.classList.add('at-drop'); };
  root.addEventListener('dragenter', over, true);
  root.addEventListener('dragover', over, true);
  root.addEventListener('dragleave', e => { const f = formOf(e.target); if (f && !f.contains(e.relatedTarget as Node | null)) f.classList.remove('at-drop'); }, true);
  // En phase de capture : sans cela, la fenêtre importerait le fichier déposé comme une note (app.ts).
  root.addEventListener('drop', e => {
    const f = formOf(e.target); if (!f || !hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); f.classList.remove('at-drop');
    void add(f, Array.from(e.dataTransfer?.files ?? []));
  }, true);
  root.addEventListener('change', e => {
    const t = e.target as HTMLInputElement; if (!t.matches?.('[data-at-file]')) return;
    const f = t.closest('form'); const files = Array.from(t.files ?? []); t.value = '';
    if (f && files.length) void add(f, files);
  });
  root.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const pick = t.closest<HTMLElement>('[data-at-pick]');
    if (pick) { const f = pick.closest('form'); const why = blocked(f); if (why) toast(why); else f?.querySelector<HTMLInputElement>('[data-at-file]')?.click(); return; }
    const rm = t.closest<HTMLElement>('[data-at-rm]');
    if (rm) { const f = rm.closest('form'); if (f) { remove(f, rm.dataset.atRm ?? ''); f.querySelector<HTMLElement>('[data-at-pick], textarea')?.focus(); } return; }
    const zoom = t.closest<HTMLElement>('[data-at-zoom]');
    if (zoom) { const f = zoom.closest('form'), p = f && list(f).find(x => x.id === zoom.dataset.atZoom); if (p) view(p.url, p.name); return; }
    const g = t.closest<HTMLElement>('[data-at-path]');
    const src = g?.querySelector('img')?.getAttribute('src');
    if (g && src) view(src);
  });
}
