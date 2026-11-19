// Confirmations demandées par les agents avant de supprimer ou d'installer (AgentGuard.swift, app Mac).
// La commande de l'agent attend ; ce panneau la montre telle quelle, où qu'on soit dans Studio. « Autoriser » ouvre
// la demande Touch ID / mot de passe du Mac : c'est elle qui décide, pas ce bouton. Sans réponse, le Mac refuse.
// Seule la page de l'app Mac répond (« agent.guard » et « agent.guardAnswer » ne sont pas dans REMOTE_ALLOWED).
import * as native from '../../core/native.ts';
import * as ai from '../../integrations/ai.ts';
import * as model from './model.ts';
import { esc } from '../../lib/markdown.ts';
import { toast } from '../../ui/kit.ts';

export interface Ask { id: string; project: string; kind: string; what: string; command: string; cwd: string; agent: string; at: number; until: number }

let asks: Ask[] = [];
let busy = '', timer = 0;

const str = (v: unknown): string => typeof v === 'string' ? v : '';
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;

function parse(raw: unknown): Ask[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object').map(a => ({
    id: str(a.id), project: str(a.project), kind: str(a.kind), what: str(a.what), command: str(a.command), cwd: str(a.cwd),
    agent: str(a.agent), at: num(a.at), until: num(a.until),
  })).filter(a => a.id && a.command);
}

/** « 4 min » avant le refus automatique. */
function left(a: Ask): string {
  const s = Math.max(0, Math.round((a.until - Date.now()) / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`;
}

function askHTML(a: Ask): string {
  const p = model.byId(a.project);
  const where = a.cwd.split('/.claude/worktrees/')[1] ?? '';
  const who = [p?.name ?? '', a.agent ? `sous-agent ${a.agent}` : '', where].filter(Boolean).join(' · ');
  return `<li class="gd-ask" data-ask="${esc(a.id)}">
    <p class="gd-what">${a.kind === 'install' ? 'Un agent veut installer' : 'Un agent veut supprimer'}<span>${esc(a.what)}</span></p>
    <pre class="gd-cmd">${esc(a.command)}</pre>
    <p class="gd-meta">${esc(who)}${who ? ' · ' : ''}refus automatique dans ${esc(left(a))}</p>
    <div class="gd-actions">
      <button class="btn" data-guard="deny"${busy === a.id ? ' disabled' : ''}>Refuser</button>
      <button class="btn btn-primary" data-guard="allow"${busy === a.id ? ' disabled' : ''}>Autoriser…</button>
    </div>
  </li>`;
}

/** Affiche les demandes en attente (ou retire le panneau s'il n'y en a plus). */
export function render(list: Ask[] = asks): void {
  asks = list;
  let box = document.getElementById('guard');
  if (!asks.length) { box?.remove(); clearInterval(timer); timer = 0; return; }
  if (!box) {
    box = document.createElement('section');
    box.id = 'guard'; box.className = 'gd';
    box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-label', 'Confirmations demandées par les agents');
    box.addEventListener('click', e => {
      const b = (e.target as Element).closest<HTMLButtonElement>('[data-guard]');
      const id = b?.closest('[data-ask]')?.dataset.ask;
      if (b && id) void answer(id, b.dataset.guard === 'allow');
    });
    document.body.append(box);
  }
  box.innerHTML = `<h2 class="gd-title">Confirmation demandée<span>Touch ID ou mot de passe du Mac</span></h2><ul class="gd-list">${asks.map(askHTML).join('')}</ul>`;
  // Le compte à rebours avance, et une demande expirée côté Mac disparaît même si son signal s'est perdu.
  if (!timer) timer = window.setInterval(() => { if (asks.some(a => a.until && a.until < Date.now())) void sync(); else if (!busy) render(); }, 15000);
}

async function answer(id: string, allow: boolean): Promise<void> {
  if (busy) return;
  busy = id; render();
  // Touch ID ou mot de passe : la réponse ne revient qu'une fois la demande du système refermée.
  const r = await native.call('agent', 'guardAnswer', { ask: id, allow }, 180000);
  busy = '';
  if (!r.ok) toast(r.message || 'Confirmation impossible.');
  await sync();
}

/** Relit les demandes en attente auprès de l'app Mac. */
export async function sync(): Promise<void> {
  const r = await native.call('agent', 'guard', {}, 10000);
  if (r.ok) render(parse(r.asks));
}

/** Branche la page : relève ce qui attend au démarrage, puis à chaque signal de l'app Mac. */
export function init(): void {
  if (!ai.cc.onMac()) return;
  if (window.carnet) window.carnet.agentGuard = () => { void sync(); };
  void sync();
}
