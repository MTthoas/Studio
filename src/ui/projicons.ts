// Projets : logo du dépôt ou pastille de couleur (`tile`) et sélecteur de couleur (`picker`) ; styles dans css/projicons.css (préfixe pi-).
// Les pictogrammes dessinés ont été retirés de l'affichage le 28 nov. 2026 (« garde les pastilles »). `ICONS`/`guessIcon` restent
// pour le champ `icône:` du bloc ```projet (model.ts), lu mais plus montré.
import { esc } from '../lib/markdown.ts';
import { popover, HUES } from './kit.ts';
import { logoOf, onChange } from '../integrations/github/logo.ts';

export interface Glyph { label: string; base: string; m: string; words?: RegExp }

export const ICONS: Record<string, Glyph> = {
  code: { label: 'Code', base: '<path d="M8.5 7.5 4 12l4.5 4.5"/><path d="m15.5 7.5 4.5 4.5-4.5 4.5"/>', m: '<path d="m13.6 5.4-3.2 13.2"/>', words: /\b(api|code|dev|sdk|lib|cli|backend|serveur|server)\b/ },
  window: { label: 'App', base: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M3.5 9.5h17"/>', m: '<circle cx="6.6" cy="7.25" r=".55" fill="currentColor" stroke="none"/><circle cx="8.7" cy="7.25" r=".55" fill="currentColor" stroke="none"/><circle cx="10.8" cy="7.25" r=".55" fill="currentColor" stroke="none"/><path d="M7 13h6M7 15.8h4"/>', words: /\b(app|studio|logiciel|saas|outil|dashboard)\b/ },
  rocket: { label: 'Fusée', base: '<path d="M12 3.2c2.8 1.9 4.3 5 4.3 8.6v3.6H7.7v-3.6c0-3.6 1.5-6.7 4.3-8.6z"/><circle cx="12" cy="10" r="1.6"/><path d="M7.7 12.8 5.2 15.6v2.6l2.5-1.3M16.3 12.8l2.5 2.8v2.6l-2.5-1.3"/>', m: '<path d="M10.3 17.6c.3 1.4.9 2.5 1.7 3.2.8-.7 1.4-1.8 1.7-3.2"/>', words: /\b(lancement|launch|startup|mvp|fusee|rocket)\b/ },
  camera: { label: 'Photo', base: '<path d="M4 9a2 2 0 0 1 2-2h2.1l1.5-2.2h4.8L15.9 7H18a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>', m: '<circle cx="12" cy="13" r="3.4"/><circle cx="17" cy="9.8" r=".55" fill="currentColor" stroke="none"/>', words: /\b(photo|photos|insta|instagram|shooting|portfolio|camera|image)\b/ },
  play: { label: 'Vidéo', base: '<rect x="3.5" y="5" width="17" height="14" rx="4"/>', m: '<path d="M10.3 9.3v5.4l4.6-2.7z"/>', words: /\b(tiktok|video|videos|youtube|reels?|shorts?|film|clip)\b/ },
  megaphone: { label: 'Annonce', base: '<path d="M4.5 10v4h3.2l7.8 4.4V5.6L7.7 10z"/><path d="m7.7 14 1.1 5h2.4l-1-4.6"/>', m: '<path d="M18.4 9.6a3.4 3.4 0 0 1 0 4.8M20.3 7.7a6.2 6.2 0 0 1 0 8.6"/>', words: /\b(marketing|com|communication|pub|ads|campagne|newsletter|social|sociaux)\b/ },
  bag: { label: 'Boutique', base: '<path d="M5.6 8.6h12.8l-1 11.4H6.6z"/>', m: '<path d="M9 10.8V7.6a3 3 0 0 1 6 0v3.2"/>', words: /\b(boutique|shop|store|ecommerce|e-commerce|vente|merch|commerce)\b/ },
  globe: { label: 'Site', base: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/>', m: '<ellipse cx="12" cy="12" rx="3.7" ry="8.5"/>', words: /\b(site|web|www|blog|landing|vitrine)\b/ },
  book: { label: 'Livre', base: '<path d="M12 6.4c-2.4-1.5-5-1.6-7.5-.6v12.6c2.5-1 5.1-.9 7.5.6"/><path d="M12 6.4v12.6"/>', m: '<path d="M12 6.4c2.4-1.5 5-1.6 7.5-.6v12.6c-2.5-1-5.1-.9-7.5.6"/>', words: /\b(livre|book|docs?|wiki|guide|ecriture|roman|cours|formation)\b/ },
  nib: { label: 'Écriture', base: '<path d="M12 3.5 17.4 9l-2.9 8.6h-5L6.6 9z"/><path d="M9.5 17.6v2.9h5v-2.9"/>', m: '<path d="M12 3.5v6.6"/><circle cx="12" cy="11.4" r="1.25"/>', words: /\b(redaction|copywriting|plume|edito|journal|articles?)\b/ },
  palette: { label: 'Design', base: '<path d="M12 3.8a8.2 8.2 0 1 0 0 16.4c1.1 0 1.8-.8 1.8-1.7 0-1.3-1.2-1.6-1.2-2.8 0-1 .8-1.7 1.9-1.7H17a3.2 3.2 0 0 0 3.2-3.2c0-3.9-3.6-7-8.2-7z"/>', m: '<circle cx="7.9" cy="11.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="10.3" cy="7.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.6" cy="7.9" r="1.15" fill="currentColor" stroke="none"/>', words: /\b(design|ui|ux|graphisme|marque|brand|identite|illustration)\b/ },
  music: { label: 'Musique', base: '<path d="M9 17.4V6.2l10-2.1v11.3"/>', m: '<circle cx="7" cy="17.4" r="2.1"/><circle cx="17" cy="15.4" r="2.1"/>', words: /\b(musique|music|son|podcast|audio|album|label|dj)\b/ },
  mic: { label: 'Podcast', base: '<rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M12 17.2v3.3M9 20.5h6"/>', m: '<path d="M6 11a6 6 0 0 0 12 0"/>', words: /\b(podcast|interview|voix|radio|live)\b/ },
  leaf: { label: 'Nature', base: '<path d="M19.5 4.5C11 4.5 5 9 5 15.5c0 2.2 1.4 4 3.5 4 6.5 0 11-6 11-15z"/>', m: '<path d="M4.5 20.5c3-5 7-9 11.2-11.6"/>', words: /\b(bio|nature|jardin|plante|green|eco|vegan|bien-etre)\b/ },
  flame: { label: 'Flamme', base: '<path d="M12 21c-3.6 0-6-2.4-6-5.8 0-3.6 2.8-5.6 3.8-9.2 2.4 1.4 3.4 3.4 3.4 5.4 1-.6 1.6-1.6 1.8-2.8 1.9 1.6 3 3.9 3 6.4 0 3.6-2.4 6-6 6z"/>', m: '<path d="M12 21c-1.4 0-2.4-1-2.4-2.3 0-1.5 1.2-2.3 2.4-3.7 1.2 1.4 2.4 2.2 2.4 3.7 0 1.3-1 2.3-2.4 2.3z"/>', words: /\b(sport|fitness|food|cuisine|restaurant|bbq|hot|tendance)\b/ },
  cup: { label: 'Café', base: '<path d="M5 9.6h11v4.4a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 11.2h1.5a2.3 2.3 0 0 1 0 4.6H16"/>', m: '<path d="M8.6 4.4c-.8 1 .8 1.7 0 2.7M12 4c-.8 1 .8 1.7 0 2.7"/>', words: /\b(cafe|coffee|bar|the|patisserie|boulangerie|brunch)\b/ },
  heart: { label: 'Cœur', base: '<path d="M12 19.6s-7.5-4.4-7.5-10.1A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.7-7.5 10.1-7.5 10.1z"/>', m: '<path d="M8.4 9.6a1.9 1.9 0 0 1 1.7-1.2"/>', words: /\b(asso|association|sante|care|love|mariage|famille|beaute)\b/ },
  chart: { label: 'Croissance', base: '<path d="M4.5 19.5h15"/>', m: '<path d="M7.5 16.5v-3.5M12 16.5V9M16.5 16.5V5.5"/>', words: /\b(finance|stats|analytics|data|croissance|growth|invest)\b/ },
  cube: { label: '3D', base: '<path d="M12 3.5 19.5 7.7v8.6L12 20.5l-7.5-4.2V7.7z"/>', m: '<path d="M4.5 7.7 12 12l7.5-4.3M12 12v8.5"/>', words: /\b(3d|jeu video|unity|blender|produit|hardware|objet)\b/ },
  game: { label: 'Jeu', base: '<path d="M7.6 8h8.8a4 4 0 0 1 3.9 4.9l-.8 3.4a2.3 2.3 0 0 1-3.9 1L14.2 16H9.8l-1.4 1.3a2.3 2.3 0 0 1-3.9-1l-.8-3.4A4 4 0 0 1 7.6 8z"/><path d="M8.3 10.8v3M6.8 12.3h3"/>', m: '<circle cx="15.3" cy="11.3" r=".7" fill="currentColor" stroke="none"/><circle cx="16.9" cy="13" r=".7" fill="currentColor" stroke="none"/>', words: /\b(jeu|game|gaming|twitch|esport|stream)\b/ },
  mountain: { label: 'Voyage', base: '<path d="m3 19.5 6.5-11.4 3.6 6.2 2.2-3.4 5.7 8.6z"/>', m: '<circle cx="17.4" cy="6.2" r="1.8"/>', words: /\b(voyage|travel|trip|rando|outdoor|tourisme|montagne)\b/ },
  house: { label: 'Maison', base: '<path d="M4.5 10.6 12 4.5l7.5 6.1v8.9h-15z"/>', m: '<path d="M10 19.5v-5h4v5"/>', words: /\b(immo|immobilier|maison|deco|interieur|archi|travaux)\b/ },
  star: { label: 'Étoile', base: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>', m: '<path d="M12 4v3"/>', words: /\b(perso|personnel|marque perso|influence|creator|createur)\b/ },
  bolt: { label: 'Éclair', base: '<path d="M13 2.8 5.8 13.4h5.4l-1 7.8 7.4-10.8h-5.4z"/>', m: '<path d="M13 2.8 5.8 13.4h5.4l-1 7.8 7.4-10.8h-5.4z"/>', words: /\b(energie|electrique|rapide|automation|automatisation|bot)\b/ },
  cat: { label: 'Chat', base: '<path d="M5.6 9.6 6 4.2l3.9 2.9h4.2L18 4.2l.4 5.4c.6 1 .9 2.2.9 3.5 0 4-3.3 6.4-7.3 6.4s-7.3-2.4-7.3-6.4c0-1.3.3-2.5.9-3.5z"/>', m: '<path d="M9.4 12.4v1.2M14.6 12.4v1.2"/>', words: /\b(chat|cat|animal|animaux|pet|veto)\b/ },
  target: { label: 'Objectif', base: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.6"/>', m: '<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>', words: /\b(objectif|okr|strategie|conseil|consulting|coaching)\b/ },
};
export const ICON_ORDER = Object.keys(ICONS);

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Icône devinée du nom d'un projet (mots-clés), sinon une icône de son genre : vidéo pour un projet social, code ou app pour le reste. */
// Un projet social regarde d'abord les sujets de contenu (« Studio Photo » → appareil photo, pas une app).
const SOCIAL_FIRST = ['camera', 'play', 'megaphone', 'music', 'mic', 'palette', 'cup', 'flame', 'leaf', 'heart', 'mountain', 'house', 'game', 'bag', 'star', 'cat'];
export function guessIcon(name: string, kind: 'code' | 'social'): string {
  const n = ` ${fold(name).replace(/[^a-z0-9 -]+/g, ' ')} `;
  const order = kind === 'social' ? [...SOCIAL_FIRST, ...ICON_ORDER.filter(k => !SOCIAL_FIRST.includes(k))] : ICON_ORDER;
  for (const k of order) if (ICONS[k]?.words?.test(n)) return k;
  return kind === 'social' ? 'play' : 'window';
}

/** Pastille d'un projet : le logo de son dépôt principal s'il en a un (src/integrations/github/logo.ts), sinon un carré arrondi de sa couleur ; `size` = taille de la case en px, `cls` en plus (pi-lg, pi-hop…). */
export function tile(p: { icon: string; hue: string; name?: string; repos?: readonly string[] }, cls = '', size = 0): string {
  const st = `--c:var(--c-${p.hue})${size ? `;--pi:${size}px` : ''}`, repo = p.repos?.[0], src = logoOf(repo);
  return `<i class="pi${src ? ' pi-logo' : ''}${cls ? ` ${cls}` : ''}" style="${st}"${repo ? ` data-pi-repo="${esc(repo)}"` : ''}${p.name ? ` title="${esc(p.name)}"` : ' aria-hidden="true"'}>${src ? `<img src="${src}" alt="">` : ''}</i>`;
}
// Un logo arrive (ou disparaît) : les pastilles déjà affichées de ce dépôt changent sur place, sans redessiner la page.
onChange(repo => {
  const src = logoOf(repo);
  document.querySelectorAll<HTMLElement>(`.pi[data-pi-repo="${CSS.escape(repo)}"]`).forEach(el => {
    el.classList.toggle('pi-logo', !!src); el.innerHTML = src ? `<img src="${src}" alt="">` : '';
  });
});

const HUE_LABEL: Record<string, string> = { blue: 'Bleu', green: 'Vert', amber: 'Ambre', violet: 'Violet', pink: 'Rose', teal: 'Sarcelle', orange: 'Orange', indigo: 'Indigo' };

/** Sélecteur de couleur, ancré sous `anchor`. `pick` reçoit chaque choix aussitôt (l'appelant l'enregistre) ; l'icône est rendue
 *  telle quelle. Le sélecteur reste ouvert pour comparer, Échap ou un clic dehors le ferment. */
export function picker(anchor: Element, cur: { icon: string; hue: string }, pick: (next: { icon: string; hue: string }) => void): void {
  let now = { ...cur };
  const hues = () => HUES.map(h => `<button type="button" data-pi-hue="${h}" aria-pressed="${h === now.hue}" title="${HUE_LABEL[h] ?? h}" aria-label="${HUE_LABEL[h] ?? h}" style="--c:var(--c-${h})"></button>`).join('');
  const head = () => `${tile(now)}<b>${esc(HUE_LABEL[now.hue] ?? now.hue)}</b><small>Couleur du projet</small>`;
  const pop = popover(anchor, `<div class="pi-pick-h">${head()}</div><div class="pi-pick-hues" role="group" aria-label="Couleur">${hues()}</div>`, 'pi-pick');
  const m = pop.panel;
  m.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLElement>('[data-pi-hue]'); if (!b) return;
    now = { ...now, hue: b.dataset.piHue ?? now.hue };
    const h = m.querySelector('.pi-pick-h'); if (h) h.innerHTML = head();
    m.querySelector('.pi-pick-h .pi')?.classList.add('pi-hop');
    m.querySelectorAll<HTMLElement>('[data-pi-hue]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.piHue === now.hue)));
    pick(now);
  });
  m.addEventListener('keydown', e => {
    const btns = [...m.querySelectorAll<HTMLElement>('[data-pi-hue]')], i = btns.indexOf(document.activeElement as HTMLElement);
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return; e.preventDefault();
    btns[i < 0 ? 0 : (i + step + btns.length) % btns.length]?.focus();
  });
  (m.querySelector<HTMLElement>('[aria-pressed="true"]') ?? m.querySelector<HTMLElement>('[data-pi-hue]'))?.focus({ preventScroll: true });
}
