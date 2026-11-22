// Nouveautés : ce qui change dans Studio, dans une fenêtre éditoriale à deux colonnes (texte à gauche,
// image en grain à droite).
//   - après une mise à jour (ou à la première ouverture d'une version qui en apporte), elle liste
//     la version installée puis chaque nouveauté pas encore vue ;
//   - sur Mac, quand une nouvelle version est téléchargée et vérifiée, une fenêtre propose de relancer.
//
// Ajouter une nouveauté : une entrée en tête de NEWS (identifiant stable, jamais réutilisé). Elle sera
// montrée une fois à chaque personne, puis reste consultable depuis le menu Studio → Nouveautés.
// Rédaction : voir « Annoncer une fonction visible » dans contexte.md.
import * as update from '../core/update.ts';
import { esc } from '../lib/markdown.ts';
import { icon, modal, need, toast, topLayer, target } from '../ui/kit.ts';
import type { Installed } from '../core/update.ts';
import type { ViewState } from '../types.ts';

/** Ce que les nouveautés attendent de l'application. */
export interface NewsApi {
  setView(v: ViewState): Promise<void>;
  flushAll(): Promise<void>;
  /** Toute première ouverture de Studio sur cet appareil : rien n'est « nouveau » pour cette personne. */
  firstRun: boolean;
}

/** Pastille d'un schéma : un libellé, une teinte (--c-…), une icône facultative. */
type Chip = [label: string, hue: string, icon?: string];
/**
 * Schéma d'une nouveauté. Seul `flow` est rendu (une ligne de texte « A → B → C », sous les points) ;
 * `chips` et `stack` restent en données : leurs exemples chiffrés (« 8 vCPU », « code 137 ») jureraient avec la fiche.
 */
type Visual = { kind: 'flow'; steps: Chip[] } | { kind: 'chips'; chips: Chip[] } | { kind: 'stack'; rows: [tag: Chip, text: string][] };

interface Item {
  id: string;
  /** Date de sortie, AAAA-MM-JJ. */
  date: string;
  /** Titre : le nom de la fonction, sans slogan ; 30 caractères au plus. */
  title: string;
  /** Une phrase factuelle au présent, 120 caractères au plus. */
  lead: string;
  /** Deux à quatre points : icône (non affichée), mot-clé (22 caractères au plus), précision (100 au plus). `code` entre accents graves. */
  bits: [icon: string, key: string, detail: string][];
  /** Où le trouver, en fil de menus : ['Réglages', 'Extensions']. */
  where?: string[];
  icon: string;
  /** Teinte presque neutre de l'image (une des couleurs --c-… de la feuille de style). */
  hue: string;
  visual: Visual;
  /** Ne concerne que l'app Mac. */
  mac?: boolean;
  /** Raccourci vers la fonction présentée. */
  go?: { label: string; view: ViewState };
}

// Les plus récentes d'abord.
const NEWS: Item[] = [
  { id: 'cockpit-projet-20261123', date: '2026-11-23', icon: 'graph', hue: 'blue', mac: true,
    title: 'Cockpit de projet complet',
    lead: 'Architecture, API, données, tests et environnements : tout le projet se lit et se pilote depuis sa page.',
    bits: [
      ['graph', 'Architecture', 'clients, services et bases détectés dans les dépôts, avec ce qui tourne sur quel port'],
      ['plug', 'API et données', 'routes à essayer en local, modèles et migrations Prisma ou Drizzle, scripts lancés d’un clic'],
      ['shield', 'Tests et environnements', 'suites lancées depuis Studio, résumé des échecs, variables attendues sans jamais leurs valeurs'],
      ['bot', 'Corriger avec Claude', 'un test en échec ou une variable manquante part en consigne vers un agent'],
    ],
    where: ['Projets', 'un projet', 'Architecture'],
    visual: { kind: 'flow', steps: [['Dépôts', 'gray', 'code'], ['Analyse', 'blue', 'graph'], ['Lancer et corriger', 'green', 'check']] } },
  { id: 'images-prompt-20261123', date: '2026-11-23', icon: 'eye', hue: 'violet', mac: true,
    title: 'Images dans les consignes',
    lead: 'Une capture ou une maquette se colle dans la consigne : Claude Code la regarde avant de travailler.',
    bits: [
      ['eye', 'Coller, déposer, choisir', '`⌘V`, glisser-déposer ou bouton image ; six images par message, vignettes avant l’envoi'],
      ['terminal', 'Partout où tu écris', 'nouvelle consigne, réponse dans un fil, Espace agents, message mis en attente'],
      ['shield', 'Gardées sur le Mac', 'rangées dans le `.git` du dépôt, jamais commitées, effacées après trente jours'],
    ],
    where: ['Projets', 'un projet', 'Claude Code'],
    visual: { kind: 'flow', steps: [['Capture', 'gray', 'eye'], ['Consigne', 'blue', 'terminal'], ['Agent', 'green', 'bot']] } },
  { id: 'fond-horizon-mouvement-20261123', date: '2026-11-23', icon: 'palette', hue: 'orange',
    title: 'Fond Horizon et mouvement',
    lead: 'Un paysage de nuit derrière l’app, ou ta propre image, et des transitions sur toutes les interactions.',
    bits: [
      ['palette', 'Horizon', 'ciel étoilé, mer de nuages et faisceau, calculés dans l’app ; l’accueil flotte dessus'],
      ['eye', 'Mon image', 'choisis une image générée ou une photo comme environnement : elle reste sur l’appareil'],
      ['gear', 'Mouvement réglable', 'complet, discret ou aucun ; le réglage « Réduire les animations » du système est respecté'],
    ],
    where: ['Réglages', 'Apparence', 'Fond'],
    visual: { kind: 'flow', steps: [['Apparence', 'gray', 'gear'], ['Fond', 'orange', 'palette'], ['Mouvement', 'green', 'check']] } },
  { id: 'onglet-mobile-20261122', date: '2026-11-22', icon: 'phone', hue: 'blue', mac: true,
    title: 'Onglet Mobile des projets',
    lead: 'Studio lance l’app mobile du projet sur un simulateur du Mac et en montre l’écran en direct.',
    bits: [
      ['phone', 'App détectée', 'Expo, React Native, Flutter, Capacitor, Xcode ou Gradle, lancée d’un clic sur iOS ou Android'],
      ['devices', 'Appareils', 'simulateurs iOS et émulateurs Android : démarrer, éteindre, voir l’écran sans quitter Studio'],
      ['moon', 'Réglages de test', 'clair ou sombre, taille du texte, barre d’état `9:41`, lien profond, capture sur le Bureau'],
      ['bot', 'Agents avertis', 'dans un dépôt mobile, ils regardent l’écran du simulateur au lieu de lancer un build'],
    ],
    where: ['Projets', 'un projet', 'Mobile'],
    visual: { kind: 'flow', steps: [['App détectée', 'gray', 'phone'], ['Simulateur', 'blue', 'devices'], ['Écran en direct', 'green', 'eye']] } },
  { id: 'fond-ciel-menus-barre-20261122', date: '2026-11-22', icon: 'palette', hue: 'teal',
    title: 'Fond Ciel et menus d’agents',
    lead: 'Les colonnes flottent sur un ciel en pixels, et chaque conversation de la barre latérale a son menu d’actions.',
    bits: [
      ['palette', 'Fond Ciel', 'cadre noir et ciel tramé autour des panneaux ; fond uni au choix'],
      ['more', 'Menu par ligne', 'bouton « … » au survol ou clic droit sur un projet, une conversation, un sous-agent'],
      ['stop', 'Gestes directs', 'renommer, arrêter l’agent, publier ou supprimer la copie sans ouvrir la conversation'],
    ],
    where: ['Réglages', 'Apparence', 'Fond'],
    visual: { kind: 'flow', steps: [['Barre latérale', 'gray', 'notes'], ['Clic droit', 'blue', 'more'], ['Action', 'green', 'check']] } },
  { id: 'agents-equipe-20261120', date: '2026-11-20', icon: 'bot', hue: 'violet', mac: true,
    title: 'Équipe de sous-agents visible',
    lead: 'L’Espace agents montre chaque sous-agent au travail, ses fichiers modifiés en direct et les échanges de l’équipe.',
    bits: [
      ['bot', 'Bande Équipe', 'sous-agents d’un agent, état de chacun, lignes ajoutées et retirées au total'],
      ['eye', 'Vue par sous-agent', 'consigne, dernière action, compte rendu et fichiers modifiés, avec le diff en direct'],
      ['share', 'Fil Échanges', 'consignes, délégations, comptes rendus et messages du tableau, dans l’ordre'],
      ['gear', 'Équipe par projet', 'composée d’après la consigne ; chaque projet garde la sienne, modifiable'],
    ],
    where: ['Barre latérale', 'Espace agents'],
    visual: { kind: 'flow', steps: [['Consigne', 'blue', 'terminal'], ['Sous-agents', 'violet', 'bot'], ['Fichiers modifiés', 'green', 'pencil'], ['Compte rendu', 'orange', 'check']] },
    go: { label: 'Ouvrir l’Espace agents', view: { type: 'workspace' } } },
  { id: 'notes-fermees-scellees', date: '2026-11-20', icon: 'lock', hue: 'indigo',
    title: 'Notes fermées à l’IA',
    lead: 'Aucune note n’est lue par une IA sans autorisation ; les agents ne reçoivent que celles jointes à la demande.',
    bits: [
      ['lock', 'Fermées par défaut', 'l’interrupteur des Réglages est coupé : aucune note n’est envoyée'],
      ['check', 'Une demande à la fois', 'une fois activé, seules les notes jointes à la demande partent'],
      ['shield', 'Exclusions', 'les notes chiffrées et marquées `#privé` ne partent jamais'],
      ['key', 'Scellées pour l’agent', 'chiffrées avec une clé à usage unique, remise à l’agent seul'],
    ],
    where: ['Réglages', 'IA'],
    visual: { kind: 'flow', steps: [['Note jointe', 'indigo', 'notes'], ['Chiffrée', 'violet', 'lock'], ['Agent', 'green', 'bot']] },
    go: { label: 'Ouvrir les réglages IA', view: { type: 'settings', tab: 'ia' } } },
  { id: 'commerce', date: '2026-11-18', icon: 'shop', hue: 'green', mac: true,
    title: 'Boutiques Shopify',
    lead: 'Studio suit les boutiques Shopify, leur publicité Meta et leur marketing, une boutique par projet.',
    bits: [
      ['graph', 'Chiffres', 'ventes, commandes, panier moyen et produits phares, comparés à la période précédente'],
      ['inbox', 'Gestion', 'expédier une commande, modifier un prix, un stock ou une fiche, créer un code de réduction'],
      ['bolt', 'Publicité Meta', 'campagnes avec Marketplace comme emplacement, toujours créées en pause'],
      ['cpu', 'Marketing', 'fiches, annonces et textes de publicité rédigés par un modèle local, sans envoi externe'],
    ],
    where: ['Barre latérale', 'Boutiques'],
    go: { label: 'Ouvrir Boutiques', view: { type: 'commerce' } },
    visual: { kind: 'flow', steps: [['Boutique', 'green', 'shop'], ['Chiffres et commandes', 'blue', 'graph'], ['Publicité et marketing', 'orange', 'bolt']] } },
  { id: 'local-models', date: '2026-11-17', icon: 'cpu', hue: 'teal', mac: true,
    title: 'Modèles locaux',
    lead: 'Studio installe et lance des modèles ouverts avec Ollama, sur ce Mac ou sur le serveur d’un projet.',
    bits: [
      ['download', 'Catalogue', 'Qwen, Llama, Mistral, Gemma, gpt-oss : installation en un clic, avec progression'],
      ['cpu', 'Compatibilité', 'chaque taille indique si elle tourne bien, selon la mémoire et la carte graphique'],
      ['server', 'Serveurs', 'déploiement d’un modèle par SSH, sans ouvrir de port'],
      ['sparkle', 'Utilisation', 'un modèle installé devient l’IA de Studio, ou s’essaie dans une conversation'],
    ],
    where: ['Barre latérale', 'Modèles'],
    go: { label: 'Ouvrir Modèles', view: { type: 'models' } },
    visual: { kind: 'flow', steps: [['Catalogue', 'teal', 'download'], ['Ce Mac ou un serveur', 'blue', 'server'], ['IA de Studio', 'orange', 'sparkle']] } },
  { id: 'agent-groups', date: '2026-11-17', icon: 'pr', hue: 'orange', mac: true,
    title: 'Branche mère des agents',
    lead: 'Des agents lancés ensemble partent d’une branche mère commune, chacun sur sa sous-branche.',
    bits: [
      ['play', 'Lancement groupé', '« 3× … » crée un agent par note ou par ligne, chacun sur sa sous-branche'],
      ['eye', 'Comparaison', 'le groupe s’affiche d’un bloc dans les copies des agents : Revue, VS Code'],
      ['pr', 'Fusion', 'le travail retenu rejoint la branche mère ; un conflit n’en fusionne aucun et nomme les fichiers'],
      ['upload', 'Publication', 'la branche mère part en une seule pull request'],
    ],
    where: ['Projets', 'un projet', 'Claude Code'],
    visual: { kind: 'flow', steps: [['Branche mère', 'orange', 'pr'], ['Agents 1, 2, 3', 'blue', 'bot'], ['Fusion', 'green', 'check']] } },
  { id: 'ci-graph', date: '2026-11-17', icon: 'graph', hue: 'teal',
    title: 'Graphe des workflows',
    lead: 'Chaque exécution GitHub Actions s’affiche en graphe de jobs, en direct, avec l’historique des durées.',
    bits: [
      ['graph', 'Graphe', 'jobs et dépendances, état, durée, attente d’un runner, étape en cours'],
      ['list', 'Étapes', 'un clic sur un job ouvre ses étapes et ses journaux'],
      ['history', 'Historique', 'taux de réussite, durée médiane et une barre par exécution'],
    ],
    where: ['Projets', 'un projet', 'Flux'],
    visual: { kind: 'flow', steps: [['Vérifications', 'green', 'check'], ['Apps Mac et iPhone', 'amber', 'bolt'], ['Publication', 'gray', 'upload']] } },
  { id: 'agents-workspace', date: '2026-11-17', icon: 'board', hue: 'violet', mac: true,
    title: 'Espace agents',
    lead: 'Tous les agents de tous les projets : une liste filtrable et une grille de 1 à 8 vues en direct.',
    bits: [
      ['list', 'Liste', 'en cours, à relire, en erreur, récents ; filtre, navigation avec J et K'],
      ['board', 'Vues', '1, 2, 3, 4, 6 ou 8 agents côte à côte, chacun avec son champ de réponse'],
      ['share', 'Diffusion', 'une même consigne envoyée à plusieurs vues, en réponse ou en nouvel agent'],
      ['keyboard', 'Clavier', '1 à 8, C créer, F agrandir, X vider, L disposition, ⇧⌘↵ interrompre'],
    ],
    where: ['Barre latérale', 'Espace agents'],
    visual: { kind: 'flow', steps: [['Liste', 'violet', 'list'], ['Vues', 'blue', 'board'], ['Diffusion', 'orange', 'share']] },
    go: { label: 'Ouvrir l’Espace agents', view: { type: 'workspace' } } },
  { id: 'subagents-auto', date: '2026-11-17', icon: 'bot', hue: 'violet', mac: true,
    title: 'Sous-agents automatiques',
    lead: 'Claude Code confie des parties d’une consigne à des sous-agents qui travaillent en parallèle.',
    bits: [
      ['sparkle', 'Délégation', 'exploration, parties indépendantes, relecture : Claude décide quand déléguer'],
      ['bot', 'Spécialistes', 'nom, rôle, consigne, modèle et lecture seule ou non, au choix'],
      ['gear', 'Réglages', 'nombre en parallèle, modèle par défaut, ou désactivation complète'],
      ['shield', 'Mêmes limites', 'un sous-agent a les droits de l’agent : même copie, même bulle'],
    ],
    where: ['Projets', 'un projet', 'Agents', 'Sous-agents'],
    visual: { kind: 'flow', steps: [['Consigne', 'blue', 'terminal'], ['Sous-agents', 'violet', 'bot'], ['Compte rendu', 'green', 'check']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'notes-agents-intervene', date: '2026-11-17', icon: 'bolt', hue: 'orange',
    title: 'Notes, agents et interventions',
    lead: 'Les notes d’un projet se cochent pour Claude ou Claude Code, et un agent au travail peut être interrompu.',
    bits: [
      ['check', 'Sélection', 'cocher des notes dans l’onglet Notes d’un projet, puis les envoyer à Claude ou à Claude Code'],
      ['notes', 'Notes jointes', 'fenêtre de choix avec filtre et « Tout cocher », dans la consigne et sur la page Claude'],
      ['terminal', 'Plusieurs agents', 'un agent par note ou par ligne de la consigne, huit au plus à la fois'],
      ['bolt', 'Intervention', 'le tour en cours est coupé, l’agent lit le message puis reprend (`⌘⇧↩`)'],
    ],
    where: ['Projets', 'un projet', 'Notes'],
    visual: { kind: 'flow', steps: [['Notes cochées', 'amber', 'notes'], ['Un agent par note', 'orange', 'bolt'], ['Copies isolées', 'green', 'terminal']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'docker-local', date: '2026-11-16', icon: 'container', hue: 'blue', mac: true,
    title: 'Conteneurs Docker par projet',
    lead: 'Un onglet Docker par projet liste les conteneurs de ce Mac, reconnus à leur dossier.',
    bits: [
      ['container', 'Conteneurs', 'état et ports ouvrables d’un clic ; ceux lancés par un agent sont signalés'],
      ['download', 'Images', 'celles construites par Compose ou utilisées par les conteneurs du projet'],
      ['home', 'Accueil', 'les conteneurs en cours, avec leur projet'],
      ['shield', 'Lecture seule', 'Studio lit le moteur Docker sans rien lancer ni arrêter'],
    ],
    where: ['Projets', 'un projet', 'Docker'],
    visual: { kind: 'stack', rows: [[['api', 'green', 'container'], 'en cours · :3000'], [['db', 'green', 'container'], 'en cours · :5432'], [['worker', 'red', 'container'], 'arrêté (code 137)']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'agent-project-items', date: '2026-11-16', icon: 'check', hue: 'green', mac: true,
    title: 'Tâches et notes des agents',
    lead: 'Un agent peut consigner une suite à donner ou une décision dans le projet d’où il est lancé.',
    bits: [
      ['check', 'Tâches', 'ajoutées à l’onglet Tâches, avec échéance (« vendredi », `@2026-12-01`)'],
      ['notes', 'Notes', 'ajoutées avec le tag du projet ; rien d’existant n’est modifié ni supprimé'],
      ['shield', 'Interrupteur', '« Notes et tâches du projet », activé par défaut'],
    ],
    where: ['Réglages', 'Autorisations des agents'],
    visual: { kind: 'flow', steps: [['Agent', 'violet', 'terminal'], ['Compte rendu', 'blue', 'notes'], ['Tâches et notes', 'green', 'check']] },
    go: { label: 'Ouvrir les autorisations', view: { type: 'settings', tab: 'autorisations' } } },
  { id: 'subnotes-commands', date: '2026-11-16', icon: 'notes', hue: 'teal',
    title: 'Sous-notes et commandes',
    lead: 'Une note peut en contenir d’autres, rangées en arbre dans la barre latérale, et garder des commandes à copier.',
    bits: [
      ['notes', 'Sous-notes', 'menu ⋯ puis « Nouvelle sous-note » ou « Ranger sous une note… »'],
      ['sidebar', 'Arborescence', 'section de la barre latérale, branches dépliables'],
      ['terminal', 'Bloc commandes', '`# description` au-dessus, `## Section` pour grouper, un clic copie'],
      ['search', 'Palette', 'les commandes enregistrées se retrouvent avec ⌘K'],
    ],
    where: ['Barre latérale', 'Arborescence'],
    visual: { kind: 'stack', rows: [[['Note', 'gray', 'notes'], 'Serveur'], [['Sous-note', 'teal', 'notes'], 'Déploiement'], [['Commande', 'orange', 'terminal'], 'docker compose up -d']] } },
  { id: 'agent-browser', date: '2026-11-16', icon: 'eye', hue: 'blue', mac: true,
    title: 'Navigateur des agents',
    lead: 'Les agents Claude Code et l’IA de Studio pilotent un navigateur sur les sites autorisés.',
    bits: [
      ['eye', 'Actions', 'ouvrir une page, cliquer, remplir un formulaire, capturer, lire la console'],
      ['sparkle', 'Tous fournisseurs', 'Claude, OpenAI ou modèle local, depuis la page Claude et « Demander à l’IA »'],
      ['shield', 'Sites listés', 'tout autre site est bloqué ; profil vide, sans session existante'],
      ['bolt', 'Playwright MCP', 'lancé par npx, sans fenêtre, sur ce Mac uniquement'],
    ],
    where: ['Réglages', 'Autorisations des agents', 'Navigateur'],
    visual: { kind: 'flow', steps: [['Ouvre', 'blue', 'eye'], ['Clique', 'orange', 'bolt'], ['Capture', 'green', 'check']] } },
  { id: 'server-specs', date: '2026-11-16', icon: 'server', hue: 'teal', mac: true,
    title: 'Fiche machine du serveur',
    lead: 'L’onglet Serveur décrit la machine : emplacement, puissance et logiciels installés.',
    bits: [
      ['link', 'Emplacement', 'ville, pays et région de l’hébergeur, fuseau horaire, adresse publique'],
      ['bolt', 'Puissance', 'vCPU et processeur, mémoire, disques SSD ou NVMe, débit réseau'],
      ['database', 'Capacités', 'volumes, virtualisation, sudo, logiciels installés (Docker, Node, nginx)'],
      ['eye', 'Localisation de l’IP', 'sur demande, le serveur interroge ipinfo.io'],
    ],
    where: ['Projets', 'un projet', 'Serveur'],
    visual: { kind: 'chips', chips: [['Paris, France', 'blue', 'link'], ['8 vCPU', 'orange', 'bolt'], ['32 Go', 'green', 'database'], ['NVMe', 'teal', 'server']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'agent-live-pulse', date: '2026-11-16', icon: 'bolt', hue: 'orange', mac: true,
    title: 'Suivi en direct des agents',
    lead: 'L’avancement de Claude s’affiche au-dessus du fil et se met à jour pendant le travail.',
    bits: [
      ['search', 'Étapes', 'explore, modifie, vérifie, répond : l’étape en cours est signalée'],
      ['plus', 'Compteurs', 'lignes ajoutées et retirées, fichiers, commandes, tokens'],
      ['pencil', 'Fichiers', 'chacun avec ses ajouts et retraits ; ceux qui changent sont signalés'],
    ],
    where: ['Projets', 'un projet', 'Agents', 'une conversation'],
    visual: { kind: 'flow', steps: [['Explore', 'blue', 'search'], ['Modifie', 'green', 'pencil'], ['Vérifie', 'amber', 'terminal'], ['Répond', 'pink', 'sparkle']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'agent-auto-model', date: '2026-11-16', icon: 'sparkle', hue: 'violet', mac: true,
    title: 'Modèle « Auto » des agents',
    lead: 'Avec « Auto », chaque message envoyé à Claude Code prend le modèle le plus économe qui suffit.',
    bits: [
      ['sparkle', 'À chaque envoi', 'pour une nouvelle consigne comme pour une réponse dans une conversation'],
      ['bolt', 'Économe', 'Haiku pour un petit changement, Sonnet pour le courant, Opus pour une refonte'],
      ['pencil', 'Champ extensible', 'il grandit avec le texte : tout reste visible'],
    ],
    where: ['Projets', 'un projet', 'Agents'],
    visual: { kind: 'chips', chips: [['Haiku', 'green', 'bolt'], ['Sonnet', 'blue', 'sparkle'], ['Opus', 'violet', 'sparkle']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'project-home', date: '2026-11-16', icon: 'folder', hue: 'blue', mac: true,
    title: 'Dossier mère du projet',
    lead: 'Le dossier mère réunit les dépôts du projet et reçoit ceux qui manquent.',
    bits: [
      ['folder', 'Détection', 'les dépôts déjà rangés dans le dossier mère sont retrouvés seuls'],
      ['download', 'Clonage', 'dans le dossier mère par défaut, ou ailleurs au choix'],
    ],
    where: ['Projets', 'un projet', 'Code'],
    visual: { kind: 'flow', steps: [['Dossier mère', 'blue', 'folder'], ['Dépôts clonés', 'green', 'download']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'agent-multi-repo', date: '2026-11-16', icon: 'folder', hue: 'blue', mac: true,
    title: 'Agents sur plusieurs dépôts',
    lead: 'Claude Code travaille sur tous les dépôts d’un projet à la fois : l’app, son site, son API.',
    bits: [
      ['folder', 'Détection', 'les clones rangés à côté du dossier du projet ; sinon, clonage en un clic'],
      ['github', 'Une copie par dépôt', 'copies isolées, du même nom : le dossier d’origine n’est jamais modifié'],
      ['check', 'Une PR par dépôt', 'même branche partout, les pull requests se citent entre elles'],
    ],
    where: ['Projets', 'un projet', 'Agents'],
    visual: { kind: 'stack', rows: [[['app', 'blue', 'folder'], '3 fichiers modifiés'], [['site', 'green', 'folder'], '1 fichier modifié'], [['api', 'amber', 'folder'], 'rien à publier']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'servers-many', date: '2026-11-16', icon: 'server', hue: 'blue', mac: true,
    title: 'Plusieurs serveurs par projet',
    lead: 'Production, préproduction et autres serveurs se relient au même projet, avec un test de connexion avant enregistrement.',
    bits: [
      ['server', 'Un onglet par serveur', 'avec son nom, sa clé, ses extensions et ses agents'],
      ['refresh', 'Test de connexion', 'SSH, empreinte, clé acceptée, dossier, Git et Claude Code'],
      ['terminal', 'Agents', 'choix du serveur où lancer la consigne'],
    ],
    where: ['Projets', 'un projet', 'Serveur'],
    visual: { kind: 'stack', rows: [[['Production', 'green', 'check'], 'en ligne · 38 ms'], [['Préproduction', 'amber', 'server'], 'dossier introuvable'], [['Ajouter un serveur', 'blue', 'plus'], 'test avant d’enregistrer']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'site-build', date: '2026-11-16', icon: 'bolt', hue: 'amber', mac: true,
    title: 'Builds notifiés',
    lead: 'Le build du projet se lance depuis l’onglet Site, et une notification signale sa fin.',
    bits: [
      ['bolt', 'Variantes', '`build`, `build:prod`, `build-staging`… lues dans le `package.json`'],
      ['check', 'Notification', 'réussite ou échec, avec la durée et le code de sortie'],
      ['terminal', 'Sortie en direct', 'le journal du build s’affiche à côté du site qui tourne'],
    ],
    where: ['Projets', 'un projet', 'Site'],
    visual: { kind: 'stack', rows: [[['build', 'green', 'check'], 'réussi en 42 s'], [['build:prod', 'amber', 'bolt'], 'en cours…'], [['build:staging', 'red', 'bolt'], 'en échec · code 1']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'agent-voice', date: '2026-11-16', icon: 'mic', hue: 'violet',
    title: 'Dictée vocale pour les agents',
    lead: 'Une consigne ou une réponse se dicte dans le champ de l’agent, puis se relit avant l’envoi.',
    bits: [
      ['mic', 'Bouton micro', 'à côté de Lancer et d’Envoyer ; un second clic termine la dictée'],
      ['pencil', 'À la suite', 'le texte dicté s’ajoute à ce qui est déjà écrit, brouillon compris'],
      ['shield', 'Sur l’appareil', 'transcription hors ligne : rien ne part sur le réseau'],
    ],
    where: ['Projets', 'un projet', 'Claude Code'],
    visual: { kind: 'flow', steps: [['Dictée', 'violet', 'mic'], ['Texte dans le champ', 'blue', 'pencil'], ['⌘↩', 'green', 'play']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'github-actions', date: '2026-11-15', icon: 'bolt', hue: 'green',
    title: 'GitHub Actions dans le Flux',
    lead: 'L’état de chaque workflow s’affiche dans l’onglet Flux, avec moins d’attente sur les projets.',
    bits: [
      ['bolt', 'Un workflow par ligne', 'dernière exécution, branche, déclencheur, durée et bande des précédentes'],
      ['refresh', 'Suivi en direct', 'relecture toutes les 30 s tant qu’une exécution tourne'],
      ['refresh', 'Relance', 'une exécution en échec se relance d’un clic (droit Actions en écriture requis sur le jeton)'],
      ['check', 'Requêtes partagées', 'une donnée n’est demandée qu’une fois, puis seulement revalidée'],
    ],
    where: ['Projets', 'un projet', 'Flux'],
    visual: { kind: 'stack', rows: [[['Build', 'green', 'check'], 'main · réussie · 2 min 14'], [['Pages', 'amber', 'bolt'], 'main · en cours'], [['Tests', 'red', 'bolt'], 'feat/api · en échec']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'server-user', date: '2026-11-15', icon: 'server', hue: 'teal',
    title: 'Utilisateur SSH du serveur',
    lead: 'Un champ Utilisateur dans l’onglet Serveur remplace la modification de ~/.ssh/config.',
    bits: [
      ['server', 'Prioritaire', 'passe avant le `User` de ~/.ssh/config, qui reste affiché en indication'],
      ['shield', 'Refus expliqué', 'quand le serveur refuse les clés, Studio indique pour quel utilisateur'],
    ],
    where: ['Projets', 'un projet', 'Serveur', 'Modifier'],
    visual: { kind: 'stack', rows: [[['Hôte', 'teal', 'server'], 'studio'], [['Utilisateur', 'teal', 'server'], 'root · au lieu de ubuntu']] },
    mac: true,
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'server-keys-ext', date: '2026-11-15', icon: 'server', hue: 'teal',
    title: 'Clé SSH, Docker et Kubernetes',
    lead: 'Studio garde une clé SSH chiffrée et pilote Docker ou Kubernetes depuis l’onglet Serveur.',
    bits: [
      ['key', 'Clé SSH', 'créée (Ed25519) ou importée, chiffrée dans le trousseau du Mac, jamais affichée'],
      ['shield', 'Empreinte vérifiée', 'un nouveau serveur n’est accepté qu’après confirmation de son empreinte'],
      ['container', 'Docker', 'conteneurs, Compose, ressources, journaux ; démarrage, arrêt, redémarrage'],
      ['kube', 'Kubernetes', 'nœuds, déploiements, pods (kubectl, k3s, microk8s) ; journaux, redémarrage'],
    ],
    where: ['Projets', 'un projet', 'Serveur', 'Modifier'],
    visual: { kind: 'stack', rows: [[['Clé', 'teal', 'key'], 'vps-prod · ED25519'], [['Docker', 'blue', 'container'], '4 en marche sur 5'], [['Kube', 'indigo', 'kube'], '1 nœud · 12 pods']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'project-repos', date: '2026-11-15', icon: 'github', hue: 'indigo',
    title: 'Plusieurs dépôts par projet',
    lead: 'L’app, son site, son API : chaque dépôt a un rôle et une carte dans le projet.',
    bits: [
      ['github', 'Ajout', 'à la création du projet, ou depuis « Ajouter un dépôt »'],
      ['palette', 'Rôle', 'App, Site, API, Mobile, Docs, Infra, déduit du nom (`…-site`, `…-api`)'],
      ['pr', 'État', 'CI, pull requests ouvertes et dernière version, sur chaque carte'],
      ['folder', 'Bon dépôt', 'la PR d’un agent part vers le dépôt du dossier sur ce Mac'],
    ],
    where: ['Projets', 'un projet', 'Vue d’ensemble', 'Dépôts'],
    visual: { kind: 'stack', rows: [[['App', 'indigo', 'code'], 'MTthoas/Studio'], [['Site', 'teal', 'link'], 'MTthoas/studio-site'], [['API', 'orange', 'plug'], 'MTthoas/studio-api']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'agent-stages', date: '2026-11-14', icon: 'pr', hue: 'blue',
    title: 'Étapes des agents',
    lead: 'Le travail des agents est rangé en quatre étapes, identiques partout dans l’app.',
    bits: [
      ['bot', 'Quatre étapes', 'au travail, à publier, PR ouverte, fusionné'],
      ['eye', 'Même repère', 'panneau Claude Code, liste des sessions et barre latérale'],
      ['check', 'Livré, donc retiré', 'seul ce qui reste à traiter demeure affiché'],
    ],
    where: ['Projets', 'un projet', 'Claude Code'],
    visual: { kind: 'flow', steps: [['Au travail', 'amber', 'bot'], ['À publier', 'violet', 'upload'], ['PR ouverte', 'blue', 'pr'], ['Fusionné', 'green', 'check']] } },
  { id: 'figma-plugin', date: '2026-11-14', icon: 'figma', hue: 'violet',
    title: 'Maquettes Figma dans les notes',
    lead: 'Un lien Figma dans une note s’affiche en aperçu agrandi.',
    bits: [
      ['figma', 'Bloc ```figma', 'maquette, prototype ou tableau FigJam, sans quitter la note'],
      ['folder', 'Dans le projet', 'liste des fichiers Figma cités dans ses notes'],
      ['key', 'Avec un jeton', 'date de dernière modification et commentaires ouverts'],
    ],
    where: ['Réglages', 'Extensions', 'Figma'],
    visual: { kind: 'chips', chips: [['Maquette', 'violet', 'figma'], ['Prototype', 'pink', 'play'], ['FigJam', 'amber', 'board'], ['Commentaires', 'blue', 'compose']] },
    go: { label: 'Activer Figma', view: { type: 'settings', tab: 'extensions' } } },
  { id: 'project-local-site', date: '2026-11-14', mac: true, icon: 'link', hue: 'teal',
    title: 'Site du projet en local',
    lead: 'Studio détecte le site dans le dossier du projet et le sert sur ce Mac.',
    bits: [
      ['folder', 'index.html', 'servi tel quel par Studio'],
      ['terminal', 'Next.js, Astro, Vite', 'lancés avec leur script `dev`'],
      ['eye', 'Pages vues et requêtes', 'affichées en direct, avec l’adresse locale'],
      ['lock', 'Accès local', 'visible sur ce Mac uniquement'],
    ],
    where: ['Projets', 'un projet', 'Site', 'En local'],
    visual: { kind: 'flow', steps: [['Dossier', 'orange', 'folder'], ['npm run dev', 'teal', 'terminal'], ['localhost', 'green', 'link']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'ai-project-scopes', date: '2026-11-14', icon: 'lock', hue: 'indigo',
    title: 'IA cloisonnée par projet',
    lead: 'Claude s’ouvre depuis un projet et ne lit que les données de ce projet.',
    bits: [
      ['folder', 'Notes, tâches, dépôts', 'uniquement ceux du projet'],
      ['linear', 'Linear', 'accessible seulement depuis le projet qui y est relié'],
      ['bolt', 'Automatisations', 'et « Demander à l’IA » appliquent la même règle'],
    ],
    where: ['Projets', 'un projet', 'Claude'],
    visual: { kind: 'chips', chips: [['Ce projet', 'indigo', 'folder'], ['Ses notes', 'teal', 'notes'], ['Ses tâches', 'green', 'check'], ['Le reste', 'gray', 'lock']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'agent-permissions', date: '2026-11-14', mac: true, icon: 'terminal', hue: 'amber',
    title: 'Autorisations des agents',
    lead: 'Une liste unique des commandes, de l’accès au web et du PATH permis aux agents.',
    bits: [
      ['terminal', 'Commandes', '`cargo test`, `npm ci`… dès que « Commandes » est cochée'],
      ['link', 'Accès au web', 'autorisé ou refusé'],
      ['folder', 'PATH', 'dossiers d’outils ajoutés'],
      ['history', 'Réponse dans le fil', 'les commandes du tour précédent sont conservées'],
    ],
    where: ['Réglages', 'Autorisations des agents'],
    visual: { kind: 'chips', chips: [['npm ci', 'green', 'check'], ['cargo test', 'green', 'check'], ['Web', 'amber', 'link'], ['rm -rf', 'red', 'lock']] },
    go: { label: 'Régler les autorisations', view: { type: 'settings', tab: 'autorisations' } } },
  { id: 'claude-chat', date: '2026-11-14', icon: 'sparkle', hue: 'orange',
    title: 'Conversation avec Claude',
    lead: 'Une conversation libre avec Claude, à côté des notes du projet.',
    bits: [
      ['notes', 'Données du projet', 'notes, tâches, Linear et GitHub, lus quand la question le demande'],
      ['shield', 'Validation', 'accord demandé avant toute modification'],
    ],
    where: ['Projets', 'un projet', 'Claude'],
    visual: { kind: 'flow', steps: [['Question', 'gray', 'compose'], ['Claude lit', 'orange', 'sparkle'], ['Validation', 'green', 'check']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'spotify-volume', date: '2026-11-14', icon: 'volume', hue: 'green',
    title: 'Volume de Spotify',
    lead: 'Le son de l’appareil qui joue se règle sans quitter Studio.',
    bits: [
      ['volume', 'Curseur', 'sous le titre en cours'],
      ['mute', 'Haut-parleur', 'coupe ou rétablit le son'],
      ['refresh', 'Compte déjà connecté', 'une reconnexion à Spotify, une seule fois, active la fonction'],
    ],
    where: ['Barre latérale', 'Spotify'],
    visual: { kind: 'chips', chips: [['Volume', 'green', 'volume'], ['Muet', 'gray', 'mute'], ['Palette ⌘K', 'blue', 'search']] } },
  { id: 'extensions', date: '2026-11-14', icon: 'plug', hue: 'green',
    title: 'Extensions : Spotify, n8n',
    lead: 'Les extensions s’activent à la demande ; aucune n’exige de serveur.',
    bits: [
      ['music', 'Spotify', 'titre en cours et commandes dans la barre latérale'],
      ['bolt', 'n8n', 'reçoit les captures, tâches terminées et notes'],
    ],
    where: ['Réglages', 'Extensions'],
    visual: { kind: 'chips', chips: [['Spotify', 'green', 'music'], ['n8n', 'pink', 'bolt'], ['Figma', 'violet', 'figma']] },
    go: { label: 'Ouvrir les extensions', view: { type: 'settings', tab: 'extensions' } } },
  { id: 'repo-memory', date: '2026-11-14', mac: true, icon: 'notes', hue: 'teal',
    title: 'Mémoire du dépôt',
    lead: 'Chaque agent lit `contexte.md` avant de commencer, au lieu d’explorer tout le dépôt.',
    bits: [
      ['eye', 'Lu en premier', '`contexte.md`, à la racine du dépôt'],
      ['pencil', 'Tenu à jour', 'l’agent y consigne ce qu’il a appris de durable'],
      ['bolt', 'Démarrage plus rapide', 'l’agent suivant repart de cet acquis'],
    ],
    where: ['Réglages', 'Consignes et contexte'],
    visual: { kind: 'flow', steps: [['contexte.md', 'teal', 'notes'], ['Agent', 'violet', 'bot'], ['Appris', 'green', 'pencil']] },
    go: { label: 'Ouvrir les consignes', view: { type: 'settings', tab: 'consignes' } } },
  { id: 'auto-update', date: '2026-11-14', mac: true, icon: 'download', hue: 'blue',
    title: 'Mises à jour automatiques',
    lead: 'La nouvelle version est téléchargée en arrière-plan, puis installée à la relance.',
    bits: [
      ['download', 'Téléchargement', 'et vérification, sans interrompre le travail'],
      ['refresh', 'Installation', 'à la relance, ou automatiquement à la fermeture de Studio'],
    ],
    where: ['Réglages', 'Mises à jour'],
    visual: { kind: 'flow', steps: [['Téléchargée', 'blue', 'download'], ['Vérifiée', 'violet', 'shield'], ['Installée', 'green', 'check']] },
    go: { label: 'Ouvrir les mises à jour', view: { type: 'settings', tab: 'maj' } } },
  { id: 'whats-new', date: '2026-11-14', icon: 'bolt', hue: 'orange',
    title: 'Fenêtre des nouveautés',
    lead: 'À chaque version, Studio liste ce qui change, classé par date.',
    bits: [
      ['eye', 'Une seule fois', 'chaque nouveauté n’est présentée qu’une fois'],
      ['history', 'Consultation libre', 'à tout moment depuis le menu Studio'],
    ],
    where: ['Studio ▾', 'Nouveautés'],
    visual: { kind: 'chips', chips: [['Nouveau', 'green', 'sparkle'], ['Amélioré', 'indigo', 'bolt'], ['Corrigé', 'orange', 'check']] } },
  { id: 'subagent-threads', date: '2026-11-13', mac: true, icon: 'bot', hue: 'violet',
    title: 'Fil des sous-agents',
    lead: 'Chaque tâche déléguée par Claude se suit dans un fil séparé.',
    bits: [
      ['bot', 'En-tête', 'liste des tâches déléguées pendant la conversation'],
      ['list', 'Fil du sous-agent', 'un clic l’ouvre, le fil d’Ariane ramène à la conversation'],
      ['pin', 'Épinglage', 'le sous-agent reste dans la barre latérale, sous sa conversation'],
    ],
    where: ['Projets', 'un projet', 'Claude Code'],
    visual: { kind: 'stack', rows: [[['Conversation', 'violet', 'terminal'], 'Refonte du site'], [['Sous-agent', 'indigo', 'bot'], 'Explorer les styles'], [['Sous-agent', 'indigo', 'bot'], 'Vérifier les liens']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'queued-messages', date: '2026-11-12', mac: true, icon: 'list', hue: 'teal',
    title: 'Messages en attente',
    lead: 'Un message envoyé pendant qu’un agent travaille attend la fin de son tour au lieu de l’interrompre.',
    bits: [
      ['hourglass', 'En attente', 'le message apparaît ainsi dans le fil'],
      ['list', 'Remise groupée', 'dans l’ordre d’envoi, dès que l’agent a terminé'],
    ],
    visual: { kind: 'flow', steps: [['Envoi', 'gray', 'compose'], ['En attente', 'amber', 'hourglass'], ['Remis', 'teal', 'check']] } },
  { id: 'reuse-worktrees', date: '2026-11-12', mac: true, icon: 'pr', hue: 'green',
    title: 'Copies relancées après fusion',
    lead: 'Une copie fusionnée repart automatiquement sur une nouvelle branche.',
    bits: [
      ['check', 'Fusion reconnue', 'la copie n’est plus proposée à la publication'],
      ['pr', 'Nouvelle branche', 'créée depuis la dernière version de la branche principale'],
    ],
    visual: { kind: 'flow', steps: [['Fusionné', 'green', 'check'], ['main à jour', 'blue', 'refresh'], ['Nouvelle branche', 'violet', 'pr']] } },
];

const SEEN = 'studio.news.seen';
let api!: NewsApi;

const applicable = (): Item[] => NEWS.filter(n => !n.mac || update.supported());
function seen(): string[] | null {
  try { const v = JSON.parse(localStorage.getItem(SEEN) || 'null') as unknown; return Array.isArray(v) ? v.map(String) : null; } catch { return null; }
}
function markSeen(items: Item[]): void {
  const ids = new Set([...(seen() ?? []), ...items.map(n => n.id)]);
  try { localStorage.setItem(SEEN, JSON.stringify([...ids])); } catch { /* stockage indisponible */ }
}
/** Nouveautés pas encore montrées sur cet appareil. */
function unseen(): Item[] { const s = new Set(seen() ?? []); return applicable().filter(n => !s.has(n.id)); }

// ---------- Notes de version (Releases GitHub) ----------
export interface Change { kind: 'new' | 'fix' | 'better'; text: string }
const KIND_LABEL: Record<Change['kind'], string> = { new: 'Nouveau', fix: 'Corrigé', better: 'Amélioré' };
const INTERNAL = new Set(['chore', 'ci', 'build', 'test', 'docs', 'style']);

/** Lit les notes d'une Release (liste « * feat(agents): … by @x in … ») et n'en garde que ce qui parle à l'utilisateur. */
export function changes(notes: string): Change[] {
  const out: Change[] = [];
  for (const raw of notes.split('\n')) {
    const line = (/^\s*[*-]\s+(.+)$/.exec(raw)?.[1] ?? '')
      .replace(/\s+by\s+@\S+\s+in\s+https?:\/\/\S+\s*$/i, '').replace(/\s*\(#\d+\)\s*$/, '').trim();
    if (!line || /^bump\b/i.test(line) || /made their first contribution/i.test(line)) continue;
    const c = /^(feat|fix|perf|refactor|revert|chore|ci|build|test|docs|style)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(line);
    const type = (c?.[1] ?? '').toLowerCase();
    if (INTERNAL.has(type)) continue;
    const text = (c?.[2] ?? line).trim();
    out.push({ kind: type === 'feat' ? 'new' : type === 'fix' ? 'fix' : 'better', text: text.charAt(0).toUpperCase() + text.slice(1) });
  }
  return out;
}
/** Liste lisible des changements d'une version ; vide si les notes n'en contiennent pas. */
export function changeList(notes: string, max = 6): string {
  const all = changes(notes);
  if (!all.length) return '';
  return `<ul class="nw-list">${all.slice(0, max).map(c => `<li><span class="nw-kind">${KIND_LABEL[c.kind]}</span><span>${esc(c.text)}</span></li>`).join('')}${all.length > max ? `<li class="nw-more">et ${all.length - max} autre${all.length - max > 1 ? 's' : ''}</li>` : ''}</ul>`;
}

// ---------- Image en grain ----------
// Une forme organique par identifiant, sans fichier ni bibliothèque : SVG en ligne (la CSP autorise
// `style-src 'unsafe-inline'`, et rien n'est chargé). Le tracé vient d'un hasard déterministe : la même
// nouveauté a toujours la même forme. Le grain est un `feTurbulence`, seuillé en fines taches.
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function rng(seed: number): () => number {
  let a = seed || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Courbe fermée irrégulière : 6 ou 7 sommets autour d'un centre, reliés en Bézier (Catmull-Rom), rayon entre 50 et 80. */
export function shapePath(id: string): string {
  const r = rng(hash(id)), n = 6 + Math.floor(r() * 2), rot = r() * Math.PI * 2;
  const cx = 100 + (r() - .5) * 14, cy = 120 + (r() - .5) * 14;
  const p: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = rot + ((k + (r() - .5) * .45) / n) * Math.PI * 2, d = 50 + r() * 30;
    p.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 1.08]);
  }
  const f = (v: number): string => v.toFixed(1);
  let out = `M${f(p[0]![0])} ${f(p[0]![1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i + n - 1) % n]!, p1 = p[i]!, p2 = p[(i + 1) % n]!, p3 = p[(i + 2) % n]!;
    out += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${out}Z`;
}
/** Matière : un grain fin sur tout le volet (le papier déborde du cadre, quel que soit son format), plus un grain plus dense dans la forme, au bord légèrement rongé. */
function grainSVG(id: string): string {
  const h = hash(id), k = `nw-${h.toString(36)}`, seed = h % 997;
  // Le bruit est lu en canal rouge (≈ 0,5 en moyenne) puis seuillé : alpha = a·R + b.
  const speck = (a: number, b: number): string => `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${a} 0 0 0 ${b}" result="s"/>`;
  return `<svg class="nw-svg" viewBox="0 0 200 240" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
    <defs>
      <filter id="${k}-e" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="1.2" numOctaves="2" seed="${seed}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G"/></filter>
      <filter id="${k}-g" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="1.2" numOctaves="2" seed="${seed}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G" result="d"/>${speck(3.4, -1.35)}<feComposite in="d" in2="s" operator="in"/></filter>
      <filter id="${k}-p" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="1" seed="${seed + 7}" result="n"/>${speck(3, -1.2)}<feComposite in="SourceGraphic" in2="s" operator="in"/></filter>
    </defs>
    <rect class="nw-paper" x="-200" y="-200" width="600" height="640" filter="url(#${k}-p)"/>
    <path class="nw-shape" d="${shapePath(id)}" filter="url(#${k}-e)"/>
    <path class="nw-grain" d="${shapePath(id)}" filter="url(#${k}-g)"/>
  </svg>`;
}

// ---------- Fenêtres ----------
/** Ouvre une fenêtre dès que rien d'autre n'est ouvert et que Studio est à l'écran. */
function whenFree(run: () => void, delay: number): void {
  const attempt = (): void => { if (topLayer() || document.hidden) setTimeout(attempt, 3000); else run(); };
  setTimeout(attempt, delay);
}

const day = (iso: string): string => { const d = new Date(`${iso}T12:00:00`); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); };
/** Texte court : `code` entre accents graves, le reste échappé. */
const rich = (t: string): string => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
/** Parcours en une ligne de texte (« A → B → C ») : le seul rendu du schéma `visual`. */
const flowHTML = (v: Visual): string => v.kind === 'flow' && v.steps.length > 1
  ? `<p class="nw-flow"><span>Parcours</span>${v.steps.map(([label]) => esc(label)).join('<i aria-hidden="true">→</i>')}</p>` : '';
/** En-tête d'une fiche : date et version, discrètes, puis le titre. */
const head = (meta: string[], title: string): string => `<header class="nw-head"><p class="nw-meta">${meta.filter(Boolean).map(esc).join('<i>·</i>')}</p><h3>${esc(title)}</h3></header>`;

/** Une fiche : sa ligne dans la liste par date, son texte, son image. */
interface Entry { id: string; group: string; title: string; html: string; where: string; go?: Item['go']; seed: string; hue: string }
function itemEntry(n: Item): Entry {
  const pts = `<ul class="nw-pts">${n.bits.slice(0, 4).map(([, key, detail]) => `<li><b>${rich(key)}</b><span>${rich(detail)}</span></li>`).join('')}</ul>`;
  return { id: n.id, group: day(n.date), title: n.title, seed: n.id, hue: n.hue,
    html: `${head([day(n.date), n.mac ? 'Mac' : ''], n.title)}<p class="nw-lead">${rich(n.lead)}</p>${pts}${flowHTML(n.visual)}`,
    where: n.where?.length ? `<p class="nw-where"><span>Où</span>${n.where.map(w => `<b>${esc(w)}</b>`).join('<i>›</i>')}</p>` : '',
    ...(n.go ? { go: n.go } : {}) };
}
function installedEntry(v: Installed): Entry {
  const list = changeList(v.notes);
  const page = v.page.startsWith('https://github.com/') ? `<p class="nw-link"><a href="${esc(v.page)}" target="_blank" rel="noopener">Voir le détail sur GitHub</a></p>` : '';
  const title = `Studio ${v.tag}`;
  return { id: '', group: 'Mise à jour', title, where: '', seed: `maj-${v.tag}`, hue: 'blue',
    html: head(['Mise à jour installée'], title)
      + (list ? `<p class="nw-lead">Studio vient de se mettre à jour. Voici ce qui change.</p>${list}` : '<p class="nw-lead">Studio vient de se mettre à jour. Tes notes et tes réglages n’ont pas bougé.</p>') + page };
}

/**
 * Fenêtre des nouveautés : le texte d'une fiche à gauche, son image à droite. Précédent et Suivant, les flèches
 * du clavier, ou « Toutes » (liste par date) pour changer de fiche. `fresh` : celles à marquer d'un point tant
 * qu'elles n'ont pas été ouvertes.
 */
function viewer(entries: Entry[], fresh: Set<string> = new Set()): void {
  if (!entries.length) return;
  const solo = entries.length === 1;
  let at = 0, group: string | null = null;
  const index = solo ? '' : `<nav class="nw-index" aria-label="Toutes les nouveautés" hidden>${entries.map((e, k) => {
    const title = e.group !== group && e.group ? `<p class="nw-group">${esc(e.group)}</p>` : '';
    group = e.group;
    return `${title}<button class="nw-item" data-nw-at="${k}"><span>${esc(e.title)}</span>${fresh.has(e.id) ? '<i class="nw-new" title="Pas encore ouverte"></i>' : ''}</button>`;
  }).join('')}</nav>`;
  const m = modal({ cls: solo ? 'nw nw-solo' : 'nw', html: `<div class="nw-text"><div class="nw-stage"></div>${index}<footer class="nw-foot">${solo ? '<span class="nw-count"></span>' : '<button class="btn btn-ghost" data-nw="all" aria-expanded="false">Toutes</button><span class="nw-count"></span>'}<button class="btn btn-ghost" data-nw="prev">Précédent</button><button class="btn btn-primary" data-nw="next" autofocus></button></footer></div><div class="nw-fig"></div>` });
  const stage = need('.nw-stage', m.body), fig = need('.nw-fig', m.body), count = need('.nw-count', m.body), prev = need<HTMLButtonElement>('[data-nw="prev"]', m.body), next = need<HTMLButtonElement>('[data-nw="next"]', m.body);
  const all = m.body.querySelector<HTMLButtonElement>('[data-nw="all"]'), list = m.body.querySelector<HTMLElement>('.nw-index');
  const items = [...m.body.querySelectorAll<HTMLElement>('.nw-item')];
  const toggle = (on: boolean): void => { if (!list || !all) return; list.hidden = !on; stage.hidden = on; all.setAttribute('aria-expanded', String(on)); all.textContent = on ? 'Retour' : 'Toutes'; if (on) items[at]?.scrollIntoView({ block: 'nearest' }); };
  const show = (i: number): void => {
    const e = entries[i]; if (!e) return;
    at = i;
    toggle(false);
    const end = e.where || e.go ? `<div class="nw-end">${e.where}${e.go ? `<button class="btn" data-nw="go">${esc(e.go.label)}</button>` : ''}</div>` : '';
    stage.innerHTML = `<article class="nw-art" aria-live="polite">${e.html}${end}</article>`;
    stage.scrollTop = 0;
    fig.style.setProperty('--nw-hue', `var(--c-${e.hue})`);
    fig.innerHTML = grainSVG(e.seed);
    items.forEach((b, k) => {
      if (k !== i) { b.removeAttribute('aria-current'); return; }
      b.setAttribute('aria-current', 'true');
      b.querySelector('.nw-new')?.remove();
    });
    count.textContent = solo ? '' : `${i + 1} sur ${entries.length}`;
    prev.hidden = solo;
    prev.disabled = i === 0;
    next.textContent = i === entries.length - 1 ? 'Fermer' : 'Suivant';
  };
  const step = (d: 1 | -1): void => {
    if (d > 0 && at === entries.length - 1) { m.close(); return; }
    if (at + d >= 0) show(at + d);
  };
  m.node.addEventListener('click', e => {
    const b = target(e).closest('[data-nw], [data-nw-at]'); if (!b) return;
    if (b.dataset.nwAt !== undefined) { show(Number(b.dataset.nwAt)); return; }
    if (b.dataset.nw === 'next') step(1);
    else if (b.dataset.nw === 'prev') step(-1);
    else if (b.dataset.nw === 'all') toggle(!!list?.hidden);
    else if (b.dataset.nw === 'go') { const go = entries[at]?.go; m.close(); if (go) void api.setView(go.view); }
  });
  m.node.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); if (at < entries.length - 1) step(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  });
  show(0);
}

/** Toutes les nouveautés, à la demande (menu Studio → Nouveautés) ; celles jamais montrées portent un point. */
export function open(): void {
  const all = applicable(), fresh = new Set(unseen().map(n => n.id));
  markSeen(all);
  viewer(all.map(itemEntry), fresh.size < all.length ? fresh : new Set());
}

/** Une nouvelle version est prête : relancer maintenant, ou la laisser s'installer à la fermeture. */
function promptReady(): void {
  const s = update.current(); if (!s) return;
  const list = changeList(s.notes ?? '', 5), title = `Studio ${s.tag ?? ''}`.trim();
  const m = modal({ cls: 'nw nw-solo', html: `<div class="nw-text"><div class="nw-stage"><article class="nw-art">${head(['Mise à jour prête'], title)}
      <p class="nw-lead">La nouvelle version est téléchargée et vérifiée. Relance Studio pour l’utiliser : tes notes sont enregistrées avant, et l’app se rouvre en quelques secondes.</p>${list}
      <p class="nw-hint">Plus tard, elle s’installera quand tu quitteras Studio. Si un agent Claude Code travaille en ce moment, laisse-le d’abord finir.</p></article></div>
    <footer class="nw-foot"><span class="nw-count"></span><button class="btn btn-ghost" data-nw="later">Plus tard</button><button class="btn btn-primary" data-nw="restart" autofocus>${icon('refresh')}Relancer maintenant</button></footer></div><div class="nw-fig" style="--nw-hue:var(--c-blue)">${grainSVG(`pret-${s.tag ?? ''}`)}</div>` });
  const restart = need<HTMLButtonElement>('[data-nw="restart"]', m.body), later = need<HTMLButtonElement>('[data-nw="later"]', m.body);
  later.onclick = () => m.close();
  restart.onclick = async () => {
    restart.disabled = later.disabled = true;
    restart.innerHTML = '<span class="spin"></span>Installation…';
    await api.flushAll();
    const r = await update.install();
    if (r.ok && r.restarting) return; // l'app se ferme et se rouvre
    m.close();
    toast(r.ok ? 'Mise à jour installée : quitte puis rouvre Studio.' : r.message ?? 'Mise à jour impossible.');
  };
}

export function init(a: NewsApi): void {
  api = a;
  // Mise à jour prête : on le propose une fois par version.
  let prompted = '';
  update.onChange(() => {
    const tag = update.current()?.tag ?? '';
    if (!update.ready() || update.working() || !tag || tag === prompted) return;
    prompted = tag;
    whenFree(() => { if (update.ready() && !update.working()) promptReady(); }, 600);
  });
  // Première ouverture de Studio : tout est nouveau, rien n'est à annoncer.
  if (a.firstRun) { markSeen(NEWS); return; }
  if (__TEST__) return; // les tests automatisés démarrent sans fenêtre ouverte
  void update.justInstalled().then(done => {
    const fresh = unseen();
    if (!done && !fresh.length) return;
    whenFree(() => {
      markSeen(applicable());
      viewer([...(done ? [installedEntry(done)] : []), ...fresh.map(itemEntry)]);
    }, 900);
  });
}
