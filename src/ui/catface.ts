// Chats des profils du Salon : une tête de chat par agent, animée comme en motion design (styles css/catface.css, préfixe cf-).
// Contrat (voir le tableau d'équipe) : face(seed, mood, o) rend un <svg class="cf …"> qui remplit son parent et prend la couleur --c héritée.
//
//   face(seed, mood, {look})  le balisage. Même seed = même chat : le prénom choisit, par hachage stable, la forme des oreilles,
//                             le motif du pelage, la forme des yeux, les moustaches et la teinte du pelage (5 axes, classes cf-…).
//   init()                    une écoute du pointeur (une seule fois) : les svg rendus avec `look` suivent le regard.
//
// Boucles : seulement sous un ancêtre `.cf-live` ou au survol du parent direct ; un ancêtre `.cf-hop` joue un saut, une fois.
import * as motion from './motion.ts';

export type Mood = 'idle' | 'work' | 'ask' | 'done' | 'sleep';

const hash = (s: string): number => {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return h >>> 0;
};

const EARS = ['pointy', 'round', 'fold'] as const;
const PATS = ['solid', 'tabby', 'mask', 'patch', 'muzzle'] as const;
const EYES = ['round', 'almond', 'tall'] as const;
const WHISK = ['long', 'short', 'down'] as const;

// La cheffe d'équipe garde une allure fixe : oreilles pointues, tigrures nettes sur le front, yeux en amande, pelage soutenu.
const FIXED: Record<string, number[]> = { moka: [0, 1, 1, 0, 1, 0] };

/** Les six choix (oreilles, motif, yeux, moustaches, teinte, côté de la tache) tirés du prénom. */
function traits(seed: string): number[] {
  const k = seed.trim().toLowerCase();
  if (FIXED[k]) return FIXED[k];
  const h = hash(k);
  return [h % 3, (h >>> 3) % 5, (h >>> 7) % 3, (h >>> 11) % 3, (h >>> 14) % 3, (h >>> 17) & 1];
}

const m = (x: number) => +(40 - x).toFixed(2);
// Un point « x y » d'un tracé, retourné pour l'oreille / l'œil droit : les chemins sont écrits pour la gauche.
const mirror = (d: string): string => d.replace(/([MLQCZ])([^MLQCZ]*)/g, (_, c: string, a: string) => {
  const n = a.trim() ? a.trim().split(/[\s,]+/).map(Number) : [];
  return c + n.map((v, i) => i % 2 === 0 ? m(v) : v).join(' ');
});

const EAR: Record<string, [string, string]> = {
  pointy: ['M8 21 L9.4 6.4 L19.2 13.6 Z', 'M10.4 17.8 L11 10.4 L15.8 14.4 Z'],
  round: ['M7.4 21 C5.8 12.6 8.2 7.6 12 7.6 C15.4 7.6 17.8 10.6 19.2 13.8 Z', 'M9.8 17.6 C9.4 13.4 10.4 10.8 12 10.8 C13.4 10.8 14.6 12.2 15.4 14.4 Z'],
  fold: ['M8 21 L8.2 8 C12.4 6.2 16.6 9.4 19.2 13.6 Z', 'M8.2 8 C10.6 7.4 12.4 8 13.8 9.4 L9.6 11.6 Z'],
};

const eyeShape = (shape: string, left: boolean): string => {
  const d = shape === 'round' ? '<ellipse rx="2.35" ry="2.45"/>'
    : shape === 'tall' ? '<ellipse rx="1.95" ry="2.95"/>'
    : '<path d="M-2.7 1 Q-.6 -2.8 2.8 -.8 Q.6 2.8 -2.7 1 Z"/>';
  return shape === 'almond' && !left ? '<path d="M2.7 1 Q.6 -2.8 -2.8 -.8 Q-.6 2.8 2.7 1 Z"/>' : d;
};

const eye = (shape: string, x: number, left: boolean): string =>
  `<g class="cf-eye" transform="translate(${x} 23.6)"><g class="cf-lid"><g class="cf-eo"><g class="cf-sc">${eyeShape(shape, left)}</g><circle class="cf-pu" r="1.4"/></g></g>` +
  `<path class="cf-ec cf-ec-up" d="M-2.6 .9 Q0 -2.6 2.6 .9"/><path class="cf-ec cf-ec-dn" d="M-2.6 -.5 Q0 2.4 2.6 -.5"/></g>`;

function pattern(p: string, side: number): string {
  switch (p) {
    case 'tabby':
      return '<g class="cf-mk cf-tab"><path d="M20 13v5.2M16.1 13.6l.8 3.8M23.9 13.6l-.8 3.8M7.8 23.2h3.6M8.6 26.6h3.4M32.2 23.2h-3.6M31.4 26.6h-3.4"/></g>';
    case 'mask': return '<rect class="cf-mk cf-fill" x="10.4" y="19.8" width="19.2" height="7.6" rx="3.8"/>';
    case 'patch': return `<ellipse class="cf-mk cf-fill" cx="${side ? 25.4 : 14.6}" cy="23.2" rx="4.6" ry="4.8"/>`;
    case 'muzzle': return '<ellipse class="cf-lt" cx="20" cy="30" rx="6.6" ry="4.6"/>';
    default: return '';
  }
}

function whiskers(w: string): string {
  const d = w === 'long' ? 'M12 28.4 4.6 26.8M12 29.8 4.4 30.2M12 31.2 6 33.8'
    : w === 'short' ? 'M12.6 29 7.6 28.2M12.6 30.4 7.8 31.6'
    : 'M12.4 28.8 6 30.2M12.6 30.4 7.6 33.4';
  return `<path class="cf-wh" d="${d}${mirror(d)}"/>`;
}

export function face(seed: string, mood: Mood = 'idle', o: { look?: boolean } = {}): string {
  const [e, p, y, w, t] = traits(seed), side = traits(seed)[5];
  const ear = EARS[e], eyes = EYES[y];
  const [outer, inner] = EAR[ear];
  const cls = `cf cf-${mood} cf-e-${ear} cf-p-${PATS[p]} cf-y-${eyes} cf-w-${WHISK[w]} cf-t${t}`;
  const earG = (cl: string, o1: string, i1: string) => `<g class="cf-ear ${cl}"><g class="cf-eh"><path class="cf-fur" d="${o1}"/><path class="cf-in" d="${i1}"/></g></g>`;
  return `<svg class="${cls}"${o.look ? ' data-look' : ''} viewBox="0 0 40 40" aria-hidden="true"><g class="cf-all"><g class="cf-look"><g class="cf-head">` +
    earG('cf-ear-l', outer, inner) + earG('cf-ear-r', mirror(outer), mirror(inner)) +
    '<path class="cf-fur" d="M6.4 25 C6.4 17 12 12.6 20 12.6 S33.6 17 33.6 25 C33.6 31 28 35.6 20 35.6 S6.4 31 6.4 25 Z"/>' +
    pattern(PATS[p], side) +
    `<g class="cf-face">${eye(eyes, 14.6, true)}${eye(eyes, 25.4, false)}` +
    '<path class="cf-nose" d="M18.6 26.6h2.8L20 28.3Z"/>' +
    '<path class="cf-mo cf-mo-a" d="M20 28.3v.9M20 29.2q-1.5 1.6-3 .4M20 29.2q1.5 1.6 3 .4"/>' +
    '<path class="cf-mo cf-mo-b" d="M17.2 28.9Q20 33 22.8 28.9"/>' +
    whiskers(WHISK[w]) + '</g></g></g>' +
    '<g class="cf-zz"><path d="M26 10.4h3.8l-3.8 4.4h3.8"/><path d="M31.4 4.8h2.8l-2.8 3.2h2.8"/></g></g></svg>';
}

let started = false, frame = 0;

export function init(): void {
  if (started) return; started = true;
  addEventListener('pointermove', e => {
    if (frame || motion.level() !== 'full' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const s of document.querySelectorAll<SVGElement>('svg.cf[data-look]')) {
        const r = s.getBoundingClientRect(); if (!r.width) continue;
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        // Saturation douce comme le chat du fil d'Ariane : le regard tourne vite près du chat, presque plus au loin.
        s.style.setProperty('--cf-x', (Math.round(Math.tanh(dx / 260) * 20) / 20).toFixed(2));
        s.style.setProperty('--cf-y', (Math.round(Math.tanh(dy / 200) * 20) / 20).toFixed(2));
      }
    });
  }, { passive: true });
}
