// Logo d'un projet, trouvé dans son dépôt GitHub principal : un fichier `logo`, `icon`, `favicon`… (SVG de préférence),
// choisi par `pickLogo` dans l'arborescence de la branche par défaut. Affiché par `tile` (src/ui/projicons.ts) à la place
// de la pastille de couleur ; sans logo, sans jeton ou sur erreur, la pastille reste.
// Cache : localStorage (`studio.logo.<dépôt>` : chemin, sha du fichier, image en base64), revu au plus une fois par jour ;
// l'image n'est retéléchargée que si son sha a changé. En mémoire, une adresse blob: par dépôt (chaînes courtes pour paintIfChanged).
import { api, active } from './api.ts';

interface Stored { at: number; path: string; sha: string; type: string; b64: string }
interface TreeItem { path: string; type: string; sha: string; size?: number }

const KEY = 'studio.logo.', DAY = 864e5, MAX_BYTES = 150e3, REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const TYPES: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', ico: 'image/x-icon' };
const SKIP = /(^|\/)(node_modules|vendor|third_party|tests?|__tests__|fixtures|examples?|dist|build|out|coverage|\.claude|\.git)\//i;
const GOOD_DIR = /^(\.github|public|assets?|static|docs|images?|img|icons?|branding|brand|media|resources|site|web|www)$/i;

/** Meilleur candidat parmi les fichiers d'un dépôt, ou null. Pur, sans réseau. */
export function pickLogo(items: readonly { path: string; size?: number }[], repo = ''): string | null {
  const name = (repo.split('/')[1] ?? '').toLowerCase();
  let best: { path: string; score: number } | null = null;
  for (const it of items) {
    const m = /^(?:(.*)\/)?([^/]+)\.(svg|png|webp|jpe?g|ico)$/i.exec(it.path);
    if (!m || SKIP.test(it.path) || (it.size ?? 0) > MAX_BYTES) continue;
    const dir = m[1] ?? '', base = m[2]!.toLowerCase(), ext = m[3]!.toLowerCase();
    let s = /logo/.test(base) ? 30 : /^apple-touch-icon/.test(base) ? 22 : /^(app-?)?icon([-_@.]?\d+(x\d+)?)?(@\dx)?$/.test(base) ? 20 : base === 'favicon' ? 20 : 0;
    if (!s) continue;
    if (name && base.includes(name)) s += 4;
    s += ext === 'svg' ? 10 : ext === 'png' ? 6 : ext === 'webp' ? 4 : ext === 'ico' ? 1 : 2;
    const depth = dir ? dir.split('/').length : 0;
    s -= depth * 2;
    if (!dir || GOOD_DIR.test(dir.split('/').pop() ?? '')) s += 3;
    const px = Number(/(\d{2,4})(?:x\d+)?(?:@\dx)?$/.exec(base)?.[1] ?? 0);
    if (px && px < 64) s -= 5; else if (px >= 128 && px <= 512) s += 2;
    if (!best || s > best.score || (s === best.score && it.path.length < best.path.length)) best = { path: it.path, score: s };
  }
  return best?.path ?? null;
}

const urls = new Map<string, string | null>(), running = new Map<string, Promise<void>>(), listeners = new Set<(repo: string) => void>();
/** Appelé quand le logo d'un dépôt arrive ou change. */
export const onChange = (f: (repo: string) => void): void => { listeners.add(f); };

const read = (repo: string): Stored | null => { try { const v = localStorage.getItem(KEY + repo); return v ? JSON.parse(v) as Stored : null; } catch { return null; } };
const write = (repo: string, v: Stored): void => { try { localStorage.setItem(KEY + repo, JSON.stringify(v)); } catch { /* stockage plein : on s'en passe */ } };
const toUrl = (v: Stored): string | null => {
  if (!v.b64) return null;
  try { const bin = atob(v.b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return URL.createObjectURL(new Blob([bytes], { type: v.type })); }
  catch { return null; }
};
const set = (repo: string, v: Stored): void => {
  const old = urls.get(repo); if (old) URL.revokeObjectURL(old);
  urls.set(repo, toUrl(v)); listeners.forEach(f => f(repo));
};

/** Adresse du logo déjà connu (blob:), null s'il n'y en a pas ; lance la recherche en arrière-plan si besoin. */
export function logoOf(repo: string | undefined): string | null {
  if (!repo || !REPO_RE.test(repo)) return null;
  if (!urls.has(repo)) { const v = read(repo); urls.set(repo, v ? toUrl(v) : null); }
  const v = read(repo);
  if ((!v || Date.now() - v.at > DAY) && !running.has(repo) && active()) {
    const p = refresh(repo, v).catch(() => write(repo, { ...(v ?? { path: '', sha: '', type: '', b64: '' }), at: Date.now() })).finally(() => running.delete(repo));
    running.set(repo, p);
  }
  return urls.get(repo) ?? null;
}

async function refresh(repo: string, prev: Stored | null): Promise<void> {
  const info = await api<{ default_branch: string }>(`/repos/${repo}`);
  const ref = encodeURIComponent(info.default_branch);
  const tree = await api<{ tree: TreeItem[] }>(`/repos/${repo}/git/trees/${ref}?recursive=1`, undefined, { maxAge: DAY });
  const blobs = tree.tree.filter(t => t.type === 'blob'), path = pickLogo(blobs, repo), hit = blobs.find(t => t.path === path);
  if (!path || !hit) { const was = !!prev?.b64; write(repo, { at: Date.now(), path: '', sha: '', type: '', b64: '' }); if (was) set(repo, read(repo)!); return; }
  if (prev && prev.sha === hit.sha && prev.b64) { write(repo, { ...prev, at: Date.now() }); return; }
  const file = await api<{ content: string; encoding: string }>(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`);
  if (file.encoding !== 'base64') return;
  const ext = path.split('.').pop()!.toLowerCase(), v: Stored = { at: Date.now(), path, sha: hit.sha, type: TYPES[ext] ?? 'image/png', b64: file.content.replace(/\s+/g, '') };
  write(repo, v); set(repo, v);
}
