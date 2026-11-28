// Poignée de redimensionnement commune (28 nov. 2026, « je devrais pouvoir custom la size de toutes mes divs ») : glisser
// à la souris (pointeur capturé), flèches au clavier, double-clic pour revenir à la taille par défaut. La valeur est en
// pixels pour le geste ; chaque appelant la convertit (fraction, px), la borne et la garde (localStorage) dans `set`/`done`.
// Le tiroir de terminaux garde sa poignée de hauteur propre (terminal.ts) : double-clic = agrandir.
export interface GripOpts {
  axis: 'x' | 'y';
  /** Taille actuelle, en pixels. */
  get(): number;
  /** Nouvelle taille demandée (à borner par l'appelant). */
  set(px: number): void;
  /** Fin du geste : enregistrer. */
  done?(): void;
  /** Double-clic : taille par défaut. */
  reset?(): void;
  /** -1 si la taille grandit quand on tire vers la gauche (ou le haut). */
  sign?: 1 | -1;
  /** Pas des flèches, en pixels. */
  step?: number;
}

/** Branche la poignée `el` (une fois). Pendant le geste, `body.grip-x`/`grip-y` fige le curseur et la sélection. */
export function grip(el: HTMLElement, o: GripOpts): void {
  const sign = o.sign ?? 1, cls = `grip-${o.axis}`;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId);
    const p0 = o.axis === 'x' ? e.clientX : e.clientY, v0 = o.get();
    document.body.classList.add(cls);
    const move = (ev: PointerEvent) => o.set(v0 + sign * ((o.axis === 'x' ? ev.clientX : ev.clientY) - p0));
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      document.body.classList.remove(cls); o.done?.();
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', e => { if (!o.reset) return; e.preventDefault(); e.stopPropagation(); o.reset(); o.done?.(); });
  el.addEventListener('keydown', e => {
    const back = o.axis === 'x' ? 'ArrowLeft' : 'ArrowUp', fwd = o.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    o.set(o.get() + sign * (e.key === fwd ? 1 : -1) * (o.step ?? 24)); o.done?.();
  });
}

/** Lecture et écriture d'un nombre dans localStorage (stockage bloqué : valeur par défaut). */
export function stored(key: string, d: number): number { try { const v = Number(localStorage.getItem(key)); return localStorage.getItem(key) !== null && Number.isFinite(v) ? v : d; } catch { return d; } }
export function store(key: string, v: number): void { try { localStorage.setItem(key, String(v)); } catch { /* stockage plein ou bloqué */ } }
