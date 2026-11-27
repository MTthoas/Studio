// Sous-agents d'une consigne Claude Code : par défaut, Claude reçoit l'outil Agent et délègue de lui-même
// (exploration, parties indépendantes, relecture), en parallèle. Cette fenêtre règle le reste : les couper,
// combien tournent ensemble, leur modèle, et des spécialistes (nom, rôle, consigne, modèle, accès) que Claude
// utilise quand leur rôle correspond. L'équipe appartient au projet (drafts.ts, une par projet) et part avec chaque
// consigne (`subagents` de `agent start`) ; le Mac le revalide (AgentTeam, Agents.swift). Avec « créer les
// spécialistes utiles », Studio ajoute lui-même à l'équipe ceux dont la consigne a besoin (autoteam.ts).
import * as ai from '../../integrations/ai.ts';
import * as saved from './drafts.ts';
import { pick } from './autoteam.ts';
import { routes, uiModel, uiTask } from './autopick.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, menu, modal, need, $$ } from '../../ui/kit.ts';
import type { Member, Team } from './drafts.ts';

/** Points de départ proposés par « Ajouter un spécialiste ». */
export const PRESETS: [label: string, m: Member][] = [
  ['Explorateur', { name: 'explorateur', model: 'haiku', access: 'read',
    description: 'Recherche dans le code, sans rien modifier : où et comment une chose est faite. Pour toute exploration large.',
    prompt: 'Tu explores le dépôt pour l’agent principal. Cherche avec Grep et Glob avant de lire, et ne lis que les passages utiles. Rends une réponse courte : les fichiers et lignes concernés (chemin:ligne), ce que fait le code, les pièges repérés. Ne propose pas de modification si on ne te le demande pas.' }],
  ['Designer', { name: 'designer', model: 'opus', access: 'all',
    description: 'Conçoit et réalise les interfaces complexes : mise en page, composants, états, responsive, mouvement, accessibilité. À appeler pour tout écran nouveau ou refondu.',
    prompt: 'Tu réalises l’interface que l’agent principal te décrit. Avant d’écrire, lis les styles et composants du dépôt (couleurs, échelle typographique, espacements, mouvement) et réutilise-les : n’invente ni couleur ni composant qui existe déjà. Traite chaque état : vide, chargement, erreur, survol, focus clavier, fenêtre étroite. Respecte prefers-reduced-motion et un contraste lisible. Vérifie le rendu par une capture d’écran quand le dépôt le permet, et cite-la. Rends : les fichiers touchés (chemin:ligne), les états couverts, les captures, ce qui reste à trancher.' }],
  ['Relecteur', { name: 'relecteur', model: '', access: 'read',
    description: 'Relit les changements une fois le travail fini : bugs, cas oubliés, régressions, conventions du dépôt.',
    prompt: 'Tu relis le travail de l’agent principal d’un œil neuf. Lis les fichiers modifiés qu’il t’indique et ce dont ils dépendent. Rends une liste courte, du plus grave au moins grave : le problème, où (chemin:ligne), la correction proposée. Ne signale que ce dont tu es sûr ; s’il n’y a rien à redire, dis-le en une ligne.' }],
  ['Testeur', { name: 'testeur', model: '', access: 'all',
    description: 'Écrit ou complète les tests d’un changement, et les lance quand les commandes sont permises.',
    prompt: 'Tu écris les tests du changement que l’agent principal te décrit, dans le style des tests existants du dépôt. Ne touche qu’aux fichiers de test. Rends : les fichiers créés ou modifiés, ce que chaque test vérifie, et le résultat si tu as pu les lancer.' }],
  ['Intégrateur', { name: 'integrateur', model: '', access: 'all',
    description: 'Après une vague de sous-agents : assemble leurs parties, réconcilie les contrats du tableau d’équipe, corrige les raccords.',
    prompt: 'Tu intègres le travail de plusieurs sous-agents. Lis d’abord tout le tableau d’équipe (plan, contrats, notes de chacun), puis les fichiers modifiés. Corrige les raccords : noms, signatures, imports et formats qui ne concordent pas, en suivant les contrats du plan. Ne réécris pas ce qui marche. Rends la liste des raccords corrigés (chemin:ligne) et ce qui reste incohérent.' }],
  ['Rédacteur', { name: 'redacteur', model: 'sonnet', access: 'all',
    description: 'Met à jour la documentation (README, commentaires d’en-tête) après un changement de comportement.',
    prompt: 'Tu mets la documentation à jour après le changement que l’agent principal te décrit. Ne touche qu’aux fichiers de documentation, dans le ton et la langue de ceux qui existent. Rends la liste des passages modifiés.' }],
];
const MODELS: [string, string][] = [['', 'Modèle de l’agent'], ...ai.CC_MODELS.filter(([v]) => v)];
const options = (list: [string, string][], cur: string): string =>
  [...list, ...(cur && !list.some(x => x[0] === cur) ? [[cur, cur] as [string, string]] : [])].map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');

/** Libellé du bouton de la consigne. */
export function label(pid: string): string {
  const t = saved.team(pid);
  return !t.on ? 'Sans sous-agent' : t.members.length ? `Sous-agents : auto + ${t.members.length}` : 'Sous-agents : auto';
}
export const HINT = 'Sous-agents : Claude confie de lui-même des parties de la consigne à des sous-agents qui travaillent en parallèle. Clique pour régler l’équipe de ce projet, ajouter des spécialistes ou les couper';

/** Spécialistes que le dernier `body` vient d'ajouter à l'équipe du projet (pour le toast de l'appelant). */
let created: string[] = [];
export const lastCreated = (): string[] => [...created];

/** Ce qui part avec la consigne ; `undefined` quand les sous-agents sont coupés. Avec `auto`, les spécialistes utiles
 *  à la consigne qui manquent à l'équipe du projet y sont ajoutés d'abord : ils y restent, modifiables dans la fenêtre. */
export function body(pid: string, prompt = '', mode = 'edit'): Record<string, unknown> | undefined {
  created = [];
  const t = saved.team(pid);
  if (!t.on) return undefined;
  if (t.auto && prompt.trim()) {
    for (const role of pick(prompt, mode)) {
      const preset = PRESETS.find(([, m]) => m.name === role)?.[1];
      if (!preset || t.members.length >= saved.TEAM_SIZE || t.members.some(m => m.name === preset.name)) continue;
      // Le modèle d'un spécialiste créé d'office suit le routage de l'orchestrateur (fenêtre « Auto » du Salon) : niveau
      // léger pour explorer, niveau interface pour le designer, niveau courant pour rédiger ; les autres gardent celui de l'agent.
      const r = routes(), model = role === 'explorateur' ? r.light : role === 'designer' ? r.ui : role === 'redacteur' ? r.standard : preset.model;
      t.members.push({ ...preset, model, auto: true }); created.push(preset.name);
    }
    if (created.length) saved.setTeam(pid, t);
  }
  // Modèle requis : pour une interface complexe, le designer ne part jamais sur un petit modèle, même si l'équipe en règle un.
  const weak = (m: string): boolean => !m || m === 'haiku' || (m === routes().light && m !== uiModel());
  const ui = !!prompt.trim() && mode !== 'read' && uiTask(prompt) === 2;
  return { on: true, max: t.max, model: t.model, members: t.members.map(({ auto: _auto, ...m }) => ui && m.name === 'designer' && weak(m.model) ? { ...m, model: uiModel() } : m) };
}

const cardHTML = (m: Member): string => `<div class="sa-card" data-m${m.auto ? ' data-auto' : ''}>
  <div class="sa-top"><input class="field" name="name" value="${esc(m.name)}" placeholder="nom-court" aria-label="Nom du spécialiste" maxlength="40" spellcheck="false" autocapitalize="off">${m.auto ? '<span class="sa-auto-tag" title="Ajouté par Studio d’après une consigne">créé automatiquement</span>' : ''}
    <select class="field" name="model" aria-label="Modèle" title="Modèle de ce spécialiste">${options(MODELS, m.model)}</select>
    <select class="field" name="access" aria-label="Accès" title="Lecture seule : il lit et cherche, sans modifier ni lancer de commande">${options([['all', 'Outils de l’agent'], ['read', 'Lecture seule']], m.access)}</select>
    <button type="button" class="icon-btn" data-del title="Retirer ce spécialiste" aria-label="Retirer ce spécialiste">${icon('trash')}</button></div>
  <input class="field" name="description" value="${esc(m.description)}" placeholder="Son rôle : quand Claude doit faire appel à lui" aria-label="Rôle" maxlength="400">
  <textarea class="field" name="prompt" rows="2" placeholder="Sa consigne (facultatif) : comment il travaille, ce qu’il doit rendre" aria-label="Consigne" maxlength="4000">${esc(m.prompt)}</textarea>
</div>`;

/** Ouvre le réglage ; rend `true` s'il a été enregistré. */
export function edit(pid: string): Promise<boolean> {
  const t: Team = saved.team(pid);
  return new Promise(res => {
    let done = false;
    const m = modal({ title: 'Sous-agents', cls: 'sa', onClose: () => res(done), html: `<form novalidate>
      <p class="modal-text">Cette équipe appartient à <strong>ce projet</strong> : les autres projets ont la leur.</p>
      <p class="modal-text">Claude Code peut confier des parties d’une même consigne à des sous-agents : ils explorent, modifient ou relisent <strong>en parallèle</strong>, chacun avec son propre contexte, puis lui rendent un résumé. Il décide seul quand cela vaut le coup : il écrit d’abord un plan (sous-tâches, fichiers réservés, contrats partagés), lance une vague, puis une seconde pour intégrer et relire.</p>
      <p class="modal-text">En mode Modifier, ils se parlent par un <strong>tableau d’équipe</strong> (dans le <code>.git</code> du dépôt, jamais commité) : chacun y note ses contrats, pièges et besoins, et relit ceux des autres. Tu le suis, et tu peux y laisser une consigne sans interrompre, depuis l’Espace agents (bouton tableau d’une vue, ou T).</p>
      <div class="ag-seg sa-seg" role="radiogroup" aria-label="Sous-agents"><label><input type="radio" name="on" value="1"${t.on ? ' checked' : ''}><span>${icon('sparkle')}Automatiques</span></label><label><input type="radio" name="on" value=""${t.on ? '' : ' checked'}><span>${icon('stop')}Coupés</span></label></div>
      <div data-body>
        <label class="ag-check sa-auto"><input type="checkbox" name="auto"${t.auto ? ' checked' : ''}><span>Créer les spécialistes utiles selon la consigne</span></label>
        <p class="sa-note">Une consigne longue, en plusieurs parties ou qui parle de tests ou de documentation ajoute un explorateur, un relecteur, un testeur, un rédacteur ou un intégrateur à l’équipe du projet. Ils y restent, tu peux les modifier ou les retirer.</p>
        <div class="sa-row">
          <label class="sa-field"><span>En parallèle, au plus</span><select class="field" name="max">${Array.from({ length: saved.TEAM_PARALLEL }, (_, i) => `<option${i + 1 === t.max ? ' selected' : ''}>${i + 1}</option>`).join('')}</select></label>
          <label class="sa-field"><span>Modèle par défaut des sous-agents</span><select class="field" name="model" title="Un modèle plus léger pour les sous-agents économise ton abonnement">${options(MODELS, t.model)}</select></label>
        </div>
        <h4 class="sa-h">Spécialistes <span>facultatif · Claude les appelle quand leur rôle correspond</span></h4>
        <div class="sa-list" data-list>${t.members.map(cardHTML).join('')}</div>
        <p class="sa-empty" data-empty>Aucun spécialiste : Claude utilise ses sous-agents d’origine (exploration, tâche générale).</p>
        <button type="button" class="btn sa-add" data-add>${icon('plus')}Ajouter un spécialiste</button>
      </div>
      <p class="lock-err" role="alert"></p>
      <p class="modal-hint">${icon('shield')}Un sous-agent a les droits de l’agent, pas plus : même copie du dépôt, mêmes outils, même bulle. Tous consomment ton abonnement Claude en même temps.</p>
      <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Enregistrer</button></div></form>` });
    const f = need<HTMLFormElement>('form', m.node), list = need('[data-list]', f), err = need('.lock-err', f);
    const cards = () => $$('[data-m]', list);
    const sync = (): void => {
      const on = !!f.querySelector<HTMLInputElement>('[name=on]:checked')?.value, n = cards().length;
      need('[data-body]', f).classList.toggle('off', !on);
      need('[data-empty]', f).hidden = n > 0;
      need<HTMLButtonElement>('[data-add]', f).disabled = n >= saved.TEAM_SIZE;
    };
    const add = (mb: Member): void => {
      // Un nom déjà pris reçoit un numéro : deux spécialistes ne peuvent pas porter le même.
      const taken = new Set(cards().map(c => need<HTMLInputElement>('[name=name]', c).value.trim()));
      let name = mb.name; for (let i = 2; name && taken.has(name); i++) name = `${mb.name}-${i}`;
      list.insertAdjacentHTML('beforeend', cardHTML({ ...mb, name }));
      sync(); err.textContent = '';
      const last = cards().at(-1); last?.scrollIntoView({ block: 'nearest' });
      if (!mb.name) last?.querySelector<HTMLInputElement>('[name=name]')?.focus();
    };
    f.addEventListener('change', e => { if ((e.target as HTMLInputElement).name === 'on') sync(); });
    f.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button'); if (!b) return;
      if (b.dataset.x !== undefined) m.close();
      else if (b.dataset.del !== undefined) { b.closest('[data-m]')?.remove(); sync(); }
      else if (b.dataset.add !== undefined) menu(b, [
        ...PRESETS.map(([l, mb]) => ({ label: l, hint: mb.access === 'read' ? 'lecture seule' : '', run: () => add(mb) })),
        '-', { label: 'Spécialiste vide', icon: 'plus', run: () => add({ name: '', description: '', prompt: '', model: '', access: 'all' }) }]);
    });
    f.addEventListener('submit', e => {
      e.preventDefault();
      const members: Member[] = [], seen = new Set<string>();
      for (const c of cards()) {
        const val = (n: string) => need<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name=${n}]`, c).value.trim();
        const name = val('name').toLowerCase(), description = val('description');
        const bad = !saved.MEMBER_RE.test(name) ? 'Nom de spécialiste invalide : minuscules, chiffres et tirets (ex. relecteur-securite).'
          : seen.has(name) ? `Deux spécialistes s’appellent « ${name} ».`
          : !description ? `Donne un rôle à « ${name} » : c’est ce qui dit à Claude quand l’appeler.` : '';
        if (bad) { err.textContent = bad; c.querySelector<HTMLElement>(`[name=${description || !saved.MEMBER_RE.test(name) || seen.has(name) ? 'name' : 'description'}]`)?.focus(); return; }
        seen.add(name);
        // Un spécialiste créé automatiquement le reste tant qu'il garde son nom ; le modifier n'y change rien.
        members.push({ name, description, prompt: val('prompt'), model: val('model'), access: val('access') === 'read' ? 'read' : 'all', ...(c.hasAttribute('data-auto') ? { auto: true } : {}) });
      }
      saved.setTeam(pid, { auto: f.querySelector<HTMLInputElement>('[name=auto]')?.checked ?? true, on: !!f.querySelector<HTMLInputElement>('[name=on]:checked')?.value, max: Number(need<HTMLSelectElement>('[name=max]', f).value) || 4,
        model: need<HTMLSelectElement>('.sa-row [name=model]', f).value, members });
      done = true; m.close();
    });
    sync();
  });
}
