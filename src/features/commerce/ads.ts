// Publicité Meta d'une boutique : section « Publicité » de l'onglet Boutique, fenêtre « Nouvelle campagne »,
// bloc « Meta » des Réglages → Boutiques. Rien n'est jamais activé sans demander : tout est créé en pause.
// Honnêteté : Meta n'offre aucune API pour publier une annonce Marketplace de particulier ; Marketplace n'est ici
// qu'un emplacement de diffusion d'une pub payante (Marketing API), et le catalogue se synchronise par Shopify.
import { esc } from '../../lib/markdown.ts';
import { el, icon, modal, confirmBox, toast, errMsg, paintIfChanged, target, need, $ } from '../../ui/kit.ts';
import * as chart from '../../ui/chart.ts';
import * as vault from '../../core/vault.ts';
import * as meta from '../../integrations/meta/api.ts';
import * as model from '../projects/model.ts';
import type { Project } from '../projects/model.ts';
import type { AdDraft, Campaign, AdStats } from '../../integrations/meta/api.ts';

type Range = 'today' | '7d' | '30d';
type Insights = Awaited<ReturnType<typeof meta.insights>>;
const RANGES: [Range, string][] = [['today', 'Aujourd’hui'], ['7d', '7 jours'], ['30d', '30 jours']];

const money = (n: number, cur: string): string => {
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur || 'EUR' }).format(n); }
  catch { return `${n.toFixed(2)} ${cur}`; }
};
const int = (n: number): string => Math.round(n).toLocaleString('fr-FR');
const dec = (n: number, d = 2): string => n.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
const STATUS: Record<string, [string, string]> = {
  ACTIVE: ['En diffusion', 'on'], PAUSED: ['En pause', ''], CAMPAIGN_PAUSED: ['En pause', ''], ADSET_PAUSED: ['En pause', ''],
  PENDING_REVIEW: ['En revue', 'warn'], IN_PROCESS: ['En revue', 'warn'], WITH_ISSUES: ['Problème', 'down'], DISAPPROVED: ['Refusée', 'down'],
  ARCHIVED: ['Archivée', ''], DELETED: ['Supprimée', ''],
};
const PLACEMENTS: Record<string, string> = {
  'facebook/marketplace': 'Marketplace', 'facebook/feed': 'Fil Facebook', 'facebook/facebook_stories': 'Stories Facebook', 'facebook/facebook_reels': 'Reels Facebook',
  'facebook/video_feeds': 'Vidéos Facebook', 'facebook/right_hand_column': 'Colonne de droite', 'facebook/search': 'Recherche Facebook', 'facebook/instream_video': 'Vidéos in-stream',
  'instagram/stream': 'Fil Instagram', 'instagram/story': 'Stories Instagram', 'instagram/ig_search': 'Recherche Instagram', 'instagram/reels': 'Reels Instagram', 'instagram/profile_feed': 'Profil Instagram',
  'messenger/messenger_inbox': 'Messenger', 'messenger/story': 'Stories Messenger', 'audience_network/classic': 'Audience Network',
};
const placementName = (k: string): string => PLACEMENTS[k] ?? k.replace('/', ' · ').replace(/_/g, ' ');

// ---------- Section « Publicité » ----------
interface View { range: Range; data: { ins: Insights; camps: Campaign[] } | null; error: string; loading: boolean; accounts: { id: string; name: string; currency: string }[] | null; accError: string }

export function mount(box: HTMLElement, p: Project): void {
  const root = el('<div class="ad-root"></div>');
  box.replaceChildren(root);
  const v: View = { range: '7d', data: null, error: '', loading: false, accounts: null, accError: '' };
  let seq = 0;
  const alive = (): boolean => root.isConnected;

  const paint = (): void => {
    if (!alive()) return;
    if (!meta.supported()) { paintIfChanged(root, notMac()); return; }
    if (!meta.connected() || !p.meta) { paintIfChanged(root, setup(p, v)); return; }
    paintIfChanged(root, dashboard(p, v));
    chart.bindTips(root);
  };
  const load = async (fresh = false): Promise<void> => {
    if (!p.meta || !meta.connected() || !alive()) return;
    const mine = ++seq, acct = p.meta, range = v.range;
    if (fresh) meta.forget();
    v.loading = !v.data; paint();
    try {
      const [ins, camps] = await Promise.all([meta.insights(acct, range), meta.campaigns(acct, range)]);
      if (mine !== seq) return;
      v.data = { ins, camps }; v.error = '';
    } catch (e) { if (mine !== seq) return; v.error = errMsg(e); }
    v.loading = false; paint();
  };
  const loadAccounts = async (): Promise<void> => {
    if (v.accounts || !meta.connected()) return;
    try { v.accounts = await meta.accounts(); v.accError = ''; } catch (e) { v.accError = errMsg(e); }
    paint();
  };

  root.addEventListener('click', e => {
    const t = target(e), b = t.closest<HTMLElement>('[data-ad]');
    if (!b || !root.contains(b)) return;
    const act = b.dataset['ad'] ?? '', id = b.dataset['id'] ?? '';
    if (act === 'range') { v.range = (b.dataset['v'] as Range) || '7d'; v.data = null; void load(); }
    else if (act === 'refresh') void load(true);
    else if (act === 'new') compose(p, {});
    else if (act === 'account') void pick(b.dataset['v'] ?? '');
    else if (act === 'pause' || act === 'activate') void toggle(id, act === 'activate');
    else if (act === 'budget') void budget(id);
  });

  async function pick(id: string): Promise<void> {
    try { await model.setField(p, 'meta', id); p.meta = model.adAccount(id) ?? id; toast('Compte publicitaire choisi'); v.data = null; paint(); void load(); }
    catch (e) { toast(errMsg(e)); }
  }
  const find = (id: string): Campaign | undefined => v.data?.camps.find(c => c.id === id);
  async function toggle(id: string, on: boolean): Promise<void> {
    const c = find(id); if (!c) return;
    const ok = await confirmBox(on
      ? { title: 'Activer cette campagne ?', ok: 'Activer', text: `« ${c.name} » va commencer à diffuser et à dépenser de l’argent réel, à hauteur de ${c.dailyBudget != null ? `${money(c.dailyBudget, v.data?.ins.currency ?? '')} par jour` : 'son budget'} sur ton compte publicitaire. Meta peut d’abord la passer en revue.` }
      : { title: 'Mettre cette campagne en pause ?', ok: 'Mettre en pause', text: `« ${c.name} » arrête de diffuser et de dépenser. Tu pourras la réactiver quand tu veux.` });
    if (!ok) return;
    try { await meta.setStatus(id, on ? 'ACTIVE' : 'PAUSED'); toast(on ? 'Campagne activée' : 'Campagne en pause'); } catch (e) { toast(errMsg(e)); }
    void load(true);
  }
  async function budget(id: string): Promise<void> {
    const c = find(id); if (!c) return;
    const cur = v.data?.ins.currency ?? '';
    const m = modal({ title: 'Changer le budget par jour', cls: 'small', html: `<form class="ad-form"><p class="modal-text">Budget par jour de « ${esc(c.name)} » (${esc(cur)}).</p><input class="field" name="b" type="number" min="1" step="0.01" value="${c.dailyBudget ?? ''}" required autofocus><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Continuer</button></div></form>` });
    need('[data-x]', m.node).onclick = () => m.close();
    need<HTMLFormElement>('form', m.node).onsubmit = async ev => {
      ev.preventDefault();
      const n = Number(need<HTMLInputElement>('[name=b]', m.node).value);
      if (!(n > 0)) { toast('Entre un budget supérieur à 0'); return; }
      m.close();
      if (!await confirmBox({ title: 'Changer le budget ?', ok: 'Changer', text: `Le budget par jour de « ${c.name} » passera de ${c.dailyBudget != null ? money(c.dailyBudget, cur) : 'sa valeur actuelle'} à ${money(n, cur)}.${c.status === 'ACTIVE' ? ' La campagne diffuse : la dépense réelle suivra ce nouveau budget.' : ''}` })) return;
      try { await meta.setBudget(id, n); toast('Budget changé'); } catch (e) { toast(errMsg(e)); }
      void load(true);
    };
  }

  paint();
  if (meta.connected() && !p.meta) void loadAccounts();
  void load();
  const t = setInterval(() => { if (!alive()) clearInterval(t); else if (!document.hidden) void load(); }, 60e3);
}

const notMac = (): string => `<div class="ad-empty"><h3>${icon('bolt')}Publicité Meta</h3><p>${meta.whyNot()}</p></div>`;

const NOTE = `<p class="ad-note">${icon('shield')}Meta ne propose aucune API pour publier une annonce Marketplace de particulier : Studio crée des <strong>publicités payantes</strong> dont Marketplace est l’un des emplacements. Le catalogue produits se synchronise par le canal « Facebook &amp; Instagram » de Shopify, à régler dans Shopify.</p>`;

function setup(p: Project, v: View): string {
  const connected = meta.connected();
  const steps = [
    'Crée une app Meta de type <strong>Business</strong> sur developers.facebook.com, puis, dans Meta Business Suite, un <strong>utilisateur système</strong> auquel tu attribues ton compte publicitaire et ta Page.',
    'Génère son jeton avec les droits <code>ads_management</code>, <code>ads_read</code>, <code>business_management</code> et <code>pages_read_engagement</code>.',
    'Colle ce jeton dans <strong>Réglages → Boutiques → Meta</strong> (avec l’identifiant de ta Page).',
    'Choisis ici le compte publicitaire de cette boutique.',
  ];
  const accounts = !connected ? '' : v.accError ? `<p class="ad-err">${esc(v.accError)}</p>`
    : !v.accounts ? '<p class="ad-sub">Lecture de tes comptes publicitaires…</p>'
    : v.accounts.length ? `<div class="ad-accts">${v.accounts.map(a => `<button class="btn" data-ad="account" data-v="${esc(a.id)}">${esc(a.name)} <span class="ad-sub">${esc(a.id)} · ${esc(a.currency)}</span></button>`).join('')}</div>`
    : '<p class="ad-sub">Aucun compte publicitaire visible avec ce jeton : attribue-le à l’utilisateur système dans Meta Business Suite.</p>';
  return `<div class="ad-empty"><h3>${icon('bolt')}Publicité Meta</h3>
    <p>Pilote les campagnes Facebook et Instagram de « ${esc(p.name)} » depuis Studio : chiffres, pause, budget, nouvelle campagne.</p>
    <ol class="ad-steps">${steps.map((s, i) => `<li class="${i === (connected ? 3 : 0) ? 'now' : ''}"><span>${i + 1}</span><div>${s}</div></li>`).join('')}</ol>${accounts}${NOTE}</div>`;
}

function stat(label: string, value: string, hint = ''): string {
  return `<div class="ad-stat"><span class="ad-k">${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<span class="ad-sub">${esc(hint)}</span>` : ''}</div>`;
}
function stats(s: AdStats, cur: string): string {
  return `<div class="ad-stats">${stat('Dépense', money(s.spend, cur))}${stat('Impressions', int(s.impressions))}${stat('Clics', int(s.clicks))}${stat('CTR', `${dec(s.ctr)} %`)}${stat('CPC', s.clicks ? money(s.cpc, cur) : '—')}${stat('Achats', int(s.purchases))}${stat('ROAS', s.roas != null ? `${dec(s.roas)} ×` : '—', s.roas == null ? 'sans achats suivis' : '')}</div>`;
}

function dashboard(p: Project, v: View): string {
  const head = `<div class="ad-head"><h3>${icon('bolt')}Publicité</h3><span class="ad-sub">${esc(p.meta ?? '')}</span>
    <div class="ad-range" role="group" aria-label="Période">${RANGES.map(([k, l]) => `<button class="btn${v.range === k ? ' on' : ''}" data-ad="range" data-v="${k}" aria-pressed="${v.range === k}">${l}</button>`).join('')}</div>
    <button class="btn" data-ad="refresh" title="Actualiser">${icon('refresh')}</button><button class="btn btn-primary" data-ad="new">${icon('plus')}Nouvelle campagne</button></div>`;
  if (!v.data) return `<div class="ad-box">${head}${v.error ? `<p class="ad-err">${esc(v.error)}</p>` : '<p class="ad-sub">Chargement des chiffres…</p>'}${NOTE}</div>`;
  const { ins, camps } = v.data, cur = ins.currency;
  const days = v.range === 'today' ? 0 : v.range === '7d' ? 7 : 30;
  const values: Record<string, number> = {};
  for (const d of ins.byDay) values[d.date] = Math.round(d.spend * 100) / 100;
  const graph = days ? `<section class="ad-sec"><h4>Dépense par jour</h4>${chart.bars(chart.lastDays(days, values), { color: 'blue', unit: cur || 'EUR', units: cur || 'EUR', summary: `Dépense par jour sur ${days} jours` })}</section>` : '';
  const total = ins.byPlacement.reduce((a, b) => a + b.spend, 0), max = Math.max(0.0001, ...ins.byPlacement.map(x => x.spend));
  const mp = ins.byPlacement.find(x => x.placement === 'facebook/marketplace');
  const rows = ins.byPlacement.filter(x => x.placement !== 'facebook/marketplace' && (x.spend > 0 || x.impressions > 0)).slice(0, 8);
  const plc = `<section class="ad-sec"><h4>Par emplacement</h4>
    <div class="ad-plc mp"><span class="ad-pn">${icon('pin')}Marketplace</span><span class="ad-bar"><i style="width:${mp && mp.spend > 0 ? Math.max(2, mp.spend / max * 100) : 0}%"></i></span><span class="ad-pv">${mp && (mp.spend || mp.impressions) ? `${esc(money(mp.spend, cur))} · ${esc(int(mp.impressions))} impr.${total && mp.spend ? ` · ${Math.round(mp.spend / total * 100)} %` : ''}` : 'aucune diffusion'}</span></div>
    ${rows.map(x => `<div class="ad-plc"><span class="ad-pn">${esc(placementName(x.placement))}</span><span class="ad-bar"><i style="width:${Math.max(2, x.spend / max * 100)}%"></i></span><span class="ad-pv">${esc(money(x.spend, cur))} · ${esc(int(x.impressions))} impr.</span></div>`).join('')}</section>`;
  const list = `<section class="ad-sec"><h4>Campagnes<span class="ad-sub">${camps.length}</span></h4>${camps.length ? camps.map(c => campRow(c, cur)).join('') : '<p class="ad-sub">Aucune campagne sur ce compte. « Nouvelle campagne » en crée une, toujours en pause.</p>'}</section>`;
  return `<div class="ad-box">${head}${v.error ? `<p class="ad-err">${esc(v.error)}</p>` : ''}${stats(ins.total, cur)}${graph}${plc}${list}${NOTE}</div>`;
}
function campRow(c: Campaign, cur: string): string {
  const [label, tone] = STATUS[c.status] ?? [c.status.toLowerCase().replace(/_/g, ' '), ''];
  const on = c.status === 'ACTIVE';
  return `<div class="ad-row"><span class="ad-dot ${tone}" title="${esc(label)}"></span>
    <div class="ad-main"><strong>${esc(c.name)}</strong><span class="ad-sub">${esc(label)} · ${c.dailyBudget != null ? `${esc(money(c.dailyBudget, cur))} / jour` : 'budget par ensemble'} · ${esc(money(c.stats.spend, cur))} dépensés${c.stats.roas != null ? ` · ROAS ${esc(dec(c.stats.roas))} ×` : ''}</span></div>
    <div class="ad-acts"><button class="btn" data-ad="${on ? 'pause' : 'activate'}" data-id="${esc(c.id)}">${icon(on ? 'pause' : 'play')}${on ? 'Mettre en pause' : 'Activer'}</button><button class="btn" data-ad="budget" data-id="${esc(c.id)}">${icon('pencil')}Budget</button><a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener" title="Ouvrir dans le Gestionnaire de publicités">${icon('link')}</a></div></div>`;
}

// ---------- Fenêtre « Nouvelle campagne » ----------
const LIMITS = { primaryText: 125, headline: 40, description: 30 } as const;
const CTAS: [string, string][] = [['SHOP_NOW', 'Acheter'], ['LEARN_MORE', 'En savoir plus'], ['ORDER_NOW', 'Commander'], ['GET_OFFER', 'Voir l’offre'], ['NO_BUTTON', 'Aucun bouton']];

export function compose(p: Project, d: Partial<AdDraft>): void {
  const c = meta.creds();
  const site = p.site ?? (p.shopify ? `https://${p.shopify}` : '');
  const m = modal({ title: 'Nouvelle campagne', cls: 'ad-modal', html: '<div class="ad-compose"></div>' });
  const host = need('.ad-compose', m.node);
  if (!meta.supported() || !c || !p.meta || !c.page) {
    const why = !meta.supported() ? meta.whyNot()
      : !c ? 'Meta n’est pas connecté : colle ton jeton dans Réglages → Boutiques → Meta.'
      : !p.meta ? 'Choisis d’abord le compte publicitaire dans l’onglet Boutique → Publicité.'
      : 'Renseigne l’identifiant de ta Page Facebook dans Réglages → Boutiques → Meta : une pub est toujours publiée au nom d’une Page.';
    host.innerHTML = `<p class="modal-text">${esc(why)}</p><div class="modal-actions"><button class="btn" data-x>Fermer</button></div>`;
    need('[data-x]', host).onclick = () => m.close();
    return;
  }
  const account = p.meta;
  const val = (k: string, x: string | number | undefined): string => esc(x ?? '');
  const counter = (k: keyof typeof LIMITS, label: string, area: boolean, x: string | undefined): string =>
    `<label class="ad-f"><span>${label} <em data-count="${k}"></em></span>${area ? `<textarea class="field area" name="${k}" rows="3">${esc(x ?? '')}</textarea>` : `<input class="field" name="${k}" value="${val(k, x)}" autocomplete="off">`}</label>`;
  host.innerHTML = `<form class="ad-form ad-cols" novalidate>
    <div class="ad-fields">
      <p class="ad-note">${icon('shield')}Studio crée une campagne <strong>en pause</strong> : rien ne diffuse ni ne dépense tant que tu ne l’actives pas. ${c.pixel ? 'Objectif : ventes (pixel renseigné).' : 'Objectif : trafic vers ta boutique (aucun pixel renseigné).'}</p>
      <label class="ad-f"><span>Nom de la campagne</span><input class="field" name="name" value="${val('name', d.name)}" autocomplete="off" autofocus></label>
      <label class="ad-f"><span>Lien de destination</span><input class="field" name="link" value="${val('link', d.link ?? site)}" autocomplete="off" placeholder="https://"></label>
      ${counter('primaryText', 'Texte principal', true, d.primaryText)}
      ${counter('headline', 'Titre', false, d.headline)}
      ${counter('description', 'Description (facultatif)', false, d.description)}
      <label class="ad-f"><span>Adresse de l’image (https, facultatif)</span><input class="field" name="imageUrl" value="${val('imageUrl', d.imageUrl)}" autocomplete="off" placeholder="https://…"></label>
      <div class="ad-two">
        <label class="ad-f"><span>Budget par jour (${esc(meta.creds() ? 'devise du compte' : '')})</span><input class="field" name="dailyBudget" type="number" min="1" step="0.5" value="${val('dailyBudget', d.dailyBudget ?? 10)}"></label>
        <label class="ad-f"><span>Pays (codes, séparés par des virgules)</span><input class="field" name="countries" value="${esc((d.countries ?? ['FR']).join(', '))}" autocomplete="off"></label>
      </div>
      <div class="ad-two">
        <label class="ad-f"><span>Âge minimum</span><input class="field" name="ageMin" type="number" min="18" max="65" value="${val('ageMin', d.ageMin ?? 18)}"></label>
        <label class="ad-f"><span>Âge maximum</span><input class="field" name="ageMax" type="number" min="18" max="65" value="${val('ageMax', d.ageMax ?? 65)}"></label>
      </div>
      <label class="ad-f"><span>Emplacements</span><select class="field" name="placements">
        <option value="auto"${(d.placements ?? 'auto') === 'auto' ? ' selected' : ''}>Automatique (recommandé) : Meta choisit, Marketplace compris</option>
        <option value="marketplace"${d.placements === 'marketplace' ? ' selected' : ''}>Marketplace (avec le fil Facebook, que Meta exige avec Marketplace)</option>
        <option value="feeds"${d.placements === 'feeds' ? ' selected' : ''}>Fils Facebook et Instagram, sans Marketplace</option></select></label>
      <label class="ad-f"><span>Bouton d’appel</span><select class="field" name="cta">${CTAS.map(([k, l]) => `<option value="${k}"${(d.cta ?? 'SHOP_NOW') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <p class="modal-hint">Longueurs conseillées par Meta : texte principal ~${LIMITS.primaryText}, titre ~${LIMITS.headline}, description ~${LIMITS.description} caractères ; au-delà, l’affichage peut être coupé. Ciblant l’UE, Meta exige un bénéficiaire et un payeur : Studio utilise ceux du compte, sinon le nom saisi dans Réglages → Meta, sinon celui de ta Page.</p>
      <p class="ad-err" data-err hidden></p>
      <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary" data-go>Créer en pause</button></div>
    </div>
    <aside class="ad-preview" aria-label="Aperçu de la pub"><span class="ad-k">Aperçu</span><div class="ad-card"><div class="ad-pg"><i></i><span>Ta Page</span><em>Sponsorisé</em></div><p data-pv="primaryText"></p><div class="ad-img" data-pv="image">Image du lien</div><div class="ad-cta"><div><span data-pv="host"></span><strong data-pv="headline"></strong><span data-pv="description"></span></div><b data-pv="cta"></b></div></div></aside></form>`;
  const form = need<HTMLFormElement>('form', host);
  const f = (n: string): string => need<HTMLInputElement>(`[name=${n}]`, form).value;
  const sync = (): void => {
    for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
      const len = f(k).length, c2 = need(`[data-count=${k}]`, form);
      c2.textContent = `${len} / ${LIMITS[k]}`; c2.classList.toggle('over', len > LIMITS[k]);
    }
    const set = (k: string, t: string): void => { need(`[data-pv=${k}]`, form).textContent = t; };
    set('primaryText', f('primaryText') || 'Le texte principal apparaît ici.');
    set('headline', f('headline') || 'Titre');
    set('description', f('description'));
    let host2 = ''; try { host2 = new URL(f('link')).host.toUpperCase(); } catch { /* lien incomplet */ }
    set('host', host2);
    set('cta', f('cta') === 'NO_BUTTON' ? '' : CTAS.find(x => x[0] === f('cta'))?.[1] ?? '');
    need('[data-pv=image]', form).textContent = f('imageUrl') ? 'Image du lien (non affichée ici)' : 'Image du lien : celle de la page';
  };
  form.addEventListener('input', sync); sync();
  need('[data-x]', form).onclick = () => m.close();
  const err = need('[data-err]', form), go = need<HTMLButtonElement>('[data-go]', form);
  const fail = (t: string): void => { err.textContent = t; err.hidden = !t; };
  form.onsubmit = async ev => {
    ev.preventDefault(); fail('');
    const draft: AdDraft = {
      name: f('name').trim(), link: f('link').trim(), primaryText: f('primaryText').trim(), headline: f('headline').trim(), description: f('description').trim(),
      imageUrl: f('imageUrl').trim(), dailyBudget: Number(f('dailyBudget')), countries: f('countries').split(/[\s,;]+/).map(x => x.toUpperCase()).filter(Boolean),
      ageMin: Number(f('ageMin')) || 18, ageMax: Number(f('ageMax')) || 65, placements: f('placements') as AdDraft['placements'], cta: f('cta'),
    };
    if (!draft.name) return fail('Donne un nom à la campagne.');
    if (!/^https:\/\/\S+$/i.test(draft.link)) return fail('Le lien doit commencer par https://.');
    if (!draft.primaryText) return fail('Écris le texte principal.');
    if (!draft.headline) return fail('Écris le titre.');
    if (draft.imageUrl && !/^https:\/\/\S+$/i.test(draft.imageUrl)) return fail('L’adresse de l’image doit commencer par https://.');
    if (!(draft.dailyBudget > 0)) return fail('Le budget par jour doit être supérieur à 0.');
    if (!draft.countries.length || draft.countries.some(x => !/^[A-Z]{2}$/.test(x))) return fail('Les pays s’écrivent en codes de deux lettres (FR, BE, CH…).');
    if ((draft.ageMax ?? 65) < (draft.ageMin ?? 18)) return fail('L’âge maximum doit être au moins égal à l’âge minimum.');
    const where = { auto: 'emplacements automatiques (Marketplace compris)', marketplace: 'Marketplace et fil Facebook', feeds: 'fils Facebook et Instagram' }[draft.placements];
    if (!await confirmBox({ title: 'Créer cette campagne ?', ok: 'Créer en pause', text: `Studio crée sur ton compte ${account} une campagne, un ensemble de pubs et une pub « ${draft.name} » : ${c.pixel ? 'objectif ventes' : 'objectif trafic'}, ${money(draft.dailyBudget, '')} par jour, ${draft.countries.join(', ')}, ${draft.ageMin}–${draft.ageMax} ans, ${where}. Le tout est créé EN PAUSE : rien ne diffuse ni ne dépense tant que tu ne l’actives pas.` })) return;
    go.disabled = true; go.textContent = 'Création…';
    try {
      const r = await meta.createCampaign(account, draft);
      host.innerHTML = `<p class="modal-text">${icon('check')}Campagne « ${esc(draft.name)} » <strong>créée en pause</strong>. Vérifie-la dans le Gestionnaire de publicités ; elle ne dépensera rien tant que tu ne l’actives pas.</p><div class="modal-actions"><a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">${icon('link')}Ouvrir dans le Gestionnaire</a><button class="btn btn-primary" data-x>Fermer</button></div>`;
      need('[data-x]', host).onclick = () => m.close();
    } catch (e) { fail(errMsg(e)); go.disabled = false; go.textContent = 'Créer en pause'; }
  };
}

// ---------- Réglages → Boutiques : bloc « Meta » ----------
let pageList: { id: string; name: string }[] | null = null, pagesLoading = false, settingsError = '', busy = false;
let current: HTMLElement | null = null;
const typed = { token: '', page: '', pixel: '', dsa: '' };

function settingsHTML(): string {
  const c = meta.creds();
  let body: string;
  if (!meta.supported()) body = `<p>${meta.whyNot()}</p>`;
  else if (!vault.enabled()) body = '<p>Active d’abord le coffre (Réglages → Coffre) : le jeton Meta y est gardé chiffré.</p>';
  else if (!vault.isOpen()) body = '<p>Le coffre est verrouillé : déverrouille-le pour gérer le jeton Meta.</p>';
  else {
    const page = c?.page ?? typed.page, pixel = c?.pixel ?? typed.pixel, dsa = c?.dsa ?? typed.dsa;
    const pages = (pageList ?? []).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    body = `<form class="ad-form" data-ad-set>
      ${c ? `<div class="cx-key">${icon('key')}<span>Connecté : <strong>${esc(c.name || 'compte Meta')}</strong> <code>••••${esc(c.token.slice(-4))}</code></span></div>`
        : `<label class="ad-f"><span>Jeton Meta (utilisateur système)</span><input type="password" class="field" name="token" value="${esc(typed.token)}" placeholder="EAA…" autocomplete="off" spellcheck="false"></label>`}
      <label class="ad-f"><span>Identifiant de la Page Facebook</span><input class="field" name="page" value="${esc(page)}" list="ad-pages" placeholder="123456789012345" autocomplete="off"></label><datalist id="ad-pages">${pages}</datalist>
      <label class="ad-f"><span>Pixel Meta (facultatif : objectif ventes au lieu de trafic)</span><input class="field" name="pixel" value="${esc(pixel)}" autocomplete="off"></label>
      <label class="ad-f"><span>Nom du bénéficiaire et payeur pour cibler l’UE (facultatif)</span><input class="field" name="dsa" value="${esc(dsa)}" placeholder="Nom de ton entreprise" autocomplete="off"></label>
      ${settingsError ? `<p class="ad-err">${esc(settingsError)}</p>` : ''}
      <div class="cx-grid"><button class="btn btn-primary" data-ad-go${busy ? ' disabled' : ''}>${c ? 'Enregistrer' : 'Connecter'}</button>${c ? '<button type="button" class="btn btn-danger" data-ad-off>Déconnecter</button>' : ''}</div></form>
      <p class="modal-hint">Utilisateur système Meta avec les droits <code>ads_management</code>, <code>ads_read</code>, <code>business_management</code> et <code>pages_read_engagement</code>. Le jeton ne part que vers <code>graph.facebook.com</code>, par l’app. Rien n’est jamais activé sans ton accord : les campagnes sont créées en pause.</p>`;
  }
  return `<section class="cx-sec ad-set"><h4>${icon('bolt')}Meta (publicité)</h4>${body}</section>`;
}

function bindSettings(root: HTMLElement): void {
  const sec = root.matches('.ad-set') ? root : $('.ad-set', root);
  if (!sec) return;
  current = sec;
  const redraw = (): void => { const at = current && current.isConnected ? current : sec; const next = el(settingsHTML()); at.replaceWith(next); bindSettings(next); };
  const read = (form: HTMLFormElement): void => {
    const g = (n: string): string => form.querySelector<HTMLInputElement>(`[name=${n}]`)?.value.trim() ?? '';
    typed.token = form.querySelector('[name=token]') ? g('token') : typed.token; typed.page = g('page'); typed.pixel = g('pixel'); typed.dsa = g('dsa');
  };
  const form = $<HTMLFormElement>('[data-ad-set]', sec);
  if (!form) return;
  form.addEventListener('input', () => read(form));
  form.addEventListener('submit', async ev => {
    ev.preventDefault(); read(form);
    const c = meta.creds();
    busy = true; settingsError = ''; redraw();
    try {
      await meta.connect({ token: c?.token ?? typed.token, page: typed.page, pixel: typed.pixel, dsa: typed.dsa });
      typed.token = ''; toast(c ? 'Réglages Meta enregistrés' : 'Meta connecté');
    } catch (e) { settingsError = errMsg(e); }
    busy = false; redraw();
  });
  $('[data-ad-off]', sec)?.addEventListener('click', async () => {
    if (!await confirmBox({ title: 'Déconnecter Meta ?', ok: 'Déconnecter', danger: true, text: 'Le jeton sera effacé du coffre de cet appareil. Tes campagnes sur Meta ne changent pas.' })) return;
    try { await meta.disconnect(); typed.page = typed.pixel = typed.dsa = ''; pageList = null; settingsError = ''; } catch (e) { settingsError = errMsg(e); }
    redraw();
  });
  if (meta.connected() && vault.isOpen() && !pageList && !pagesLoading) {
    pagesLoading = true;
    void meta.pages().then(l => { pageList = l; }).finally(() => { pagesLoading = false; if (current?.isConnected) redraw(); });
  }
}

export const settings = { html: settingsHTML, bind: bindSettings };

// ---------- Accueil ----------
export async function homeStat(p: Project): Promise<{ spend: number; roas: number | null; currency: string } | null> {
  if (!meta.supported() || !meta.connected() || !p.meta) return null;
  try { const i = await meta.insights(p.meta, '7d'); return { spend: i.total.spend, roas: i.total.roas, currency: i.currency }; }
  catch { return null; }
}
