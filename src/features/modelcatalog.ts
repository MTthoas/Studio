// Catalogue des modèles proposés dans la vue Modèles : une sélection de modèles ouverts de la bibliothèque d'Ollama.
// Les tailles sont celles du téléchargement (quantification par défaut d'Ollama), arrondies : elles servent à
// estimer la place et la mémoire, pas à facturer. Tout autre modèle s'installe par son nom (champ libre de la vue).

export type Kind = 'general' | 'code' | 'reason' | 'vision' | 'light' | 'marketing';
export const KINDS: [Kind | '', string][] = [['', 'Tous'], ['general', 'Polyvalent'], ['code', 'Code'], ['reason', 'Raisonnement'], ['vision', 'Vision'], ['light', 'Léger'], ['marketing', 'Marketing']];

export interface Variant { tag: string; gb: number }
export interface Entry {
  /** Nom dans la bibliothèque d'Ollama : le modèle s'installe par `<id>:<tag>`. */
  id: string;
  name: string;
  by: string;
  desc: string;
  kinds: Kind[];
  /** Sait appeler des outils : nécessaire aux automatisations de Studio qui lisent ou écrivent des données. */
  tools: boolean;
  variants: Variant[];
  /** Variante proposée quand la machine n'est pas encore connue. */
  def: string;
}

export const CATALOG: Entry[] = [
  { id: 'qwen3', name: 'Qwen 3', by: 'Alibaba', desc: 'Polyvalent et solide avec les outils, bon en français. Le meilleur point de départ.', kinds: ['general', 'reason'], tools: true, def: '8b',
    variants: [{ tag: '4b', gb: 2.6 }, { tag: '8b', gb: 5.2 }, { tag: '14b', gb: 9.3 }, { tag: '30b', gb: 19 }, { tag: '32b', gb: 20 }] },
  { id: 'gpt-oss', name: 'gpt-oss', by: 'OpenAI', desc: 'Le modèle ouvert d’OpenAI : raisonnement réglable, pensé pour les agents et les outils.', kinds: ['general', 'reason'], tools: true, def: '20b',
    variants: [{ tag: '20b', gb: 14 }, { tag: '120b', gb: 65 }] },
  { id: 'llama3.2', name: 'Llama 3.2', by: 'Meta', desc: 'Petit et rapide : résumés, reformulations, messages de commit.', kinds: ['general', 'light'], tools: true, def: '3b',
    variants: [{ tag: '1b', gb: 1.3 }, { tag: '3b', gb: 2 }] },
  { id: 'llama3.3', name: 'Llama 3.3', by: 'Meta', desc: 'Le grand modèle de Meta, pour une machine très bien dotée ou un serveur avec carte graphique.', kinds: ['general'], tools: true, def: '70b',
    variants: [{ tag: '70b', gb: 43 }] },
  { id: 'gemma3', name: 'Gemma 3', by: 'Google', desc: 'Rédaction soignée et lecture d’images : le bon choix d’un Mac à 8 Go pour des textes de vente. N’appelle pas d’outils.', kinds: ['general', 'vision', 'light', 'marketing'], tools: false, def: '4b',
    variants: [{ tag: '1b', gb: 0.8 }, { tag: '4b', gb: 3.4 }, { tag: '12b', gb: 8.2 }, { tag: '27b', gb: 17 }] },
  { id: 'gemma4', name: 'Gemma 4', by: 'Google', desc: 'Le successeur de Gemma 3 : multilingue, lit les images (photos de produits), réfléchit et appelle des outils.', kinds: ['general', 'vision', 'reason', 'marketing'], tools: true, def: '12b',
    variants: [{ tag: 'e2b', gb: 7.5 }, { tag: 'e4b', gb: 9.5 }, { tag: '12b', gb: 8 }, { tag: '26b', gb: 19 }, { tag: '31b', gb: 20 }] },
  { id: 'mistral-small', name: 'Mistral Small', by: 'Mistral AI', desc: 'Modèle français, à l’aise avec les outils et les longues consignes.', kinds: ['general'], tools: true, def: '24b',
    variants: [{ tag: '24b', gb: 14 }] },
  { id: 'mistral-small3.2', name: 'Mistral Small 3.2', by: 'Mistral AI', desc: 'Le plus à l’aise en français pour écrire fiches produits et annonces, et il lit aussi les photos.', kinds: ['general', 'vision', 'marketing'], tools: true, def: '24b',
    variants: [{ tag: '24b', gb: 15 }] },
  { id: 'ministral-3', name: 'Ministral 3', by: 'Mistral AI', desc: 'Petite famille de Mistral pour les machines modestes : lit les images, appelle des outils, très long contexte.', kinds: ['general', 'vision', 'light', 'marketing'], tools: true, def: '8b',
    variants: [{ tag: '3b', gb: 3 }, { tag: '8b', gb: 6 }, { tag: '14b', gb: 9.1 }] },
  { id: 'mistral-nemo', name: 'Mistral Nemo', by: 'Mistral AI', desc: 'Bon compromis en français, grande fenêtre de contexte.', kinds: ['general', 'marketing'], tools: true, def: '12b',
    variants: [{ tag: '12b', gb: 7.1 }] },
  { id: 'qwen3.5', name: 'Qwen 3.5', by: 'Alibaba', desc: 'Générale et multilingue, lit les images, réfléchit avant de répondre : une gamme de 0,8 à 122 milliards de paramètres.', kinds: ['general', 'vision', 'reason', 'marketing'], tools: true, def: '9b',
    variants: [{ tag: '0.8b', gb: 1.3 }, { tag: '2b', gb: 3.1 }, { tag: '4b', gb: 4 }, { tag: '9b', gb: 7.6 }, { tag: '27b', gb: 20 }, { tag: '35b', gb: 22 }] },
  { id: 'aya-expanse', name: 'Aya Expanse', by: 'Cohere', desc: 'Entraîné pour 23 langues : traduire et adapter une fiche produit pour plusieurs marchés.', kinds: ['general', 'marketing'], tools: true, def: '8b',
    variants: [{ tag: '8b', gb: 5.1 }, { tag: '32b', gb: 20 }] },
  { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', by: 'Alibaba', desc: 'Spécialisé dans le code : écriture, relecture, explication.', kinds: ['code'], tools: true, def: '7b',
    variants: [{ tag: '1.5b', gb: 1 }, { tag: '7b', gb: 4.7 }, { tag: '14b', gb: 9 }, { tag: '32b', gb: 20 }] },
  { id: 'devstral', name: 'Devstral', by: 'Mistral AI', desc: 'Conçu pour les agents de code : parcourt un dépôt, modifie plusieurs fichiers.', kinds: ['code'], tools: true, def: '24b',
    variants: [{ tag: '24b', gb: 14 }] },
  { id: 'deepseek-r1', name: 'DeepSeek R1', by: 'DeepSeek', desc: 'Réfléchit avant de répondre : analyse, mathématiques, problèmes à étapes.', kinds: ['reason'], tools: true, def: '8b',
    variants: [{ tag: '1.5b', gb: 1.1 }, { tag: '8b', gb: 5.2 }, { tag: '14b', gb: 9 }, { tag: '32b', gb: 20 }, { tag: '70b', gb: 43 }] },
  { id: 'phi4', name: 'Phi-4', by: 'Microsoft', desc: 'Raisonnement compact et précis. N’appelle pas d’outils.', kinds: ['reason'], tools: false, def: '14b',
    variants: [{ tag: '14b', gb: 9.1 }] },
  { id: 'phi4-mini', name: 'Phi-4 mini', by: 'Microsoft', desc: 'Très léger, appelle des outils : idéal sur un petit serveur sans carte graphique.', kinds: ['light'], tools: true, def: '3.8b',
    variants: [{ tag: '3.8b', gb: 2.5 }] },
  { id: 'llava', name: 'LLaVA', by: 'Communauté', desc: 'Décrit et lit des images : captures d’écran, schémas, photos.', kinds: ['vision'], tools: false, def: '7b',
    variants: [{ tag: '7b', gb: 4.7 }, { tag: '13b', gb: 8 }] },
];

/** Fiche du catalogue d'un modèle installé (`qwen3:8b` → Qwen 3), s'il en fait partie. */
export const entryOf = (model: string): Entry | undefined => CATALOG.find(e => e.id === model.split(':')[0]);

// ---------- Marketing ----------
// Choix pour rédiger fiches produits, annonces et textes de pub (surtout en français), du plus au moins conseillé.
// `minRam` : mémoire vive de la machine (en Go) à partir de laquelle le modèle tourne confortablement ; en dessous,
// on passe au suivant. Les noms et les tailles ont été relus sur ollama.com/library (novembre 2026).
export const MARKETING_PICKS: { id: string; why: string; minRam: number }[] = [
  { id: 'mistral-small3.2:24b', minRam: 32, why: 'Le plus naturel en français, suit bien les consignes de format, lit les photos de produits.' },
  { id: 'gemma4:12b', minRam: 16, why: 'Multilingue et rapide, lit les photos de produits : le meilleur équilibre sur 16 Go.' },
  { id: 'ministral-3:8b', minRam: 16, why: 'Compact, de Mistral : un français propre et des réponses vives.' },
  { id: 'mistral-nemo:12b', minRam: 16, why: 'Bon français et grand contexte, éprouvé pour la rédaction.' },
  { id: 'aya-expanse:8b', minRam: 16, why: 'Pensé pour 23 langues : idéal pour traduire une fiche vers d’autres marchés.' },
  { id: 'gemma3:4b', minRam: 8, why: 'Le plus léger qui écrive correctement : convient à un Mac à 8 Go.' },
];

const baseOf = (m: string): string => m.split(':')[0] ?? m;

/** Le meilleur modèle pour le marketing : déjà installé si possible, sinon le plus adapté à installer sur cette machine
 *  (`ramGb` : mémoire vive en Go, `null` si inconnue). */
export function bestForMarketing(installed: string[], ramGb: number | null): { model: string; installed: boolean; why: string } | null {
  const have = new Set(installed);
  const exact = MARKETING_PICKS.find(p => have.has(p.id));
  if (exact) return { model: exact.id, installed: true, why: exact.why };
  // Une autre variante d'une des familles conseillées (gemma4:e4b, qwen3.5:9b…), dans l'ordre de préférence des familles.
  for (const p of MARKETING_PICKS) {
    const alt = installed.find(m => baseOf(m) === baseOf(p.id));
    if (alt) return { model: alt, installed: true, why: p.why };
  }
  const other = installed.find(m => entryOf(m)?.kinds.includes('marketing'));
  if (other) return { model: other, installed: true, why: entryOf(other)?.desc ?? '' };
  const ram = ramGb ?? 16;
  const fit = MARKETING_PICKS.find(p => p.minRam <= ram) ?? MARKETING_PICKS[MARKETING_PICKS.length - 1];
  return fit ? { model: fit.id, installed: false, why: fit.why } : null;
}
