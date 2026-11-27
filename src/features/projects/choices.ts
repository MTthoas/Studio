// Questions à choix posées par un agent dans le Salon. L'agent écrit, en fin de message, un ou plusieurs blocs
//   ```studio-question La question ?
//   - Premier choix — précision facultative
//   - Second choix
//   ```
// (format dicté par `AgentTuning.chat`, côté Mac). Le Salon retire ces blocs du texte et montre les choix en boutons :
// une seule question part au premier clic ; plusieurs se cochent, puis « Envoyer mes choix » les envoie ensemble.
import { esc } from '../../lib/markdown.ts';

export interface Choice { label: string; hint: string }
export interface Question { q: string; options: Choice[] }

const BLOCK = /^[ \t]*```studio-question[ \t]*(.*)\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
const MAX_Q = 4, MAX_OPT = 6;

/** Le texte sans ses blocs de questions, et les questions qu'ils portaient (au plus 4, de 2 à 6 choix chacune). */
export function parse(t: string): { text: string; questions: Question[] } {
  if (!t.includes('```studio-question')) return { text: t, questions: [] };
  const questions: Question[] = [];
  const text = t.replace(/\r/g, '').replace(BLOCK, (_m, head: string, body: string) => {
    const options = body.split('\n').map(l => l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/)?.[1]?.trim() ?? '').filter(Boolean).slice(0, MAX_OPT).map(o => {
      const m = o.match(/^(.+?)\s+[—–]\s+(.+)$/) ?? o.match(/^(.+?)\s:\s+(.+)$/);
      return { label: (m?.[1] ?? o).replace(/\*\*/g, '').trim().slice(0, 80), hint: (m?.[2] ?? '').trim().slice(0, 160) };
    });
    const q = head.trim().slice(0, 240);
    if (q && options.length >= 2 && questions.length < MAX_Q) questions.push({ q, options });
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), questions };
}

/** Les questions en boutons. Actives seulement dans le dernier message de l'agent qui attend une réponse (`.sl-msg.ask`). */
export function html(qs: Question[]): string {
  if (!qs.length) return '';
  const multi = qs.length > 1;
  return `<div class="sl-ask-qs${multi ? ' multi' : ''}">${qs.map((x, i) => `<fieldset class="sl-ask-q" data-q="${i}"><legend data-no-i18n>${esc(x.q)}</legend><div class="sl-ask-opts" data-no-i18n>${x.options.map(o =>
    `<button type="button" class="sl-ch" data-sl="choice" data-q="${i}" data-text="${esc(o.label)}" aria-pressed="false"${o.hint ? ` title="${esc(o.hint)}"` : ''}><b>${esc(o.label)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</button>`).join('')}</div></fieldset>`).join('')}${multi ? `<button type="button" class="btn btn-primary sl-ask-go" data-sl="choices" disabled>Envoyer mes choix</button>` : ''}</div>`;
}

/** Un choix cliqué. Rend le message à envoyer, ou '' tant qu'il manque des réponses (questions multiples). */
export function pick(btn: HTMLElement): string {
  const box = btn.closest('.sl-ask-qs'); if (!box) return '';
  if (!box.classList.contains('multi')) return btn.dataset.text ?? '';
  for (const b of box.querySelectorAll<HTMLElement>(`.sl-ch[data-q="${btn.dataset.q}"]`)) b.setAttribute('aria-pressed', String(b === btn));
  const go = box.querySelector<HTMLButtonElement>('.sl-ask-go');
  if (go) go.disabled = [...box.querySelectorAll('.sl-ask-q')].some(f => !f.querySelector('[aria-pressed="true"]'));
  return '';
}

/** Les réponses cochées, une ligne par question (« Question → choix »). */
export function answers(go: HTMLElement): string {
  const box = go.closest('.sl-ask-qs'); if (!box) return '';
  return [...box.querySelectorAll<HTMLElement>('.sl-ask-q')].map(f => {
    const c = f.querySelector<HTMLElement>('[aria-pressed="true"]');
    return c ? `${f.querySelector('legend')?.textContent ?? ''} → ${c.dataset.text ?? ''}` : '';
  }).filter(Boolean).join('\n');
}
