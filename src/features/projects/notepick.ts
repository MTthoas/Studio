// Choix des notes d'un projet à joindre à une consigne (Claude Code) ou à une conversation (page Claude) :
// une fenêtre avec recherche, cases à cocher et « Tout cocher ». Seules les notes lisibles par l'IA y figurent
// (ni chiffrées, ni #privé, ni la liste des tâches) ; rien n'est envoyé ici, la fenêtre ne rend qu'une liste d'ids.
import * as store from '../../core/store.ts';
import * as ai from '../../integrations/ai.ts';
import * as model from './model.ts';
import { esc } from '../../lib/markdown.ts';
import { fold } from '../../lib/fuzzy.ts';
import { icon, modal, need, rel, $ } from '../../ui/kit.ts';
import type { Project } from './model.ts';
import type { Note } from '../../types.ts';

const titleOf = (n: Note): string => n.title.trim() || 'Sans titre';

/** Notes du projet qu'on peut joindre. `self` : la note du projet elle-même en fait partie. */
export function attachable(p: Project, self = true): Note[] {
  return model.notesOf(p).filter(n => (self || n.id !== p.id) && ai.shareable(n) && store.getBody(n) != null);
}

/** Ouvre le choix des notes à joindre ; rend la nouvelle liste complète (ordre déjà choisi gardé), ou `null` si on annule. */
export function pickNotes(p: Project, have: string[], { self = true, ok = 'Joindre' } = {}): Promise<string[] | null> {
  return pickFrom(attachable(p, self), have, { title: `Notes de ${p.name}`, ok, sub: n => n.id === p.id ? 'note du projet' : '',
    hint: `${icon('lock')}Les notes chiffrées ou marquées #privé ne sont jamais proposées.`,
    empty: `Aucune note lisible dans ce projet. Ajoute <code>#${esc(p.tag)}</code> à une note pour la rattacher.` });
}

/** La fenêtre elle-même, pour n'importe quelle liste de notes. `sub` : mention à côté du titre ; `hint` et `empty` sont du HTML sûr. */
export function pickFrom(list: Note[], have: string[], { title, ok, sub, hint, empty }: { title: string; ok: string; sub?: (n: Note) => string; hint: string; empty: string }): Promise<string[] | null> {
  return new Promise(res => {
    let out: string[] | null = null;
    const picked = new Set(have.filter(id => list.some(n => n.id === id)));
    const row = (n: Note) => { const s = sub?.(n) ?? ''; return `<label class="np-row" data-t="${esc(fold(`${titleOf(n)} ${s}`))}"><input type="checkbox" data-np="${esc(n.id)}"${picked.has(n.id) ? ' checked' : ''}>${icon('notes')}<span>${esc(titleOf(n))}${s ? `<i>${esc(s)}</i>` : ''}</span><em>${esc(rel(n.updated))}</em></label>`; };
    const m = modal({ title, cls: 'np', onClose: () => res(out), html: list.length
      ? `<input class="field" type="search" placeholder="Filtrer les notes…" aria-label="Filtrer les notes" data-np-filter autofocus>
        <div class="np-bar"><span data-np-count></span><button type="button" class="link-btn" data-np-all>Tout cocher</button><button type="button" class="link-btn" data-np-none>Tout décocher</button></div>
        <div class="np-list">${list.map(row).join('')}</div>
        <p class="modal-hint">${hint}</p>
        <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button type="button" class="btn btn-primary" data-ok>${esc(ok)}</button></div>`
      : `<p class="modal-text">${empty}</p><div class="modal-actions"><button type="button" class="btn btn-primary" data-x>Fermer</button></div>` });
    need('[data-x]', m.node).onclick = m.close;
    if (!list.length) return;
    const boxes = () => [...m.node.querySelectorAll<HTMLInputElement>('[data-np]')];
    const count = () => { const k = boxes().filter(b => b.checked).length, c = $('[data-np-count]', m.node); if (c) c.textContent = k ? `${k} note${k > 1 ? 's' : ''} cochée${k > 1 ? 's' : ''}` : 'Aucune note cochée'; };
    // « Tout cocher » ne touche que les notes visibles : filtrer puis tout cocher donne une sélection par mot-clé.
    const setAll = (on: boolean) => { for (const b of boxes()) if (!b.closest<HTMLElement>('.np-row')?.hidden) b.checked = on; count(); };
    need('[data-np-all]', m.node).onclick = () => setAll(true);
    need('[data-np-none]', m.node).onclick = () => setAll(false);
    m.node.addEventListener('change', count);
    need<HTMLInputElement>('[data-np-filter]', m.node).addEventListener('input', e => {
      const q = fold((e.target as HTMLInputElement).value.trim());
      m.node.querySelectorAll<HTMLElement>('.np-row').forEach(l => { l.hidden = !!q && !(l.dataset.t ?? '').includes(q); });
    });
    const done = () => {
      const now = new Set(boxes().filter(b => b.checked).map(b => b.dataset.np ?? ''));
      out = [...have.filter(id => now.has(id)), ...[...now].filter(id => !have.includes(id))];
      m.close();
    };
    need('[data-ok]', m.node).onclick = done;
    m.node.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done(); } });
    count();
  });
}
