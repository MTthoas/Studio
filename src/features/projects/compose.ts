// Complétion du champ du Salon : « @ » un agent du fil, « [[ » une note du projet, « / » une commande en début de champ.
// Un seul menu (`.sl-ac`, css/salon.css), posé dans le formulaire au-dessus du champ : ↑ ↓ pour choisir, Entrée ou Tab pour
// prendre, Échap pour fermer. Les listes sont demandées à chaque frappe (`Source`) : rien n'est gardé ici, et rien n'est lu
// tant qu'aucun déclencheur n'est tapé. Les touches sont prises sur le champ lui-même, avant le Salon (qui envoie sur Entrée).
import { esc } from '../../lib/markdown.ts';
import { fold } from '../../lib/fuzzy.ts';
import { icon } from '../../ui/kit.ts';
import { t as tr } from '../../ui/i18n.ts';

export interface Item { label: string; hint?: string; icon?: string; hue?: string; /** Texte mis à la place du déclencheur ; absent : une commande, le déclencheur est effacé. */ insert?: string; run?: () => void }
export interface Source { agents: () => Item[]; notes: () => Item[]; commands: () => Item[] }
type Kind = keyof Source;
interface Open { kind: Kind; from: number; items: Item[]; sel: number }
const TITLE: Record<Kind, string> = { agents: 'Écrire à', notes: 'Lier une note', commands: 'Commandes' };
const MAX = 14; // la liste défile au-delà de huit lignes (`.sl-ac`)

/** Déclencheur juste avant le curseur : `@mot`, `[[texte`, ou `/mot` seul en début de champ. */
export function trigger(text: string, caret: number): { kind: Kind; from: number; q: string } | null {
  const before = text.slice(0, caret);
  let m = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(before);
  if (m) return { kind: 'agents', from: caret - (m[1]?.length ?? 0) - 1, q: m[1] ?? '' };
  m = /\[\[([^\]\n]*)$/.exec(before);
  if (m) return { kind: 'notes', from: caret - (m[1]?.length ?? 0) - 2, q: m[1] ?? '' };
  m = /^\/([\p{L}\p{N} ’'-]*)$/u.exec(before);
  if (m) return { kind: 'commands', from: 0, q: m[1] ?? '' };
  return null;
}

/** Branche la complétion sur le champ `ta` du formulaire `form`. `changed` : le texte vient d'être modifié par un choix. */
export function bind(form: HTMLElement, ta: HTMLTextAreaElement, src: Source, changed: () => void): void {
  if (ta.dataset.cpBound) return;
  ta.dataset.cpBound = '1';
  const box = document.createElement('div');
  box.className = 'sl-ac'; box.hidden = true; box.setAttribute('role', 'listbox'); box.setAttribute('aria-label', 'Suggestions');
  form.append(box);
  let cur: Open | null = null;
  const close = (): void => { cur = null; box.hidden = true; box.replaceChildren(); ta.removeAttribute('aria-activedescendant'); };
  const draw = (): void => {
    if (!cur) return;
    const sel = cur.sel;
    box.innerHTML = `<div class="sl-ac-h">${TITLE[cur.kind]}</div>${cur.items.map((it, i) => `<button type="button" role="option" id="sl-ac-${i}" class="sl-ac-i${i === sel ? ' on' : ''}" data-i="${i}" aria-selected="${i === sel}" tabindex="-1">${it.hue ? `<i class="tag-dot" style="--c:var(--c-${esc(it.hue)})"></i>` : it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`).join('')}`;
    box.hidden = false; ta.setAttribute('aria-activedescendant', `sl-ac-${sel}`);
  };
  const refresh = (): void => {
    const t = trigger(ta.value, ta.selectionStart ?? ta.value.length);
    if (!t) { close(); return; }
    // Le libellé est cherché en français et dans la langue affichée (« /new » comme « /nouveau »).
    const q = fold(t.q.trim()), hit = (x: string): boolean => fold(x).includes(q) || fold(tr(x)).includes(q);
    const items = src[t.kind]().filter(i => !q || hit(i.label) || hit(i.hint ?? '')).slice(0, MAX);
    if (!items.length) { close(); return; }
    cur = { kind: t.kind, from: t.from, items, sel: cur?.kind === t.kind ? Math.min(cur.sel, items.length - 1) : 0 };
    draw();
  };
  const take = (i: number): void => {
    const it = cur?.items[i]; if (!cur || !it) return;
    const caret = ta.selectionStart ?? ta.value.length, head = ta.value.slice(0, cur.from), ins = it.insert ?? '';
    ta.value = head + ins + ta.value.slice(caret);
    const at = head.length + ins.length;
    close(); ta.focus(); ta.setSelectionRange(at, at); changed(); it.run?.();
  };
  ta.addEventListener('input', refresh);
  ta.addEventListener('click', refresh);
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) close(); }, 120));
  ta.addEventListener('keydown', e => {
    if (!cur) return;
    const n = cur.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); cur.sel = (cur.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; draw(); }
    else if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); take(cur.sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  // `pointerdown` et pas `click` : le champ ne perd pas la main, le menu ne se ferme pas avant le choix.
  box.addEventListener('pointerdown', e => { e.preventDefault(); const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]'); if (b) take(Number(b.dataset.i)); });
}
