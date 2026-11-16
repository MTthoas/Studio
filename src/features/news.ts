// Nouveautés : ce qui change dans Studio, dans une fenêtre à deux colonnes (sommaire par date, fiche).
//   - après une mise à jour (ou à la première ouverture d'une version qui en apporte), elle liste
//     la version installée puis chaque nouveauté pas encore vue ;
//   - sur Mac, quand une nouvelle version est téléchargée et vérifiée, une fenêtre propose de relancer.
//
// Ajouter une nouveauté : une entrée en tête de NEWS (identifiant stable, jamais réutilisé). Elle sera
// montrée une fois à chaque personne, puis reste consultable depuis le menu Studio → Nouveautés.
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

/** Pastille de l'illustration : un libellé, sa teinte (--c-…), une icône facultative. */
type Chip = [label: string, hue: string, icon?: string];
/**
 * Illustration d'une nouveauté, toujours parlante d'un coup d'œil :
 *   - `flow` : un parcours fléché (étape → étape → étape) ;
 *   - `chips` : des pastilles colorées, ce qu'on trouve ou ce qu'on règle ;
 *   - `stack` : des lignes empilées (dépôts d'un projet, fichiers…), chacune avec sa pastille.
 */
type Visual = { kind: 'flow'; steps: Chip[] } | { kind: 'chips'; chips: Chip[] } | { kind: 'stack'; rows: [tag: Chip, text: string][] };

interface Item {
  id: string;
  /** Date de sortie, AAAA-MM-JJ. */
  date: string;
  /** Titre : le nom de la fonction, sobre, sans slogan ; 30 caractères au plus (il tient dans le sommaire). */
  title: string;
  /** Une phrase factuelle, pas plus. */
  lead: string;
  /** Deux à quatre points : icône, mot-clé (en gras), précision courte. `code` entre accents graves. */
  bits: [icon: string, key: string, detail: string][];
  /** Où le trouver, en fil de menus : ['Réglages', 'Extensions']. */
  where?: string[];
  icon: string;
  /** Teinte de l'illustration (une des couleurs --c-… de la feuille de style). */
  hue: string;
  visual: Visual;
  /** Ne concerne que l'app Mac. */
  mac?: boolean;
  /** Raccourci vers la fonction présentée. */
  go?: { label: string; view: ViewState };
}

// Les plus récentes d'abord.
const NEWS: Item[] = [
  { id: 'agent-project-items', date: '2026-11-16', icon: 'check', hue: 'green', mac: true,
    title: 'Tes agents ajoutent des tâches et des notes',
    lead: 'Demande à un agent de noter une suite à donner ou une décision : il l’ajoute au projet d’où il est lancé.',
    bits: [
      ['check', 'Tâches', 'dans l’onglet Tâches du projet, avec leur échéance (« vendredi », `@2026-12-01`)'],
      ['notes', 'Notes', 'avec le tag du projet ; rien d’existant n’est modifié ni supprimé'],
      ['shield', 'Interrupteur', '« Notes et tâches du projet », activé par défaut'],
    ],
    where: ['Réglages', 'Autorisations des agents'],
    visual: { kind: 'flow', steps: [['Agent', 'violet', 'terminal'], ['Compte rendu', 'blue', 'notes'], ['Tâches et notes', 'green', 'check']] },
    go: { label: 'Voir les autorisations', view: { type: 'settings', tab: 'autorisations' } } },
  { id: 'subnotes-commands', date: '2026-11-16', icon: 'notes', hue: 'teal',
    title: 'Sous-notes et commandes',
    lead: 'Une note peut en contenir d’autres, rangées en arbre dans la barre latérale, et garder des commandes à copier.',
    bits: [
      ['notes', 'Sous-notes', 'menu ⋯ → « Nouvelle sous-note » ou « Ranger sous une note… »'],
      ['sidebar', 'Arborescence', 'section de la barre latérale, branches dépliables'],
      ['terminal', 'Bloc commandes', '`# description` au-dessus, `## Section` pour grouper, un clic copie'],
      ['search', 'Palette', 'les commandes enregistrées se retrouvent avec ⌘K'],
    ],
    where: ['Barre latérale', 'Arborescence'],
    visual: { kind: 'stack', rows: [[['Note', 'gray', 'notes'], 'Serveur'], [['Sous-note', 'teal', 'notes'], 'Déploiement'], [['Commande', 'orange', 'terminal'], 'docker compose up -d']] } },
  { id: 'agent-browser', date: '2026-11-16', icon: 'eye', hue: 'blue', mac: true,
    title: 'Navigateur des agents',
    lead: 'Les agents Claude Code et l’IA de Studio pilotent un navigateur sur les sites que tu leur ouvres.',
    bits: [
      ['eye', 'Actions', 'ouvrir une page, cliquer, remplir un formulaire, capturer, lire la console'],
      ['sparkle', 'Tous fournisseurs', 'Claude, OpenAI ou modèle local : page Claude, « Demander à l’IA », outils: navigateur'],
      ['shield', 'Sites listés', 'tout autre site est bloqué ; profil vide, sans tes sessions'],
      ['bolt', 'Playwright MCP', 'lancé par npx, sans fenêtre, sur ce Mac seulement'],
    ],
    where: ['Réglages', 'Autorisations des agents', 'Navigateur'],
    visual: { kind: 'flow', steps: [['Ouvre', 'blue', 'eye'], ['Clique', 'orange', 'bolt'], ['Capture', 'green', 'check']] } },
  { id: 'server-specs', date: '2026-11-16', icon: 'server', hue: 'teal', mac: true,
    title: 'Fiche machine du serveur',
    lead: 'L’onglet Serveur décrit la machine : où elle se trouve, sa puissance, ce qui y est installé.',
    bits: [
      ['link', 'Emplacement', 'ville, pays et région de l’hébergeur, fuseau, adresse publique'],
      ['bolt', 'Puissance', 'vCPU et modèle du processeur, mémoire, disques SSD ou NVMe, débit réseau'],
      ['database', 'Capacités', 'volumes, virtualisation, sudo, logiciels installés (Docker, Node, nginx…)'],
      ['eye', 'Localiser l’IP', 'sur demande, le serveur interroge ipinfo.io'],
    ],
    where: ['Projets', 'un projet', 'Serveur'],
    visual: { kind: 'chips', chips: [['Paris, France', 'blue', 'link'], ['8 vCPU', 'orange', 'bolt'], ['32 Go', 'green', 'database'], ['NVMe', 'teal', 'server']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'agent-live-pulse', date: '2026-11-16', icon: 'bolt', hue: 'orange', mac: true,
    title: 'Suivi en direct des agents',
    lead: 'Au-dessus du fil, l’avancement de Claude se met à jour pendant qu’il travaille.',
    bits: [
      ['search', 'Étapes', 'explore, modifie, vérifie, répond : l’étape en cours bat'],
      ['plus', 'Compteurs vivants', 'lignes ajoutées et retirées, fichiers, commandes, tokens'],
      ['pencil', 'Fichiers', 'chacun avec ses +/−, ceux qui bougent s’allument'],
    ],
    where: ['Projets', 'un projet', 'Agents', 'une conversation'],
    visual: { kind: 'flow', steps: [['Explore', 'blue', 'search'], ['Modifie', 'green', 'pencil'], ['Vérifie', 'amber', 'terminal'], ['Répond', 'pink', 'sparkle']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'agent-auto-model', date: '2026-11-16', icon: 'sparkle', hue: 'violet', mac: true,
    title: 'Modèle « Auto » des agents',
    lead: 'Avec « Auto », chaque message envoyé à Claude Code prend le modèle le plus économe qui suffit.',
    bits: [
      ['sparkle', 'À chaque envoi', 'nouvelle consigne comme réponse dans une conversation'],
      ['bolt', 'Économe', 'Haiku pour un petit changement, Sonnet pour le courant, Opus pour une refonte'],
      ['pencil', 'Champ sans limite', 'il grandit avec ton texte : tout reste visible'],
    ],
    where: ['Projets', 'un projet', 'Agents'],
    visual: { kind: 'chips', chips: [['Haiku', 'green', 'bolt'], ['Sonnet', 'blue', 'sparkle'], ['Opus', 'violet', 'sparkle']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'project-home', date: '2026-11-16', icon: 'folder', hue: 'blue', mac: true,
    title: 'Dossier mère du projet',
    lead: 'Tu choisis le dossier qui réunit les dépôts du projet, et où cloner ceux qui manquent.',
    bits: [
      ['folder', 'Retrouvés seuls', 'les dépôts déjà rangés dans le dossier mère'],
      ['download', 'Clonés au bon endroit', 'dans le dossier mère, ou ailleurs au choix'],
    ],
    where: ['Projets', 'un projet', 'Code'],
    visual: { kind: 'flow', steps: [['Dossier mère', 'blue', 'folder'], ['Dépôts clonés', 'green', 'download']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'agent-multi-repo', date: '2026-11-16', icon: 'folder', hue: 'blue', mac: true,
    title: 'Agents sur plusieurs dépôts',
    lead: 'Claude Code travaille sur tous les dépôts du projet à la fois : l’app, son site, son API.',
    bits: [
      ['folder', 'Trouvés seuls', 'les clones rangés à côté du dossier du projet ; sinon, cloner en un clic'],
      ['github', 'Une copie par dépôt', 'isolées, du même nom, ton dossier n’est jamais touché'],
      ['check', 'Une PR par dépôt', 'même branche partout, les pull requests se citent entre elles'],
    ],
    where: ['Projets', 'un projet', 'Agents'],
    visual: { kind: 'stack', rows: [[['app', 'blue', 'folder'], '3 fichiers modifiés'], [['site', 'green', 'folder'], '1 fichier modifié'], [['api', 'amber', 'folder'], 'rien à publier']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'servers-many', date: '2026-11-16', icon: 'server', hue: 'blue', mac: true,
    title: 'Plusieurs serveurs par projet',
    lead: 'Relie la production, la préproduction et les autres au même projet, et teste la connexion avant d’enregistrer.',
    bits: [
      ['server', 'Un onglet par serveur', 'chacun avec son nom, sa clé, ses extensions et ses agents'],
      ['refresh', 'Tester la connexion', 'SSH, empreinte, clé acceptée, dossier, Git et Claude Code'],
      ['terminal', 'Agents', 'choisis le serveur où lancer la consigne'],
    ],
    where: ['Projets', 'un projet', 'Serveur'],
    visual: { kind: 'stack', rows: [[['Production', 'green', 'check'], 'en ligne · 38 ms'], [['Préproduction', 'amber', 'server'], 'dossier introuvable'], [['Ajouter un serveur', 'blue', 'plus'], 'test avant d’enregistrer']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'site-build', date: '2026-11-16', icon: 'bolt', hue: 'amber', mac: true,
    title: 'Builds notifiés',
    lead: 'Lance le build du projet depuis l’onglet Site : une notification t’avertit dès qu’il se termine.',
    bits: [
      ['bolt', 'Variantes', '`build`, `build:prod`, `build-staging`… lues dans le `package.json`'],
      ['check', 'Notification', 'réussite ou échec, avec la durée et le code de sortie'],
      ['terminal', 'Sortie en direct', 'le journal du build, à côté du site qui tourne'],
    ],
    where: ['Projets', 'un projet', 'Site'],
    visual: { kind: 'stack', rows: [[['build', 'green', 'check'], 'réussi en 42 s'], [['build:prod', 'amber', 'bolt'], 'en cours…'], [['build:staging', 'red', 'bolt'], 'en échec · code 1']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'agent-voice', date: '2026-11-16', icon: 'mic', hue: 'violet',
    title: 'Dictée vocale pour les agents',
    lead: 'Dicte une consigne ou une réponse à un agent : ta voix s’écrit dans le champ, tu relis, tu envoies.',
    bits: [
      ['mic', 'Bouton micro', 'à côté de Lancer et d’Envoyer ; un second clic termine'],
      ['pencil', 'À la suite', 'la dictée s’ajoute au texte déjà écrit et au brouillon'],
      ['shield', 'Sur l’appareil', 'transcription hors ligne, rien ne part en ligne'],
    ],
    where: ['Projets', 'un projet', 'Claude Code'],
    visual: { kind: 'flow', steps: [['Tu parles', 'violet', 'mic'], ['Texte dans le champ', 'blue', 'pencil'], ['⌘↩', 'green', 'play']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'github-actions', date: '2026-11-15', icon: 'bolt', hue: 'green',
    title: 'GitHub Actions dans le Flux',
    lead: 'L’état de chaque workflow dans l’onglet Flux, et beaucoup moins d’attente sur les projets.',
    bits: [
      ['bolt', 'Un workflow par ligne', 'dernière exécution, branche, déclencheur, durée et bande des précédentes'],
      ['refresh', 'Suivi en direct', 'relu toutes les 30 s tant qu’une exécution tourne'],
      ['refresh', 'Relancer', 'une exécution en échec se relance d’un clic (droit Actions en écriture sur le jeton)'],
      ['check', 'Requêtes partagées', 'une même donnée n’est demandée qu’une fois, puis seulement revalidée'],
    ],
    where: ['Projets', 'un projet', 'Flux'],
    visual: { kind: 'stack', rows: [[['Build', 'green', 'check'], 'main · réussie · 2 min 14'], [['Pages', 'amber', 'bolt'], 'main · en cours'], [['Tests', 'red', 'bolt'], 'feat/api · en échec']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'server-user', date: '2026-11-15', icon: 'server', hue: 'teal',
    title: 'Utilisateur SSH du serveur',
    lead: 'Un champ Utilisateur dans l’onglet Serveur : root, ubuntu, deploy… sans toucher à ~/.ssh/config.',
    bits: [
      ['server', 'Prioritaire sur ta config', 'passe avant le `User` de ~/.ssh/config, qui reste proposé en indication'],
      ['shield', 'Refus expliqué', 'quand le serveur refuse tes clés, Studio dit pour quel utilisateur'],
    ],
    where: ['Projets', 'un projet', 'Serveur', 'Modifier'],
    visual: { kind: 'stack', rows: [[['Hôte', 'teal', 'server'], 'studio'], [['Utilisateur', 'teal', 'server'], 'root · au lieu de ubuntu']] },
    mac: true,
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'server-keys-ext', date: '2026-11-15', icon: 'server', hue: 'teal',
    title: 'Clé SSH, Docker et Kubernetes',
    lead: 'Une clé SSH gardée chiffrée par Studio, et Docker ou Kubernetes pilotés depuis l’onglet Serveur.',
    bits: [
      ['key', 'Clé SSH dans Studio', 'créée (Ed25519) ou importée, chiffrée dans le trousseau du Mac, jamais montrée'],
      ['shield', 'Empreinte vérifiée', 'un nouveau serveur n’est accepté qu’après confirmation de son empreinte'],
      ['container', 'Docker', 'conteneurs, Compose, ressources, journaux ; démarrer, arrêter, redémarrer'],
      ['kube', 'Kubernetes', 'nœuds, déploiements, pods (kubectl, k3s, microk8s) ; journaux, redémarrage'],
    ],
    where: ['Projets', 'un projet', 'Serveur', 'Modifier'],
    visual: { kind: 'stack', rows: [[['Clé', 'teal', 'key'], 'vps-prod · ED25519'], [['Docker', 'blue', 'container'], '4 en marche sur 5'], [['Kube', 'indigo', 'kube'], '1 nœud · 12 pods']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'project-repos', date: '2026-11-15', icon: 'github', hue: 'indigo',
    title: 'Plusieurs dépôts par projet',
    lead: 'L’app, son site, son API : chaque dépôt a son rôle et sa carte dans le projet.',
    bits: [
      ['github', 'Plusieurs dépôts', 'ajoutés à la création ou d’un clic sur « Ajouter un dépôt »'],
      ['palette', 'Un rôle par dépôt', 'App, Site, API, Mobile, Docs, Infra… deviné du nom (`…-site`, `…-api`)'],
      ['pr', 'État de chacun', 'CI, PR ouvertes, dernière version, sur chaque carte'],
      ['folder', 'Le bon dépôt', 'la PR d’un agent part vers le dépôt du dossier sur ce Mac'],
    ],
    where: ['Projets', 'un projet', 'Vue d’ensemble', 'Dépôts'],
    visual: { kind: 'stack', rows: [[['App', 'indigo', 'code'], 'MTthoas/Studio'], [['Site', 'teal', 'link'], 'MTthoas/studio-site'], [['API', 'orange', 'plug'], 'MTthoas/studio-api']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'agent-stages', date: '2026-11-14', icon: 'pr', hue: 'blue',
    title: 'Étapes des agents',
    lead: 'Le travail des agents est rangé par étape, chacune avec sa couleur.',
    bits: [
      ['bot', 'Quatre étapes', 'au travail, à publier, PR ouverte, fusionné'],
      ['eye', 'Partout pareil', 'panneau Claude Code, liste des sessions, barre latérale'],
      ['check', 'Ce qui est livré s’efface', 'il ne reste que ce qui t’attend'],
    ],
    where: ['Projets', 'un projet', 'Claude Code'],
    visual: { kind: 'flow', steps: [['Au travail', 'amber', 'bot'], ['À publier', 'violet', 'upload'], ['PR ouverte', 'blue', 'pr'], ['Fusionné', 'green', 'check']] } },
  { id: 'figma-plugin', date: '2026-11-14', icon: 'figma', hue: 'violet',
    title: 'Maquettes Figma dans les notes',
    lead: 'Un lien Figma dans une note devient un aperçu en grand.',
    bits: [
      ['figma', 'Bloc ```figma', 'maquette, prototype ou tableau FigJam, sans quitter la note'],
      ['folder', 'Dans le projet', 'la liste des fichiers Figma cités dans ses notes'],
      ['key', 'Avec un jeton', 'dernière modification et commentaires ouverts'],
    ],
    where: ['Réglages', 'Extensions', 'Figma'],
    visual: { kind: 'chips', chips: [['Maquette', 'violet', 'figma'], ['Prototype', 'pink', 'play'], ['FigJam', 'amber', 'board'], ['Commentaires', 'blue', 'compose']] },
    go: { label: 'Activer Figma', view: { type: 'settings', tab: 'extensions' } } },
  { id: 'project-local-site', date: '2026-11-14', mac: true, icon: 'link', hue: 'teal',
    title: 'Site du projet en local',
    lead: 'Studio trouve le site dans le dossier du projet et le sert sur ce Mac.',
    bits: [
      ['folder', 'index.html', 'servi tel quel par Studio'],
      ['terminal', 'Next.js, Astro, Vite', 'lancés avec leur script `dev`'],
      ['eye', 'Pages vues et requêtes', 'en direct, avec l’adresse locale'],
      ['lock', 'Rien ne sort', 'visible sur ce Mac seulement'],
    ],
    where: ['Projets', 'un projet', 'Site', 'En local'],
    visual: { kind: 'flow', steps: [['Dossier', 'orange', 'folder'], ['npm run dev', 'teal', 'terminal'], ['localhost', 'green', 'link']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'ai-project-scopes', date: '2026-11-14', icon: 'lock', hue: 'indigo',
    title: 'IA cloisonnée par projet',
    lead: 'Claude s’ouvre depuis un projet, et n’en sort pas.',
    bits: [
      ['folder', 'Notes, tâches, dépôts', 'seulement ceux du projet'],
      ['linear', 'Linear', 'jamais ouvert hors du projet qui y est relié'],
      ['bolt', 'Automatisations', 'et « Demander à l’IA » suivent la même règle'],
    ],
    where: ['Projets', 'un projet', 'Claude'],
    visual: { kind: 'chips', chips: [['Ce projet', 'indigo', 'folder'], ['Ses notes', 'teal', 'notes'], ['Ses tâches', 'green', 'check'], ['Le reste', 'gray', 'lock']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'agent-permissions', date: '2026-11-14', mac: true, icon: 'terminal', hue: 'amber',
    title: 'Autorisations des agents',
    lead: 'Une liste claire des commandes, du web et du PATH permis aux agents.',
    bits: [
      ['terminal', 'Commandes', '`cargo test`, `npm ci`… quand « Commandes » est cochée'],
      ['link', 'Accès au web', 'autorisé ou non'],
      ['folder', 'PATH', 'les dossiers d’outils ajoutés'],
      ['history', 'Réponse dans le fil', 'garde les commandes du tour précédent'],
    ],
    where: ['Réglages', 'Autorisations des agents'],
    visual: { kind: 'chips', chips: [['npm ci', 'green', 'check'], ['cargo test', 'green', 'check'], ['Web', 'amber', 'link'], ['rm -rf', 'red', 'lock']] },
    go: { label: 'Régler les autorisations', view: { type: 'settings', tab: 'autorisations' } } },
  { id: 'claude-chat', date: '2026-11-14', icon: 'sparkle', hue: 'orange',
    title: 'Conversation avec Claude',
    lead: 'Une conversation libre avec Claude, à côté de tes notes.',
    bits: [
      ['notes', 'Tes données', 'notes, tâches, Linear et GitHub, quand c’est utile'],
      ['shield', 'Ton accord', 'demandé avant toute modification'],
    ],
    where: ['Projets', 'un projet', 'Claude'],
    visual: { kind: 'flow', steps: [['Ta question', 'gray', 'compose'], ['Claude lit', 'orange', 'sparkle'], ['Tu valides', 'green', 'check']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'spotify-volume', date: '2026-11-14', icon: 'volume', hue: 'green',
    title: 'Volume de Spotify',
    lead: 'Règle le son de l’appareil qui joue, sans quitter Studio.',
    bits: [
      ['volume', 'Curseur', 'sous le titre en cours'],
      ['mute', 'Haut-parleur', 'coupe ou remet le son'],
      ['refresh', 'Déjà connecté ?', 'reconnecte Spotify une fois pour l’activer'],
    ],
    where: ['Barre latérale', 'Spotify'],
    visual: { kind: 'chips', chips: [['Volume', 'green', 'volume'], ['Muet', 'gray', 'mute'], ['Palette ⌘K', 'blue', 'search']] } },
  { id: 'extensions', date: '2026-11-14', icon: 'plug', hue: 'green',
    title: 'Extensions : Spotify, n8n',
    lead: 'Active seulement ce dont tu as besoin. Toujours sans serveur.',
    bits: [
      ['music', 'Spotify', 'le titre en cours et ses commandes dans la barre latérale'],
      ['bolt', 'n8n', 'reçoit tes captures, tâches terminées et notes'],
    ],
    where: ['Réglages', 'Extensions'],
    visual: { kind: 'chips', chips: [['Spotify', 'green', 'music'], ['n8n', 'pink', 'bolt'], ['Figma', 'violet', 'figma']] },
    go: { label: 'Voir les extensions', view: { type: 'settings', tab: 'extensions' } } },
  { id: 'repo-memory', date: '2026-11-14', mac: true, icon: 'notes', hue: 'teal',
    title: 'Mémoire du dépôt',
    lead: 'Chaque agent lit `contexte.md` avant de commencer, au lieu de tout réexplorer.',
    bits: [
      ['eye', 'Lu en premier', '`contexte.md`, à la racine du dépôt'],
      ['pencil', 'Tenu à jour', 'l’agent y note ce qu’il a appris de durable'],
      ['bolt', 'Plus rapide', 'l’agent suivant démarre avec cet acquis'],
    ],
    where: ['Réglages', 'Consignes et contexte'],
    visual: { kind: 'flow', steps: [['contexte.md', 'teal', 'notes'], ['Agent', 'violet', 'bot'], ['Appris', 'green', 'pencil']] },
    go: { label: 'Voir les consignes', view: { type: 'settings', tab: 'consignes' } } },
  { id: 'auto-update', date: '2026-11-14', mac: true, icon: 'download', hue: 'blue',
    title: 'Mises à jour automatiques',
    lead: 'La nouvelle version est téléchargée en arrière-plan, puis installée à la relance.',
    bits: [
      ['download', 'Téléchargée', 'et vérifiée sans te déranger'],
      ['refresh', 'Installée', 'quand tu relances, ou toute seule quand tu quittes'],
    ],
    where: ['Réglages', 'Mises à jour'],
    visual: { kind: 'flow', steps: [['Téléchargée', 'blue', 'download'], ['Vérifiée', 'violet', 'shield'], ['Installée', 'green', 'check']] },
    go: { label: 'Réglages des mises à jour', view: { type: 'settings', tab: 'maj' } } },
  { id: 'whats-new', date: '2026-11-14', icon: 'bolt', hue: 'orange',
    title: 'Fenêtre des nouveautés',
    lead: 'À chaque version, Studio liste ce qui change, rangé par date.',
    bits: [
      ['eye', 'Une fois', 'chaque nouveauté n’est montrée qu’une fois'],
      ['history', 'À revoir', 'quand tu veux, depuis le menu Studio'],
    ],
    where: ['Studio ▾', 'Nouveautés'],
    visual: { kind: 'chips', chips: [['Nouveau', 'green', 'sparkle'], ['Amélioré', 'indigo', 'bolt'], ['Corrigé', 'orange', 'check']] } },
  { id: 'subagent-threads', date: '2026-11-13', mac: true, icon: 'bot', hue: 'violet',
    title: 'Fil des sous-agents',
    lead: 'Ce que Claude délègue se suit comme une conversation à part.',
    bits: [
      ['bot', 'Dans l’en-tête', 'les tâches déléguées pendant la conversation'],
      ['list', 'Fil du sous-agent', 'un clic pour l’ouvrir, le fil d’Ariane pour revenir'],
      ['pin', 'Épingler', 'le garde dans la barre latérale, sous sa conversation'],
    ],
    where: ['Projets', 'un projet', 'Claude Code'],
    visual: { kind: 'stack', rows: [[['Conversation', 'violet', 'terminal'], 'Refonte du site'], [['Sous-agent', 'indigo', 'bot'], 'Explorer les styles'], [['Sous-agent', 'indigo', 'bot'], 'Vérifier les liens']] },
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'queued-messages', date: '2026-11-12', mac: true, icon: 'list', hue: 'teal',
    title: 'Messages en attente',
    lead: 'Studio ne coupe jamais un agent en plein travail.',
    bits: [
      ['hourglass', 'En attente', 'tes messages s’affichent ainsi dans le fil'],
      ['list', 'Remis ensemble', 'dans l’ordre, dès que l’agent a fini son tour'],
    ],
    visual: { kind: 'flow', steps: [['Tu écris', 'gray', 'compose'], ['En attente', 'amber', 'hourglass'], ['Remis', 'teal', 'check']] } },
  { id: 'reuse-worktrees', date: '2026-11-12', mac: true, icon: 'pr', hue: 'green',
    title: 'Copies réutilisées après fusion',
    lead: 'Une copie fusionnée repart d’elle-même sur une nouvelle branche.',
    bits: [
      ['check', 'Fusion reconnue', 'la copie n’est plus reproposée à la publication'],
      ['pr', 'Nouvelle branche', 'à partir de la dernière version de la branche principale'],
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
  return `<ul class="wn-list">${all.slice(0, max).map(c => `<li><span class="wn-kind ${c.kind}">${KIND_LABEL[c.kind]}</span><span>${esc(c.text)}</span></li>`).join('')}${all.length > max ? `<li class="wn-more">et ${all.length - max} autre${all.length - max > 1 ? 's' : ''}</li>` : ''}</ul>`;
}

// ---------- Fenêtres ----------
/** Ouvre une fenêtre dès que rien d'autre n'est ouvert et que Studio est à l'écran. */
function whenFree(run: () => void, delay: number): void {
  const attempt = (): void => { if (topLayer() || document.hidden) setTimeout(attempt, 3000); else run(); };
  setTimeout(attempt, delay);
}

const day = (iso: string): string => { const d = new Date(`${iso}T12:00:00`); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }); };
/** Texte court : `code` entre accents graves, le reste échappé. */
const rich = (t: string): string => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
/** Repère d'une pastille ou d'une ligne : son icône, sinon un point. C'est lui seul qui porte la teinte. */
const mark = (ic?: string): string => ic ? icon(ic) : '<i class="wn-pt"></i>';
const chipHTML = ([label, hue, ic]: Chip): string => `<span class="wn-chip" style="--c:var(--c-${esc(hue)})">${mark(ic)}${esc(label)}</span>`;
/** Schéma d'une nouveauté : un encadré neutre, comme les sections des Réglages. */
function visualHTML(v: Visual): string {
  if (v.kind === 'flow') return `<div class="wn-fig wn-flow" aria-hidden="true">${v.steps.map((c, i) => `${i ? `<i class="wn-arrow">${icon('chevronRight')}</i>` : ''}${chipHTML(c)}`).join('')}</div>`;
  if (v.kind === 'stack') return `<div class="wn-fig wn-stack" aria-hidden="true">${v.rows.map(([[label, hue, ic], text]) => `<div class="wn-row" style="--c:var(--c-${esc(hue)})"><span>${mark(ic)}${esc(label)}</span><code>${esc(text)}</code></div>`).join('')}</div>`;
  return `<div class="wn-fig wn-flow" aria-hidden="true">${v.chips.slice(0, 4).map(c => chipHTML(c)).join('')}</div>`;
}
/** En-tête d'une fiche : l'icône dans sa case, une ligne d'informations, le titre. */
const head = (ic: string, hue: string, meta: string[], title: string): string =>
  `<header class="wn-head"><span class="wn-ic" style="--c:var(--c-${esc(hue)})">${icon(ic)}</span><div><p class="wn-meta">${meta.filter(Boolean).map(esc).join('<i>·</i>')}</p><h3>${esc(title)}</h3></div></header>`;
/** Une fiche de la fenêtre : sa ligne dans le sommaire (groupe, icône, titre) et son contenu. */
interface Entry { id: string; group: string; icon: string; title: string; html: string; where: string; go?: Item['go'] }
function itemEntry(n: Item): Entry {
  const bits = `<dl class="wn-bits">${n.bits.map(([ic, key, detail]) => `<div><dt>${icon(ic)}<span>${rich(key)}</span></dt><dd>${rich(detail)}</dd></div>`).join('')}</dl>`;
  return { id: n.id, group: day(n.date), icon: n.icon, title: n.title,
    html: `${head(n.icon, n.hue, [day(n.date), n.mac ? 'Mac' : ''], n.title)}<p class="wn-lead">${rich(n.lead)}</p>${visualHTML(n.visual)}${bits}`,
    where: n.where?.length ? `<p class="wn-where"><span>Où</span>${n.where.map(w => `<b>${esc(w)}</b>`).join('<i>›</i>')}</p>` : '',
    ...(n.go ? { go: n.go } : {}) };
}
function installedEntry(v: Installed): Entry {
  const list = changeList(v.notes);
  const page = v.page.startsWith('https://github.com/') ? `<p class="wn-link"><a href="${esc(v.page)}" target="_blank" rel="noopener">Voir le détail sur GitHub</a></p>` : '';
  const title = `Studio ${v.tag}`;
  return { id: '', group: 'Mise à jour', icon: 'check', title, where: '',
    html: head('check', 'green', ['Mise à jour installée'], title)
      + (list ? `<p class="wn-lead">Studio vient de se mettre à jour. Voici ce qui change.</p>${list}` : '<p class="wn-lead">Studio vient de se mettre à jour. Tes notes et tes réglages n’ont pas bougé.</p>') + page };
}

/**
 * Fenêtre des nouveautés : le sommaire à gauche (rangé par date), la fiche choisie à droite.
 * Une seule fiche : pas de sommaire. `fresh` : celles à marquer d'un point tant qu'elles n'ont pas été ouvertes.
 */
function viewer(entries: Entry[], fresh: Set<string> = new Set()): void {
  if (!entries.length) return;
  const solo = entries.length === 1;
  let at = 0, group: string | null = null;
  const nav = solo ? '' : `<nav class="wn-nav" aria-label="Nouveautés"><h2>Nouveautés</h2>${entries.map((e, k) => {
    const title = e.group !== group && e.group ? `<p class="wn-group">${esc(e.group)}</p>` : '';
    group = e.group;
    return `${title}<button class="wn-item" data-wn-at="${k}">${icon(e.icon)}<span>${esc(e.title)}</span>${fresh.has(e.id) ? '<i class="wn-new" title="Pas encore ouverte"></i>' : ''}</button>`;
  }).join('')}</nav>`;
  const m = modal({ cls: solo ? 'wn wn-solo' : 'wn', html: `${nav}<div class="wn-main"><div class="wn-stage"></div><footer class="wn-foot"><span class="wn-count"></span><button class="btn btn-ghost" data-wn="prev">Précédent</button><button class="btn btn-primary" data-wn="next" autofocus></button></footer></div>` });
  const stage = need('.wn-stage', m.body), count = need('.wn-count', m.body), prev = need<HTMLButtonElement>('[data-wn="prev"]', m.body), next = need<HTMLButtonElement>('[data-wn="next"]', m.body);
  const items = [...m.body.querySelectorAll<HTMLElement>('.wn-item')];
  const show = (i: number): void => {
    const e = entries[i]; if (!e) return;
    at = i;
    const end = e.where || e.go ? `<div class="wn-end">${e.where}${e.go ? `<button class="btn" data-wn="go">${esc(e.go.label)}</button>` : ''}</div>` : '';
    stage.innerHTML = `<article class="wn-art" aria-live="polite">${e.html}${end}</article>`;
    stage.scrollTop = 0;
    items.forEach((b, k) => {
      if (k !== i) { b.removeAttribute('aria-current'); return; }
      b.setAttribute('aria-current', 'true');
      b.querySelector('.wn-new')?.remove();
      b.scrollIntoView({ block: 'nearest' });
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
    const b = target(e).closest('[data-wn], [data-wn-at]'); if (!b) return;
    if (b.dataset.wnAt !== undefined) { const k = Number(b.dataset.wnAt); if (k !== at) show(k); return; }
    if (b.dataset.wn === 'next') step(1);
    else if (b.dataset.wn === 'prev') step(-1);
    else if (b.dataset.wn === 'go') { const go = entries[at]?.go; m.close(); if (go) void api.setView(go.view); }
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
  const list = changeList(s.notes ?? '', 5);
  const m = modal({ cls: 'wn wn-solo', html: `<div class="wn-main"><div class="wn-stage"><article class="wn-art">${head('download', 'blue', ['Mise à jour prête'], `Studio ${s.tag ?? ''}`)}
      <p class="wn-lead">La nouvelle version est téléchargée et vérifiée. Relance Studio pour l’utiliser : tes notes sont enregistrées avant, et l’app se rouvre en quelques secondes.</p>${list}
      <p class="wn-hint">Plus tard, elle s’installera quand tu quitteras Studio. Si un agent Claude Code travaille en ce moment, laisse-le d’abord finir.</p></article></div>
    <footer class="wn-foot"><span class="wn-count"></span><button class="btn btn-ghost" data-wn="later">Plus tard</button><button class="btn btn-primary" data-wn="restart" autofocus>${icon('refresh')}Relancer maintenant</button></footer></div>` });
  const restart = need<HTMLButtonElement>('[data-wn="restart"]', m.body), later = need<HTMLButtonElement>('[data-wn="later"]', m.body);
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
