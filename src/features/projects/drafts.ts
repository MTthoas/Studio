// Ce que le formulaire de consigne de Claude Code retient d'une visite à l'autre, sur cet appareil :
//   - le brouillon de chaque consigne (texte, notes jointes, mode, répartition entre agents), pour ne rien perdre en naviguant ;
//   - le modèle et le niveau d'effort choisis, par défaut et pour chaque conversation ;
//   - les modèles ajoutés à la main à la liste.
// Tout reste dans le stockage local du navigateur, comme les noms des conversations.

// ---------- Brouillons ----------
/** `fan` : répartition entre plusieurs agents ('' : un seul, 'notes' : un par note jointe, 'lines' : un par ligne). */
export interface Draft { text: string; notes: string[]; mode: string; tests: boolean; fan?: string; at: number }
const DRAFTS = 'studio.cc.drafts', MAX_DRAFTS = 40, MAX_TEXT = 100_000;

function object(key: string): Record<string, unknown> {
  try { const v = JSON.parse(localStorage.getItem(key) || '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}
function stored(): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  for (const [k, v] of Object.entries(object(DRAFTS))) {
    const d = v as Partial<Draft> | null;
    if (!d || typeof d.text !== 'string') continue;
    out[k] = { text: d.text, notes: Array.isArray(d.notes) ? d.notes.filter(x => typeof x === 'string') : [], mode: d.mode === 'read' ? 'read' : 'edit', tests: d.tests === true, fan: d.fan === 'notes' || d.fan === 'lines' ? d.fan : '', at: typeof d.at === 'number' ? d.at : 0 };
  }
  return out;
}

let drafts = stored();
/** Brouillons modifiés depuis la dernière écriture : seuls ceux-là sont reportés (une autre fenêtre garde les siens). */
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(timer); timer = undefined;
  if (!dirty.size) return;
  const all = stored();
  for (const k of dirty) { const d = drafts[k]; if (d) all[k] = d; else delete all[k]; }
  dirty.clear();
  drafts = Object.fromEntries(Object.entries(all).sort((a, b) => a[1].at - b[1].at).slice(-MAX_DRAFTS));
  try { localStorage.setItem(DRAFTS, JSON.stringify(drafts)); } catch { /* stockage plein : le brouillon reste en mémoire */ }
}
// La frappe est écrite avec un léger délai ; on n'attend pas si la page se ferme ou passe en arrière-plan.
addEventListener('pagehide', persist);
document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); });

/** Brouillon d'un formulaire de consigne, s'il y en a un. */
export const draft = (key: string): Draft | null => drafts[key] ?? null;
/** Retient le brouillon ; un formulaire vide (ni texte ni note) n'en laisse pas. */
export function saveDraft(key: string, d: Omit<Draft, 'at'>): void {
  if (!d.text.trim() && !d.notes.length) { dropDraft(key); return; }
  drafts[key] = { ...d, text: d.text.slice(0, MAX_TEXT), at: Date.now() };
  dirty.add(key);
  timer ??= setTimeout(persist, 400);
}
export function dropDraft(key: string): void {
  if (!drafts[key] && !dirty.has(key)) return;
  delete drafts[key]; dirty.add(key); persist();
}

// ---------- Modèle et effort ----------
export interface Choice { model: string; effort: string }
interface Prefs { model: string; effort: string; extra: string[]; sessions: Record<string, Choice> }
const PREFS = 'studio.cc.compose', MAX_EXTRA = 8, MAX_SESSIONS = 300;
/** Identifiant ou alias de modèle accepté par le Mac (même règle que dans Agents.swift). */
export const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,40}$/;
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const choice = (v: unknown): Choice => { const c = (v ?? {}) as Partial<Choice>; return { model: str(c.model), effort: str(c.effort) }; };

const prefs: Prefs = (() => {
  const o = object(PREFS), s = o.sessions;
  return {
    ...choice(o),
    extra: Array.isArray(o.extra) ? (o.extra as unknown[]).filter((x): x is string => typeof x === 'string' && MODEL_RE.test(x)) : [],
    sessions: s && typeof s === 'object' && !Array.isArray(s) ? Object.fromEntries(Object.entries(s as Record<string, unknown>).map(([k, v]) => [k, choice(v)])) : {},
  };
})();
function savePrefs(): void {
  prefs.extra = prefs.extra.slice(-MAX_EXTRA);
  prefs.sessions = Object.fromEntries(Object.entries(prefs.sessions).slice(-MAX_SESSIONS));
  try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* stockage plein */ }
}

/** Modèle et effort proposés pour une nouvelle consigne : les derniers choisis. */
export const defaults = (): Choice => ({ model: prefs.model, effort: prefs.effort });
export function setDefaults(c: Choice): void { prefs.model = c.model; prefs.effort = c.effort; savePrefs(); }
/** Modèle et effort d'une conversation, si elle a été lancée ou réglée depuis cet appareil. */
export const ofSession = (id: string): Choice | null => prefs.sessions[id] ?? null;
export function setSession(id: string, c: Choice): void {
  if (!id) return;
  delete prefs.sessions[id]; prefs.sessions[id] = { model: c.model, effort: c.effort }; savePrefs();
}
export function forgetSession(id: string): void { if (prefs.sessions[id]) { delete prefs.sessions[id]; savePrefs(); } }
/** Modèles ajoutés à la main (« Autre modèle… »), les plus récents en dernier. */
export const extraModels = (): string[] => [...prefs.extra];
export function addModel(id: string): void {
  prefs.extra = [...prefs.extra.filter(x => x !== id), id]; savePrefs();
}

// ---------- Sous-agents ----------
/** Spécialiste proposé à Claude Code en plus de ses sous-agents d'origine (voir AgentTeam dans Agents.swift). */
export interface Member { name: string; description: string; prompt: string; model: string; access: 'read' | 'all' }
/** Sous-agents des consignes lancées depuis cet appareil. `on` : Claude Code reçoit l'outil Agent et délègue de lui-même. */
export interface Team { on: boolean; max: number; model: string; members: Member[] }
const TEAM = 'studio.cc.subagents';
/** Mêmes bornes que le Mac, qui revalide tout. */
export const MEMBER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/, TEAM_SIZE = 8, TEAM_PARALLEL = 10;
const member = (v: unknown): Member => {
  const m = (v ?? {}) as Partial<Record<keyof Member, unknown>>;
  return { name: str(m.name), description: str(m.description).slice(0, 400), prompt: str(m.prompt).slice(0, 4000), model: MODEL_RE.test(str(m.model)) ? str(m.model) : '', access: m.access === 'read' ? 'read' : 'all' };
};
let teamNow: Team = (() => {
  const o = object(TEAM), max = typeof o.max === 'number' && Number.isInteger(o.max) ? o.max : 4;
  return { on: o.on !== false, max: Math.min(TEAM_PARALLEL, Math.max(1, max)), model: MODEL_RE.test(str(o.model)) ? str(o.model) : '',
    members: (Array.isArray(o.members) ? (o.members as unknown[]).map(member) : []).filter(m => MEMBER_RE.test(m.name) && m.description.trim()).slice(0, TEAM_SIZE) };
})();
export const team = (): Team => ({ ...teamNow, members: teamNow.members.map(m => ({ ...m })) });
export function setTeam(t: Team): void {
  teamNow = { ...t, members: t.members.map(m => ({ ...m })) };
  try { localStorage.setItem(TEAM, JSON.stringify(teamNow)); } catch { /* stockage plein : le réglage vaut jusqu'au rechargement */ }
}
