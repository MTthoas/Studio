// Onglet « Boutique » d'un projet : la boutique en ligne reliée au projet, en lecture seule.
// Connexion (adresse dans la note du projet, identifiants dans le coffre), puis tableau de bord : chiffres clés,
// ventes par jour, commandes récentes, stock bas, meilleures ventes. Les données viennent du socle e-commerce
// (integrations/commerce) ; rien ici ne parle à Shopify directement, et rien ne modifie la boutique.
import * as commerce from '../../integrations/commerce/index.ts';
import * as vault from '../../core/vault.ts';
import * as chart from '../../ui/chart.ts';
import { esc } from '../../lib/markdown.ts';
import { $, need, icon, rel, errMsg, toast, menu, confirmBox } from '../../ui/kit.ts';
import * as model from './model.ts';
import type { Project } from './model.ts';

const SCOPES = ['read_orders', 'read_products', 'read_inventory'];

// ---------- Connexion ----------
export function formHTML(p: Project, error = ''): string {
  const known = !!p.shop;
  return `<form class="sv-form shp-form">
    <div class="ag-empty sv-intro">${icon('bag')}<h3>${known ? 'Reconnecte la boutique sur cet appareil' : 'Relie une boutique Shopify à ce projet'}</h3>
      <p>${known ? `Ce projet est relié à <strong>${esc(p.shop ?? '')}</strong>, mais ses identifiants ne sont pas sur cet appareil : ils restent dans le coffre de celui où tu l’as reliée.` : 'Ventes, commandes à expédier et stock bas, à côté des notes, des tâches et du code du projet. Studio lit la boutique, il ne la modifie jamais.'}</p></div>
    ${error ? `<p class="modal-hint ap-warn">${icon('shield')}${esc(error)}</p>` : ''}
    <label class="pj-field"><span>Boutique</span><input class="field" name="shop" placeholder="ma-boutique.myshopify.com" value="${esc(p.shop ?? '')}" required autocomplete="off" spellcheck="false" autocapitalize="off"></label>
    <div class="pj-field"><span>Connexion</span><div class="shp-modes">
      <label class="sv-extopt"><input type="radio" name="mode" value="app" checked><span><b>App du Dev Dashboard</b><em>Client ID et secret : la voie actuelle de Shopify. Le jeton est renouvelé tout seul.</em></span></label>
      <label class="sv-extopt"><input type="radio" name="mode" value="token"><span><b>Jeton d’accès Admin</b><em>Un jeton <code>shpat_…</code> d’une app personnalisée déjà créée dans l’administration.</em></span></label></div></div>
    <div data-mode="app"><div class="sv-row"><label class="pj-field"><span>Client ID</span><input class="field" name="id" autocomplete="off" spellcheck="false"></label>
      <label class="pj-field"><span>Secret</span><input class="field" name="secret" type="password" autocomplete="off"></label></div>
      <p class="modal-hint">Sur <a class="link-btn" href="https://dev.shopify.com/dashboard" target="_blank" rel="noopener">dev.shopify.com</a> : crée une app, donne-lui les droits ${SCOPES.map(s => `<code>${s}</code>`).join(', ')}, publie une version, installe-la sur la boutique, puis copie son Client ID et son secret (Réglages de l’app). L’app et la boutique doivent être dans la même organisation.</p></div>
    <div data-mode="token" hidden><label class="pj-field"><span>Jeton d’accès Admin</span><input class="field" name="token" type="password" placeholder="shpat_…" autocomplete="off"></label>
      <p class="modal-hint">Droits nécessaires, en lecture : ${SCOPES.map(s => `<code>${s}</code>`).join(', ')}.</p></div>
    <p class="modal-hint">${icon('lock')}Les identifiants sont chiffrés dans le coffre de cet appareil et ne partent que vers ta boutique. Studio ne demande aucune donnée de client : ni nom, ni adresse, ni e-mail.</p>
    ${vault.isOpen() ? '' : `<p class="modal-hint ap-warn">${icon('lock')}Le coffre est fermé ou pas encore créé : <button type="button" class="link-btn" data-open-conn="coffre">ouvrir le coffre</button></p>`}
    <div class="modal-actions">${known ? `<button type="button" class="btn" data-shp="detach">Détacher la boutique</button>` : ''}<button class="btn btn-primary">${icon('check')}Relier la boutique</button></div></form>`;
}

function bindForm(box: HTMLElement, p: Project, done: () => void): void {
  const f = need<HTMLFormElement>('.shp-form', box);
  const field = (n: string) => need<HTMLInputElement>(`[name=${n}]`, f).value.trim();
  f.addEventListener('change', e => {
    const t = e.target as HTMLInputElement; if (t.name !== 'mode') return;
    for (const x of f.querySelectorAll<HTMLElement>('[data-mode]')) x.hidden = x.dataset.mode !== t.value;
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const mode = need<HTMLInputElement>('[name=mode]:checked', f).value, btn = need<HTMLButtonElement>('button.btn-primary', f);
    const conn: commerce.Conn = mode === 'token' ? { token: field('token') } : { id: field('id'), secret: field('secret') };
    if ('token' in conn ? !conn.token : !conn.id || !conn.secret) { toast(mode === 'token' ? 'Colle le jeton d’accès Admin.' : 'Renseigne le Client ID et le secret de l’app.'); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Vérification…';
    try { const s = await commerce.connect(p, field('shop'), conn); toast(`Boutique reliée : ${s.name}`); done(); }
    catch (err) { btn.disabled = false; btn.innerHTML = `${icon('check')}Relier la boutique`; toast(`Connexion refusée : ${errMsg(err)}`); }
  });
}

// ---------- Tableau de bord ----------
const pill = ([label, hue]: [string, string]) => `<em class="shp-st" style="--c:var(--c-${hue})">${esc(label)}</em>`;
const tile = (label: string, value: string, sub = '', hue = 'gray') => `<div class="shp-kpi" style="--c:var(--c-${hue})"><span>${esc(label)}</span><strong>${esc(value)}</strong><p>${sub}</p></div>`;
const plural = (n: number, one: string, many = one + 's') => `${String(n)} ${n > 1 ? many : one}`;
/** Symbole court d'une devise (« € »), pour l'axe du graphique. */
function symbol(currency: string): string {
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).formatToParts(0).find(x => x.type === 'currency')?.value ?? currency; } catch { return currency; }
}

function orderRow(o: commerce.Order): string {
  const items = o.items.map(l => `${l.qty > 1 ? `${String(l.qty)} × ` : ''}${l.title}`).join(', ');
  return `<a class="shp-row${commerce.counted(o) ? '' : ' off'}" href="${esc(o.url)}" target="_blank" rel="noopener" title="Ouvrir dans l’administration de la boutique">
    <code>${esc(o.name)}</code><span class="shp-items">${esc(items || '—')}</span>
    ${o.cancelled ? pill(['annulée', 'gray']) : o.test ? pill(['essai', 'gray']) : `${o.pay === 'paid' ? '' : pill(commerce.PAY[o.pay])}${pill(commerce.SHIP[o.ship])}`}
    <strong>${esc(commerce.money(o.total, o.currency))}</strong><time>${esc(rel(o.at))}</time></a>`;
}

function stockHTML(s: commerce.Snapshot): string {
  if (!s.stock) return `<p class="hm-empty">Stock illisible : ${esc(s.stockNote ?? 'raison inconnue')}.</p>`;
  if (!s.stock.length) return `<p class="hm-empty">Aucune référence suivie à ${String(commerce.LOW)} exemplaires ou moins.</p>`;
  return s.stock.slice(0, 12).map(l => `<a class="shp-row" href="${esc(l.url)}" target="_blank" rel="noopener"><span class="shp-items"><b>${esc(l.product)}</b>${l.variant ? ` · ${esc(l.variant)}` : ''}${l.sku ? ` <code>${esc(l.sku)}</code>` : ''}</span>
    ${pill(l.qty <= 0 ? ['rupture', 'red'] : [`${String(l.qty)} en stock`, 'amber'])}</a>`).join('') + (s.stock.length > 12 ? `<p class="shp-more">et ${String(s.stock.length - 12)} autres</p>` : '');
}

export function dashHTML(s: commerce.Snapshot): string {
  const st = commerce.stats(s.orders), cur = s.shop.currency, m = (n: number) => commerce.money(n, cur);
  const toShip = s.toShip ?? st.toShip, min = s.partial ? 'au moins ' : '';
  const points = chart.lastDays(s.days, Object.fromEntries(Object.entries(st.revenueByDay).map(([k, v]) => [k, Math.round(v)])));
  const recent = s.orders.filter(o => !o.test).slice(0, 12), maxSold = Math.max(1, ...st.top.map(l => l.qty));
  return `<header class="shp-head"><span class="pj-ico" style="--c:var(--c-green)">${icon('bag')}</span><div><strong>${esc(s.shop.name)}</strong><a href="${esc(s.shop.url)}" target="_blank" rel="noopener">${esc(s.shop.url.replace(/^https:\/\//, '').replace(/\/$/, ''))}</a></div>
      <span class="shp-act"><a class="btn" href="${esc(s.shop.admin)}" target="_blank" rel="noopener">${icon('share')}Administration</a><button class="btn" data-shp="refresh">${icon('refresh')}Actualiser</button><button class="icon-btn" data-shp="more" title="Plus" aria-label="Plus d’actions">${icon('more')}</button></span></header>
    ${s.partial ? `<p class="modal-hint ap-warn">${icon('shield')}Cette boutique a plus de commandes sur ${String(s.days)} jours que Studio n’en lit (${String(s.orders.length)}) : les totaux de la période sont des minimums.</p>` : ''}
    <div class="shp-kpis">
      ${tile('Aujourd’hui', m(st.today.revenue), plural(st.today.orders, 'commande'), 'green')}
      ${tile('7 jours', m(st.d7.revenue), `${plural(st.d7.orders, 'commande')} ${chart.trend(st.d7.revenue, st.prev7.revenue)}`, 'green')}
      ${tile(`${String(s.days)} jours`, min + m(st.all.revenue), min + plural(st.all.orders, 'commande'), 'green')}
      ${tile('Panier moyen', st.all.orders ? m(st.basket) : '—', `sur ${String(s.days)} jours`, 'violet')}
      ${tile('À expédier', String(toShip), toShip ? `<a class="link-btn" href="${esc(s.shop.admin)}/orders?fulfillment_status=unfulfilled&status=open" target="_blank" rel="noopener">Voir dans Shopify</a>` : 'tout est parti', toShip ? 'blue' : 'gray')}
    </div>
    <section class="shp-card"><h3>${icon('activity')}Ventes par jour<span>${String(s.days)} derniers jours · ${esc(cur)}</span></h3>
      ${st.all.orders ? chart.bars(points, { color: 'green', unit: symbol(cur), units: symbol(cur), summary: `Chiffre d’affaires par jour sur ${String(s.days)} jours : ${m(st.all.revenue)} au total` }) : `<p class="pj-chart-empty">Aucune commande sur les ${String(s.days)} derniers jours.</p>`}</section>
    <div class="shp-cols">
      <section class="shp-card"><h3>${icon('list')}Commandes récentes<span>${String(recent.length)} sur ${String(s.orders.length)}</span></h3>${recent.length ? recent.map(orderRow).join('') : '<p class="hm-empty">Aucune commande récente.</p>'}</section>
      <div class="shp-side">
        <section class="shp-card"><h3>${icon('container')}Stock bas<span>${String(commerce.LOW)} ou moins</span></h3>${stockHTML(s)}</section>
        <section class="shp-card"><h3>${icon('sparkle')}Meilleures ventes<span>${String(s.days)} jours</span></h3>${st.top.length ? st.top.map(l => `<div class="shp-top"><span>${esc(l.title)}</span><i style="--w:${String(Math.round(l.qty / maxSold * 100))}%"></i><b>${String(l.qty)}</b></div>`).join('') : '<p class="hm-empty">Rien de vendu sur la période.</p>'}</section>
      </div></div>
    <p class="shp-foot">Chiffre d’affaires : total des commandes non annulées, taxes et livraison comprises, remboursements déduits. Les jours sont ceux de cet appareil. Lu ${esc(rel(s.at))} · lecture seule.</p>`;
}

/** Affiche l'onglet dans `box` : formulaire de connexion, ou tableau de bord (dernier état connu, puis relu). */
export function mount(box: HTMLElement, project: Project): void {
  // Relier ou détacher réécrit la note du projet : on repart toujours de sa version à jour.
  const p = model.byId(project.id) ?? project;
  const again = () => mount(box, p);
  if (!commerce.supported()) { box.innerHTML = `<div class="ag-empty">${icon('bag')}<h3>Boutique</h3><p>La boutique d’un projet se lit depuis l’app Studio (Mac ou iPhone) : un navigateur ne peut pas joindre l’API de Shopify.${p.shop ? ` Ce projet est relié à <strong>${esc(p.shop)}</strong>.` : ''}</p></div>`; return; }
  if (!commerce.ready(p)) { box.innerHTML = formHTML(p); bindForm(box, p, again); bindActions(box, p, again); return; }
  const known = commerce.cached(p);
  box.innerHTML = known ? dashHTML(known) : '<div class="pj-skel"></div>';
  bindActions(box, p, again);
  void load(box, p, false);
  // Une nouvelle commande, vue par la surveillance : l'onglet se relit tant qu'il est affiché.
  const off = commerce.onChange(domain => { if (!box.isConnected) { off(); return; } if (domain === p.shop && commerce.ready(p)) void load(box, p, false); });
}

async function load(box: HTMLElement, p: Project, fresh: boolean): Promise<void> {
  try {
    const s = await commerce.snapshot(p, { fresh });
    if (!box.isConnected) return;
    box.innerHTML = dashHTML(s); chart.bindTips(box);
  } catch (e) {
    if (!box.isConnected) return;
    // Connexion cassée (jeton révoqué, droit retiré) : l'erreur, et de quoi relier à nouveau.
    box.innerHTML = `<p class="sv-err">${icon('shield')}${esc(errMsg(e))}</p><div class="modal-actions shp-retry"><button class="btn" data-shp="refresh">${icon('refresh')}Réessayer</button><button class="btn" data-shp="reconnect">Modifier la connexion</button></div>`;
  }
}

const bound = new WeakSet<HTMLElement>();
function bindActions(box: HTMLElement, project: Project, again: () => void): void {
  if (bound.has(box)) return;
  bound.add(box);
  const detach = async () => {
    const p = model.byId(project.id) ?? project;
    if (!await confirmBox({ title: 'Détacher la boutique ?', text: `« ${p.shop ?? ''} » ne sera plus reliée à ce projet, et ses identifiants seront effacés de cet appareil. Rien ne change dans Shopify.`, ok: 'Détacher', danger: true })) return;
    try { await commerce.disconnect(p); toast('Boutique détachée'); } catch (e) { toast(errMsg(e)); }
    again();
  };
  box.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-shp]'); if (!b) return;
    const act = b.dataset.shp, p = model.byId(project.id) ?? project;
    if (act === 'refresh') { const btn = b as HTMLButtonElement; btn.disabled = true; void load(box, p, true); }
    else if (act === 'reconnect') { box.innerHTML = formHTML(p); bindForm(box, p, again); }
    else if (act === 'detach') void detach();
    else if (act === 'more') menu(b, [{ label: 'Modifier la connexion', icon: 'key', run: () => { box.innerHTML = formHTML(p); bindForm(box, p, again); } }, '-', { label: 'Détacher la boutique', icon: 'trash', danger: true, run: detach }]);
  });
}

/** Carte « Boutique » de la vue d'ensemble : le chiffre du jour et ce qui attend. */
export async function fillCard(root: HTMLElement, p: Project): Promise<void> {
  const b = $('[data-ov="shop"]', root); if (!b) return;
  if (!commerce.ready(p)) { b.textContent = commerce.supported() ? 'Reconnecte la boutique sur cet appareil' : 'Visible dans l’app Studio'; return; }
  try {
    const s = await commerce.snapshot(p), st = commerce.stats(s.orders), toShip = s.toShip ?? st.toShip;
    if (!b.isConnected) return;
    b.innerHTML = `<b>${esc(commerce.money(st.today.revenue, s.shop.currency))}</b> aujourd’hui · ${esc(plural(st.today.orders, 'commande'))}${toShip ? ` · ${String(toShip)} à expédier` : ''}`;
  } catch (e) { if (b.isConnected) b.textContent = errMsg(e); }
}
