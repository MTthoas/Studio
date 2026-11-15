// Notes vocales : l'app native transcrit la voix sur l'appareil (rien n'est envoyé en ligne),
// et le texte devient une note, synchronisée ensuite comme les autres.
import * as store from '../core/store.ts';
import * as events from '../core/events.ts';
import { $, icon, toast, modal, need } from '../ui/kit.ts';
import type { AppShell } from '../types.ts';

/** Message de l'app native pendant la dictée. */
interface VoiceEvent { state: 'listening' | 'partial' | 'final' | 'error' | 'cancelled'; text?: string; message?: string }
interface Session { status(text: string, live: boolean): void; text(t: string): void; done(t: string): Promise<void>; close(): void }

let app!: AppShell;
let session: Session | null = null;
const bridge = () => window.webkit?.messageHandlers?.carnet;
const send = (action: 'start' | 'stop' | 'cancel') => bridge()?.postMessage({ type: 'voice', action });
export const available = (): boolean => !!bridge();
export const init = (shell: AppShell): void => { app = shell; };

// Appelé par l'app native : { state: listening | partial | final | error | cancelled, text?, message? }
export function onNative(raw: unknown): void {
  const p = raw as VoiceEvent | null;
  if (!session || !p || typeof p.state !== 'string') return;
  if (p.state === 'listening') session.status('Je t’écoute…', true);
  else if (p.state === 'partial') session.text(p.text || '');
  else if (p.state === 'error') { session.close(); toast(p.message || 'La note vocale a échoué.'); }
  else if (p.state === 'final') void session.done(p.text || '');
  else if (p.state === 'cancelled') session.close();
}

async function save(text: string): Promise<void> {
  text = text.trim();
  if (!text) { toast('Rien n’a été entendu.'); return; }
  const d = new Date();
  const title = `Note vocale · ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  const n = await store.createNote({ title, body: `${text}\n\n#vocal`, inbox: true });
  events.emit('capture', `${title}\n\n${text}`, { noteId: n.id });
  toast('Note vocale enregistrée', { label: 'Ouvrir', run: () => app.openNote(n.id) });
}

/** Bouton micro d'une zone de saisie (voir `dictate`) ; vide hors de l'app native. */
export const micHTML = (label: string): string => available()
  ? `<button type="button" class="icon-btn vc-mic" data-vc-mic title="${label} (transcription sur l’appareil)" aria-label="${label}" aria-pressed="false">${icon('mic')}</button>` : '';

/**
 * Dictée dans un champ : la voix s'écrit à la suite du texte déjà là, au fil de la transcription.
 * Un second clic sur le bouton termine ; quitter la page annule. `onText` suit chaque changement (brouillon).
 */
export function dictate(field: HTMLTextAreaElement | HTMLInputElement, btn: HTMLElement, onText?: () => void): void {
  if (!available()) { toast('La dictée fonctionne dans l’app Studio (iPhone ou Mac) : la transcription s’y fait sur l’appareil.'); return; }
  if (session) { if (btn.classList.contains('live')) { btn.classList.add('busy'); send('stop'); } return; }
  const before = field.value.trimEnd(), sep = !before ? '' : before.includes('\n') ? '\n\n' : ' ';
  const put = (t: string) => {
    if (!field.isConnected) { send('cancel'); session = null; return; }
    t = t.trim(); field.value = t ? before + sep + t : before; field.scrollTop = field.scrollHeight; onText?.();
  };
  const end = () => { session = null; btn.classList.remove('live', 'busy'); btn.setAttribute('aria-pressed', 'false'); };
  btn.classList.add('live'); btn.setAttribute('aria-pressed', 'true');
  session = {
    status: () => {},
    text: put,
    done: async t => { put(t); end(); field.focus(); if (!t.trim()) toast('Rien n’a été entendu.'); },
    close: end,
  };
  send('start');
}

/** Coupe la dictée en cours en gardant le texte déjà écrit (envoi du formulaire pendant qu'on parle). */
export function cancel(): void { if (session) { send('cancel'); session.close(); } }

export function record(): void {
  if (!available()) { toast('Les notes vocales fonctionnent dans l’app Studio (iPhone ou Mac) : la transcription s’y fait sur l’appareil.'); return; }
  if (session) return;
  let finished = false, last = '';
  const m = modal({ cls: 'small voice', onClose: () => { if (!finished) send('cancel'); session = null; },
    html: `<div class="vc-head"><i class="vc-dot"></i><span class="vc-state">Préparation du micro…</span></div><div class="vc-text" aria-live="polite"></div>
      <p class="modal-hint">${icon('shield')} Transcription sur l’appareil : ta voix ne part nulle part.</p>
      <div class="modal-actions"><button class="btn" data-vc-cancel>Annuler</button><button class="btn btn-primary" data-vc-stop disabled>Terminer</button></div>` });
  const stop = need<HTMLButtonElement>('[data-vc-stop]', m.node);
  session = {
    status: (t, live) => { need('.vc-state', m.node).textContent = t; $('.vc-dot', m.node)?.classList.toggle('live', live); stop.disabled = !live; },
    text: t => { last = t; const b = need('.vc-text', m.node); b.textContent = t; b.scrollTop = b.scrollHeight; },
    done: async t => { finished = true; m.close(); await save(t || last); },
    close: () => { finished = true; m.close(); },
  };
  need('[data-vc-cancel]', m.node).onclick = () => m.close();
  stop.onclick = () => { session?.status('Transcription des derniers mots…', false); send('stop'); };
  send('start');
}
