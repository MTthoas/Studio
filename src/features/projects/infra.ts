// Serveur d'un projet, côté page : la connexion (clé SSH gardée par Studio ou configuration SSH du Mac), la confiance
// dans l'empreinte du serveur, et les extensions Docker et Kubernetes. Tout se fait sur le Mac (Servers.swift,
// SSHKeys.swift, ServerExtensions.swift) : la clé privée ne passe jamais par la page, seules sa clé publique et son
// empreinte y sont montrées. Depuis un appareil lié, on ne fait que lire l'état (voir REMOTE_ALLOWED dans link.ts).
import * as native from '../../core/native.ts';
import * as bridge from '../../integrations/remote.ts';
import * as model from './model.ts';
import { esc } from '../../lib/markdown.ts';
import { $, $$, icon, modal, need, rel, toast, confirmBox } from '../../ui/kit.ts';
import type { Project } from './model.ts';

export interface SshKey { id: string; name: string; type: string; fingerprint: string; public: string; created: number; projects?: string[] }
type Ext = 'docker' | 'kube';
export interface ServerConf { configured?: boolean; host?: string; /** Utilisateur fixé dans Studio (vide : celui de ~/.ssh/config). */ user?: string; /** utilisateur@hôte, à afficher. */ dest?: string; path?: string; port?: number; key?: SshKey; ext?: Ext[]; hostKey?: 'unknown' | 'changed'; denied?: boolean }

const EXTS: Record<Ext, { label: string; icon: string; hint: string }> = {
  docker: { label: 'Docker', icon: 'container', hint: 'Conteneurs, Compose, ressources, journaux ; démarrer, arrêter, redémarrer.' },
  kube: { label: 'Kubernetes', icon: 'kube', hint: 'Nœuds, déploiements et pods (kubectl, k3s ou microk8s) ; journaux, redémarrage.' },
};

const call = (op: string, p: Project | null, extra: Record<string, unknown> = {}, timeout = 30000) =>
  native.call('agent', 'server', { project: p?.id ?? '', op, ...extra }, timeout);
const read = (op: string, p: Project, extra: Record<string, unknown> = {}, timeout = 45000) =>
  bridge.call('agent', 'server', { project: p.id, op, ...extra }, timeout);

async function copy(text: string, what: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast(`${what} copiée`); } catch { toast('Copie impossible : sélectionne le texte'); }
}
const installCmd = (pub: string) => `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${pub.replace(/'/g, '')}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;

// ---------- Formulaire ----------

let keys: SshKey[] = [];

function keyPanel(k: SshKey | undefined): string {
  if (!k) return `<p class="modal-hint">${icon('shield')}Studio passe par <code>/usr/bin/ssh</code> avec ta configuration (<code>~/.ssh/config</code>, agent SSH) et ne voit aucune clé.</p>`;
  return `<div class="sv-pub"><div class="sv-pub-h">${icon('key')}<strong>${esc(k.name)}</strong><span>${esc(k.type)} · <code>${esc(k.fingerprint)}</code></span></div>
    <p>À ajouter une fois sur le serveur, dans <code>~/.ssh/authorized_keys</code> de l’utilisateur SSH (par ta console d’hébergeur ou une session existante) :</p>
    <pre class="sv-cmd">${esc(installCmd(k.public))}</pre>
    <div class="sv-pub-a"><button type="button" class="btn" data-sx="copy-install" data-key="${esc(k.id)}">${icon('copy')}Copier la commande</button><button type="button" class="btn btn-ghost" data-sx="copy-pub" data-key="${esc(k.id)}">${icon('copy')}Clé publique seule</button></div></div>`;
}

type SshHost = { alias: string; hostname: string; user?: string };
/** Indication du champ Utilisateur : le `User` de l'alias choisi, sinon un exemple. */
const userHint = (hosts: SshHost[], host: string): string => { const u = hosts.find(h => h.alias === host)?.user; return u ? `${u} (d’après ~/.ssh/config)` : 'root, ubuntu, deploy…'; };

function formHTML(hosts: SshHost[], cur?: ServerConf): string {
  const ext = new Set(cur?.ext ?? []), key = cur?.key?.id ?? '';
  return `<form class="sv-form"><div class="ag-empty sv-intro">${icon('server')}<h3>${cur?.configured ? 'Modifier le serveur' : 'Relie un serveur à ce projet'}</h3><p>Un VPS ou une VM où tourne le projet ou ses agents. Studio s’y connecte en SSH depuis ce Mac, par clé uniquement : jamais de mot de passe. L’utilisateur choisi ici passe avant celui de <code>~/.ssh/config</code>.</p></div>
    <div class="sv-row"><label class="pj-field"><span>Hôte SSH</span><input class="field" name="host" list="sv-hosts" placeholder="vps-prod ou deploy@203.0.113.10" value="${esc(cur?.host ?? '')}" required autocomplete="off" spellcheck="false"><datalist id="sv-hosts">${hosts.map(h => `<option value="${esc(h.alias)}">${esc(h.user ? `${h.user}@${h.hostname}` : h.hostname)}</option>`).join('')}</datalist></label>
      <label class="pj-field sv-user"><span>Utilisateur</span><input class="field" name="user" placeholder="${esc(userHint(hosts, cur?.host ?? ''))}" value="${esc(cur?.user ?? '')}" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
      <label class="pj-field sv-port"><span>Port</span><input class="field" name="port" inputmode="numeric" placeholder="22" value="${cur?.port ? String(cur.port) : ''}" autocomplete="off"></label></div>
    <label class="pj-field"><span>Dossier du projet sur le serveur</span><input class="field" name="path" placeholder="/srv/studio ou ~/studio" value="${esc(cur?.path ?? '')}" required autocomplete="off" spellcheck="false"></label>
    <div class="pj-field"><span>Clé SSH</span><div class="sv-keyrow"><select class="field" name="key"><option value="">Ma configuration SSH (~/.ssh, agent SSH)</option>${keys.map(k => `<option value="${esc(k.id)}"${k.id === key ? ' selected' : ''}>${esc(k.name)} · ${esc(k.type)}</option>`).join('')}</select>
      <button type="button" class="btn" data-sx="key-new">${icon('plus')}Créer</button><button type="button" class="btn" data-sx="key-import">${icon('download')}Importer</button>${keys.length ? `<button type="button" class="icon-btn" data-sx="keys" title="Gérer les clés" aria-label="Gérer les clés SSH de Studio">${icon('gear')}</button>` : ''}</div>
      <div class="sv-keyinfo">${keyPanel(keys.find(k => k.id === key))}</div>
      <p class="modal-hint">${icon('lock')}Une clé gardée par Studio est chiffrée dans le trousseau de ce Mac, ne quitte jamais l’app et n’est montrée qu’au serveur (elle seule) ; macOS peut te demander d’en autoriser l’accès.</p></div>
    <div class="pj-field"><span>Extensions</span><div class="sv-exts">${(Object.keys(EXTS) as Ext[]).map(e => `<label class="sv-extopt"><input type="checkbox" name="ext" value="${e}"${ext.has(e) ? ' checked' : ''}><span class="sv-ext-ic">${icon(EXTS[e].icon)}</span><span><b>${EXTS[e].label}</b><em>${EXTS[e].hint}</em></span></label>`).join('')}</div></div>
    <p class="modal-hint">${icon('shield')}Les commandes envoyées sont fixes : état du serveur, extensions activées, et Claude Code avec les mêmes garde-fous que sur le Mac.</p>
    <div class="modal-actions">${cur?.configured ? '<button type="button" class="btn" data-sv="cancel">Annuler</button>' : ''}<button class="btn btn-primary">${icon('check')}Enregistrer</button></div></form>`;
}

async function loadKeys(): Promise<void> {
  const r = await call('keys', null, {}, 10000);
  keys = r.ok ? (r.keys as SshKey[]) ?? [] : [];
}

/** Affiche le formulaire du serveur (nouveau ou à modifier) dans `box`. */
export async function openForm(box: HTMLElement, p: Project, cur?: ServerConf): Promise<void> {
  const [h] = await Promise.all([call('hosts', p, {}, 10000), loadKeys()]);
  if (!box.isConnected) return;
  const hosts = (h.hosts as SshHost[] | undefined) ?? [];
  box.innerHTML = formHTML(hosts, cur);
  const f = need<HTMLFormElement>('.sv-form', box), sel = need<HTMLSelectElement>('[name=key]', f);
  const hostIn = need<HTMLInputElement>('[name=host]', f), userIn = need<HTMLInputElement>('[name=user]', f);
  hostIn.addEventListener('input', () => { userIn.placeholder = userHint(hosts, hostIn.value.trim()); });
  sel.addEventListener('change', () => { need('.sv-keyinfo', f).innerHTML = keyPanel(keys.find(k => k.id === sel.value)); });
}

/** Enregistre le formulaire ; vrai si le serveur est relié. */
export async function submit(f: HTMLFormElement, p: Project): Promise<boolean> {
  const v = (n: string) => need<HTMLInputElement>(`[name=${n}]`, f).value.trim();
  const ext = $$<HTMLInputElement>('[name=ext]:checked', f).map(i => i.value);
  // « deploy@vps » tapé dans l'hôte, champ Utilisateur vide : on range chaque morceau à sa place.
  let host = v('host'), user = v('user');
  const at = host.lastIndexOf('@');
  if (at > 0 && !user) { user = host.slice(0, at); host = host.slice(at + 1); }
  const r = await call('set', p, { host, user, path: v('path'), port: v('port'), key: v('key'), ext }, 10000);
  if (!r.ok) { toast(r.message ?? 'Configuration refusée.'); return false; }
  toast('Serveur relié au projet');
  return true;
}

function ask(title: string, label: string, placeholder: string, ok: string, value = ''): Promise<string | null> {
  return new Promise(res => {
    let done = false;
    const m = modal({ title, cls: 'small', html: `<form class="sv-ask"><label class="pj-field"><span>${esc(label)}</span><input class="field" name="v" placeholder="${esc(placeholder)}" value="${esc(value)}" maxlength="60" required autofocus autocomplete="off"></label><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">${esc(ok)}</button></div></form>`, onClose: () => { if (!done) res(null); } });
    need('[data-x]', m.node).onclick = () => m.close();
    need('form', m.node).onsubmit = e => { e.preventDefault(); done = true; const v = need<HTMLInputElement>('[name=v]', m.node).value.trim(); m.close(); res(v || null); };
  });
}

async function refreshSelect(form: HTMLElement | null, select?: string): Promise<void> {
  await loadKeys();
  const sel = form && $<HTMLSelectElement>('[name=key]', form);
  if (!form || !sel) return;
  const keep = select ?? sel.value;
  sel.innerHTML = `<option value="">Ma configuration SSH (~/.ssh, agent SSH)</option>${keys.map(k => `<option value="${esc(k.id)}">${esc(k.name)} · ${esc(k.type)}</option>`).join('')}`;
  sel.value = keys.some(k => k.id === keep) ? keep : '';
  sel.dispatchEvent(new Event('change'));
}

function keysDialog(form: HTMLElement | null): void {
  const row = (k: SshKey) => {
    const used = (k.projects ?? []).map(id => model.byId(id)?.name ?? id);
    return `<div class="sv-krow" data-key="${esc(k.id)}">${icon('key')}<div><strong>${esc(k.name)}</strong><span>${esc(k.type)} · <code>${esc(k.fingerprint)}</code></span><em>${used.length ? `Utilisée par ${esc(used.join(', '))}` : 'Utilisée par aucun serveur'} · créée ${esc(rel(k.created))}</em></div>
      <button class="icon-btn" data-k="copy" title="Copier la clé publique" aria-label="Copier la clé publique">${icon('copy')}</button><button class="icon-btn" data-k="delete" title="Supprimer" aria-label="Supprimer la clé"${used.length ? ' disabled' : ''}>${icon('trash')}</button></div>`;
  };
  const m = modal({ title: 'Clés SSH de Studio', html: `<p class="modal-hint">${icon('lock')}Clés privées chiffrées dans le trousseau de ce Mac (« app.carnet.notes.ssh »), jamais synchronisées ni montrées. Une clé utilisée par un serveur ne peut pas être supprimée.</p><div class="sv-klist">${keys.map(row).join('') || '<p class="hm-empty">Aucune clé.</p>'}</div><div class="modal-actions"><button class="btn" data-x>Fermer</button></div>` });
  need('[data-x]', m.node).onclick = () => m.close();
  m.node.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-k]'), r = b?.closest<HTMLElement>('[data-key]');
    const k = keys.find(x => x.id === r?.dataset.key); if (!b || !r || !k) return;
    if (b.dataset.k === 'copy') { void copy(k.public, 'Clé publique'); return; }
    if (!await confirmBox({ title: `Supprimer la clé « ${k.name} » ?`, text: 'Elle sera effacée du trousseau. Les serveurs où sa clé publique est installée ne l’accepteront plus de ce Mac : retire-la aussi de leur authorized_keys.', ok: 'Supprimer', danger: true })) return;
    const res = await call('key-delete', null, { key: k.id }, 10000);
    if (!res.ok) { toast(res.message ?? 'Suppression impossible.'); return; }
    r.remove(); toast('Clé supprimée'); await refreshSelect(form);
  });
}

// ---------- État du serveur ----------

/** Ligne « par quelle clé » sous l'hôte. */
export const viaHTML = (st: ServerConf): string =>
  `<span class="sv-via">${st.user ? `utilisateur ${esc(st.user)} · ` : ''}${st.port ? `port ${st.port} · ` : ''}${st.key ? `${icon('key')}clé Studio « ${esc(st.key.name)} »` : 'configuration SSH du Mac'}</span>`;

/** Aide quand le serveur ne répond pas : empreinte à vérifier, clé à installer, ou rappel de la configuration. */
export function offlineHTML(st: ServerConf): string {
  if (st.hostKey === 'changed') return `<p class="modal-hint warn">${icon('shield')}L’empreinte de ce serveur ne correspond plus à celle enregistrée dans <code>~/.ssh/known_hosts</code>. Ce peut être une réinstallation… ou une interception. Studio refuse de s’y connecter : vérifie l’empreinte auprès de ton hébergeur, puis retire l’ancienne ligne (<code>ssh-keygen -R ${esc(st.host ?? '')}</code>).</p>`;
  if (st.hostKey === 'unknown') return `<div class="sv-trust"><p>${icon('shield')}Studio ne connaît pas encore l’empreinte de ce serveur. Vérifie-la (console de ton hébergeur, ou <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> sur le serveur) avant de lui faire confiance.</p><button class="btn btn-primary" data-sx="hostkeys">${icon('eye')}Voir l’empreinte du serveur</button></div>`;
  const who = st.user ? `l’utilisateur <code>${esc(st.user)}</code>` : 'l’utilisateur SSH';
  if (st.denied && st.key) return `<p class="modal-hint">Le serveur refuse la clé « ${esc(st.key.name)} » pour ${who} : installe sa clé publique pour cet utilisateur, ou change d’utilisateur (Modifier).</p>${keyPanel(st.key)}`;
  if (st.denied) return `<p class="modal-hint">Le serveur refuse tes clés pour ${who}. Vérifie que <code>ssh ${esc(st.dest ?? st.host ?? '')}</code> fonctionne dans le Terminal : sinon, la bonne clé n’est pas dans <code>~/.ssh/authorized_keys</code> de cet utilisateur, ou ce n’est pas le bon utilisateur (Modifier → Utilisateur).</p>`;
  if (st.key) return `<p class="modal-hint">Vérifie l’hôte, le port et que le serveur accepte SSH.</p>`;
  return `<p class="modal-hint">Vérifie que <code>ssh ${esc(st.dest ?? st.host ?? '')}</code> fonctionne dans le Terminal sans mot de passe (clé chargée dans l’agent SSH), ou choisis une clé gardée par Studio (Modifier).</p>`;
}

async function trust(p: Project, reload: () => void): Promise<void> {
  const r = await call('hostkeys', p, {}, 30000);
  if (!r.ok) { toast(r.message ?? 'Empreinte illisible.'); return; }
  const list = (r.keys as { fingerprint: string; type: string }[]) ?? [];
  const m = modal({ title: 'Empreinte du serveur', cls: 'sv-trustm', html: `<p class="modal-text">Compare avec l’empreinte affichée par ton hébergeur ou sur le serveur. Si elle est identique, Studio l’ajoute à <code>~/.ssh/known_hosts</code> ; une empreinte qui changerait ensuite serait refusée.</p>
    <ul class="sv-fps">${list.map(k => `<li><span>${esc(k.type)}</span><code>${esc(k.fingerprint)}</code></li>`).join('')}</ul>
    <div class="modal-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-primary" data-ok>${icon('check')}C’est la bonne, faire confiance</button></div>` });
  need('[data-x]', m.node).onclick = () => m.close();
  need('[data-ok]', m.node).onclick = async () => {
    m.close();
    const t = await call('trust', p, { fingerprints: list.map(k => k.fingerprint) }, 30000);
    if (!t.ok) { toast(t.message ?? 'Impossible d’enregistrer l’empreinte.'); return; }
    toast('Empreinte enregistrée'); reload();
  };
}

// ---------- Extensions ----------

/** Emplacements des extensions activées, remplis ensuite par `loadExts`. */
export const extsHTML = (st: ServerConf): string => (st.ext ?? []).map(e =>
  `<section class="sv-ext" data-ext="${e}"><header class="sv-ext-h"><span class="sv-ext-ic">${icon(EXTS[e].icon)}</span><h3>${EXTS[e].label}</h3><span class="sv-ext-sub"></span><button class="icon-btn" data-sx="ext-refresh" title="Actualiser" aria-label="Actualiser ${EXTS[e].label}">${icon('refresh')}</button></header><div class="sv-ext-b"><div class="pj-skel"></div></div></section>`).join('');

export function loadExts(box: HTMLElement, p: Project): void {
  for (const sec of $$('.sv-ext', box)) void loadExt(sec, p);
}

const dot = (tone: string) => `<span class="sv-dot ${tone}"></span>`;
const actBtn = (sx: string, ic: string, label: string, data: string) => `<button class="icon-btn" data-sx="${sx}" ${data} title="${label}" aria-label="${label}">${icon(ic)}</button>`;

interface Container { id: string; name: string; image: string; state: string; status: string; ports: string; since: string; compose: string; cpu?: string; mem?: string }
function dockerHTML(r: native.Reply, local: boolean): { sub: string; body: string } {
  const cs = (r.containers as Container[]) ?? [], up = cs.filter(c => c.state === 'running').length;
  const tone = (s: string) => s === 'running' ? 'up' : s === 'restarting' || s === 'paused' ? 'amber' : s === 'exited' || s === 'dead' ? 'down' : 'idle';
  const rows = cs.map(c => {
    const d = `data-name="${esc(c.name)}"`, run = c.state === 'running';
    return `<tr>${'<td>' + dot(tone(c.state)) + '</td>'}<td><strong>${esc(c.name)}</strong>${c.compose ? `<span class="sv-chip">${esc(c.compose)}</span>` : ''}<em>${esc(c.image)}</em></td>
      <td>${esc(c.status)}</td><td class="sv-num">${c.cpu ? `${esc(c.cpu)}<em>${esc(c.mem ?? '')}</em>` : '—'}</td><td class="sv-ports">${esc(c.ports.replace(/0\.0\.0\.0:|\[::\]:/g, '')) || '—'}</td>
      <td class="sv-acts">${actBtn('ext-logs', 'list', 'Journal', d)}${local ? (run ? actBtn('ext-act', 'refresh', 'Redémarrer', `${d} data-action="restart"`) + actBtn('ext-act', 'stop', 'Arrêter', `${d} data-action="stop"`) : actBtn('ext-act', 'play', 'Démarrer', `${d} data-action="start"`)) : ''}</td></tr>`;
  }).join('');
  return {
    sub: `${r.version ? `v${esc(String(r.version))} · ` : ''}${up} en marche sur ${cs.length}`,
    body: cs.length ? `<div class="sv-tblw"><table class="sv-tbl"><thead><tr><th></th><th>Conteneur</th><th>État</th><th>Processeur · mémoire</th><th>Ports</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hm-empty">Aucun conteneur sur ce serveur.</p>',
  };
}

interface Pod { ns: string; name: string; phase: string; ready: number; containers: number; restarts: number; reason: string; created: string }
interface Deploy { ns: string; name: string; want: number; ready: number; updated: number }
const SYSTEM_NS = /^(kube-system|kube-public|kube-node-lease|kube-flannel|cert-manager|ingress-nginx|metallb-system|longhorn-system)$/;
function kubeHTML(r: native.Reply, local: boolean): { sub: string; body: string } {
  const nodes = (r.nodes as { name: string; ready: boolean; version: string }[]) ?? [];
  const deps = (r.deployments as Deploy[]) ?? [], pods = (r.pods as Pod[]) ?? [];
  const bad = pods.filter(p => p.phase !== 'Succeeded' && (p.phase !== 'Running' || p.ready < p.containers));
  const depRow = (d: Deploy) => `<tr><td>${dot(d.ready >= d.want ? 'up' : d.ready ? 'amber' : 'down')}</td><td><strong>${esc(d.name)}</strong><em>${esc(d.ns)}</em></td><td class="sv-num">${d.ready}/${d.want}</td><td class="sv-acts">${local ? actBtn('ext-act', 'refresh', 'Redémarrer le déploiement', `data-name="${esc(d.name)}" data-ns="${esc(d.ns)}" data-action="rollout"`) : ''}</td></tr>`;
  const podRow = (p: Pod) => {
    const tone = p.phase === 'Succeeded' ? 'idle' : p.phase === 'Running' && p.ready === p.containers ? 'up' : p.phase === 'Pending' || p.phase === 'Running' ? 'amber' : 'down';
    const d = `data-name="${esc(p.name)}" data-ns="${esc(p.ns)}"`, t = Date.parse(p.created);
    return `<tr><td>${dot(tone)}</td><td><strong>${esc(p.name)}</strong><em>${esc(p.ns)}</em></td><td>${esc(p.reason || p.phase)}</td><td class="sv-num">${p.ready}/${p.containers}</td><td class="sv-num">${p.restarts ? `<span class="${p.restarts > 5 ? 'warn' : ''}">${p.restarts}</span>` : '0'}</td><td>${Number.isNaN(t) ? '' : esc(rel(t))}</td>
      <td class="sv-acts">${actBtn('ext-logs', 'list', 'Journal', d)}${local ? actBtn('ext-act', 'trash', 'Supprimer le pod (recréé par son déploiement)', `${d} data-action="delete-pod"`) : ''}</td></tr>`;
  };
  const table = (head: string, rows: string) => `<div class="sv-tblw"><table class="sv-tbl"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const podHead = '<th></th><th>Pod</th><th>État</th><th>Prêts</th><th>Redémarrages</th><th>Âge</th><th></th>';
  const mine = (ns: string) => !SYSTEM_NS.test(ns);
  const appPods = pods.filter(p => mine(p.ns)), sysPods = pods.filter(p => !mine(p.ns)), appDeps = deps.filter(d => mine(d.ns));
  const body = `<div class="sv-nodes">${nodes.map(n => `<span class="sv-node">${dot(n.ready ? 'up' : 'down')}${esc(n.name)}<em>${esc(n.version)}</em></span>`).join('')}</div>
    ${appDeps.length ? `<h4 class="sv-ext-t">Déploiements</h4>${table('<th></th><th>Déploiement</th><th>Prêts</th><th></th>', appDeps.map(depRow).join(''))}` : ''}
    <h4 class="sv-ext-t">Pods</h4>${appPods.length ? table(podHead, appPods.map(podRow).join('')) : '<p class="hm-empty">Aucun pod hors des espaces système.</p>'}
    ${sysPods.length ? `<details class="sv-sys"><summary>Espaces système · ${sysPods.length} pod${sysPods.length > 1 ? 's' : ''}</summary>${table(podHead, sysPods.map(podRow).join(''))}</details>` : ''}`;
  return { sub: `${r.context ? `${esc(String(r.context))} · ` : ''}${nodes.length} nœud${nodes.length > 1 ? 's' : ''} · ${pods.length} pods${bad.length ? ` · <span class="warn">${bad.length} à surveiller</span>` : ''}`, body };
}

async function loadExt(sec: HTMLElement, p: Project): Promise<void> {
  const ext = sec.dataset.ext as Ext, b = need('.sv-ext-b', sec), sub = need('.sv-ext-sub', sec);
  const r = await read('ext', p, { ext });
  if (!sec.isConnected) return;
  if (!r.ok) { b.innerHTML = `<p class="sv-err">${icon('shield')}${esc(r.message ?? 'Lecture impossible.')}</p>`; sub.textContent = ''; return; }
  if (!r.installed) {
    sub.textContent = 'non installé';
    b.innerHTML = ext === 'docker'
      ? '<p class="modal-hint">Docker n’est pas installé pour l’utilisateur SSH (<code>docker</code> introuvable). Sur Debian ou Ubuntu : <code>curl -fsSL https://get.docker.com | sh</code>.</p>'
      : '<p class="modal-hint">Ni <code>kubectl</code>, ni <code>k3s</code>, ni <code>microk8s</code> n’ont été trouvés pour l’utilisateur SSH. Pour un seul serveur, k3s suffit : <code>curl -sfL https://get.k3s.io | sh -</code>.</p>';
    return;
  }
  if (r.error) { sub.textContent = ''; b.innerHTML = `<p class="sv-err">${icon('shield')}${esc(String(r.error))}</p>${r.hint ? `<p class="modal-hint">Piste : <code>${esc(String(r.hint))}</code></p>` : ''}`; return; }
  const v = ext === 'docker' ? dockerHTML(r, bridge.local()) : kubeHTML(r, bridge.local());
  sub.innerHTML = v.sub; b.innerHTML = v.body;
}

const ACT_LABEL: Record<string, [string, string, boolean]> = {
  start: ['Démarrer', 'Le conteneur « {n} » va démarrer.', false],
  stop: ['Arrêter', 'Le conteneur « {n} » va s’arrêter : ce qu’il sert ne répondra plus.', true],
  restart: ['Redémarrer', 'Le conteneur « {n} » va redémarrer : coupure de quelques secondes.', true],
  rollout: ['Redémarrer', 'Les pods du déploiement « {n} » vont être remplacés un par un (rollout restart).', true],
  'delete-pod': ['Supprimer', 'Le pod « {n} » va être supprimé ; son déploiement en recréera un.', true],
};

async function logs(p: Project, ext: Ext, name: string, ns: string): Promise<void> {
  const m = modal({ title: `Journal · ${name}`, cls: 'sv-logm', html: `<pre class="st-log sv-log">Chargement…</pre><div class="modal-actions"><button class="btn" data-r>${icon('refresh')}Actualiser</button><button class="btn" data-x>Fermer</button></div>` });
  const pre = need('pre', m.node);
  const load = async () => {
    pre.textContent = 'Chargement…';
    const r = await call('ext-logs', p, { ext, name, ns }, 45000);
    pre.textContent = r.ok ? (String(r.log ?? '').trim() || 'Journal vide.') : (r.message ?? 'Lecture impossible.');
    pre.scrollTop = pre.scrollHeight;
  };
  need('[data-x]', m.node).onclick = () => m.close();
  need('[data-r]', m.node).onclick = () => void load();
  await load();
}

// ---------- Clics ----------

/** Clics de l'onglet Serveur propres à ce module (`data-sx`) ; vrai si le clic est traité. */
export async function click(t: HTMLElement, p: Project, reload: () => void): Promise<boolean> {
  const b = t.closest<HTMLElement>('[data-sx]'); if (!b) return false;
  const act = b.dataset.sx, form = b.closest<HTMLElement>('.sv-form');
  if (act === 'copy-install' || act === 'copy-pub') {
    if (!keys.some(x => x.id === b.dataset.key)) await loadKeys();
    const k = keys.find(x => x.id === b.dataset.key);
    if (k) void copy(act === 'copy-pub' ? k.public : installCmd(k.public), act === 'copy-pub' ? 'Clé publique' : 'Commande');
    return true;
  }
  if (act === 'key-new') {
    const name = await ask('Nouvelle clé SSH', 'Nom de la clé', 'vps-prod', 'Créer la clé', p.name);
    if (!name) return true;
    const r = await call('key-new', null, { name }, 15000);
    if (!r.ok) { toast(r.message ?? 'Création impossible.'); return true; }
    toast('Clé Ed25519 créée et rangée dans le trousseau'); await refreshSelect(form, (r.key as SshKey).id); return true;
  }
  if (act === 'key-import') {
    const name = await ask('Importer une clé SSH', 'Nom de la clé', 'vps-prod', 'Choisir le fichier…', p.name);
    if (!name) return true;
    const r = await call('key-import', null, { name }, 600000);
    if (r.cancelled) return true;
    if (!r.ok) { toast(r.message ?? 'Import impossible.'); return true; }
    toast(r.existing ? 'Cette clé était déjà dans Studio' : 'Clé importée et chiffrée dans le trousseau'); await refreshSelect(form, (r.key as SshKey).id); return true;
  }
  if (act === 'keys') { await loadKeys(); keysDialog(form); return true; }
  if (act === 'hostkeys') { await trust(p, reload); return true; }
  const sec = b.closest<HTMLElement>('.sv-ext'), ext = sec?.dataset.ext as Ext | undefined;
  if (!sec || !ext) return true;
  if (act === 'ext-refresh') { need('.sv-ext-b', sec).innerHTML = '<div class="pj-skel"></div>'; void loadExt(sec, p); return true; }
  const name = b.dataset.name ?? '', ns = b.dataset.ns ?? '';
  if (act === 'ext-logs') { if (!bridge.local()) { toast('Les journaux se lisent depuis le Mac.'); return true; } await logs(p, ext, name, ns); return true; }
  if (act === 'ext-act') {
    const a = b.dataset.action ?? '', l = ACT_LABEL[a]; if (!l) return true;
    if (!await confirmBox({ title: `${l[0]} ${name} ?`, text: l[1].replace('{n}', name), ok: l[0], danger: l[2] })) return true;
    b.setAttribute('disabled', '');
    const r = await call('ext-act', p, { ext, action: a, name, ns }, 70000);
    if (!r.ok) { toast(r.message ?? 'L’action a échoué.'); b.removeAttribute('disabled'); return true; }
    toast(`${l[0]} : ${name}`); void loadExt(sec, p);
  }
  return true;
}
