// Choix automatique du modèle et de l'effort d'après la consigne en cours (entrée « Auto » du formulaire d'agent).
// But : ne pas payer Opus pour renommer une variable, ni confier une refonte à Haiku. Tout se joue sur la page,
// sans appel réseau : longueur, structure et mots de la consigne.

/** Valeur de l'entrée « Auto » dans la liste des modèles (jamais envoyée au Mac : remplacée par `pickFor`). */
export const AUTO = 'auto';

export interface Pick { model: 'haiku' | 'sonnet' | 'opus'; effort: 'low' | 'medium' | 'high'; why: string }

// `\b` ignore les lettres accentuées : les mots sont bornés par des lettres Unicode (drapeau `u`).
const vocab = (list: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list})(?![\\p{L}\\p{N}])`, 'iu');
const HEAVY = vocab('architecture|refonte|refactor\\p{L}*|r[ée]organis\\p{L}*|migr\\p{L}*|s[ée]curit[ée]|vuln\\p{L}*|perf\\p{L}*|optimis\\p{L}*|concurren\\p{L}*|race condition|fuites?|memory|m[ée]moire|conception|design|algorithm\\p{L}*|plusieurs (?:d[ée]p[ôo]ts|fichiers|modules|pages)|tout le (?:projet|code)|de bout en bout|from scratch|de z[ée]ro|pourquoi|incompr[ée]hensible|introuvable|intermittent|al[ée]atoire');
const LIGHT = vocab('renomm\\p{L}*|rename|typo|fautes?|orthographe|coquilles?|tradui\\p{L}*|reformul\\p{L}*|r[ée]sum\\p{L}*|expliqu\\p{L}*|o[ùu] (?:est|se trouve|sont)|liste\\p{L}*|montre|affiche|commentaires?|wording|libell[ée]s?|couleurs?|marges?|padding|ic[ôo]nes?|bump|version|readme|changelog');
const ACK = /^\s*(?:ok|oui|non|vas-y|go|continue|parfait|merci|top|c'?est bon|d'accord|valide|fais-le|lance)[\s!.]*$/iu;

/** Modèle et effort pour `text`. `read` : mode Analyser ; `reply` : réponse dans une conversation déjà lancée. */
export function pickFor(text: string, { read = false, reply = false } = {}): Pick {
  const t = text.trim(), words = t ? t.split(/\s+/).length : 0;
  const lines = t.split('\n').filter(l => /^\s*([-*•]|\d+[.)])\s/.test(l)).length;
  const code = (t.match(/```/g) ?? []).length >= 2 || /\b(error|exception|stack ?trace|traceback|at .+:\d+)\b/i.test(t);
  if (reply && (ACK.test(t) || words <= 4)) return { model: 'haiku', effort: 'low', why: 'réponse courte' };
  const heavy = HEAVY.test(t), light = LIGHT.test(t);
  if (heavy && (words > 40 || lines >= 3 || code)) return { model: 'opus', effort: 'high', why: 'tâche lourde et détaillée' };
  if (words > 220 || lines >= 6) return { model: 'opus', effort: 'medium', why: 'consigne longue' };
  if (heavy) return { model: 'opus', effort: 'medium', why: 'tâche de fond' };
  if (light && words <= 30 && !code) return { model: 'haiku', effort: 'low', why: read ? 'question simple' : 'petit changement' };
  if (words <= 12 && !code) return { model: read ? 'haiku' : 'sonnet', effort: 'low', why: 'consigne brève' };
  return { model: 'sonnet', effort: 'medium', why: code ? 'erreur à corriger' : 'tâche courante' };
}

const NAMES: Record<Pick['model'], string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
const EFFORT: Record<Pick['effort'], string> = { low: 'effort faible', medium: 'effort moyen', high: 'effort élevé' };
export const label = (p: Pick): { model: string; effort: string } => ({ model: NAMES[p.model], effort: EFFORT[p.effort] });
