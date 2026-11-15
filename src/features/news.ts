// Nouveautés : ce qui change dans Studio, présenté une nouveauté après l'autre.
//   - après une mise à jour (ou à la première ouverture d'une version qui en apporte), un carrousel
//     montre la version installée puis chaque nouveauté pas encore vue ;
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
  /** Titre : le bénéfice, en quelques mots. */
  title: string;
  /** Une phrase, pas plus. */
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
    title: 'Parle à Claude Code',
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
    title: 'GitHub Actions, et GitHub plus rapide',
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
    title: 'Choisis l’utilisateur de ton serveur',
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
    title: 'Ton serveur, clé et extensions',
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
    title: 'Un projet, tous ses dépôts',
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
    title: 'Où en sont tes agents, d’un coup d’œil',
    lead: 'Le travail des agents est rangé par étape, chacune avec sa couleur.',
    bits: [
      ['bot', 'Quatre étapes', 'au travail, à publier, PR ouverte, fusionné'],
      ['eye', 'Partout pareil', 'panneau Claude Code, liste des sessions, barre latérale'],
      ['check', 'Ce qui est livré s’efface', 'il ne reste que ce qui t’attend'],
    ],
    where: ['Projets', 'un projet', 'Claude Code'],
    visual: { kind: 'flow', steps: [['Au travail', 'amber', 'bot'], ['À publier', 'violet', 'upload'], ['PR ouverte', 'blue', 'pr'], ['Fusionné', 'green', 'check']] } },
  { id: 'figma-plugin', date: '2026-11-14', icon: 'figma', hue: 'violet',
    title: 'Tes maquettes Figma dans tes notes',
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
    title: 'Lance le site d’un projet en un clic',
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
    title: 'L’IA ne voit que ton projet',
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
    title: 'Choisis ce que tes agents peuvent lancer',
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
    title: 'Parle à Claude, sans terminal',
    lead: 'Une conversation libre avec Claude, à côté de tes notes.',
    bits: [
      ['notes', 'Tes données', 'notes, tâches, Linear et GitHub, quand c’est utile'],
      ['shield', 'Ton accord', 'demandé avant toute modification'],
    ],
    where: ['Projets', 'un projet', 'Claude'],
    visual: { kind: 'flow', steps: [['Ta question', 'gray', 'compose'], ['Claude lit', 'orange', 'sparkle'], ['Tu valides', 'green', 'check']] },
    go: { label: 'Voir mes projets', view: { type: 'projets' } } },
  { id: 'spotify-volume', date: '2026-11-14', icon: 'volume', hue: 'green',
    title: 'Le volume de Spotify',
    lead: 'Règle le son de l’appareil qui joue, sans quitter Studio.',
    bits: [
      ['volume', 'Curseur', 'sous le titre en cours'],
      ['mute', 'Haut-parleur', 'coupe ou remet le son'],
      ['refresh', 'Déjà connecté ?', 'reconnecte Spotify une fois pour l’activer'],
    ],
    where: ['Barre latérale', 'Spotify'],
    visual: { kind: 'chips', chips: [['Volume', 'green', 'volume'], ['Muet', 'gray', 'mute'], ['Palette ⌘K', 'blue', 'search']] } },
  { id: 'extensions', date: '2026-11-14', icon: 'plug', hue: 'green',
    title: 'Des extensions : Spotify, n8n…',
    lead: 'Active seulement ce dont tu as besoin. Toujours sans serveur.',
    bits: [
      ['music', 'Spotify', 'le titre en cours et ses commandes dans la barre latérale'],
      ['bolt', 'n8n', 'reçoit tes captures, tâches terminées et notes'],
    ],
    where: ['Réglages', 'Extensions'],
    visual: { kind: 'chips', chips: [['Spotify', 'green', 'music'], ['n8n', 'pink', 'bolt'], ['Figma', 'violet', 'figma']] },
    go: { label: 'Voir les extensions', view: { type: 'settings', tab: 'extensions' } } },
  { id: 'repo-memory', date: '2026-11-14', mac: true, icon: 'notes', hue: 'teal',
    title: 'Les agents se souviennent du dépôt',
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
    title: 'Studio se met à jour tout seul',
    lead: 'Tu n’as plus rien à faire : la nouvelle version arrive en arrière-plan.',
    bits: [
      ['download', 'Téléchargée', 'et vérifiée sans te déranger'],
      ['refresh', 'Installée', 'quand tu relances, ou toute seule quand tu quittes'],
    ],
    where: ['Réglages', 'Mises à jour'],
    visual: { kind: 'flow', steps: [['Téléchargée', 'blue', 'download'], ['Vérifiée', 'violet', 'shield'], ['Installée', 'green', 'check']] },
    go: { label: 'Réglages des mises à jour', view: { type: 'settings', tab: 'maj' } } },
  { id: 'whats-new', date: '2026-11-14', icon: 'bolt', hue: 'orange',
    title: 'Les nouveautés, une à une',
    lead: 'À chaque version, Studio montre ce qui change, ici même.',
    bits: [
      ['eye', 'Une fois', 'chaque nouveauté n’est montrée qu’une fois'],
      ['history', 'À revoir', 'quand tu veux, depuis le menu Studio'],
    ],
    where: ['Studio ▾', 'Nouveautés'],
    visual: { kind: 'chips', chips: [['Nouveau', 'green', 'sparkle'], ['Amélioré', 'indigo', 'bolt'], ['Corrigé', 'orange', 'check']] } },
  { id: 'subagent-threads', date: '2026-11-13', mac: true, icon: 'bot', hue: 'violet',
    title: 'Les sous-agents ont leur fil',
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
    title: 'Écris pendant que l’agent travaille',
    lead: 'Studio ne coupe jamais un agent en plein travail.',
    bits: [
      ['hourglass', 'En attente', 'tes messages s’affichent ainsi dans le fil'],
      ['list', 'Remis ensemble', 'dans l’ordre, dès que l’agent a fini son tour'],
    ],
    visual: { kind: 'flow', steps: [['Tu écris', 'gray', 'compose'], ['En attente', 'amber', 'hourglass'], ['Remis', 'teal', 'check']] } },
  { id: 'reuse-worktrees', date: '2026-11-12', mac: true, icon: 'pr', hue: 'green',
    title: 'Une discussion, plusieurs branches',
    lead: 'Une copie fusionnée repart d’elle-même sur une nouvelle branche.',
    bits: [
      ['check', 'Fusion reconnue', 'la copie n’est plus reproposée à la publication'],
      ['pr', 'Nouvelle branche', 'à partir de la dernière version de la branche principale'],
    ],
    visual: { kind: 'flow', steps: [['Fusionné', 'green', 'check'], ['main à jour', 'blue', 'refresh'], ['Nouvelle branche', 'violet', 'pr']] } },
];

const SEEN = 'studio.news.seen', MAX_AUTO = 5;
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
const chipHTML = ([label, hue, ic]: Chip, i: number): string => `<span class="wn-pill" style="--c:var(--c-${esc(hue)});--i:${i}">${ic ? icon(ic) : ''}${esc(label)}</span>`;
function visualHTML(v: Visual): string {
  if (v.kind === 'flow') return `<div class="wn-flow">${v.steps.map((c, i) => `${i ? `<i class="wn-arrow" style="--i:${i}">${icon('chevronRight')}</i>` : ''}${chipHTML(c, i)}`).join('')}</div>`;
  if (v.kind === 'stack') return `<div class="wn-stack">${v.rows.map(([c, text], i) => `<div class="wn-row" style="--i:${i}">${chipHTML(c, i)}<code>${esc(text)}</code></div>`).join('')}</div>`;
  return `<div class="wn-chips">${v.chips.slice(0, 4).map(chipHTML).join('')}</div>`;
}
/** Illustration d'une diapositive : une icône sur un fond teinté, et son schéma. */
const hero = (ic: string, hue: string, v: Visual): string =>
  `<div class="wn-hero" style="--c:var(--c-${esc(hue)})" aria-hidden="true"><i class="wn-orb"></i><i class="wn-orb b"></i><span class="wn-badge">${icon(ic)}</span>${visualHTML(v)}</div>`;
const steps = (labels: string[], hue: string): Visual => ({ kind: 'flow', steps: labels.map(l => [l, hue] as Chip) });

interface Slide { hero: string; kicker: string; title: string; body: string; go?: Item['go'] }
function itemSlide(n: Item): Slide {
  const bits = `<ul class="wn-bits">${n.bits.map(([ic, key, detail]) => `<li style="--c:var(--c-${esc(n.hue)})"><span class="wn-bit-ic">${icon(ic)}</span><span><b>${rich(key)}</b>${detail ? ` · ${rich(detail)}` : ''}</span></li>`).join('')}</ul>`;
  const where = n.where?.length ? `<p class="wn-where">${icon('search')}<span>Où</span>${n.where.map(w => `<kbd>${esc(w)}</kbd>`).join('<i>›</i>')}</p>` : '';
  return { hero: hero(n.icon, n.hue, n.visual), kicker: `Nouveau${day(n.date) ? ` · ${day(n.date)}` : ''}${n.mac ? ' · Mac' : ''}`, title: n.title,
    body: `<p class="wn-lead">${rich(n.lead)}</p>${bits}${where}`, ...(n.go ? { go: n.go } : {}) };
}
function installedSlide(v: Installed): Slide {
  const list = changeList(v.notes);
  const page = v.page.startsWith('https://github.com/') ? `<p class="wn-link"><a href="${esc(v.page)}" target="_blank" rel="noopener">Voir le détail sur GitHub</a></p>` : '';
  return { hero: hero('check', 'green', steps(['Installée', 'Vérifiée', 'À jour'], 'green')), kicker: 'Mise à jour installée', title: `Studio ${v.tag}`,
    body: (list ? `<p>Studio vient de se mettre à jour. Voici ce qui change :</p>${list}` : '<p>Studio vient de se mettre à jour. Tes notes et tes réglages n’ont pas bougé.</p>') + page };
}

/** Carrousel : une diapositive à la fois, points de progression, flèches du clavier. */
function carousel(slides: Slide[]): void {
  if (!slides.length) return;
  let at = 0;
  const m = modal({ cls: 'wn', html: '<div class="wn-stage"></div><footer class="wn-foot"><div class="wn-dots"></div><button class="btn btn-ghost" data-wn="prev">Précédent</button><button class="btn btn-primary" data-wn="next" autofocus></button></footer>' });
  const stage = need('.wn-stage', m.body), dots = need('.wn-dots', m.body), prev = need<HTMLButtonElement>('[data-wn="prev"]', m.body), next = need<HTMLButtonElement>('[data-wn="next"]', m.body);
  const show = (i: number, dir: 1 | -1 | 0): void => {
    const s = slides[i]; if (!s) return;
    at = i;
    stage.innerHTML = `<section class="wn-slide${dir > 0 ? ' fwd' : dir < 0 ? ' back' : ''}" aria-live="polite">${s.hero}<div class="wn-text"><p class="wn-kicker">${esc(s.kicker)}</p><h3>${esc(s.title)}</h3>${s.body}${s.go ? `<p class="wn-link"><button class="link-btn" data-wn="go">${esc(s.go.label)}</button></p>` : ''}</div></section>`;
    dots.innerHTML = slides.length > 1 ? slides.map((_, k) => `<button class="wn-dot${k === i ? ' on' : ''}" data-wn-at="${k}" aria-label="Nouveauté ${k + 1} sur ${slides.length}"${k === i ? ' aria-current="true"' : ''}></button>`).join('') : '';
    prev.hidden = i === 0;
    next.textContent = i === slides.length - 1 ? (slides.length > 1 ? 'C’est parti' : 'Compris') : 'Suivant';
  };
  const step = (d: 1 | -1): void => {
    if (d > 0 && at === slides.length - 1) { m.close(); return; }
    if (at + d >= 0) show(at + d, d);
  };
  m.node.addEventListener('click', e => {
    const b = target(e).closest('[data-wn], [data-wn-at]'); if (!b) return;
    if (b.dataset.wnAt !== undefined) { const k = Number(b.dataset.wnAt); if (k !== at) show(k, k > at ? 1 : -1); return; }
    if (b.dataset.wn === 'next') step(1);
    else if (b.dataset.wn === 'prev') step(-1);
    else if (b.dataset.wn === 'go') { const go = slides[at]?.go; m.close(); if (go) void api.setView(go.view); }
  });
  m.node.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); if (at < slides.length - 1) step(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  });
  show(0, 0);
}

/** Toutes les nouveautés, à la demande (menu Studio → Nouveautés). */
export function open(): void {
  const all = applicable();
  markSeen(all);
  carousel(all.map(itemSlide));
}

/** Une nouvelle version est prête : relancer maintenant, ou la laisser s'installer à la fermeture. */
function promptReady(): void {
  const s = update.current(); if (!s) return;
  const list = changeList(s.notes ?? '', 5);
  const m = modal({ cls: 'wn', html: `<section class="wn-slide">${hero('download', 'blue', steps(['Téléchargée', 'Vérifiée', 'Prête'], 'blue'))}<div class="wn-text"><p class="wn-kicker">Mise à jour prête</p><h3>Studio ${esc(s.tag ?? '')}</h3>
      <p>La nouvelle version est déjà téléchargée et vérifiée. Relance Studio pour l’utiliser : tes notes sont enregistrées avant, et l’app se rouvre en quelques secondes.</p>${list}
      <p class="wn-hint">Plus tard, elle s’installera toute seule quand tu quitteras Studio. Si un agent Claude Code travaille en ce moment, laisse-le d’abord finir.</p></div></section>
    <footer class="wn-foot"><span class="wn-dots"></span><button class="btn btn-ghost" data-wn="later">Plus tard</button><button class="btn btn-primary" data-wn="restart" autofocus>${icon('refresh')}Relancer maintenant</button></footer>` });
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
    const fresh = unseen().slice(0, MAX_AUTO);
    if (!done && !fresh.length) return;
    whenFree(() => {
      markSeen(applicable());
      carousel([...(done ? [installedSlide(done)] : []), ...fresh.map(itemSlide)]);
    }, 900);
  });
}
