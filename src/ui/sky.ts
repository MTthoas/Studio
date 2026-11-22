// Fond « Ciel » : un ciel de cumulus en mosaïque de pixels tramés, calculé une fois dans la page (aucune image livrée).
// Posé en variable CSS `--sky` sur <html> ; css/sky.css s'en sert quand `data-backdrop="sky"`.

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Teintes du ciel (du haut vers l'horizon) et des nuages (de l'ombre à la lumière). */
const PALETTES: Record<'light' | 'dark', { sky: RGB[]; cloud: RGB[] }> = {
  light: { sky: ['#6c8793', '#7f99a2', '#93abb0', '#a7bbbb'].map(hex), cloud: ['#8e9c94', '#b9b393', '#d6c8a0', '#e9dcb6', '#f4ead0'].map(hex) },
  dark: { sky: ['#141c27', '#1b2633', '#243242', '#2e3f52'].map(hex), cloud: ['#323b47', '#454a52', '#5d5a56', '#7a7262', '#958a73'].map(hex) },
};
const CELL = 7; // pas de la mosaïque, en pixels CSS (6 de couleur + 1 de joint)
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + .5) / 16);

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
function fbm(x: number, y: number, s: number): number {
  let t = 0, a = .5, f = 1;
  for (let i = 0; i < 5; i++) { t += a * noise(x * f, y * f, s + i * 17); f *= 2.03; a *= .5; }
  return t / .97;
}
const clamp = (v: number): number => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (a: number, b: number, v: number): number => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Niveau tramé : `t` entre 0 et 1, réparti sur `n` teintes par une trame de Bayer 4×4. */
const level = (t: number, n: number, x: number, y: number): number => Math.min(n - 1, Math.floor(clamp(t) * (n - 1) + (BAYER[(x & 3) + (y & 3) * 4] ?? .5)));

let url = '', drawn = '';
/** À appeler quand un autre fond a pris `--sky` : le prochain `paint` redessinera. */
export function release(): void { drawn = ''; }

/** Dessine le ciel à la taille de l'écran (une fois par thème et par taille) et le pose dans `--sky`. */
export function paint(dark: boolean): void {
  const W = Math.min(2560, Math.max(screen.width, innerWidth)), H = Math.min(1600, Math.max(screen.height, innerHeight));
  const key = `${dark}|${W}x${H}`;
  if (key === drawn) return;
  drawn = key;
  const pal = PALETTES[dark ? 'dark' : 'light'];
  const cols = Math.ceil(W / CELL), rows = Math.ceil(H / CELL), seed = 7;
  const cells = new Uint8ClampedArray(cols * rows * 3);
  for (let y = 0; y < rows; y++) {
    const ny = y / rows;
    // Ciel dégagé en haut, cumulus qui montent du bas.
    const thr = .66 - .3 * smooth(.25, .95, ny);
    for (let x = 0; x < cols; x++) {
      const nx = x / rows; // même échelle sur les deux axes : les nuages ne s'étirent pas avec la fenêtre
      const shape = fbm(nx * 2.6, ny * 3.4, seed);
      const dens = shape - thr, edge = clamp(dens / .06);
      let c: RGB;
      if (edge > (BAYER[(x & 3) + (y & 3) * 4] ?? .5)) {
        // Lumière venue d'en haut : une cellule plus dense que sa voisine du dessus est sur la face éclairée.
        const above = fbm(nx * 2.6, (ny - 3 / rows) * 3.4, seed);
        const t = .45 + (shape - above) * 9 + dens * .9 - ny * .25;
        c = pal.cloud[level(t, pal.cloud.length, x, y)] ?? pal.cloud[0]!;
      } else {
        const t = ny * 1.05 + (noise(nx * 6, ny * 6, seed + 99) - .5) * .18;
        c = pal.sky[level(t, pal.sky.length, x, y)] ?? pal.sky[0]!;
      }
      // Légère variation d'une cellule à l'autre, comme un écran de diodes.
      const j = 1 + (hash(x, y, seed + 3) - .5) * .05, i = (y * cols + x) * 3;
      cells[i] = c[0] * j; cells[i + 1] = c[1] * j; cells[i + 2] = c[2] * j;
    }
  }
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); if (!g) return;
  const img = g.createImageData(W, H), d = img.data;
  for (let py = 0; py < H; py++) {
    const cy = (py / CELL) | 0, gy = py % CELL === CELL - 1;
    for (let px = 0; px < W; px++) {
      const cx = (px / CELL) | 0, i = (cy * cols + cx) * 3, o = (py * W + px) * 4;
      const k = gy || px % CELL === CELL - 1 ? .86 : 1; // joint de la mosaïque, un ton plus sombre
      d[o] = (cells[i] ?? 0) * k; d[o + 1] = (cells[i + 1] ?? 0) * k; d[o + 2] = (cells[i + 2] ?? 0) * k; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  cv.toBlob(b => {
    if (!b || drawn !== key) return;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(b);
    const r = document.documentElement.style;
    r.setProperty('--sky', `url("${url}")`);
    r.setProperty('--sky-size', `${W}px ${H}px`);
  });
}
