// Choix automatique du modèle et de l'effort d'après la consigne en cours (entrée « Auto » du formulaire d'agent).
// But : ne pas payer Opus pour renommer une variable, ni confier une refonte à Haiku. Tout se joue sur la page,
// sans appel réseau : longueur, structure et mots de la consigne.

/** Valeur de l'entrée « Auto » dans la liste des modèles (jamais envoyée au Mac : remplacée par `pickFor`). */
export const AUTO = 'auto';

/** Niveaux de l'orchestrateur. Chaque consigne est rangée dans un niveau ; le niveau donne le modèle (`routes`). */
export type Tier = 'light' | 'standard' | 'deep' | 'ui';
export interface Pick { /** Modèle du niveau, tel que l'agent l'accepte (`opus`, `claude-fable-5-2`, `ollama/<nom>`…). */ model: string; effort: 'low' | 'medium' | 'high'; why: string; tier: Tier }

// ---------- Routage : quel modèle pour quel niveau ----------
// L'orchestrateur ne connaît que des niveaux ; le modèle de chacun se règle (fenêtre « Auto » du Salon) et peut être
// n'importe quel modèle que la machine de l'agent accepte : Claude, Fable, un modèle local `ollama/<nom>` du Mac ou d'un
// serveur du projet, un modèle ajouté par « Autre modèle… ». Un nouveau moteur n'a donc rien à changer ici.
/** Niveaux dans l'ordre d'affichage : clé, nom, ce qu'on y range. */
export const TIERS: [Tier, string, string][] = [['light', 'Léger', 'question, retouche, réponse courte'], ['standard', 'Courant', 'tâche habituelle, erreur à corriger'],
  ['deep', 'Profond', 'architecture, refonte, consigne longue'], ['ui', 'Interface', 'écran complexe : modèle requis']];
const ROUTES = 'studio.orchestrator.routes';
const BASE: Record<Tier, string> = { light: 'haiku', standard: 'sonnet', deep: 'opus', ui: 'opus' };
let routed: Record<Tier, string> | null = null;
/** Modèle de chaque niveau (réglage de l'appareil ; à défaut Haiku, Sonnet, Opus, et Opus pour l'interface). */
export function routes(): Record<Tier, string> {
  if (!routed) {
    let o: Partial<Record<Tier, unknown>> = {};
    try { o = JSON.parse(localStorage.getItem(ROUTES) ?? '{}') as Partial<Record<Tier, unknown>>; } catch { /* réglage illisible : défaut */ }
    const ok = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][\w.:/-]{0,80}$/.test(v);
    routed = { light: ok(o.light) ? o.light : BASE.light, standard: ok(o.standard) ? o.standard : BASE.standard, deep: ok(o.deep) ? o.deep : BASE.deep, ui: ok(o.ui) ? o.ui : BASE.ui };
  }
  return { ...routed };
}
/** Change le modèle d'un niveau ; vide = retour au défaut. */
export function setRoute(tier: Tier, model: string): void {
  const r = routes(); r[tier] = model || BASE[tier]; routed = r;
  try { localStorage.setItem(ROUTES, JSON.stringify(r)); } catch { /* plein : vaut jusqu'à la fermeture */ }
}

// `\b` ignore les lettres accentuées : les mots sont bornés par des lettres Unicode (drapeau `u`).
const vocab = (list: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list})(?![\\p{L}\\p{N}])`, 'iu');
const HEAVY = vocab('architecture|refonte|refactor\\p{L}*|r[ée]organis\\p{L}*|migr\\p{L}*|s[ée]curit[ée]|vuln\\p{L}*|perf\\p{L}*|optimis\\p{L}*|concurren\\p{L}*|race condition|fuites?|memory|m[ée]moire|conception|design|algorithm\\p{L}*|plusieurs (?:d[ée]p[ôo]ts|fichiers|modules|pages)|tout le (?:projet|code)|de bout en bout|from scratch|de z[ée]ro|pourquoi|incompr[ée]hensible|introuvable|intermittent|al[ée]atoire');
const LIGHT = vocab('renomm\\p{L}*|rename|typo|fautes?|orthographe|coquilles?|tradui\\p{L}*|reformul\\p{L}*|r[ée]sum\\p{L}*|expliqu\\p{L}*|o[ùu] (?:est|se trouve|sont)|liste\\p{L}*|montre|affiche|commentaires?|wording|libell[ée]s?|couleurs?|marges?|padding|ic[ôo]nes?|bump|version|readme|changelog');
// Vocabulaire d'interface : une tâche d'UI complexe (plusieurs de ces mots dans une consigne détaillée, ou une refonte) a un
// modèle requis, quel que soit le reste (`REQUIRED.ui`) ; une retouche (« change la couleur du bouton ») reste légère.
const UI_WORDS = 'ui|ux|interfaces?|maquettes?|mockups?|design system|web ?design|[ée]crans?|mise en page|layout|responsive|animations?|motion design|motion|transitions?|composants?|sidebar|barres? lat[ée]rales?|navigation|fil d[’\']ariane|breadcrumb|accessibilit[ée]|a11y|th[èe]mes?|typograph\\p{L}*|landing|page d[’\']accueil|formulaires?|tableaux? de bord|dashboard|onglets?|modales?|interacti\\p{L}*';
const UI = new RegExp(`(?<![\\p{L}\\p{N}])(?:${UI_WORDS})(?![\\p{L}\\p{N}])`, 'giu');
const REDO = vocab('refonte|refon\\p{L}*|redesign|repens\\p{L}*|r[ée]volutionn\\p{L}*|de z[ée]ro|from scratch|nouvel(?:le)? (?:interface|[ée]cran|page|maquette)');
/** Modèle requis pour une interface complexe : elle ne se confie pas à un petit modèle (demande du 28 nov. 2026). */
export const uiModel = (): string => routes().ui;
/** Poids « interface » d'une consigne : 0 = aucun, 1 = retouche d'interface, 2 = interface complexe (modèle requis). */
export function uiTask(text: string): 0 | 1 | 2 {
  const t = text.trim(), hits = new Set((t.match(UI) ?? []).map(x => x.toLowerCase())).size;
  if (!hits) return 0;
  const words = t.split(/\s+/).length, lines = t.split('\n').filter(l => /^\s*([-*•]|\d+[.)])\s/.test(l)).length;
  return (hits >= 2 && (words >= 18 || lines >= 2)) || (REDO.test(t) && words >= 8) ? 2 : 1;
}
const ACK = /^\s*(?:ok|oui|non|vas-y|go|continue|parfait|merci|top|c'?est bon|d'accord|valide|fais-le|lance)[\s!.]*$/iu;

/** Modèle et effort pour `text`. `read` : mode Analyser ; `reply` : réponse dans une conversation déjà lancée. */
export function pickFor(text: string, { read = false, reply = false } = {}): Pick {
  const t = text.trim(), words = t ? t.split(/\s+/).length : 0;
  const lines = t.split('\n').filter(l => /^\s*([-*•]|\d+[.)])\s/.test(l)).length;
  const code = (t.match(/```/g) ?? []).length >= 2 || /\b(error|exception|stack ?trace|traceback|at .+:\d+)\b/i.test(t);
  const r = routes(), on = (tier: Tier, effort: Pick['effort'], why: string): Pick => ({ model: r[tier], effort, why, tier });
  if (reply && (ACK.test(t) || words <= 4)) return on('light', 'low', 'réponse courte');
  // Interface complexe : le modèle requis passe avant toute économie.
  if (uiTask(t) === 2) return on('ui', 'high', 'interface complexe : modèle requis');
  const heavy = HEAVY.test(t), light = LIGHT.test(t);
  if (heavy && (words > 40 || lines >= 3 || code)) return on('deep', 'high', 'tâche lourde et détaillée');
  if (words > 220 || lines >= 6) return on('deep', 'medium', 'consigne longue');
  if (heavy) return on('deep', 'medium', 'tâche de fond');
  if (light && words <= 30 && !code) return on('light', 'low', read ? 'question simple' : 'petit changement');
  if (words <= 12 && !code) return on(read ? 'light' : 'standard', 'low', 'consigne brève');
  return on('standard', 'medium', code ? 'erreur à corriger' : 'tâche courante');
}

const NAMES: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', 'claude-fable-5-2': 'Fable 5.2' };
const EFFORT: Record<Pick['effort'], string> = { low: 'effort faible', medium: 'effort moyen', high: 'effort élevé' };
/** Nom court d'un modèle : « Opus », « Fable 5.2 », sinon son nom sans préfixe (`ollama/qwen3` → « qwen3 »). */
export const modelLabel = (m: string): string => NAMES[m] ?? m.replace(/^ollama\//, '').replace(/^claude-/, '');
export const label = (p: Pick): { model: string; effort: string } => ({ model: modelLabel(p.model), effort: EFFORT[p.effort] });
