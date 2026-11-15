// Fiche « Machine » de l'onglet Serveur : emplacement, puissance et capacités, lus par SSH comme on le ferait dans
// une console (Servers.specs côté Mac, action `server` `specs`). La fiche change rarement : elle est gardée en
// mémoire par serveur et ne se relit qu'à la demande. La localisation par l'adresse IP (ipinfo.io, depuis le
// serveur) n'est faite que sur un clic.
import * as bridge from '../../integrations/remote.ts';
import * as chart from '../../ui/chart.ts';
import * as infra from './infra.ts';
import { esc } from '../../lib/markdown.ts';
import { $, icon } from '../../ui/kit.ts';
import type { Project } from './model.ts';

interface Geo { ip: string; city: string; region: string; country: string; org: string; loc: string; timezone: string; hostname: string }
interface Specs {
  ok: boolean; message?: string; at: number;
  cpu: { model: string; threads: number; cores: number; sockets: number; mhz: number; l2: string; l3: string; hypervisor: string; vendor: string; flags: string[] };
  mem: { total: number; swap: number };
  disks: { name: string; size: number; ssd: boolean; model: string }[];
  fs: { dev: string; type: string; size: number; used: number; free: number; pct: number; mount: string }[];
  net: { iface: string; speed: number; addrs: { iface: string; v6: boolean; addr: string; public: boolean }[] };
  gpu: string[];
  location: { region: string; zone: string; type: string; ip: string; tz: string; offset: string; geo?: Geo; geoError?: string };
  system: { hostname: string; fqdn: string; distro: string; kernel: string; arch: string; virt: string; vendor: string; product: string; uptime: number; user: string; sudo: boolean; nofile: string; tools: string[] };
}

const cache = new Map<string, Specs>();
const keyOf = (p: Project) => `${p.id}:${infra.current(p)}`;

// Régions courantes des hébergeurs : code → [lieu, pays ISO]. Le code est cherché tel quel, puis raccourci.
const PLACES: Record<string, [string, string]> = {
  fsn1: ['Falkenstein', 'DE'], nbg1: ['Nuremberg', 'DE'], hel1: ['Helsinki', 'FI'], ash: ['Ashburn', 'US'], hil: ['Hillsboro', 'US'], sin: ['Singapour', 'SG'],
  'fr-par': ['Paris', 'FR'], 'nl-ams': ['Amsterdam', 'NL'], 'pl-waw': ['Varsovie', 'PL'],
  nyc: ['New York', 'US'], sfo: ['San Francisco', 'US'], ams: ['Amsterdam', 'NL'], sgp: ['Singapour', 'SG'], lon: ['Londres', 'GB'], fra: ['Francfort', 'DE'], tor: ['Toronto', 'CA'], blr: ['Bangalore', 'IN'], syd: ['Sydney', 'AU'],
  cdg: ['Paris', 'FR'], lhr: ['Londres', 'GB'], ewr: ['New Jersey', 'US'], ord: ['Chicago', 'US'], lax: ['Los Angeles', 'US'], sjc: ['Silicon Valley', 'US'], nrt: ['Tokyo', 'JP'], waw: ['Varsovie', 'PL'], mad: ['Madrid', 'ES'],
  'us-east-1': ['Virginie du Nord', 'US'], 'us-east-2': ['Ohio', 'US'], 'us-west-1': ['Californie du Nord', 'US'], 'us-west-2': ['Oregon', 'US'],
  'eu-west-1': ['Irlande', 'IE'], 'eu-west-2': ['Londres', 'GB'], 'eu-west-3': ['Paris', 'FR'], 'eu-central-1': ['Francfort', 'DE'], 'eu-central-2': ['Zurich', 'CH'],
  'eu-north-1': ['Stockholm', 'SE'], 'eu-south-1': ['Milan', 'IT'], 'ca-central-1': ['Montréal', 'CA'], 'sa-east-1': ['São Paulo', 'BR'],
  'ap-northeast-1': ['Tokyo', 'JP'], 'ap-southeast-1': ['Singapour', 'SG'], 'ap-southeast-2': ['Sydney', 'AU'], 'ap-south-1': ['Bombay', 'IN'],
  'europe-west1': ['Saint-Ghislain', 'BE'], 'europe-west2': ['Londres', 'GB'], 'europe-west3': ['Francfort', 'DE'], 'europe-west4': ['Eemshaven', 'NL'], 'europe-west9': ['Paris', 'FR'],
  'us-central1': ['Iowa', 'US'], 'us-east1': ['Caroline du Sud', 'US'], 'us-east4': ['Virginie du Nord', 'US'], 'us-west1': ['Oregon', 'US'],
  francecentral: ['Paris', 'FR'], westeurope: ['Pays-Bas', 'NL'], northeurope: ['Irlande', 'IE'], germanywestcentral: ['Francfort', 'DE'], uksouth: ['Londres', 'GB'], eastus: ['Virginie', 'US'], westus2: ['Washington', 'US'],
  'eu-paris-1': ['Paris', 'FR'], 'eu-marseille-1': ['Marseille', 'FR'], 'eu-frankfurt-1': ['Francfort', 'DE'], 'uk-london-1': ['Londres', 'GB'], 'us-ashburn-1': ['Ashburn', 'US'], 'us-phoenix-1': ['Phoenix', 'US'],
};
function place(l: Specs['location']): [string, string] | null {
  for (const raw of [l.region, l.zone]) {
    const c = raw.toLowerCase().trim(); if (!c) continue;
    for (const k of [c, c.replace(/-[a-z]$/, ''), c.replace(/-dc\d+$/, ''), c.replace(/-\d+$/, ''), c.replace(/\d+$/, ''), c.split('-')[0]]) if (PLACES[k]) return PLACES[k];
  }
  return null;
}

/** Hébergeur deviné par la DMI (comme `dmidecode`), sinon par l'opérateur de l'adresse IP. */
function provider(s: Specs): string {
  const d = `${s.system.vendor} ${s.system.product}`;
  const known: [RegExp, string][] = [[/hetzner/i, 'Hetzner'], [/amazon/i, 'AWS'], [/google/i, 'Google Cloud'], [/digitalocean/i, 'DigitalOcean'], [/scaleway/i, 'Scaleway'],
    [/vultr/i, 'Vultr'], [/linode|akamai/i, 'Akamai (Linode)'], [/ovh/i, 'OVHcloud'], [/oracle/i, 'Oracle Cloud'], [/microsoft.*virtual|hyper-v/i, 'Azure ou Hyper-V'], [/contabo/i, 'Contabo'], [/ionos|1&1/i, 'IONOS']];
  for (const [re, name] of known) if (re.test(d)) return name;
  if (/raspberry/i.test(s.cpu.model)) return 'Raspberry Pi';
  return s.location.geo?.org.replace(/^AS\d+\s*/, '') ?? '';
}

const country = (cc: string) => { try { return new Intl.DisplayNames(['fr'], { type: 'region' }).of(cc) ?? cc; } catch { return cc; } };
const flag = (cc: string) => /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';
const num = (n: number, d = 1) => n.toLocaleString('fr-FR', { maximumFractionDigits: d });
function size(b: number): string {
  const g = b / 1024 ** 3;
  return g >= 1000 ? `${num(g / 1024)} To` : g >= 1 ? `${num(g, g >= 100 ? 0 : 1)} Go` : `${num(b / 1024 ** 2, 0)} Mo`;
}
function since(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d} j ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
const FLAGS: Record<string, string> = { aes: 'AES-NI', avx: 'AVX', avx2: 'AVX2', avx512f: 'AVX-512', sha_ni: 'SHA', sse4_2: 'SSE4.2', vmx: 'VT-x', svm: 'AMD-V', asimd: 'NEON', sve: 'SVE' };
const fact = (dt: string, dd: string, title = '') => dd ? `<div><dt>${dt}</dt><dd${title ? ` title="${esc(title)}"` : ''}>${dd}</dd></div>` : '';
const tile = (label: string, value: string, sub: string) => `<div class="sv-tile"><span>${label}</span><strong>${value}</strong><em title="${esc(sub)}">${esc(sub) || '—'}</em></div>`;

/** Emplacement de la fiche, rempli ensuite par `load`. */
export const html = (): string => `<section class="sv-ext sv-hw"><header class="sv-ext-h"><span class="sv-ext-ic">${icon('server')}</span><h3>Machine</h3><span class="sv-ext-sub" data-hw-sub></span><button class="icon-btn" data-hw="refresh" title="Relire la machine" aria-label="Relire la machine">${icon('refresh')}</button></header><div class="sv-hw-b"><div class="pj-skel"></div></div></section>`;

function locHTML(s: Specs): string {
  const l = s.location, g = l.geo, p = place(l), host = provider(s);
  const cc = g?.country || p?.[1] || '';
  const where = g ? [g.city, g.region !== g.city ? g.region : '', country(g.country)].filter(Boolean).join(', ') : p ? `${p[0]}, ${country(p[1])}` : '';
  const zone = [l.region, l.zone].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ');
  const tz = l.tz || g?.timezone || '';
  const off = /^[+-]\d{4}$/.test(l.offset) ? `UTC${l.offset.slice(0, 3)}:${l.offset.slice(3)}` : '';
  const map = g?.loc && /^-?[\d.]+,-?[\d.]+$/.test(g.loc) ? (() => { const [la, lo] = g.loc.split(','); return `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=9/${la}/${lo}`; })() : '';
  const sub = [host, zone && `région ${zone}`, tz && `${tz}${off ? ` (${off})` : ''}`].filter(Boolean).map(x => esc(x)).join(' · ');
  return `<div class="sv-hw-loc"><span class="sv-hw-flag" aria-hidden="true">${flag(cc) || icon('server')}</span>
    <div><strong>${esc(where || 'Emplacement inconnu')}</strong><em>${sub || 'L’hébergeur ne publie pas de métadonnées lisibles depuis la machine.'}</em>
    ${l.geoError ? `<em class="warn">${esc(l.geoError)}</em>` : ''}${g ? `<em>Selon ipinfo.io${g.org ? ` · ${esc(g.org)}` : ''}${g.hostname ? ` · ${esc(g.hostname)}` : ''}</em>` : ''}</div>
    <span class="sv-hw-ip">${l.ip || g?.ip ? `<code>${esc(l.ip || g?.ip || '')}</code>` : ''}
      ${map ? `<a class="btn" href="${esc(map)}" target="_blank" rel="noopener">${icon('link')}Carte</a>` : ''}
      ${g ? '' : `<button class="btn" data-hw="geo" title="Le serveur demande à ipinfo.io où se trouve son adresse IP publique">${icon('eye')}Localiser l’adresse IP</button>`}</span></div>`;
}

function bodyHTML(s: Specs): string {
  const c = s.cpu, sys = s.system, n = s.net;
  const disk = s.disks.reduce((a, d) => a + d.size, 0) || s.fs.reduce((a, f) => a + f.size, 0);
  const ssd = s.disks.length ? (s.disks.every(d => d.ssd) ? 'SSD' : s.disks.some(d => d.ssd) ? 'SSD et disques durs' : 'disques durs') : '';
  const nvme = s.disks.some(d => d.name.startsWith('nvme')) ? ' NVMe' : '';
  const ghz = c.mhz ? `${num(c.mhz / 1000, 2)} GHz` : '';
  const cores = c.cores && c.cores !== c.threads ? `${c.cores} cœurs physiques, ${c.threads} fils` : `${c.threads} fil${c.threads > 1 ? 's' : ''}`;
  const pubs = n.addrs.filter(a => a.public), privs = n.addrs.filter(a => !a.public);
  const tiles = `<div class="sv-grid sv-hw-grid">
    ${tile('Processeur', `${c.threads || '—'} vCPU`, [cores, ghz].filter(Boolean).join(' · '))}
    ${tile('Mémoire', s.mem.total ? size(s.mem.total) : '—', s.mem.swap ? `+ ${size(s.mem.swap)} d’échange (swap)` : 'pas d’échange (swap)')}
    ${tile('Stockage', disk ? size(disk) : '—', [ssd + nvme, s.disks.length > 1 ? `${s.disks.length} disques` : ''].filter(Boolean).join(' · '))}
    ${tile('Réseau', n.speed ? (n.speed >= 1000 ? `${num(n.speed / 1000)} Gb/s` : `${n.speed} Mb/s`) : '—', [n.iface, pubs.length ? `${pubs.length} adresse${pubs.length > 1 ? 's' : ''} publique${pubs.length > 1 ? 's' : ''}` : 'aucune adresse publique'].filter(Boolean).join(' · '))}</div>`;
  const facts = `<dl class="sv-facts">
    ${fact('Modèle du processeur', esc(c.model), c.model)}
    ${fact('Cache', esc([c.l2 && `L2 ${c.l2}`, c.l3 && `L3 ${c.l3}`].filter(Boolean).join(' · ')))}
    ${fact('Jeux d’instructions', c.flags.map(f => esc(FLAGS[f] ?? f)).join(', '))}
    ${fact('Offre', esc(s.location.type || ''))}
    ${fact('Plateforme', esc([sys.vendor, sys.product].filter(Boolean).join(' · ')), `${sys.vendor} ${sys.product}`)}
    ${fact('Virtualisation', esc([sys.virt, c.hypervisor].filter((x, i, a) => x && a.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i).join(' · ')))}
    ${fact('Architecture', esc(sys.arch))}
    ${fact('Distribution', esc(sys.distro))}
    ${fact('Noyau', esc(sys.kernel))}
    ${fact('Nom d’hôte', esc(sys.fqdn || sys.hostname), sys.fqdn)}
    ${fact('Allumé depuis', sys.uptime ? since(sys.uptime) : '')}
    ${fact('Utilisateur SSH', esc(sys.user) + (sys.user === 'root' ? ' · administrateur' : sys.sudo ? ' · sudo sans mot de passe' : sys.user ? ' · sans sudo' : ''))}
    ${fact('Fichiers ouverts', esc(sys.nofile === 'unlimited' ? 'illimité' : sys.nofile))}
    ${fact('Carte graphique', esc(s.gpu.join(' · ')), s.gpu.join('\n'))}</dl>`;
  const fs = s.fs.length ? `<h4 class="sv-ext-t">Volumes</h4><div class="sv-tblw"><table class="sv-tbl"><thead><tr><th></th><th>Point de montage</th><th>Type</th><th>Utilisé</th><th class="sv-hw-m"></th><th>Libre</th></tr></thead><tbody>${s.fs.map(f => `<tr><td></td><td><strong>${esc(f.mount)}</strong><em>${esc(f.dev)}</em></td><td>${esc(f.type)}</td><td class="sv-num">${size(f.used)} / ${size(f.size)}</td><td class="sv-hw-m">${chart.meter(f.pct, 100, f.pct >= 90 ? 'red' : f.pct >= 75 ? 'amber' : 'green')}</td><td class="sv-num">${size(f.free)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const disks = s.disks.length ? `<div class="sv-nodes">${s.disks.map(d => `<span class="sv-node">${icon('database')}${esc(d.name)}<em>${size(d.size)} · ${d.ssd ? 'SSD' : 'disque dur'}${d.model ? ` · ${esc(d.model)}` : ''}</em></span>`).join('')}</div>` : '';
  const addr = (a: Specs['net']['addrs'][number]) => `<span class="sv-node"><code>${esc(a.addr)}</code><em>${esc(a.iface)} · IPv${a.v6 ? 6 : 4}</em></span>`;
  const net = n.addrs.length ? `<h4 class="sv-ext-t">Adresses</h4><div class="sv-nodes">${pubs.map(addr).join('')}${privs.map(addr).join('')}</div>` : '';
  const tools = sys.tools.length ? `<h4 class="sv-ext-t">Logiciels installés</h4><div class="sv-nodes">${sys.tools.map(t => `<span class="sv-chip">${esc(t)}</span>`).join('')}</div>` : '';
  return locHTML(s) + tiles + facts + disks + fs + net + tools;
}

function paint(sec: HTMLElement, s: Specs): void {
  const b = $('.sv-hw-b', sec), sub = $('[data-hw-sub]', sec); if (!b || !sub) return;
  sub.textContent = [provider(s), s.location.type, `lu ${new Date(s.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`].filter(Boolean).join(' · ');
  b.innerHTML = bodyHTML(s);
}

/** Remplit la fiche (depuis la mémoire si elle a déjà été lue, sauf `fresh`). */
export async function load(box: HTMLElement, p: Project, opts: { fresh?: boolean; geo?: boolean } = {}): Promise<void> {
  const sec = $('.sv-hw', box); if (!sec) return;
  const key = keyOf(p), old = cache.get(key);
  if (old && !opts.fresh && !opts.geo) { paint(sec, old); return; }
  const b = $('.sv-hw-b', sec);
  if (b && !old) b.innerHTML = '<div class="pj-skel"></div>';
  const geo = opts.geo || !!old?.location.geo;
  const r = await bridge.call('agent', 'server', { project: p.id, op: 'specs', server: infra.current(p), geo }, 60000) as unknown as Specs;
  if (!sec.isConnected || keyOf(p) !== key) return;
  if (!r.ok) { if (b) b.innerHTML = `<p class="sv-err">${icon('shield')}${esc(r.message ?? 'Lecture impossible.')}</p>`; return; }
  cache.set(key, r); paint(sec, r);
}

/** Clics de la fiche (`data-hw`) ; vrai si le clic est traité. */
export function click(t: HTMLElement, p: Project): boolean {
  const b = t.closest<HTMLElement>('[data-hw]'), box = t.closest<HTMLElement>('.sv-box'); if (!b || !box) return false;
  b.setAttribute('disabled', '');
  if (b.dataset.hw === 'geo') b.textContent = 'Localisation…';
  void load(box, p, { fresh: true, geo: b.dataset.hw === 'geo' }).finally(() => b.removeAttribute('disabled'));
  return true;
}
