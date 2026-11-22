// Le chat du fil d'Ariane (styles css/cat.css) : un petit personnage animé comme en motion design, pas une boucle décorative.
// Il suit le pointeur de la tête et du regard (parallaxe tête / visage), saute quand on change de vue ou qu'on le touche
// (anticipation, étirement, écrasement), s'endort après un moment sans geste et se réveille au premier mouvement.
//
//   html(key?)   le balisage, à insérer dans le fil d'Ariane ; `key` = la vue affichée : un changement de clé le fait sauter.
//   init()       écoutes globales (pointeur, clavier, clic), une seule fois.
//
// Le fil d'Ariane est réécrit à chaque rendu : l'état (regard, sommeil) vit ici et repart dans le balisage, jamais dans le DOM.
import * as motion from './motion.ts';

const SLEEP_AFTER = 45_000;
let x = 0, y = 0;                 // regard, de -1 à 1
let asleep = false, lastKey = '', started = false, frame = 0;
let sleepTimer: ReturnType<typeof setTimeout> | undefined, armed = 0;

const SVG = `<svg viewBox="0 0 36 32" width="30" height="27">
<g class="cat-all">
<g class="cat-tail"><path d="M21 30.6c5.6.6 8.6-1.6 8.4-6"/><path class="cat-tip" d="M29.4 24.6c-.1-2.6-1.6-4.3-3.4-5"/></g>
<g class="cat-body"><path d="M9 32c-1-6.4.6-11.6 4.6-14.6h4.8c4 3 5.6 8.2 4.6 14.6Z"/>
<ellipse cx="13.4" cy="31" rx="2.4" ry="1.4"/><ellipse cx="18.6" cy="31" rx="2.4" ry="1.4"/>
<g class="cat-head"><path class="cat-ear-l" d="M9.8 11.4 10.4 3.8 14.6 8.4Z"/><path class="cat-ear-r" d="M22.2 11.4 21.6 3.8 17.4 8.4Z"/>
<ellipse cx="16" cy="12.6" rx="6.8" ry="5.8"/>
<g class="cat-face"><g class="cat-eyes"><ellipse cx="13.3" cy="12.2" rx=".95" ry="1.25"/><ellipse cx="18.7" cy="12.2" rx=".95" ry="1.25"/></g>
<path class="cat-nose" d="M15.2 14.6h1.6L16 15.5Z"/>
<path class="cat-whisk" d="M10 14.4 5.8 13.8M10 15.6 6 16.6M22 14.4 26.2 13.8M22 15.6 26 16.6"/></g></g></g>
<g class="cat-zz"><path d="M26 9.4h2.4L26 12.2h2.4"/><path d="M30 3.6h3L30 7h3"/></g>
</g></svg>`;

const moving = () => motion.level() === 'full';
const el = () => document.querySelector<HTMLElement>('.crumb-cat');

export function html(key = ''): string {
  const hop = !!lastKey && key !== lastKey && moving();
  lastKey = key;
  if (hop) wake();
  return `<span class="crumb-cat${asleep ? ' asleep' : ''}${hop ? ' hop' : ''}" aria-hidden="true" style="--cat-x:${x.toFixed(2)};--cat-y:${y.toFixed(2)}">${SVG}</span>`;
}

function replay(c: HTMLElement, cls: string): void {
  c.classList.remove(cls); void c.offsetWidth; c.classList.add(cls);
}
function doze(): void {
  // Appelée à chaque mouvement du pointeur : le minuteur n'est réarmé qu'une fois par seconde.
  const now = Date.now(); if (now - armed < 1000) return; armed = now;
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => { asleep = true; x = y = 0; const c = el(); if (c) { c.classList.add('asleep'); look(c); } }, SLEEP_AFTER);
}
function wake(): void {
  if (asleep) { asleep = false; const c = el(); if (c) { c.classList.remove('asleep'); if (moving()) replay(c, 'perk'); } }
  doze();
}
function look(c: HTMLElement): void { c.style.setProperty('--cat-x', x.toFixed(2)); c.style.setProperty('--cat-y', y.toFixed(2)); }

export function init(): void {
  if (started) return; started = true;
  addEventListener('pointermove', e => {
    wake();
    if (frame || !moving()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const c = el(); if (!c) return;
      const r = c.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      // Saturation douce : le regard tourne vite près du chat, presque plus au loin.
      const nx = Math.round(Math.tanh(dx / 260) * 20) / 20, ny = Math.round(Math.tanh(dy / 200) * 20) / 20;
      if (nx === x && ny === y) return;
      x = nx; y = ny; look(c);
    });
  }, { passive: true });
  addEventListener('keydown', wake, { passive: true });
  document.addEventListener('click', e => {
    const c = (e.target as Element | null)?.closest?.<HTMLElement>('.crumb-cat');
    if (c && moving()) { wake(); replay(c, 'hop'); }
  });
  doze();
}
