// Fichiers que l'agent envoie à l'utilisateur (vidéo, image, PDF, export) : il les écrit dans `<dépôt>/.git/studio-sorties/` et cite le
// chemin dans son message ; le Salon en fait une carte (lecteur, aperçu, téléchargement). Côté Mac : `AgentOutbox` (Agents.swift).
import * as bridge from '../../integrations/remote.ts';
import { esc } from '../../lib/markdown.ts';

const RE = /\/[^\s"'`()<>[\]]*\/\.git\/studio-sorties\/[^\s"'`()<>[\]]+/g;
/** Chemins de fichiers envoyés cités dans un texte, sans doublon (ponctuation finale retirée). */
export const pathsOf = (t: string): string[] => [...new Set((t.match(RE) ?? []).map(p => p.replace(/[.,;:!?]+$/, '')))].slice(0, 8);

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const kind = (name: string): 'video' | 'audio' | 'image' | 'pdf' | 'file' => {
  const e = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return /^(mp4|mov|m4v|webm)$/.test(e) ? 'video' : /^(mp3|m4a|wav)$/.test(e) ? 'audio' : /^(png|jpe?g|gif|webp)$/.test(e) ? 'image' : e === 'pdf' ? 'pdf' : 'file';
};
const size = (n: number): string => n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`;

/** Carte d'un fichier envoyé ; `hydrate` la remplit une fois le fichier lu par le Mac. */
export function cardHTML(path: string): string {
  const n = base(path);
  return `<div class="sl-card res ob" data-ob-path="${esc(path)}" data-ob-kind="${kind(n)}"><span class="sl-pill" style="--c:var(--c-blue)">fichier</span><div class="sl-card-t"><b>${esc(n)}</b><small>Lecture du fichier…</small></div></div>`;
}

type Got = { url: string; type: string; name: string; bytes: number } | { gone: string };
const cache = new Map<string, Got>(), flying = new Map<string, Promise<Got>>();
const bin = (data: string): Uint8Array<ArrayBuffer> => { const s = atob(data), u = new Uint8Array(new ArrayBuffer(s.length)); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
function load(project: string, path: string): Promise<Got> {
  const k = `${project}|${path}`, hit = cache.get(k);
  if (hit && 'url' in hit) return Promise.resolve(hit);
  let p = flying.get(k);
  if (!p) {
    p = bridge.call('agent', 'file', { project, path }, 60000).then((r): Got => {
      if (r.ok && typeof r.data === 'string' && typeof r.type === 'string') {
        const g: Got = { url: URL.createObjectURL(new Blob([bin(r.data)], { type: r.type })), type: r.type, name: String(r.name ?? base(path)), bytes: Number(r.size) || 0 };
        cache.set(k, g); return g;
      }
      return { gone: String(r.message ?? 'Fichier indisponible.') };
    }).catch((): Got => ({ gone: 'Fichier indisponible.' })).finally(() => { flying.delete(k); });
    flying.set(k, p);
  }
  return p;
}

function paint(el: HTMLElement, g: Got): void {
  const t = el.querySelector('.sl-card-t'); if (!t) return;
  if ('gone' in g) { t.querySelector('small')!.textContent = g.gone; el.classList.add('ob-gone'); return; }
  if (el.dataset.obDone === g.url) return;
  el.dataset.obDone = g.url;
  const k = el.dataset.obKind, name = esc(g.name), meta = `${esc(g.type.split('/')[1] ?? g.type)} · ${size(g.bytes)}`;
  const media = k === 'video' ? `<video class="ob-media" src="${esc(g.url)}" controls preload="metadata" playsinline></video>`
    : k === 'audio' ? `<audio class="ob-media" src="${esc(g.url)}" controls preload="metadata"></audio>`
    : k === 'image' ? `<img class="ob-media" src="${esc(g.url)}" alt="${name}" loading="lazy">` : '';
  const open = k === 'pdf' ? `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener">Ouvrir</a>` : '';
  t.innerHTML = `<b>${name}</b><small>${meta}</small>`;
  el.querySelector('.ob-media, .sl-card-a')?.remove();
  el.insertAdjacentHTML('beforeend', `${media}<div class="sl-card-a">${open}<a class="btn" href="${esc(g.url)}" download="${name}">Enregistrer</a></div>`);
}

/** Charge (une fois, puis depuis le cache) les fichiers envoyés présents dans `root`. */
export function hydrate(root: ParentNode, project: string): void {
  root.querySelectorAll<HTMLElement>('[data-ob-path]').forEach(el => {
    const path = el.dataset.obPath ?? '', hit = cache.get(`${project}|${path}`);
    if (hit) { paint(el, hit); return; }
    if (el.dataset.obTry === '1') return;
    el.dataset.obTry = '1';
    void load(project, path).then(g => { if (el.isConnected) paint(el, g); });
  });
}
