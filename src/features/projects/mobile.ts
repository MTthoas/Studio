// Onglet Mobile d'un projet : Studio cherche une app mobile dans le dossier du projet (Expo, React Native, Flutter,
// Capacitor, Xcode, Gradle), la lance sur un simulateur iOS ou un émulateur Android de ce Mac, montre l'écran de
// l'appareil et règle ce qu'on teste sans cesse (apparence, taille du texte, barre d'état, lien profond, capture).
// Voir Mobile.swift : la page ne fournit ni chemin ni commande, seulement un emplacement et un appareil que le Mac
// vient de lister. Rien de tout cela ne passe à distance (« project.mobile » n'est pas dans REMOTE_ALLOWED).
import * as native from '../../core/native.ts';
import { esc } from '../../lib/markdown.ts';
import { $, icon, target, toast } from '../../ui/kit.ts';
import type { Project } from './model.ts';

type OS = 'ios' | 'android';
type Found = { rel: string; kind: string; label: string; platforms: OS[]; commands: Partial<Record<OS, string>> };
type Device = { id: string; name: string; os: OS; runtime: string; booted: boolean; tablet: boolean };
type Run = { rel: string; kind: string; label: string; platform: OS; device: string; deviceName: string; command: string; status: 'running' | 'done' | 'error' | 'stopped'; code: number; ends: boolean; reload: boolean; since: number; ended?: number; log: string };
type State = { ok: boolean; message?: string; folder?: boolean; apps?: Found[]; devices?: Device[]; tools?: { xcode: boolean; android: boolean }; run?: Run };

const OSES: Record<OS, string> = { ios: 'iOS', android: 'Android' };
const place = (rel: string): string => (rel ? `${rel}/` : 'racine du dossier');
/** L'onglet n'agit que dans l'app Mac : simulateurs et outils de build y vivent. */
const onMac = (): boolean => native.available() && document.documentElement.dataset.native === 'mac';

function took(from: number, to = Date.now()): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

// Projets où une app mobile a déjà été trouvée : l'onglet y reste affiché d'une session à l'autre.
const KEY = 'studio.mobile.projects';
const known = new Set<string>((() => { try { const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } })());
const probed = new Set<string>();
function remember(id: string, has: boolean): boolean {
  if (known.has(id) === has) return false;
  if (has) known.add(id); else known.delete(id);
  try { localStorage.setItem(KEY, JSON.stringify([...known])); } catch { /* stockage plein : l'onglet reviendra à la prochaine détection */ }
  return true;
}
/** Le projet a-t-il une app mobile ? Un dépôt de rôle « mobile », ou une app trouvée dans son dossier. */
export const concerns = (p: Project): boolean => p.stack.some(r => r.role === 'mobile') || known.has(p.id);
/** Regarde une fois par session si le dossier du projet contient une app mobile ; vrai si la réponse a changé. */
export async function probe(p: Project): Promise<boolean> {
  if (!onMac() || probed.has(p.id)) return false;
  probed.add(p.id);
  try {
    const r = await native.call('project', 'mobile', { project: p.id, op: 'probe' }, 15000);
    return r.ok && r.folder === true ? remember(p.id, Number(r.count) > 0) : false;
  } catch { return false; }
}

const empty = (title: string, text: string): string => `<div class="st-empty">${icon('phone')}<div><strong>${title}</strong><p>${text}</p></div></div>`;

/** Appareil choisi par projet (celui dont on voit l'écran, et la cible de sa plateforme), gardé entre deux rendus. */
const picked = new Map<string, string>();
/** Réglages posés depuis Studio sur chaque appareil : simctl ne sait pas tous les relire, on retient ce qu'on a demandé. */
const tuned = new Map<string, { look?: string; text?: string; bar?: string }>();

function current(pid: string, list: Device[]): Device | undefined {
  return list.find(d => d.id === picked.get(pid)) ?? list.find(d => d.booted) ?? list.find(d => !d.tablet) ?? list[0];
}
/** Appareil sur lequel lancer une plateforme : celui choisi s'il est du bon système, sinon un démarré, sinon le premier téléphone. */
function targetOf(pid: string, list: Device[], os: OS): Device | undefined {
  const mine = list.filter(d => d.os === os), cur = current(pid, list);
  return (cur?.os === os ? cur : undefined) ?? mine.find(d => d.booted) ?? mine.find(d => !d.tablet) ?? mine[0];
}

function runHTML(r: Run): string {
  const running = r.status === 'running', ok = r.status === 'done';
  const title = running ? (r.ends ? 'Build et installation en cours…' : `${esc(r.label)} tourne`) : ok ? 'App installée et lancée' : `Arrêt sur une erreur${r.code ? ` (code ${r.code})` : ''}`;
  const state = running ? `depuis ${took(r.since)}` : ok ? `en ${took(r.since, r.ended)}` : `<span class="err">après ${took(r.since, r.ended)}</span>`;
  const again = `<button class="btn${ok ? '' : ' btn-primary'}" data-mb="run" data-rel="${esc(r.rel)}" data-kind="${esc(r.kind)}" data-os="${r.platform}">${icon('refresh')}Relancer</button>`;
  const reload = r.reload ? `<button class="btn btn-primary" data-mb="reload" title="Recharge à chaud (r)">${icon('bolt')}Recharger</button><button class="btn" data-mb="restart" title="Redémarre l’app (R)">${icon('refresh')}Redémarrer</button>` : '';
  return `<div class="sv-head"><span class="pj-site-dot ${ok || (running && !r.ends) ? 'up' : running ? '' : 'down'}"></span>
    <div><strong>${title}</strong><code>${esc(r.command)} · ${esc(place(r.rel))} · ${esc(r.deviceName)}</code></div>
    <span class="sv-state">${state}</span>
    <div class="sv-act">${running ? reload : again}<button class="btn" data-mb="run-stop">${icon(running ? 'stop' : 'check')}${running ? 'Arrêter' : 'Fermer'}</button></div></div>
    <pre class="st-log" aria-label="Sortie du lancement">${esc(r.log.trim() || 'En attente de la sortie…')}</pre>`;
}

function appsHTML(pid: string, st: State): string {
  const list = st.apps ?? [], devices = st.devices ?? [];
  if (!st.folder) return empty('Choisis d’abord le dossier du projet', 'Studio y cherchera une app mobile à lancer. Le dossier se choisit dans l’onglet Code.');
  if (st.run) return runHTML(st.run);
  if (!list.length) return empty('Aucune app mobile trouvée dans le dossier', 'Studio reconnaît Expo, React Native, Flutter, Capacitor, un projet Xcode et un projet Android (Gradle), à la racine ou dans <code>mobile/</code>, <code>app/</code>, <code>ios/</code>, <code>android/</code>, <code>apps/mobile/</code>… Les simulateurs ci-dessous restent utilisables.');
  return `<div class="st-list">${list.map(a => {
    const buttons = a.platforms.map((os, i) => {
      const d = targetOf(pid, devices, os), missing = os === 'ios' ? !st.tools?.xcode : !st.tools?.android;
      const why = missing ? (os === 'ios' ? 'Xcode et ses simulateurs sont introuvables sur ce Mac' : 'Le SDK Android (adb) est introuvable sur ce Mac') : !d ? `Aucun appareil ${OSES[os]}` : `Lance ${a.commands[os] ?? ''} sur ${d.name}`;
      return `<button class="btn${i === 0 ? ' btn-primary' : ''}" data-mb="run" data-rel="${esc(a.rel)}" data-kind="${esc(a.kind)}" data-os="${os}" title="${esc(why)}"${missing || !d ? ' disabled' : ''}>${icon('play')}${OSES[os]}</button>`;
    }).join('');
    const cmd = a.commands[a.platforms[0]] ?? '';
    return `<div class="st-row">${icon('phone')}
    <div><strong>${esc(a.label)}</strong><code>${esc(place(a.rel))}</code><em>Lance <code>${esc(cmd)}</code> sur ce Mac, vers l’appareil choisi ci-dessous : le code du projet s’exécute</em></div>
    ${buttons}</div>`;
  }).join('')}</div>`;
}

const seg = (what: string, value: string | undefined, options: [string, string][]): string =>
  `<span class="mb-seg" role="group">${options.map(([v, l]) => `<button data-mb="${what}" data-value="${v}" class="${v === value ? 'sel' : ''}" aria-pressed="${v === value}">${l}</button>`).join('')}</span>`;

/** Écran en direct et réglages de l'appareil choisi. */
function stageHTML(d: Device): string {
  if (!d.booted) {
    return `<div class="mb-stage"><div class="mb-off"><strong>${esc(d.name)}</strong><span>${esc(d.runtime)} · éteint</span>
      <button class="btn btn-primary" data-mb="boot" data-device="${esc(d.id)}">${icon('play')}Démarrer</button></div></div>`;
  }
  const t = tuned.get(d.id) ?? {};
  return `<div class="mb-stage"><div class="mb-screen${d.tablet ? ' tablet' : ''}" data-mb-screen="${esc(d.id)}"><span>Lecture de l’écran…</span></div>
    <div class="mb-tools">
      <div class="mb-tool"><span>Apparence</span>${seg('look', t.look, [['light', 'Clair'], ['dark', 'Sombre']])}</div>
      <div class="mb-tool"><span>Texte</span>${seg('text', t.text, [['small', 'Petit'], ['normal', 'Normal'], ['large', 'Grand'], ['huge', 'Très grand']])}</div>
      <div class="mb-tool"><span>Barre d’état</span>${seg('bar', t.bar, [['real', 'Réelle'], ['demo', '9:41']])}</div>
      <form class="mb-tool mb-link" data-mb-link><span>Ouvrir un lien</span><input class="field" name="url" placeholder="monapp://ecran ou https://…" autocomplete="off" spellcheck="false" aria-label="Lien à ouvrir sur l’appareil"><button class="btn" type="submit">Ouvrir</button></form>
      <div class="mb-acts"><button class="btn" data-mb="snap">${icon('download')}Capture sur le Bureau</button><button class="btn" data-mb="boot" data-device="${esc(d.id)}" title="Montre la fenêtre du simulateur">${icon('eye')}Fenêtre</button><button class="btn" data-mb="shutdown" data-device="${esc(d.id)}">${icon('stop')}Éteindre</button></div>
      <p class="modal-hint">L’écran se rafraîchit toutes les deux secondes. Pour toucher l’app, passe par la fenêtre du simulateur.</p>
    </div></div>`;
}

function devicesHTML(pid: string, st: State): string {
  const list = st.devices ?? [];
  if (!list.length) {
    return empty('Aucun simulateur sur ce Mac', st.tools?.xcode || st.tools?.android
      ? 'Crée un simulateur dans Xcode (Window → Devices and Simulators) ou un appareil virtuel dans Android Studio (Device Manager).'
      : 'Installe Xcode (App Store) pour les simulateurs iOS, ou Android Studio pour les émulateurs Android : Studio les retrouvera ici.');
  }
  const cur = current(pid, list);
  const groups = new Map<string, Device[]>();
  for (const d of list) {
    const k = d.booted ? 'Démarrés' : d.os === 'ios' ? d.runtime : 'Android';
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const rows = [...groups].map(([k, ds]) => `<div class="mb-group">${esc(k)}</div>${ds.map(d =>
    `<button class="mb-dev${d.id === cur?.id ? ' sel' : ''}" data-mb="pick" data-device="${esc(d.id)}" aria-pressed="${d.id === cur?.id}"><i class="pj-site-dot ${d.booted ? 'up' : ''}"></i><span>${esc(d.name)}</span><em>${esc(d.booted ? (d.os === 'ios' ? d.runtime : `Android · ${d.runtime}`) : d.os === 'ios' ? (d.tablet ? 'iPad' : 'iPhone') : d.runtime)}</em></button>`).join('')}`).join('');
  const missing = !st.tools?.xcode ? 'Xcode est introuvable : pas de simulateur iOS.' : !st.tools.android ? 'SDK Android introuvable : pas d’émulateur Android (Android Studio l’installe dans <code>~/Library/Android/sdk</code>).' : '';
  return `<div class="mb-devices"><div class="mb-list"><div class="mb-scroll">${rows}</div>${missing ? `<p class="modal-hint">${missing}</p>` : ''}</div>${cur ? stageHTML(cur) : ''}</div>`;
}

/** Contenu de l'onglet avant la première réponse du Mac. */
export const tabHTML = (section: (id: string, title: string, ic: string, body: string) => string): string => {
  if (!onMac()) return section('mobile-apps', 'App mobile', 'phone', empty('Le développement mobile se suit depuis l’app Mac', 'Ouvre ce projet dans Studio pour Mac : il y détecte l’app du dossier, la lance sur un simulateur et en montre l’écran.'));
  return `${section('mobile-apps', 'App', 'phone', '<div class="mb-apps" data-mb-apps><div class="pj-skel"></div></div>')}${section('mobile-devices', 'Appareils', 'devices', '<div data-mb-devices><div class="pj-skel"></div></div>')}`;
};

let timer = 0, shots = 0;
/** Branche l'onglet : état, boutons, écran en direct de l'appareil choisi. */
export function mount(root: HTMLElement, p: Project): void {
  window.clearInterval(timer); window.clearInterval(shots);
  const apps = $('[data-mb-apps]', root), devs = $('[data-mb-devices]', root);
  if (!apps || !devs || !onMac()) return;
  let shownApps = '', shownDevs = '', busy = false, last: State | null = null, shooting = false;
  // Dernière image de chaque appareil : reposée aussitôt quand la section est redessinée, sans attendre la capture suivante.
  const frames = new Map<string, string>();
  const show = (box: HTMLElement, d: Device, src: string): void => {
    let img = box.querySelector('img');
    if (!img) { box.innerHTML = '<img alt="">'; img = box.querySelector('img'); }
    if (img) { img.src = src; img.alt = `Écran de ${d.name}`; }
  };
  const ask = async (extra: Record<string, unknown> = {}, timeout = 30000): Promise<State> => (await native.call('project', 'mobile', { project: p.id, ...extra }, timeout)) as State;
  const cur = (): Device | undefined => (last ? current(p.id, last.devices ?? []) : undefined);

  const shoot = async (): Promise<void> => {
    const d = cur(), box = $('[data-mb-screen]', devs);
    if (!d?.booted || !box || shooting || document.hidden) return;
    shooting = true;
    try {
      const r = await native.call('project', 'mobile', { project: p.id, op: 'screen', device: d.id }, 20000);
      if (!box.isConnected || box.dataset.mbScreen !== d.id) return;
      if (r.ok && typeof r.image === 'string') {
        const src = `data:image/jpeg;base64,${r.image}`;
        frames.set(d.id, src); show(box, d, src);
      } else if (!box.querySelector('img')) box.innerHTML = `<span>${esc(r.message ?? 'L’appareil démarre…')}</span>`;
    } catch { /* délai dépassé : la prochaine capture réessaiera */ } finally { shooting = false; }
  };

  const paint = (st: State): void => {
    if (!st.ok) { st = { ...st, folder: true, apps: [], devices: [] }; }
    last = st;
    const a = appsHTML(p.id, st), d = devicesHTML(p.id, st);
    apps.dataset.live = st.run?.status === 'running' || (st.devices ?? []).some(x => x.booted) ? '1' : '';
    if (a !== shownApps) { shownApps = a; apps.innerHTML = a; }
    if (d !== shownDevs) {
      shownDevs = d; devs.innerHTML = d;
      const dev = cur(), box = $('[data-mb-screen]', devs), frame = dev ? frames.get(dev.id) : undefined;
      if (dev && box && frame) show(box, dev, frame);
      void shoot();
    }
  };
  const load = async (): Promise<void> => {
    const st = await ask();
    if (!apps.isConnected || busy) return;
    // L'onglet apparaîtra (ou disparaîtra) au prochain rendu de la page.
    if (st.ok && st.folder) remember(p.id, (st.apps ?? []).length > 0);
    paint(st);
  };

  const onClick = async (e: Event): Promise<void> => {
    const b = target(e).closest<HTMLButtonElement>('[data-mb]');
    if (!b || busy) return;
    const op = b.dataset.mb ?? '';
    if (op === 'pick') { picked.set(p.id, b.dataset.device ?? ''); if (last) paint(last); return; }
    const d = cur();
    busy = true; b.disabled = true;
    try {
      let r: State = { ok: true };
      if (op === 'run') {
        const os = (b.dataset.os === 'android' ? 'android' : 'ios') as OS, t = last ? targetOf(p.id, last.devices ?? [], os) : undefined;
        if (!t) { toast(`Aucun appareil ${OSES[os]} sur ce Mac.`); return; }
        picked.set(p.id, t.id);
        // Un build Xcode lit d'abord les schémas du projet : le Mac peut mettre plus d'une minute à répondre.
        r = await ask({ op: 'run', rel: b.dataset.rel ?? '', kind: b.dataset.kind ?? '', platform: os, device: t.id, name: p.name }, 180000);
      } else if (op === 'run-stop') r = await ask({ op });
      else if (op === 'reload' || op === 'restart') { r = await ask({ op: 'reload', full: op === 'restart' }); if (r.ok) toast(op === 'restart' ? 'App redémarrée' : 'App rechargée'); }
      else if (op === 'boot' || op === 'shutdown') {
        const id = b.dataset.device ?? '';
        picked.set(p.id, id);
        r = await ask({ op, device: id }, 90000);
        if (op === 'shutdown') { tuned.delete(id); frames.delete(id); }
      }
      else if (!d) return;
      else if (op === 'snap') { r = await ask({ op, device: d.id }); if (r.ok) toast('Capture enregistrée sur le Bureau'); }
      else if (op === 'look' || op === 'text' || op === 'bar') {
        const value = b.dataset.value ?? '';
        r = await ask({ op, device: d.id, value });
        if (r.ok) tuned.set(d.id, { ...tuned.get(d.id), [op]: value });
      }
      if (!r.ok) { toast(r.message ?? 'Le Mac n’a pas pu le faire.'); return; }
      const st = op === 'run' ? r : await ask();
      if (apps.isConnected) { paint(st); void shoot(); }
    } catch { toast('Le Mac n’a pas répondu à temps.'); } finally { busy = false; if (b.isConnected) b.disabled = false; }
  };
  apps.addEventListener('click', e => void onClick(e));
  devs.addEventListener('click', e => void onClick(e));
  devs.addEventListener('submit', async e => {
    const f = target(e).closest<HTMLFormElement>('[data-mb-link]');
    if (!f) return;
    e.preventDefault();
    const input = f.querySelector<HTMLInputElement>('input'), d = cur(), url = input?.value.trim() ?? '';
    if (!d || !url) return;
    const r = await ask({ op: 'url', device: d.id, url });
    if (!r.ok) toast(r.message ?? 'Lien refusé.'); else { toast(`Lien ouvert sur ${d.name}`); void shoot(); }
  });

  void load();
  // L'état (journal du lancement, appareils qui démarrent) suit tant que quelque chose tourne ; la liste des
  // simulateurs est relue de temps en temps même au repos (un simulateur démarré depuis Xcode doit apparaître).
  let tick = 0;
  timer = window.setInterval(() => {
    if (!apps.isConnected) { window.clearInterval(timer); return; }
    tick++;
    if (!document.hidden && !busy && (apps.dataset.live || tick % 4 === 0)) void load();
  }, 2500);
  shots = window.setInterval(() => {
    if (!apps.isConnected) { window.clearInterval(shots); return; }
    void shoot();
  }, 2000);
}
