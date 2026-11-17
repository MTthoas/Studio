// Catalogue des modèles proposés dans la vue Modèles : une sélection de modèles ouverts de la bibliothèque d'Ollama.
// Les tailles sont celles du téléchargement (quantification par défaut d'Ollama), arrondies : elles servent à
// estimer la place et la mémoire, pas à facturer. Tout autre modèle s'installe par son nom (champ libre de la vue).

export type Kind = 'general' | 'code' | 'reason' | 'vision' | 'light';
export const KINDS: [Kind | '', string][] = [['', 'Tous'], ['general', 'Polyvalent'], ['code', 'Code'], ['reason', 'Raisonnement'], ['vision', 'Vision'], ['light', 'Léger']];

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
  { id: 'gemma3', name: 'Gemma 3', by: 'Google', desc: 'Rédaction soignée et lecture d’images. N’appelle pas d’outils.', kinds: ['general', 'vision', 'light'], tools: false, def: '4b',
    variants: [{ tag: '1b', gb: 0.8 }, { tag: '4b', gb: 3.3 }, { tag: '12b', gb: 8.1 }, { tag: '27b', gb: 17 }] },
  { id: 'mistral-small', name: 'Mistral Small', by: 'Mistral AI', desc: 'Modèle français, à l’aise avec les outils et les longues consignes.', kinds: ['general'], tools: true, def: '24b',
    variants: [{ tag: '24b', gb: 14 }] },
  { id: 'mistral-nemo', name: 'Mistral Nemo', by: 'Mistral AI', desc: 'Bon compromis en français, grande fenêtre de contexte.', kinds: ['general'], tools: true, def: '12b',
    variants: [{ tag: '12b', gb: 7.1 }] },
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
