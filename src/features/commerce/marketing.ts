// Atelier marketing d'une boutique : fiche produit, annonce Facebook Marketplace, textes de pub.
// Le texte est écrit par un modèle local (vue Modèles, rien ne quitte le Mac) ou par l'IA de Studio ; rien ne part vers
// Shopify ni vers Meta sans clic et confirmation. Moteur, consignes et analyse du JSON : marketing-gen.ts.
import * as shopify from '../../integrations/shopify/api.ts';
import * as ai from '../../integrations/ai.ts';
import * as store from '../../core/store.ts';
import * as ads from './ads.ts';
import { esc } from '../../lib/markdown.ts';
import { need, icon, modal, confirmBox, toast, paintIfChanged, errMsg, target } from '../../ui/kit.ts';
import { CATALOG, bestForMarketing } from '../modelcatalog.ts';
import { notesFor, noteFor } from './links.ts';
import type { AdDraft } from '../../integrations/meta/api.ts';
import type { Project } from '../projects/model.ts';
import type { AppShell } from '../../types.ts';
import * as gen from './marketing-gen.ts';
import type { Work, Settings, Fiche, Listing, AdSet, Engine, Machine } from './marketing-gen.ts';

type Product = shopify.Product;
type ShopCreds = shopify.ShopCreds;

let app: AppShell | undefined;
/** À appeler une fois au démarrage : sert au bouton qui ouvre la vue Modèles. */
export const init = (api: AppShell): void => { app = api; };

const SET_KEY = 'studio.marketing.set';
const MARKETPLACE = 'https://www.facebook.com/marketplace/create/item';
const WORKS: [Work, string, string][] = [['fiche', 'Fiche produit', 'Titre, description et SEO à renvoyer sur Shopify.'], ['marketplace', 'Annonce Marketplace', 'Une annonce prête à copier sur Facebook.'], ['pub', 'Textes de pub', 'Trois variantes pour une campagne Meta.']];

interface St {
  work: Work;
  mode: 'shop' | 'free';
  product: Product | null;
  shop: ShopCreds | null;
  picks: Product[]; pickQ: string; pickErr: string; pickBusy: boolean;
  free: { title: string; details: string; price: string; link: string };
  set: Settings; useNote: boolean; noteN: number | null; adjust: string;
  engine: Engine; machine: Machine | null;
  out: { fiche?: Fiche; marketplace?: Listing; pub?: AdSet };
  done: Partial<Record<Work, { ms: number; by: string }>>;
  busy: { work: Work; since: number } | null;
  err: string; run: number; sending: boolean;
}

function savedSettings(): Settings {
  try { const v = JSON.parse(localStorage.getItem(SET_KEY) || '{}') as Partial<Settings>; return { tone: v.tone || 'sobre', lang: v.lang || 'français', audience: '', points: '' }; } catch { return { tone: 'sobre', lang: 'français', audience: '', points: '' }; }
}

const dur = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
const nowText = (): string => new Date().toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const sizeOf = (model: string): string => {
  const [id, tag] = model.split(':'), v = CATALOG.find(e => e.id === id)?.variants.find(x => x.tag === tag);
  return v ? `${v.gb.toLocaleString('fr-FR')} Go` : '';
};

/** Atelier dans l'onglet Boutique : `box` reçoit une racine à lui. */
export function mount(box: HTMLElement, p: Project): void { build(box, p, null); }

/** Atelier dans une fenêtre, déjà positionné sur ce produit (depuis la fiche d'un produit). */
export function openFor(p: Project, product: Product): void {
  const m = modal({ title: 'Atelier marketing', cls: 'mk-modal', html: '<div data-mk></div>' });
  build(need('[data-mk]', m.body), p, product);
}

function build(box: HTMLElement, p: Project, first: Product | null): void {
  const shop = shopify.supported() ? shopify.shopOf(p) : null;
  const st: St = {
    work: 'fiche', mode: shop ? 'shop' : 'free', product: first, shop, picks: [], pickQ: '', pickErr: '', pickBusy: false,
    free: { title: '', details: '', price: '', link: p.site ?? '' },
    set: savedSettings(), useNote: false, noteN: null, adjust: '',
    engine: gen.pickEngine({ installed: [], ram: null, running: false, ok: false, message: '' }), machine: null,
    out: {}, done: {}, busy: null, err: '', run: 0, sending: false,
  };
  if (first) st.mode = 'shop';
  const root = document.createElement('div');
  root.className = 'mk-root';
  box.append(root);

  const cur = (): string => st.shop?.currency || 'EUR';
  const money = (n: number): string => { try { return shopify.money(n, cur()); } catch { return `${n} ${cur()}`; } };

  // ---------- Données du produit ----------
  const hasSource = (): boolean => st.mode === 'shop' ? !!st.product : !!st.free.title.trim();
  const titleOf = (): string => st.mode === 'shop' ? st.product?.title ?? '' : st.free.title.trim();
  const factsText = (): string => {
    if (st.mode === 'free') {
      const f = st.free;
      return [`Produit : ${f.title.trim()}`, f.price.trim() ? `Prix : ${f.price.trim()}` : '', f.details.trim() ? `Détails : ${f.details.trim()}` : '', f.link.trim() ? `Lien : ${f.link.trim()}` : ''].filter(Boolean).join('\n');
    }
    const x = st.product; if (!x) return '';
    const price = x.priceMax > x.priceMin ? `de ${money(x.priceMin)} à ${money(x.priceMax)}` : money(x.priceMin);
    return [
      `Titre : ${x.title}`, x.vendor ? `Marque : ${x.vendor}` : '', x.type ? `Type : ${x.type}` : '', `Prix : ${price}`,
      x.variants.length > 1 ? `Variantes : ${x.variants.slice(0, 10).map(v => v.title).join(', ')}` : '',
      x.tags.length ? `Étiquettes : ${x.tags.join(', ')}` : '',
      x.description ? `Description actuelle : ${x.description.slice(0, 1500)}` : '', x.onlineUrl ? `Lien : ${x.onlineUrl}` : '',
    ].filter(Boolean).join('\n');
  };

  async function noteText(): Promise<string> {
    if (!st.useNote || !st.product) return '';
    try {
      const notes = notesFor(p, { kind: 'product', id: st.product.id, name: st.product.title, handle: st.product.handle });
      // Même règle que partout : seules les notes que l’IA a le droit de lire partent (interrupteur général, #privé, chiffrées).
      return notes.filter(n => ai.shareable(n)).map(n => store.getBody(n) ?? '').filter(Boolean).join('\n\n---\n\n').slice(0, 4000);
    } catch { return ''; }
  }
  async function countNotes(): Promise<void> {
    const x = st.product; st.noteN = null;
    if (!x) return;
    try {
      const n = notesFor(p, { kind: 'product', id: x.id, name: x.title, handle: x.handle }).filter(y => ai.shareable(y)).length;
      if (st.product === x) { st.noteN = n; render(); }
    } catch { /* pas de note liée */ }
  }

  // ---------- Produits de la boutique ----------
  let pickRun = 0;
  async function loadPicks(q: string): Promise<void> {
    if (!st.shop) return;
    const mine = ++pickRun; st.pickBusy = true; paintPicks();
    try {
      const o: { query?: string; first: number } = { first: 12 };
      if (q.trim()) o.query = q.trim();
      const list = await shopify.products(st.shop, o);
      if (mine !== pickRun) return;
      st.picks = list; st.pickErr = '';
    } catch (e) { if (mine === pickRun) { st.picks = []; st.pickErr = errMsg(e); } }
    if (mine === pickRun) { st.pickBusy = false; paintPicks(); }
  }
  const picksHTML = (): string => {
    if (st.pickErr) return `<p class="mk-err">${esc(st.pickErr)}</p>`;
    if (st.pickBusy && !st.picks.length) return '<p class="mk-hint">Recherche…</p>';
    if (!st.picks.length) return '<p class="mk-hint">Aucun produit trouvé.</p>';
    return st.picks.map(x => `<button class="mk-prod" data-a="pick" data-id="${esc(x.id)}">${x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy">` : '<i></i>'}<span><b>${esc(x.title)}</b><small>${esc(x.status === 'ACTIVE' ? '' : x.status === 'DRAFT' ? 'Brouillon · ' : 'Archivé · ')}${esc(money(x.priceMin))}</small></span></button>`).join('');
  };
  function paintPicks(): void { const n = root.querySelector('[data-picks]'); if (n) paintIfChanged(n, picksHTML()); }

  // ---------- Rendu ----------
  const cnt = (path: string, max: number, text: string): string => `<em class="mk-n" data-cnt="${path}" data-max="${max}">${text.length} / ${max}</em>`;
  const input = (path: string, v: string, o: { ph?: string; area?: number; list?: boolean } = {}): string => o.area
    ? `<textarea class="field area" data-k="${path}" rows="${o.area}"${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}>${esc(v)}</textarea>`
    : `<input class="field" data-k="${path}"${o.list ? ' data-list' : ''} value="${esc(v)}" autocomplete="off"${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}>`;
  const copy = (path: string): string => `<button class="btn mk-copy" data-a="copy" data-path="${path}" title="Copier">${icon('copy')}Copier</button>`;
  const sel = (path: string, cur2: string, opts: [string, string][]): string => `<select class="field" data-k="${path}">${opts.map(([k, l]) => `<option value="${esc(k)}"${k === cur2 ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  function engineHTML(): string {
    const m = st.machine, e = st.engine, local = gen.localAvailable();
    const best = m ? bestForMarketing(m.installed, m.ram) : null;
    let panel = '';
    if (!m) panel = '<p class="mk-hint">Lecture des modèles installés…</p>';
    else if (e.kind === 'local') {
      const names = [...m.installed].sort((a, b) => (a === best?.model ? -1 : b === best?.model ? 1 : a.localeCompare(b)));
      panel = `<div class="mk-eng-row">${sel('engine.model', e.model, names.map(n => [n, n === best?.model && best.installed ? `${n} (conseillé)` : n]))}</div>`
        + (best?.installed && best.model !== e.model ? `<p class="mk-hint">Conseillé pour le marketing : <b>${esc(best.model)}</b>. ${esc(best.why)} <button class="mk-link" data-a="use-best">L’utiliser</button></p>` : best?.installed ? `<p class="mk-hint">${esc(best.why)}</p>` : '');
    } else panel = ai.ready()
      ? `<p class="mk-hint">Fournisseur réglé dans Studio : <b>${esc(ai.PROVIDERS[ai.config().provider])}</b>.</p>`
      : '<p class="mk-err">Aucune IA n’est configurée (Réglages → Intelligence artificielle).</p>';
    const invite = local && m && !m.installed.length && best
      ? `<div class="mk-invite">${icon('cpu')}<div><b>${m.ok && !m.running ? 'Ollama n’est pas lancé sur ce Mac, ou aucun modèle n’y est installé.' : 'Aucun modèle installé sur ce Mac.'}</b><p>${m.ok ? '' : esc(m.message) + ' '}Pour écrire des textes de vente, <b>${esc(best.model)}</b>${sizeOf(best.model) ? ` (${esc(sizeOf(best.model))})` : ''} est conseillé : ${esc(best.why)} Studio l’installe en un clic depuis la vue Modèles.</p></div><button class="btn" data-a="open-models">Ouvrir les modèles</button></div>`
      : '';
    const privacy = e.kind === 'local' ? 'Avec un modèle local, rien ne quitte ton Mac.' : `Les données du produit sont envoyées à ${esc(ai.PROVIDERS[ai.config().provider])}.`;
    return `<div class="mk-eng-top"><b>Moteur</b><div class="mk-seg">
      <button data-a="engine" data-kind="local" aria-pressed="${e.kind === 'local'}"${local ? '' : ' disabled title="Disponible dans l’app Mac."'}>Modèle local</button>
      <button data-a="engine" data-kind="studio" aria-pressed="${e.kind === 'studio'}">IA de Studio</button></div></div>${panel}${invite}<p class="mk-priv">${icon('shield')}${privacy}</p>`;
  }

  function sourceHTML(): string {
    const head = `<div class="mk-src-top"><b>Produit</b>${st.shop ? `<div class="mk-seg"><button data-a="mode" data-mode="shop" aria-pressed="${st.mode === 'shop'}">Ma boutique</button><button data-a="mode" data-mode="free" aria-pressed="${st.mode === 'free'}">Saisie libre</button></div>` : '<span class="mk-hint">Boutique non reliée : décris le produit ci-dessous.</span>'}</div>`;
    if (st.mode === 'free') {
      return `${head}<div class="mk-grid">
        <label class="mk-f"><span>Nom du produit</span>${input('free.title', st.free.title)}</label>
        <label class="mk-f"><span>Prix (facultatif)</span>${input('free.price', st.free.price, { ph: '29,90 €' })}</label>
        <label class="mk-f mk-wide"><span>Détails : matière, taille, usage, points forts…</span>${input('free.details', st.free.details, { area: 3 })}</label>
        <label class="mk-f mk-wide"><span>Lien de la page produit (facultatif)</span>${input('free.link', st.free.link, { ph: 'https://' })}</label></div>`;
    }
    const x = st.product;
    if (x) return `${head}<div class="mk-chosen">${x.image ? `<img src="${esc(x.image)}" alt="">` : '<i></i>'}<span><b>${esc(x.title)}</b><small>${esc(money(x.priceMin))}${x.stock !== null ? ` · ${x.stock} en stock` : ''}</small></span><button class="btn" data-a="change">Changer</button></div>`;
    return `${head}<input class="field" data-k="pickQ" type="search" value="${esc(st.pickQ)}" placeholder="Chercher un produit de ${esc(st.shop?.name || st.shop?.domain || 'la boutique')}" autocomplete="off"><div class="mk-picks" data-picks>${picksHTML()}</div>`;
  }

  function settingsHTML(): string {
    return `<div class="mk-grid mk-set">
      <label class="mk-f"><span>Ton</span>${sel('set.tone', st.set.tone, gen.TONES)}</label>
      <label class="mk-f"><span>Langue</span>${sel('set.lang', st.set.lang, gen.LANGS)}</label>
      <label class="mk-f"><span>Public visé</span>${input('set.audience', st.set.audience, { ph: 'Ex. : parents de jeunes enfants' })}</label>
      <label class="mk-f"><span>À mettre en avant</span>${input('set.points', st.set.points, { ph: 'Ex. : fabriqué en France, livraison rapide' })}</label>
      ${st.mode === 'shop' && st.product ? `<label class="mk-check mk-wide"><input type="checkbox" data-k="useNote"${st.useNote ? ' checked' : ''}> S’appuyer sur la note du produit <small>${st.noteN === null ? '' : st.noteN ? `(${st.noteN} note${st.noteN > 1 ? 's' : ''} liée${st.noteN > 1 ? 's' : ''})` : '(aucune note pour l’instant)'}</small></label>` : ''}</div>`;
  }

  const busyHTML = (): string => st.busy ? `<div class="mk-busy"><span class="mk-spin"></span><span>${esc(st.busy.work === 'fiche' ? 'Rédaction de la fiche' : st.busy.work === 'marketplace' ? 'Rédaction de l’annonce' : 'Rédaction des textes')} avec ${esc(gen.engineLabel(st.engine))}… <span data-elapsed>${dur(Date.now() - st.busy.since)}</span></span><button class="btn" data-a="stop">${icon('stop')}Arrêter</button></div>` : '';

  const actions = (extra: string): string => {
    const d = st.done[st.work];
    return `<div class="mk-acts">${extra}<button class="btn" data-a="note"${st.mode === 'shop' && st.product ? '' : ' disabled title="Relie d’abord un produit de ta boutique."'}>${icon('notes')}Garder dans une note</button><button class="btn" data-a="regen">${icon('refresh')}Régénérer</button></div>
      <div class="mk-adjust"><label class="mk-f"><span>Ajuste</span>${input('adjust', st.adjust, { ph: 'Ex. : plus court, mets le prix en avant, tutoie' })}</label><button class="btn" data-a="adjust">Appliquer</button></div>
      ${d ? `<p class="mk-hint">Écrit en ${esc(dur(d.ms))} avec ${esc(d.by)}. Relis avant d’utiliser : le modèle peut se tromper.</p>` : ''}`;
  };

  function ficheHTML(f: Fiche): string {
    const c = st.mode === 'shop' ? st.product : null;
    const row = (label: string, now: string, mine: string): string => `<div class="mk-cmp"><span class="mk-k">${label}</span><div class="mk-now">${now || '<em>—</em>'}</div><div class="mk-new">${mine}</div></div>`;
    return `<div class="mk-cmp mk-cmp-head"><span></span><span>Actuel</span><span>Proposé (modifiable)</span></div>
      ${row('Titre', esc(c?.title ?? ''), input('out.fiche.title', f.title))}
      ${row('Description', c ? gen.cleanHtml(c.descriptionHtml) : '', `<div class="field mk-edit" contenteditable="true" role="textbox" aria-multiline="true" data-k="out.fiche.descriptionHtml" data-html>${gen.cleanHtml(f.descriptionHtml)}</div>`)}
      ${row(`Titre SEO ${cnt('out.fiche.seoTitle', 60, f.seoTitle)}`, esc(c?.seoTitle ?? ''), input('out.fiche.seoTitle', f.seoTitle))}
      ${row(`Description SEO ${cnt('out.fiche.seoDescription', 155, f.seoDescription)}`, esc(c?.seoDescription ?? ''), input('out.fiche.seoDescription', f.seoDescription, { area: 3 }))}
      ${row('Étiquettes', esc((c?.tags ?? []).join(', ')), input('out.fiche.tags', f.tags.join(', '), { list: true }))}
      ${actions(`<button class="btn btn-primary" data-a="send"${st.mode === 'shop' && st.product && !st.sending ? '' : ' disabled'}>${icon('upload')}Envoyer sur Shopify</button>`)}`;
  }

  function listingHTML(l: Listing): string {
    const line = (label: string, field: string, path: string): string => `<div class="mk-line"><span class="mk-k">${label}</span><div class="mk-new">${field}</div>${copy(path)}</div>`;
    return `<p class="mk-note">${icon('shield')}Meta ne permet pas de publier une annonce Marketplace par programme : tu copies chaque champ dans le formulaire de Marketplace. Pour vendre sans copier-coller, passe par le catalogue du canal « Facebook &amp; Instagram » de Shopify.</p>
      ${line(`Titre ${cnt('out.marketplace.title', 60, l.title)}`, input('out.marketplace.title', l.title), 'out.marketplace.title')}
      ${line('Prix', input('out.marketplace.price', l.price), 'out.marketplace.price')}
      ${line('État', sel('out.marketplace.condition', l.condition, [...new Set([l.condition, ...gen.CONDITIONS])].map(x => [x, x])), 'out.marketplace.condition')}
      ${line('Catégorie suggérée', input('out.marketplace.category', l.category), 'out.marketplace.category')}
      ${line('Description', input('out.marketplace.description', l.description, { area: 8 }), 'out.marketplace.description')}
      ${line('Mots-clés', input('out.marketplace.keywords', l.keywords.join(', '), { list: true }), 'out.marketplace.keywords')}
      ${actions(`<a class="btn btn-primary" href="${MARKETPLACE}" target="_blank" rel="noopener">${icon('share')}Ouvrir Marketplace</a><button class="btn" data-a="copy-all">${icon('copy')}Tout copier</button>`)}`;
  }

  function adsHTML(a: AdSet): string {
    const link = st.mode === 'shop' ? st.product?.onlineUrl ?? '' : st.free.link.trim();
    return `<div class="mk-variants">${a.variants.map((v, i) => {
      const b = `out.pub.variants.${i}`;
      return `<section class="mk-var"><div class="mk-var-top"><b>Variante ${i + 1}</b>${v.angle ? `<span class="mk-tag">${esc(v.angle)}</span>` : ''}</div>
        <label class="mk-f"><span>Texte principal ${cnt(`${b}.primaryText`, 125, v.primaryText)}</span>${input(`${b}.primaryText`, v.primaryText, { area: 3 })}</label>
        <label class="mk-f"><span>Titre ${cnt(`${b}.headline`, 40, v.headline)}</span>${input(`${b}.headline`, v.headline)}</label>
        <label class="mk-f"><span>Description ${cnt(`${b}.description`, 30, v.description)}</span>${input(`${b}.description`, v.description)}</label>
        <div class="mk-acts"><button class="btn" data-a="copy-var" data-i="${i}">${icon('copy')}Copier</button><button class="btn btn-primary" data-a="campaign" data-i="${i}">${icon('plug')}Créer la campagne</button></div></section>`;
    }).join('')}</div>${link ? '' : '<p class="mk-hint">Sans lien de page produit, tu le renseigneras dans la fenêtre de la campagne.</p>'}${actions('')}`;
  }

  function outHTML(): string {
    if (st.busy) return busyHTML();
    const w = st.work, o = st.out[w];
    const err = st.err ? `<p class="mk-err">${esc(st.err)}</p>` : '';
    if (!o) {
      const ready = hasSource() && gen.engineReady(st.engine);
      return `${err}<div class="mk-go"><button class="btn btn-primary" data-a="gen"${ready ? '' : ' disabled'}>${icon('sparkle')}Générer</button><span class="mk-hint">${hasSource() ? gen.engineReady(st.engine) ? esc(WORKS.find(x => x[0] === w)?.[2] ?? '') : 'Choisis un moteur ci-dessus.' : st.mode === 'shop' ? 'Choisis d’abord un produit.' : 'Donne au moins le nom du produit.'}</span></div>`;
    }
    return err + (w === 'fiche' ? ficheHTML(o as Fiche) : w === 'marketplace' ? listingHTML(o as Listing) : adsHTML(o as AdSet));
  }

  function render(): void {
    // Une relecture asynchrone (modèles installés, notes) ne doit pas faire perdre le champ en cours de saisie.
    const act = document.activeElement, key = act instanceof HTMLElement && root.contains(act) ? act.dataset.k : undefined;
    const sel0 = act instanceof HTMLInputElement || act instanceof HTMLTextAreaElement ? [act.selectionStart, act.selectionEnd] as const : null;
    const changed = paintIfChanged(root, `<section class="mk-box mk-engine">${engineHTML()}</section>
      <section class="mk-box">${sourceHTML()}</section>
      <nav class="mk-tabs" role="tablist">${WORKS.map(([k, l]) => `<button role="tab" data-a="work" data-w="${k}" aria-selected="${st.work === k}">${l}${st.out[k] ? '<i></i>' : ''}</button>`).join('')}</nav>
      <section class="mk-box">${settingsHTML()}</section>
      <section class="mk-out">${outHTML()}</section>`);
    if (changed && key) {
      const back = [...root.querySelectorAll<HTMLElement>('[data-k]')].find(n => n.dataset.k === key);
      if (back) { back.focus(); if (sel0 && (back instanceof HTMLInputElement || back instanceof HTMLTextAreaElement) && back.type !== 'checkbox' && back.type !== 'search') back.setSelectionRange(sel0[0], sel0[1]); }
    }
    counters();
    if (st.mode === 'shop' && !st.product && !st.picks.length && !st.pickBusy && !st.pickErr) void loadPicks(st.pickQ);
  }

  // ---------- Saisie ----------
  const walk = (path: string): [Record<string, unknown>, string] | null => {
    const ks = path.split('.'), last = ks.pop();
    if (!last) return null;
    let o: unknown = st;
    for (const k of ks) { if (k === '__proto__' || !o || typeof o !== 'object') return null; o = (o as Record<string, unknown>)[k]; }
    return o && typeof o === 'object' ? [o as Record<string, unknown>, last] : null;
  };
  const get = (path: string): unknown => { const w = walk(path); return w ? w[0][w[1]] : undefined; };
  const put = (path: string, v: unknown): void => { const w = walk(path); if (w) w[0][w[1]] = v; };
  const text = (path: string): string => { const v = get(path); return Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : v == null ? '' : String(v); };
  function counters(): void {
    for (const n of root.querySelectorAll<HTMLElement>('[data-cnt]')) {
      const len = text(n.dataset.cnt ?? '').length, max = Number(n.dataset.max);
      n.textContent = `${len} / ${max}`; n.classList.toggle('over', len > max);
    }
  }
  let typing = 0;
  function sync(e: Event): void {
    const el = target(e).closest<HTMLElement>('[data-k]'); if (!el) return;
    const path = el.dataset.k ?? '';
    if (el instanceof HTMLInputElement && el.type === 'checkbox') put(path, el.checked);
    else if (el.isContentEditable) put(path, gen.cleanHtml(el.innerHTML));
    else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      put(path, 'list' in el.dataset ? el.value.split(/[,;]/).map(s => s.trim()).filter(Boolean) : el.value);
    }
    if (path.startsWith('set.')) localStorage.setItem(SET_KEY, JSON.stringify({ tone: st.set.tone, lang: st.set.lang }));
    if (path === 'engine.model') gen.saveEngine(st.engine);
    if (path === 'useNote' || path.startsWith('set.tone') || path === 'engine.model') return;
    if (path === 'pickQ') { window.clearTimeout(typing); typing = window.setTimeout(() => void loadPicks(st.pickQ), 300); return; }
    counters();
    if (path.startsWith('free.title')) { const g = root.querySelector<HTMLButtonElement>('[data-a=gen]'); if (g) g.disabled = !hasSource() || !gen.engineReady(st.engine); }
  }
  root.addEventListener('input', sync);
  root.addEventListener('paste', e => { // dans l'éditeur de la description, on ne colle que du texte
    const n = target(e).closest<HTMLElement>('[contenteditable]'); if (!n) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
  });
  root.addEventListener('change', e => { sync(e); if (target(e).closest('[data-k^="engine."]')) render(); });

  // ---------- Génération ----------
  async function go(adjust: boolean): Promise<void> {
    if (st.busy) return;
    const work = st.work;
    if (!hasSource()) { st.err = 'Choisis d’abord un produit.'; return render(); }
    if (!gen.engineReady(st.engine)) { st.err = 'Aucun moteur disponible : installe un modèle ou configure l’IA de Studio.'; return render(); }
    const mine = ++st.run, since = Date.now(), previous = adjust && st.out[work] ? JSON.stringify(st.out[work]) : '';
    st.busy = { work, since }; st.err = ''; render();
    try {
      const notes = await noteText();
      const out = await gen.generate(st.engine, { work, facts: factsText(), notes, set: { ...st.set }, adjust: adjust ? st.adjust.trim() : '', previous }, () => mine === st.run);
      if (mine !== st.run) return;
      (st.out as Record<string, unknown>)[work] = out;
      st.done[work] = { ms: Date.now() - since, by: gen.engineLabel(st.engine) };
      st.adjust = '';
    } catch (e) { if (mine === st.run) st.err = errMsg(e); }
    if (mine === st.run) { st.busy = null; render(); }
  }

  // ---------- Notes ----------
  function noteMarkdown(): string {
    const w = st.work, when = `${nowText()}, ${gen.engineLabel(st.engine)}`;
    if (w === 'fiche' && st.out.fiche) {
      const f = st.out.fiche;
      return `## Fiche produit proposée (${when})\n\n**Titre** : ${f.title}\n\n${gen.htmlToMd(f.descriptionHtml)}\n\n**Titre SEO** : ${f.seoTitle}\n\n**Description SEO** : ${f.seoDescription}\n\n**Étiquettes** : ${f.tags.join(', ')}`;
    }
    if (w === 'marketplace' && st.out.marketplace) {
      const l = st.out.marketplace;
      return `## Annonce Marketplace (${when})\n\n**Titre** : ${l.title}\n\n**Prix** : ${l.price}\n\n**État** : ${l.condition}\n\n**Catégorie** : ${l.category}\n\n${l.description}\n\n**Mots-clés** : ${l.keywords.join(', ')}`;
    }
    const a = st.out.pub;
    return a ? `## Textes de pub (${when})\n\n${a.variants.map((v, i) => `### Variante ${i + 1}${v.angle ? ` : ${v.angle}` : ''}\n\n- Texte principal : ${v.primaryText}\n- Titre : ${v.headline}\n- Description : ${v.description}`).join('\n\n')}` : '';
  }
  async function keep(): Promise<void> {
    const x = st.product, md = noteMarkdown().replace(/```/g, '’’’');
    if (!x || !md) return;
    try {
      const n = await noteFor(p, x);
      await ai.appendTo(n, md);
      toast(`Gardé dans la note « ${n.title} ».`);
      void countNotes();
    } catch (e) { st.err = errMsg(e); render(); }
  }

  // ---------- Shopify ----------
  async function send(): Promise<void> {
    const f = st.out.fiche, x = st.product, shop = st.shop;
    if (!f || !x || !shop || st.sending) return;
    const patch: Parameters<typeof shopify.updateProduct>[2] = {}, names: string[] = [];
    if (f.title && f.title !== x.title) { patch.title = f.title; names.push('le titre'); }
    const html = gen.cleanHtml(f.descriptionHtml);
    if (html && html !== gen.cleanHtml(x.descriptionHtml)) { patch.descriptionHtml = html; names.push('la description'); }
    if (f.seoTitle && f.seoTitle !== x.seoTitle) { patch.seoTitle = f.seoTitle; names.push('le titre SEO'); }
    if (f.seoDescription && f.seoDescription !== x.seoDescription) { patch.seoDescription = f.seoDescription; names.push('la description SEO'); }
    if (f.tags.length && f.tags.join('|') !== x.tags.join('|')) { patch.tags = f.tags; names.push('les étiquettes'); }
    if (!names.length) { toast('Rien ne change par rapport à la fiche actuelle.'); return; }
    const ok = await confirmBox({
      title: 'Envoyer sur Shopify ?', ok: 'Envoyer',
      text: `Sur ${shop.name || shop.domain}, pour « ${x.title} », Studio remplace ${names.join(', ')} par ta version. Le contenu actuel est écrasé : garde-le dans une note avant si tu veux pouvoir le retrouver. Le statut du produit ne change pas.`,
    });
    if (!ok) return;
    st.sending = true; st.err = ''; render();
    try {
      await shopify.updateProduct(shop, x.id, patch);
      shopify.forget(shop.domain);
      if (patch.title) x.title = patch.title;
      if (patch.descriptionHtml) { x.descriptionHtml = patch.descriptionHtml; x.description = gen.htmlText(patch.descriptionHtml); }
      if (patch.seoTitle) x.seoTitle = patch.seoTitle;
      if (patch.seoDescription) x.seoDescription = patch.seoDescription;
      if (patch.tags) x.tags = patch.tags;
      toast('Fiche envoyée sur Shopify.');
    } catch (e) { st.err = errMsg(e); }
    st.sending = false; render();
  }

  // ---------- Clics ----------
  const write = (t: string, what = 'Copié.'): void => { void navigator.clipboard.writeText(t).then(() => toast(what), () => toast('Copie impossible : sélectionne le texte à la main.')); };
  root.addEventListener('click', ev => {
    const b = target(ev).closest<HTMLElement>('[data-a]'); if (!b || !root.contains(b)) return;
    const a = b.dataset.a, i = Number(b.dataset.i);
    if (a === 'engine') {
      const kind = b.dataset.kind === 'local' ? 'local' : 'studio';
      const best = kind === 'local' && st.machine ? bestForMarketing(st.machine.installed, st.machine.ram) : null;
      st.engine = kind === 'local' ? { kind: 'local', model: best?.installed ? best.model : st.machine?.installed[0] ?? '' } : { kind: 'studio', model: '' };
      gen.saveEngine(st.engine); render();
    } else if (a === 'use-best') {
      const best = st.machine ? bestForMarketing(st.machine.installed, st.machine.ram) : null;
      if (best?.installed) { st.engine = { kind: 'local', model: best.model }; gen.saveEngine(st.engine); render(); }
    } else if (a === 'open-models') {
      if (app) void app.setView({ type: 'models' }); else toast('Ouvre la vue Modèles depuis la barre latérale.');
    } else if (a === 'mode') { st.mode = b.dataset.mode === 'free' ? 'free' : 'shop'; render(); }
    else if (a === 'work') { st.work = (b.dataset.w ?? 'fiche') as Work; st.err = ''; render(); }
    else if (a === 'pick') {
      const x = st.picks.find(v => v.id === b.dataset.id); if (!x) return;
      st.product = x; st.out = {}; st.done = {}; st.err = ''; st.useNote = false; void countNotes(); render();
    } else if (a === 'change') { st.product = null; st.noteN = null; st.out = {}; st.done = {}; st.err = ''; render(); }
    else if (a === 'gen' || a === 'regen') void go(false);
    else if (a === 'adjust') { if (!st.adjust.trim()) { toast('Écris d’abord ce que tu veux changer.'); return; } void go(true); }
    else if (a === 'stop') { st.run++; st.busy = null; render(); toast('Arrêté. Le modèle peut finir sa réponse en arrière-plan.'); }
    else if (a === 'copy') write(text(b.dataset.path ?? ''));
    else if (a === 'copy-all') { const l = st.out.marketplace; if (l) write(`${l.title}\n\nPrix : ${l.price}\nÉtat : ${l.condition}\nCatégorie : ${l.category}\n\n${l.description}\n\nMots-clés : ${l.keywords.join(', ')}`, 'Annonce copiée.'); }
    else if (a === 'copy-var') { const v = st.out.pub?.variants[i]; if (v) write(`${v.primaryText}\n\n${v.headline}\n${v.description}`.trim()); }
    else if (a === 'note') void keep();
    else if (a === 'send') void send();
    else if (a === 'campaign') {
      const v = st.out.pub?.variants[i]; if (!v) return;
      const x = st.mode === 'shop' ? st.product : null;
      const d: Partial<AdDraft> = { name: `${titleOf()}${v.angle ? ` · ${v.angle}` : ''}`.slice(0, 120), primaryText: v.primaryText, headline: v.headline };
      const link = x?.onlineUrl || (st.mode === 'free' ? st.free.link.trim() : '');
      if (link) d.link = link;
      if (v.description) d.description = v.description;
      if (x?.image) d.imageUrl = x.image;
      ads.compose(p, d);
    }
  });

  // ---------- Démarrage ----------
  let seen = false;
  const tick = window.setInterval(() => {
    if (!root.isConnected) { if (seen) window.clearInterval(tick); return; }
    seen = true;
    const n = root.querySelector('[data-elapsed]');
    if (n && st.busy && !document.hidden) n.textContent = dur(Date.now() - st.busy.since);
  }, 1000);

  const refresh = async (): Promise<void> => {
    try {
      const m = await gen.machine();
      st.machine = m;
      st.engine = gen.pickEngine(m);
    } catch (e) { st.machine = { installed: [], ram: null, running: false, ok: false, message: errMsg(e) }; }
    render();
  };
  render();
  void refresh();
  if (st.product) void countNotes();
}
