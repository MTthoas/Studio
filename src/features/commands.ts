// Commandes enregistrées : un bloc ```commandes dans une note (une commande par ligne, `# description` au-dessus,
// `## Section` pour grouper, `\` en fin de ligne pour continuer), rendu avec un bouton Copier, et retrouvé depuis la palette (⌘K).
import * as store from '../core/store.ts';
import { esc } from '../lib/markdown.ts';
import { icon, toast } from '../ui/kit.ts';
import type { Note } from '../types.ts';

/** Langages de bloc reconnus. */
export const LANGS = new Set(['commandes', 'commande', 'cmd', 'commands']);
export const TEMPLATE = '```commandes\n## Projet\n# Installer les dépendances\nnpm install\n# Lancer en local\nnpm run dev\n```\n';

export interface Command { label: string; cmd: string; section: string }

export function parse(code: string): Command[] {
  const out: Command[] = [];
  let label = '', section = '', buf: string[] = [];
  const push = () => { if (buf.length) out.push({ label, cmd: buf.join('\n'), section }); buf = []; label = ''; };
  for (const raw of code.split('\n')) {
    const line = raw.trimEnd();
    if (buf.length) { buf.push(line); if (!line.endsWith('\\')) push(); continue; } // suite d'une commande sur plusieurs lignes
    const t = line.trim();
    if (!t) { label = ''; continue; }
    if (/^##\s/.test(t)) { section = t.replace(/^##\s+/, ''); label = ''; continue; }
    if (t.startsWith('#') && !t.startsWith('#!')) { label = t.replace(/^#\s*/, ''); continue; }
    buf = [t];
    if (!t.endsWith('\\')) push();
  }
  push();
  return out;
}

export function blockHTML(code: string): string {
  const list = parse(code);
  const head = `<div class="cmds-head">${icon('terminal')}<span>Commandes${list.length ? ` · ${list.length}` : ''}</span></div>`;
  if (!list.length) return `<div class="cmds">${head}<p class="cmds-hint">Une commande par ligne, <code># description</code> au-dessus, <code>## Section</code> pour grouper.</p></div>`;
  let sec = '';
  const rows = list.map(c => (c.section && c.section !== sec ? `<div class="cmds-sec">${esc(sec = c.section)}</div>` : '')
    + `<div class="cmd-row"><div class="cmd-main">${c.label ? `<span class="cmd-label">${esc(c.label)}</span>` : ''}<code class="cmd-code" data-cmd-copy="${esc(c.cmd)}" title="Cliquer pour copier">${esc(c.cmd)}</code></div>`
    + `<button class="icon-btn cmd-copy" data-cmd-copy="${esc(c.cmd)}" title="Copier la commande" aria-label="Copier la commande">${icon('copy')}</button></div>`).join('');
  return `<div class="cmds">${head}${rows}</div>`;
}

/** Contenu des blocs de commandes d'un texte. */
function blocks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^\s*(`{3,}|~{3,})\s*([\w-]+)[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm)) if (LANGS.has((m[2] ?? '').toLowerCase())) out.push(m[3] ?? '');
  return out;
}

/** Toutes les commandes enregistrées dans les notes lisibles (les notes verrouillées sont ignorées). */
export function all(): { note: Note; c: Command }[] {
  const out: { note: Note; c: Command }[] = [];
  for (const n of store.index().live) {
    const body = store.getBody(n);
    if (!body || !/^\s*(```|~~~)/m.test(body)) continue;
    for (const code of blocks(body)) for (const c of parse(code)) out.push({ note: n, c });
  }
  return out;
}

export async function copy(cmd: string): Promise<void> {
  try { await navigator.clipboard.writeText(cmd); toast('Commande copiée'); } catch { toast('Copie impossible : sélectionne la commande'); }
}
