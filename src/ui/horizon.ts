// Fonds « Horizon » et « Mon image » (`data-backdrop="horizon" | "image"`, styles dans css/sky.css).
// Horizon : un paysage de nuit calculé dans la page (aucune image livrée) : ciel étoilé, plaine ambrée à l'horizon,
// mer de nuages éclairée à contre-jour, sphère noire et faisceau. Dessiné par tranches pour ne pas figer l'interface,
// puis posé dans `--sky` comme le fond « Ciel ».
// Mon image : une image choisie par l'utilisateur (générée par une IA, une photo…), réduite et gardée sur l'appareil
// dans une petite base IndexedDB à part (hors coffre : elle doit s'afficher avant le déverrouillage).

type RGB = [number, number, number];

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Bruit « en chou-fleur » : sommets ronds, creux nets, comme les bourgeons d'un cumulus. Entre 0 et 1. */
function billow(x: number, y: number, s: number, oct: number): number {
  let t = 0, a = .5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { t += a * Math.abs(2 * noise(x * f, y * f, s + i * 31) - 1); n += a; f *= 2.07; a *= .5; }
  return Math.min(1, t / n * 1.9);
}
const clamp = (v: number): number => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (a: number, b: number, v: number): number => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Hauteur de l'horizon, en part de la hauteur de la scène. */
const HORIZON = .245;
const NIGHT: RGB = [2, 2, 4], AMBER: RGB = [172, 108, 34], EARTH: RGB = [12, 8, 6];
const SHADE: RGB = [10, 7, 5], BODY: RGB = [78, 60, 46], CREAM: RGB = [208, 186, 156], RIM: RGB = [230, 122, 30];

/** Bancs de nuages, du plus lointain (0) au plus proche : chacun est une rangée de cumulus dont on calcule la crête, colonne par colonne. */
const LAYERS = 12;
interface Layer { /** Part de la profondeur, 0 au loin, 1 au premier plan. */ u: number; /** Taille d'un cumulus, en hauteurs de scène. */ s: number; base: number; tops: Float32Array }
/** Crête d'une rangée de bourgeons ronds (demi-cercles tirés au sort, une case sur deux environ), en unités de `cell`. */
function lobes(x: number, cell: number, rmin: number, rmax: number, seed: number): number {
  const q = x / cell, c0 = Math.floor(q);
  let top = 0;
  for (let c = c0 - 2; c <= c0 + 2; c++) {
    const cx = c + hash(c, 1, seed), r = rmin + (rmax - rmin) * hash(c, 2, seed), dx = q - cx;
    if (Math.abs(dx) >= r) continue;
    top = Math.max(top, Math.sqrt(r * r - dx * dx) * (.55 + .45 * hash(c, 3, seed)));
  }
  return top;
}
function layers(w: number, h: number, seed: number): Layer[] {
  const out: Layer[] = [];
  for (let i = 0; i < LAYERS; i++) {
    const u = i / (LAYERS - 1), s = .014 + .17 * u ** 1.7, base = HORIZON + .035 + 1.0 * (1 - HORIZON) * u ** 1.3;
    const tops = new Float32Array(w), sd = seed + i * 17;
    for (let x = 0; x < w; x++) {
      const nx = x / h + i * 3.3;
      // Au loin, des nappes éparses qui laissent voir la plaine ; au premier plan, un banc continu.
      const cover = smooth(.5 - .5 * u, .7 - .5 * u, noise(nx / s * .09, i * 3.7, seed + 40));
      // Gros dômes, bourgeons moyens posés dessus, petits bourgeons sur la crête : la silhouette en chou-fleur d'un cumulus.
      const big = lobes(nx, s * 1.5, .9, 1.7, sd) * 1.1 + .35 * noise(nx / s * .5, 0, sd + 1);
      const mid = lobes(nx, s * .5, .7, 1.3, sd + 2) * .36, small = lobes(nx, s * .17, .6, 1.2, sd + 3) * .12;
      tops[x] = base - s * (big + mid + small) * (.25 + .75 * cover);
    }
    out.push({ u, s, base, tops });
  }
  return out;
}

function pixel(x: number, y: number, w: number, h: number, seed: number, ls: Layer[], out: Uint8ClampedArray, o: number): void {
  const nx = x / h, ny = y / h;
  let c: RGB;
  if (ny < HORIZON) {
    // Ciel : noir profond, étoiles clairsemées, lueur ambrée au ras de l'horizon.
    c = mix(NIGHT, [40, 24, 9], smooth(HORIZON - .03, HORIZON, ny) * .45);
    const r = hash(x, y, seed + 11);
    if (r > .9972) { const b = 50 + 200 * hash(x, y, seed + 12) ** 2.4, cold = hash(x, y, seed + 13) > .8; c = [c[0] + b * (cold ? .8 : 1), c[1] + b * (cold ? .88 : .96), c[2] + b * (cold ? 1 : .9)]; }
  } else {
    const t = ny - HORIZON, far = 1 - smooth(0, .15, t);
    // Plaine : braise au loin, terre sombre plus près, bras d'eau noirs.
    c = mix(EARTH, AMBER, far * (.72 + .28 * noise(nx * 4, t * 40, seed + 70)));
    c = mix(c, [5, 5, 8], smooth(.56, .7, noise(nx * 2.4 + 40, t * 26, seed + 72)) * .85 * (1 - far * .5));
    // Le banc le plus proche dont la crête passe au-dessus du point l'emporte.
    for (let i = LAYERS - 1; i >= 0; i--) {
      const L = ls[i]!, top = L.tops[x] ?? 1;
      if (ny < top) continue;
      const d = (ny - top) / L.s, f = 1 / L.s, u = L.u;
      // Bourgeons : sommets ronds éclairés, creux dans l'ombre ; la lumière vient de l'horizon et s'éteint en descendant dans le banc.
      const b = 1 - billow(nx * f * 1.6 + i * 3.1, ny * f * 1.6, seed + 200 + i * 5, 3);
      const light = (.18 + .82 * Math.exp(-d * .9)) * (.45 + .55 * b);
      let k = mix(SHADE, BODY, clamp(light * (.45 + .75 * u)));
      k = mix(k, CREAM, clamp(light * 1.6 - .78) * smooth(.4, 1, u) * .75);
      // Contre-jour : crête orangée, vive à mi-distance, crème au premier plan.
      k = mix(k, mix(RIM, CREAM, smooth(.5, 1, u)), Math.exp(-d * (7 + 6 * u)) * (.85 - .4 * u));
      // Brume chaude sur les bancs lointains.
      k = mix(k, [104, 62, 20], (1 - smooth(0, .45, u)) * .5);
      const grain = .95 + .1 * hash(x, y, seed + 5);
      c = [k[0] * grain, k[1] * grain, k[2] * grain];
      break;
    }
  }
  out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
}

/** Sphère noire, faisceau et ligne d'horizon, par-dessus le paysage. */
function props(g: CanvasRenderingContext2D, w: number, h: number): void {
  const cx = Math.round(w / 2) + .5, hy = HORIZON * h, sy = .565 * h, r = .078 * h;
  // Ligne d'horizon : un trait d'atmosphère froide.
  const line = g.createLinearGradient(0, hy - 3, 0, hy + 2);
  line.addColorStop(0, 'rgb(70 96 110 / 0)'); line.addColorStop(.6, 'rgb(84 112 126 / .7)'); line.addColorStop(1, 'rgb(40 30 20 / 0)');
  g.fillStyle = line; g.fillRect(0, hy - 3, w, 5);
  // Faisceau : rouge orangé dans le ciel, fil clair jusqu'à la sphère, puis un fil ténu en dessous.
  g.globalCompositeOperation = 'lighter';
  const glow = g.createLinearGradient(cx - 9, 0, cx + 9, 0);
  glow.addColorStop(0, 'rgb(255 60 20 / 0)'); glow.addColorStop(.5, 'rgb(255 70 24 / .5)'); glow.addColorStop(1, 'rgb(255 60 20 / 0)');
  g.fillStyle = glow; g.fillRect(cx - 9, 0, 18, hy);
  g.fillStyle = 'rgb(255 132 72)'; g.fillRect(cx - 1.5, 0, 3, hy);
  g.fillStyle = 'rgb(255 226 170 / .8)'; g.fillRect(cx - .5, hy, 1, sy - r - hy);
  const tail = g.createLinearGradient(0, sy + r, 0, sy + r + .3 * h);
  tail.addColorStop(0, 'rgb(255 200 140 / .5)'); tail.addColorStop(1, 'rgb(255 200 140 / 0)');
  g.fillStyle = tail; g.fillRect(cx - .5, sy + r, 1, .3 * h);
  g.globalCompositeOperation = 'source-over';
  // Sphère : noire, avec le reflet du paysage (ciel en bas, braise au milieu) et un liseré chaud.
  g.save(); g.beginPath(); g.arc(cx, sy, r, 0, Math.PI * 2); g.clip();
  const body = g.createRadialGradient(cx - r * .25, sy - r * .35, r * .1, cx, sy, r);
  body.addColorStop(0, '#2a1c10'); body.addColorStop(.55, '#0b0705'); body.addColorStop(1, '#020202');
  g.fillStyle = body; g.fillRect(cx - r, sy - r, r * 2, r * 2);
  g.fillStyle = 'rgb(214 132 44 / .16)'; g.beginPath(); g.ellipse(cx, sy - r * .1, r * .92, r * .2, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#030303'; g.beginPath(); g.ellipse(cx, sy + r * .28, r * .4, r * .3, 0, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 90; i++) { // braises reflétées
    const a = hash(i, 1, 9) * Math.PI * 2, d = Math.sqrt(hash(i, 2, 9)) * r * .92;
    g.fillStyle = `rgb(255 ${150 + Math.round(hash(i, 3, 9) * 70)} 70 / ${(.12 + hash(i, 4, 9) * .5).toFixed(2)})`;
    g.fillRect(cx + Math.cos(a) * d, sy - r * .1 + Math.sin(a) * d * .55, 1.2, 1.2);
  }
  g.restore();
  g.strokeStyle = 'rgb(236 150 60 / .55)'; g.lineWidth = 1.2; g.beginPath(); g.arc(cx, sy, r - .6, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
  g.fillStyle = 'rgb(255 214 150 / .95)'; g.beginPath(); g.arc(cx, sy - r * .86, 1.6, 0, Math.PI * 2); g.fill();
}

let url = '', drawn = '', job = 0;
const root = (): CSSStyleDeclaration => document.documentElement.style;
function show(blob: Blob | null, key: string, size: string): void {
  if (!blob || drawn !== key) return;
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(blob);
  root().setProperty('--sky', `url("${url}")`); root().setProperty('--sky-size', size);
}

/** Dessine le paysage à la taille de l'écran (une fois par taille), par tranches de quelques millisecondes. */
export function paint(): void {
  const sw = Math.max(screen.width, innerWidth), sh = Math.max(screen.height, innerHeight);
  // Au plus ~1,3 million de points calculés : au-delà, la scène est agrandie par le navigateur (elle est douce, cela ne se voit pas).
  const k = Math.min(1, Math.sqrt(1_300_000 / (sw * sh))), W = Math.round(sw * k), H = Math.round(sh * k);
  const key = `horizon|${W}x${H}`;
  if (key === drawn) return;
  drawn = key;
  const mine = ++job, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); if (!g) return;
  const img = g.createImageData(W, H), d = img.data;
  const ls = layers(W, H, 19);
  let y = 0;
  const step = (): void => {
    if (mine !== job) return; // une autre taille ou un autre fond a pris la place
    const end = performance.now() + 9;
    while (y < H && performance.now() < end) { for (let x = 0; x < W; x++) pixel(x, y, W, H, 19, ls, d, (y * W + x) * 4); y++; }
    if (y < H) { setTimeout(step, 0); return; }
    g.putImageData(img, 0, 0); props(g, W, H);
    cv.toBlob(b => show(b, key, 'cover'), 'image/jpeg', .92);
  };
  setTimeout(step, 0);
}

// ---------- Mon image ----------
const DB = 'studio-backdrop', STORE = 'kv', KEY = 'image';
function db(): Promise<IDBDatabase> {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error ?? new Error('Stockage indisponible.'));
  });
}
async function kv<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((ok, ko) => { const r = run(d.transaction(STORE, mode).objectStore(STORE)); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error ?? new Error('Stockage indisponible.')); });
  } finally { d.close(); }
}
const has = (): boolean => localStorage.getItem('studio.backdrop.image') === '1';
/** Vrai si une image a été choisie sur cet appareil. */
export const hasImage = has;

/** Affiche l'image choisie ; renvoie faux s'il n'y en a pas (ou plus). */
export async function paintImage(): Promise<boolean> {
  if (!has()) return false;
  const key = 'image';
  if (drawn === key) return true;
  try {
    const blob = await kv<unknown>('readonly', s => s.get(KEY));
    if (!(blob instanceof Blob)) { localStorage.removeItem('studio.backdrop.image'); return false; }
    drawn = key; job++;
    show(blob, key, 'cover');
    return true;
  } catch { return false; }
}

/** Garde une image comme fond : réduite à 2880 px de large au plus, en JPEG. Lève une erreur lisible si elle ne se lit pas. */
export async function setImage(file: Blob): Promise<void> {
  if (!/^image\/(png|jpeg|webp|avif|gif)$/.test(file.type)) throw new Error('Format non pris en charge : choisis une image PNG, JPEG ou WebP.');
  if (file.size > 40 * 1048576) throw new Error('Image trop lourde (40 Mo au plus).');
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('Cette image ne se lit pas.'); }
  const k = Math.min(1, 2880 / bmp.width, 1800 / bmp.height), cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
  cv.getContext('2d')?.drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close();
  const blob = await new Promise<Blob | null>(ok => cv.toBlob(ok, 'image/jpeg', .9));
  if (!blob) throw new Error('Cette image ne se lit pas.');
  await kv('readwrite', s => s.put(blob, KEY));
  localStorage.setItem('studio.backdrop.image', '1');
  drawn = ''; // forcer le prochain affichage
}

/** Retire l'image choisie. */
export async function clearImage(): Promise<void> {
  localStorage.removeItem('studio.backdrop.image');
  if (drawn === 'image') drawn = '';
  try { await kv('readwrite', s => s.delete(KEY)); } catch { /* rien à retirer */ }
}

/** À appeler quand un autre fond prend la place : le prochain `paint` redessinera. */
export function release(): void { drawn = ''; job++; }
