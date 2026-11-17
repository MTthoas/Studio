// Mise en route : bloc « Shopify » des Réglages → Boutiques (liste, ajout, retrait, guide) et écran d'un projet
// dont la boutique n'est pas encore reliée (choisir une boutique du coffre).
import { esc } from '../../lib/markdown.ts';
import { el, icon, toast, errMsg, confirmBox, menu } from '../../ui/kit.ts';
import * as api from '../../integrations/shopify/api.ts';
import * as model from '../projects/model.ts';
import type { Project } from '../projects/model.ts';
import { clicks, vaultIssue, notMacHTML, openProject } from './shop-common.ts';

type Mode = 'app' | 'token';
const typed = { domain: '', clientId: '', clientSecret: '', token: '' };
let mode: Mode = 'app', busy = false, error = '', saved = '', savedProject = '', guideOpen = false, current: HTMLElement | null = null;
/** Projet à qui donner la boutique ajoutée : 'new' (projet créé à son nom), l'id d'un projet, ou '' (aucun pour l'instant). */
let dest = 'new';

/** Rattache une boutique du coffre à un projet ('new' : crée le projet au nom de la boutique). Null si `to` est vide. */
export async function attach(s: api.ShopCreds, to: string): Promise<Project | null> {
  if (!to) return null;
  const p = to === 'new'
    ? await model.createProject({ name: s.name || s.domain.replace(/\.myshopify\.com$/, ''), repos: [], linear: null, description: `Boutique Shopify ${s.domain} : ses chiffres, ses commandes, sa publicité et ses notes.` })
    : model.byId(to);
  if (!p) throw new Error('Projet introuvable.');
  await model.setField(p, 'shopify', s.domain);
  p.shopify = s.domain;
  return p;
}
/** Menu « Rattacher à un projet » d'une boutique sans projet : un nouveau projet à son nom, ou un projet qui n'a pas encore de boutique. */
export function attachMenu(anchor: Element, s: api.ShopCreds, done: (p: Project) => void): void {
  const run = (to: string) => () => { void attach(s, to).then(p => { if (p) { toast(`Boutique rattachée à « ${p.name} »`); done(p); } }).catch(err => toast(errMsg(err))); };
  const free = model.projects().filter(p => !p.shopify);
  menu(anchor, [{ label: `Nouveau projet « ${s.name || s.domain} »`, icon: 'plus', run: run('new') },
    ...(free.length ? ['-' as const, { label: 'Projet existant' }, ...free.map(p => ({ label: p.name, icon: 'folder', run: run(p.id) }))] : [])]);
}


const vaultNote = (): string => vaultIssue() === 'absent'
  ? '<p>Active d’abord le coffre : les accès à ta boutique y sont gardés chiffrés, jamais en clair.</p><div class="cx-grid"><button class="btn btn-primary" data-open-conn="coffre">Ouvrir l’onglet du coffre</button></div>'
  : '<p>Le coffre est verrouillé : déverrouille-le pour gérer tes boutiques.</p><div class="cx-grid"><button class="btn" data-open-conn="coffre">Ouvrir l’onglet du coffre</button></div>';

const guide = (open: boolean): string => `<details class="sh-guide" data-guide${open ? ' open' : ''}><summary>Où trouver l’identifiant client et la clé secrète</summary>
  <ol class="sh-steps">
    <li>Va sur <a href="https://dev.shopify.com/dashboard" target="_blank" rel="noopener noreferrer"><strong>dev.shopify.com</strong></a> (le Dev Dashboard) avec le compte de l’organisation qui possède la boutique. <strong>L’app et la boutique doivent être dans la même organisation.</strong></li>
    <li>Crée une app (« Créer une app »), par exemple nommée « Studio ».</li>
    <li>Dans la configuration de l’app, à la rubrique des droits d’accès (<em>scopes</em>), colle la liste ci-dessous, puis publie la version.</li>
    <li>Installe l’app sur ta boutique.</li>
    <li>Dans les paramètres de l’app, copie l’<strong>identifiant client</strong> et la <strong>clé secrète</strong>, et colle-les dans le formulaire. Le Mac demande lui-même un jeton à Shopify et le renouvelle toutes les 24 heures : tu n’as rien d’autre à faire.</li>
  </ol>
  <p class="sh-sub">Droits à cocher</p>
  <pre class="cx-code sh-scopes">${esc(api.SCOPES.join(', '))}</pre>
  <div class="cx-grid"><button type="button" class="btn" data-sh="copy">${icon('copy')}Copier la liste</button></div>
  <ul class="sh-notes-list">
    <li><code>read_orders</code> ne donne accès qu’aux <strong>60 derniers jours</strong> de commandes. Pour tout l’historique, il faut aussi <code>read_all_orders</code> (soumis à l’approbation de Shopify).</li>
    <li>Les <strong>clients</strong> (nom, e-mail) et les <strong>rapports</strong> (sessions, conversion) demandent l’accès aux <strong>données client protégées</strong> : à demander dans la configuration de l’app.</li>
    <li>Une ancienne <strong>app personnalisée</strong> (Paramètres → Applications → Développer des apps) donne un jeton d’accès Admin <code>shpat_…</code> : choisis alors « Jeton d’accès Admin » ci-dessus.</li>
  </ul></details>`;

function settingsHTML(): string {
  let body: string;
  if (!api.supported()) body = notMacHTML();
  else if (vaultIssue()) body = vaultNote();
  else {
    const shops = api.shops(), projects = model.projects();
    const rows = shops.map(s => {
      const users = projects.filter(p => p.shopify === s.domain), first = users[0];
      return `<div class="sh-shop"><div class="sh-shop-main"><strong>${esc(s.name || s.domain)}</strong>
        <span class="sh-sub">${esc(s.domain)}${s.currency ? ` · ${esc(s.currency)}` : ''} · ${s.token ? 'jeton d’accès Admin' : 'app du Dev Dashboard'}</span>
        <span class="sh-sub">${users.length ? `Projet : ${esc(users.map(p => p.name).join(', '))}` : 'Pas encore rattachée à un projet.'}</span></div>
        ${first ? `<button class="btn" data-sh="openp" data-project="${esc(first.id)}">Ouvrir</button>` : `<button class="btn btn-primary" data-sh="attach" data-domain="${esc(s.domain)}">${icon('folder')}Rattacher à un projet</button>`}
        <button class="btn btn-danger" data-sh="remove" data-domain="${esc(s.domain)}">Retirer</button></div>`;
    }).join('');
    const free = projects.filter(p => !p.shopify);
    if (dest !== 'new' && dest && !free.some(p => p.id === dest)) dest = 'new';
    const destField = `<label class="sh-f"><span>Projet de la boutique</span><select class="field" name="dest">
        <option value="new"${dest === 'new' ? ' selected' : ''}>Nouveau projet au nom de la boutique</option>
        ${free.map(p => `<option value="${esc(p.id)}"${dest === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        <option value=""${dest === '' ? ' selected' : ''}>Aucun pour l’instant</option></select>
        <small class="sh-sub">Chaque boutique vit dans un projet : c’est là que tu retrouves ses chiffres, ses commandes et ses notes.</small></label>`;
    const fields = mode === 'app'
      ? `<label class="sh-f"><span>Identifiant client</span><input class="field" name="clientId" value="${esc(typed.clientId)}" autocomplete="off" spellcheck="false"></label>
         <label class="sh-f"><span>Clé secrète</span><input type="password" class="field" name="clientSecret" value="${esc(typed.clientSecret)}" autocomplete="off" spellcheck="false" placeholder="shpss_…"></label>`
      : `<label class="sh-f"><span>Jeton d’accès Admin</span><input type="password" class="field" name="token" value="${esc(typed.token)}" autocomplete="off" spellcheck="false" placeholder="shpat_…"></label>`;
    body = `${rows ? `<div class="sh-shops">${rows}</div>` : `<ol class="sh-steps sh-intro"><li><strong>Crée l’accès dans Shopify</strong> : une app sur le Dev Dashboard, en quelques minutes (guide ci-dessous).</li>
        <li><strong>Colle ses identifiants ici</strong>, avec l’adresse <code>nom.myshopify.com</code> de ta boutique.</li><li><strong>Choisis son projet</strong> : Studio en crée un au nom de la boutique si tu veux.</li></ol>`}
      <form class="sh-form" data-form>
        <label class="sh-f"><span>Adresse de la boutique</span><input class="field" name="domain" value="${esc(typed.domain)}" placeholder="ma-boutique.myshopify.com" autocomplete="off" spellcheck="false"></label>
        <div class="sh-seg" role="tablist" aria-label="Type d’accès"><button type="button" class="btn${mode === 'app' ? ' on' : ''}" data-sh="mode" data-mode="app">Identifiant client + clé secrète</button>
          <button type="button" class="btn${mode === 'token' ? ' on' : ''}" data-sh="mode" data-mode="token">Jeton d’accès Admin</button></div>
        ${fields}
        ${destField}
        ${error ? `<p class="sh-err-inline" role="alert">${esc(error)}</p>` : ''}${saved && !error ? `<p class="sh-ok">${esc(saved)}${savedProject ? ` <button type="button" class="link-btn" data-sh="openp" data-project="${esc(savedProject)}">Ouvrir sa boutique</button>` : ''}</p>` : ''}
        <div class="cx-grid"><button class="btn btn-primary" type="submit"${busy ? ' disabled' : ''}>${busy ? 'Vérification…' : 'Relier la boutique'}</button></div></form>
      <p class="modal-hint">Les identifiants restent chiffrés dans le coffre de ce Mac. Ils ne servent qu’à parler à Shopify, par l’app.</p>${guide(guideOpen || !shops.length)}`;
  }
  return `<section class="cx-sec sh-set"><h4>${icon('plug')}Shopify (boutiques)</h4>${body}</section>`;
}

/** `changed` : appelé après un ajout, un retrait ou un rattachement (la vue Boutiques relit alors ses cartes). */
function bindSettings(root: HTMLElement, changed?: () => void): void {
  const sec = root.matches('.sh-set') ? root : root.querySelector<HTMLElement>('.sh-set');
  if (!sec || sec.dataset.shBound) return;
  sec.dataset.shBound = '1'; current = sec;
  const redraw = (): void => { const at = current?.isConnected ? current : sec; const next = el(settingsHTML()); at.replaceWith(next); bindSettings(next, changed); };
  const read = (): void => {
    const form = sec.querySelector<HTMLFormElement>('[data-form]'); if (!form) return;
    for (const k of ['domain', 'clientId', 'clientSecret', 'token'] as const) { const i = form.querySelector<HTMLInputElement>(`[name=${k}]`); if (i) typed[k] = i.value.trim(); }
    const d = form.querySelector<HTMLSelectElement>('[name=dest]'); if (d) dest = d.value;
  };
  sec.addEventListener('input', read);
  sec.addEventListener('change', read);
  sec.addEventListener('toggle', e => { if ((e.target as HTMLElement).matches?.('[data-guide]')) guideOpen = (e.target as HTMLDetailsElement).open; }, true);
  sec.addEventListener('submit', async e => {
    e.preventDefault(); if (busy) return; read();
    busy = true; error = ''; saved = ''; redraw();
    try {
      const s = await api.saveShop({ domain: typed.domain, name: '', ...(mode === 'token' ? { token: typed.token } : { clientId: typed.clientId, clientSecret: typed.clientSecret }) });
      typed.domain = typed.clientId = typed.clientSecret = typed.token = '';
      let p: Project | null = null;
      try { p = await attach(s, dest); } catch (err) { toast(`Boutique reliée, mais pas rattachée au projet : ${errMsg(err)}`); }
      saved = p ? `${s.name || s.domain} est reliée au projet « ${p.name} ».` : `${s.name || s.domain} est reliée. Rattache-la à un projet pour ouvrir ses chiffres.`;
      savedProject = p?.id ?? ''; dest = 'new'; toast('Boutique reliée');
    } catch (err) { error = errMsg(err); }
    busy = false; redraw(); changed?.();
  });
  clicks(sec, {
    mode: t => { read(); mode = t.dataset.mode === 'token' ? 'token' : 'app'; error = ''; redraw(); },
    openp: t => { if (t.dataset.project) openProject(t.dataset.project); },
    attach: t => { const s = api.shops().find(x => x.domain === t.dataset.domain); if (s) attachMenu(t, s, () => { redraw(); changed?.(); }); },
    copy: async () => { await navigator.clipboard.writeText(api.SCOPES.join(',')); toast('Droits copiés'); },
    remove: async t => {
      const domain = t.dataset.domain ?? '', s = api.shops().find(x => x.domain === domain); if (!s) return;
      const users = model.projects().filter(p => p.shopify === domain).map(p => p.name);
      if (!await confirmBox({ title: `Retirer ${s.name || domain} ?`, ok: 'Retirer', danger: true,
        text: `Les accès à ${domain} seront effacés du coffre de ce Mac. ${users.length ? `Les projets ${users.join(', ')} ne pourront plus lire ni modifier cette boutique tant que tu ne l’auras pas reliée de nouveau. ` : ''}Rien ne change sur Shopify.` })) return;
      try { await api.removeShop(domain); saved = ''; savedProject = ''; error = ''; toast('Boutique retirée'); } catch (err) { error = errMsg(err); }
      redraw(); changed?.();
    },
  });
}

export const settings = { html: settingsHTML, bind: bindSettings };

// ---------- Projet dont la boutique n'est pas reliée ----------
/** Écran de mise en route d'un projet : choisir une boutique du coffre, ou aller en relier une. `linked` redessine la section. */
export function mountSetup(root: HTMLElement, p: Project, linked: () => void): void {
  const paint = (): void => {
    if (!root.isConnected) return;
    let body: string;
    if (!api.supported()) body = notMacHTML();
    else if (vaultIssue()) body = `<h3>${icon('shield')}Le coffre garde les accès de ta boutique</h3>${vaultNote()}`;
    else {
      const shops = api.shops(), lost = p.shopify && !shops.some(s => s.domain === p.shopify);
      const others = (domain: string): string => model.projects().filter(x => x.id !== p.id && x.shopify === domain).map(x => x.name).join(', ');
      body = `<h3>${icon('plug')}Relier une boutique Shopify à « ${esc(p.name)} »</h3>
        ${lost ? `<p>Ce projet vise <strong>${esc(p.shopify ?? '')}</strong>, mais ses accès ne sont pas dans le coffre de ce Mac.</p>` : ''}
        ${shops.length ? `<p>Choisis la boutique de ce projet. Une boutique = un projet : tu retrouveras ses chiffres, ses commandes et ses produits ici.</p>
          <div class="sh-shops">${shops.map(s => `<button class="sh-shop sh-pick" data-sh="pick" data-domain="${esc(s.domain)}"><span class="sh-shop-main"><strong>${esc(s.name || s.domain)}</strong>
            <span class="sh-sub">${esc(s.domain)}${s.currency ? ` · ${esc(s.currency)}` : ''}${others(s.domain) ? ` · déjà utilisée par ${esc(others(s.domain))}` : ''}</span></span>${icon('chevronRight')}</button>`).join('')}</div>
          <p class="sh-sub">Une autre boutique ? <button class="link-btn" data-open-conn="commerce">Ajouter dans les réglages</button></p>`
        : `<p>Aucune boutique n’est encore reliée. Il te faut créer une app dans le Dev Dashboard de Shopify, puis coller son identifiant client et sa clé secrète dans les réglages : un guide pas à pas t’y attend.</p>
          <div class="cx-grid"><button class="btn btn-primary" data-open-conn="commerce">Relier une boutique</button></div>`}`;
    }
    root.innerHTML = `<div class="sh-empty">${body}</div>`;
  };
  clicks(root, {
    pick: async t => {
      const domain = t.dataset.domain ?? ''; if (!domain) return;
      await model.setField(p, 'shopify', domain);
      p.shopify = domain;
      toast('Boutique choisie pour ce projet');
      linked();
    },
  });
  paint();
}
