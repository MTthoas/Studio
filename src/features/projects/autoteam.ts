// Équipe automatique : d'après la consigne, quels spécialistes (modèles `PRESETS` de subagents.ts) méritent d'être
// créés dans le projet. Heuristique locale et lisible, dans l'esprit d'autopick.ts : aucun appel, aucune IA, et
// la règle tient en quelques lignes pour pouvoir être corrigée à la lecture. Quand la consigne est courte ou d'un
// seul tenant, on ne crée rien : Claude se débrouille seul et chaque spécialiste coûte des tokens.

import { uiTask } from './autopick.ts';

/** Noms des modèles de spécialistes (clés de `PRESETS`, en minuscules sans accent). */
export type Role = 'explorateur' | 'designer' | 'relecteur' | 'testeur' | 'redacteur' | 'integrateur';

/** Retire les accents et met en minuscules : « Rédige la doc » et « redige la doc » se valent. */
const plain = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/’/g, "'").toLowerCase();

const SHORT = 90;      // en dessous, une consigne est trop courte pour justifier une équipe
const LONG = 400;      // au-delà, une consigne est longue : un regard neuf sur le résultat se justifie
const WIDE = /\b(tout(e|es|s)? (le|la|les|l)\b|partout|repo|depot|projet entier|codebase|architecture|audit|inventaire|cartograph|analyse|analyser|investigu|comprendre|comprends|explor|cherche|recherche|ou est|comment fonctionne|migrer|migration|refonte|refactor)/;
const TESTS = /\b(tests?|testes?|tester|couverture|coverage|vitest|jest|pytest|spec|e2e)\b/;
const DOCS = /\b(documentation|documente|documenter|readme|changelog|docs?|commentaires? d'en-tete|contexte\.md)\b/;

/** Nombre de parties distinctes : lignes de liste (tirets, puces, numéros), sinon phrases enchaînées par « puis », « ensuite », « et aussi ». */
function parts(text: string): number {
  const items = text.split('\n').filter(l => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length;
  if (items >= 2) return items;
  const chained = (plain(text).match(/\b(puis|ensuite|et aussi|en plus|apres ca|ainsi que)\b/g) ?? []).length + 1;
  return chained;
}

/** Spécialistes utiles pour cette consigne, dans l'ordre où ils interviennent. `mode` : 'edit' (Modifier) ou 'read' (Analyser). */
export function pick(prompt: string, mode: string): Role[] {
  const text = prompt.trim();
  const edit = mode !== 'read', ui = edit && uiTask(text) === 2;
  if (text.length < SHORT && !TESTS.test(plain(text)) && !ui) return [];
  const t = plain(text), n = parts(text), out: Role[] = [];
  // Un seul tenant et pas de mot-clé : rien. Une consigne de 90 caractères sur un seul geste n'a pas besoin d'équipe.
  const wide = WIDE.test(t) || text.length >= LONG;
  if (wide || n >= 2) out.push('explorateur');
  // Interface complexe : un designer, sur le modèle requis (`uiModel()` d'autopick.ts), puis un regard neuf sur le résultat.
  if (ui) out.push('designer');
  if (edit && (n >= 2 || text.length >= LONG || ui)) out.push('relecteur');
  if (edit && TESTS.test(t)) out.push('testeur');
  if (edit && DOCS.test(t)) out.push('redacteur');
  if (edit && n >= 3) out.push('integrateur');
  return out;
}
