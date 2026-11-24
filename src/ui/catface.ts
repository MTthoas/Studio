// Chats des profils du Salon : un chat assis par agent, animée comme en motion design (styles css/catface.css, préfixe cf-).
// Contrat (voir le tableau d'équipe) : face(seed, mood, o) rend un <svg class="cf …"> qui remplit son parent et prend la couleur --c héritée.
//
//   face(seed, mood, {look})  le balisage. Même seed = même chat : le prénom choisit, par hachage stable, la forme des oreilles,
//                             la forme des yeux, les moustaches et la teinte du pelage (4 axes, classes cf-…). Silhouette assise
//                             d'un seul aplat, dessinée comme le chat du fil d'Ariane (src/ui/cat.ts), cadrée en icône : grosse tête, la silhouette remplit la case.
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
const EYES = ['round', 'almond', 'tall'] as const;
const WHISK = ['long', 'short', 'down'] as const;

// La cheffe d'équipe garde une allure fixe : oreilles pointues, yeux en amande, moustaches longues, pelage soutenu.
const FIXED: Record<string, number[]> = { moka: [0, 1, 0, 1] };

/** Les quatre choix (oreilles, yeux, moustaches, teinte) tirés du prénom. */
function traits(seed: string): number[] {
  const k = seed.trim().toLowerCase();
  if (FIXED[k]) return FIXED[k];
  const h = hash(k);
  return [h % 3, (h >>> 7) % 3, (h >>> 11) % 3, (h >>> 14) % 3];
}

const m = (x: number) => +(40 - x).toFixed(2);
// Un tracé retourné pour l'oreille / la moustache droite : les chemins sont écrits pour la gauche (coordonnées absolues).
const mirror = (d: string): string => d.replace(/([MLQCZ])([^MLQCZ]*)/g, (_, c: string, a: string) => {
  const n = a.trim() ? a.trim().split(/[\s,]+/).map(Number) : [];
  return c + n.map((v, i) => i % 2 === 0 ? m(v) : v).join(' ');
});

// Silhouette d'un seul aplat, comme le chat du fil d'Ariane (src/ui/cat.ts) : assis, queue à droite, yeux et nez couleur du fond.
const EAR: Record<string, string> = {
  pointy: 'M10.6 12.8 L11.4 1.8 L18.6 7.4 Z',
  round: 'M10.2 13 C9.2 6.6 10.8 2.6 13.8 2.6 C16.2 2.6 17.8 4.8 18.8 7.6 Z',
  fold: 'M10.4 12.4 L10.8 5 C13.6 3.6 16.8 5.4 18.8 7.8 Z',
};

const eyeShape = (shape: string, left: boolean): string =>
  shape === 'round' ? '<ellipse rx="1.6" ry="1.95"/>'
  : shape === 'tall' ? '<ellipse rx="1.3" ry="2.4"/>'
  : left ? '<path d="M-2 .7 Q-.5 -2.1 2.1 -.6 Q.5 2.1 -2 .7 Z"/>' : '<path d="M2 .7 Q.5 -2.1 -2.1 -.6 Q-.5 2.1 2 .7 Z"/>';

const eye = (shape: string, x: number, left: boolean): string =>
  `<g class="cf-eye" transform="translate(${x} 15.6)"><g class="cf-lid"><g class="cf-eo">${eyeShape(shape, left)}</g></g>` +
  '<path class="cf-ec cf-ec-up" d="M-2 .7 Q0 -1.7 2 .7"/><path class="cf-ec cf-ec-dn" d="M-2 -.4 Q0 1.6 2 -.4"/></g>';

function whiskers(w: string): string {
  const d = w === 'long' ? 'M12 19 6 18M12 20.6 6.2 22'
    : w === 'short' ? 'M12.2 19.2 8.6 18.6M12.2 20.6 8.8 21.6'
    : 'M12 19.4 6.8 21.2M12.4 20.8 8.2 24';
  return `<path class="cf-wh" d="${d}${mirror(d)}"/>`;
}

export function face(seed: string, mood: Mood = 'idle', o: { look?: boolean } = {}): string {
  const [e, y, w, t] = traits(seed);
  const ear = EARS[e], eyes = EYES[y], d = EAR[ear];
  const cls = `cf cf-${mood} cf-e-${ear} cf-y-${eyes} cf-w-${WHISK[w]} cf-t${t}`;
  const earG = (cl: string, p: string) => `<g class="cf-ear ${cl}"><g class="cf-eh"><path d="${p}"/></g></g>`;
  return `<svg class="${cls}"${o.look ? ' data-look' : ''} viewBox="0 0 40 40" aria-hidden="true"><g class="cf-all">` +
    '<g class="cf-tail"><path d="M28.6 38.6c4.6.4 7.2-1.8 6.8-5.8"/><path class="cf-tip" d="M35.4 32.8c-.1-2.4-1.3-4-2.9-4.8"/></g>' +
    '<g class="cf-body"><path d="M10.6 40c-1.2-7.8 1.4-13.6 6.2-16.4h6.4c4.8 2.8 7.4 8.6 6.2 16.4Z"/>' +
    '<ellipse cx="16" cy="38.4" rx="3" ry="1.6"/><ellipse cx="24" cy="38.4" rx="3" ry="1.6"/>' +
    '<g class="cf-look"><g class="cf-head">' + earG('cf-ear-l', d) + earG('cf-ear-r', mirror(d)) +
    '<ellipse cx="20" cy="15.6" rx="10.2" ry="8.6"/>' +
    `<g class="cf-face">${eye(eyes, 15.8, true)}${eye(eyes, 24.2, false)}` +
    '<path class="cf-nose" d="M18.8 19h2.4L20 20.3Z"/>' + whiskers(WHISK[w]) + '</g></g></g></g>' +
    '<g class="cf-zz"><path d="M32 9.6h2.6l-2.6 3h2.6"/><path d="M35.4 4h2.2l-2.2 2.6h2.2"/></g></g></svg>';
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
