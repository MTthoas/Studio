// « Demander à l'IA » sur une sélection : dès qu'on sélectionne du texte dans une note, un petit champ apparaît
// sous la sélection. On y écrit une consigne (ou on choisit une suggestion), l'IA répond, et l'on peut remplacer
// la sélection, insérer la réponse dessous, la copier ou continuer l'échange dans le panneau IA.
// La demande part par `hooks.run` (features/noteai.ts `quick`) : même contexte que le panneau (note, notes du projet).

export interface SelAskHooks {
  /** La note peut-elle partir vers l'IA ? (chiffrée, #privé : la bulle ne s'affiche pas) */
  enabled: () => boolean;
  /** Notes fermées à l'IA (interrupteur général) : la bulle propose de les autoriser au lieu d'envoyer. */
  locked?: () => boolean;
  unlock?: () => void;
  run: (sel: { s: number; e: number; text: string }, prompt: string) => Promise<string>;
  /** Reprendre l'échange dans le panneau IA de la note. */
  more: (sel: { s: number; e: number; text: string }, prompt: string, answer: string) => void;
  /** Remplace [start, end[ en gardant l'historique d'annulation de l'éditeur (`replaceRange` d'app.ts). */
  replace: (start: number, end: number, text: string) => void;
}

const MIN = 3; // en dessous, ce n'est pas un passage
const QUICK: [string, string][] = [
  ['Reformuler', 'Reformule ce passage pour qu’il soit plus clair, sans changer le sens.'],
  ['Corriger', 'Corrige l’orthographe, la grammaire et la ponctuation, sans rien changer d’autre.'],
  ['Résumer', 'Résume ce passage en quelques lignes.'],
  ['Développer', 'Développe ce passage avec plus de détails.'],
  ['Traduire', 'Traduis ce passage en anglais (ou en français s’il est déjà en anglais).'],
];

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const SPARK = '<svg class="sa-ic" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2l1.2 3.3 3.3 1.2-3.3 1.2L7 11 5.8 7.7 2.5 6.5l3.3-1.2zM12.5 10l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/></svg>';

export function attach(ta: HTMLTextAreaElement, hooks: SelAskHooks) {
  if (!ta?.parentElement) return;
  const host = ta.parentElement, box = document.createElement('div');
  box.className = 'selask'; box.hidden = true;
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Demander à l’IA');
  host.append(box);

  const mirror = document.createElement('div'), mark = document.createElement('span');
  mark.textContent = '​';
  let range = { s: 0, e: 0 }, text = '', open = false, busy = false, token = 0, answer = '', frame = 0;
  const input = () => box.querySelector<HTMLInputElement>('.sa-in');

  function close() { token++; open = busy = false; answer = ''; box.hidden = true; box.innerHTML = ''; box.classList.remove('wide'); }

  // Position, dans le parent du champ, du point `pos` du texte (même double invisible que caret.ts).
  function pointAt(pos: number) {
    const cs = getComputedStyle(ta);
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize', 'lineHeight'] as const) mirror.style[p] = cs[p];
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'border-box', width: ta.clientWidth + 'px', top: 0, left: 0 });
    mirror.textContent = ta.value.slice(0, pos);
    mirror.append(mark);
    host.append(mirror);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5, top = mark.offsetTop - ta.scrollTop;
    const pt = { x: mark.offsetLeft - ta.scrollLeft + ta.offsetLeft, top: top + ta.offsetTop, bottom: top + ta.offsetTop + lh, inView: top > -lh && top < ta.clientHeight };
    mirror.remove();
    return pt;
  }

  function place() {
    if (!open) return;
    const end = pointAt(range.e), start = pointAt(range.s);
    if (!end.inView && !start.inView && !busy && !answer) { close(); return; } // sélection sortie de la zone visible
    const w = box.offsetWidth, h = box.offsetHeight, maxX = host.clientWidth - w - 8;
    const x = Math.max(8, Math.min(end.x - 24, maxX));
    // Sous la sélection, ou au-dessus s'il n'y a pas la place en bas.
    const below = end.bottom + 6, above = start.top - h - 6;
    const y = below + h > host.clientHeight - 4 && above > 4 ? above : Math.max(4, Math.min(below, host.clientHeight - h - 4));
    box.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }

  function show() {
    open = true; box.hidden = false; box.classList.remove('wide');
    if (hooks.locked?.()) {
      box.innerHTML = `<div class="sa-lock">${SPARK}<span>L’IA ne lit pas tes notes pour l’instant.</span><button type="button" class="primary" data-a="unlock">Autoriser</button></div>`;
      place(); return;
    }
    box.innerHTML = `<form class="sa-row">${SPARK}<input class="sa-in" type="text" placeholder="Demander à l’IA…" aria-label="Consigne pour l’IA à propos de la sélection" autocomplete="off" spellcheck="false" enterkeyhint="send"><button class="sa-go" type="submit" title="Envoyer (↵)" aria-label="Envoyer">↵</button></form>`
      + `<div class="sa-quick">${QUICK.map(([l], i) => `<button type="button" data-q="${i}">${l}</button>`).join('')}</div>`;
    place();
  }

  function grab() { range = { s: ta.selectionStart, e: ta.selectionEnd }; text = ta.value.slice(range.s, range.e); }

  function sync() {
    frame = 0;
    if (busy || answer || (open && document.activeElement === input())) return; // on est en train de s'en servir
    const len = ta.selectionEnd - ta.selectionStart;
    if (ta.readOnly || !hooks.enabled() || document.activeElement !== ta || len < MIN || !ta.value.slice(ta.selectionStart, ta.selectionEnd).trim()) { if (open) close(); return; }
    const same = open && range.s === ta.selectionStart && range.e === ta.selectionEnd;
    grab();
    if (!same) { if (open) place(); else show(); }
  }
  const soon = () => { if (!frame) frame = requestAnimationFrame(sync); };

  const changed = () => ta.value.slice(range.s, range.e) !== text;

  async function ask(instruction: string) {
    instruction = instruction.trim();
    if (!instruction || busy) return;
    if (changed()) { showError('Le texte a changé depuis la sélection : sélectionne-le de nouveau.'); return; }
    const my = ++token; busy = true; answer = '';
    box.classList.add('wide');
    box.innerHTML = `<div class="sa-q">${SPARK}<span>${esc(instruction)}</span></div><div class="sa-wait"><i></i><i></i><i></i><span>L’IA réfléchit…</span></div><div class="sa-actions"><button type="button" data-a="close">Annuler</button></div>`;
    place();
    try {
      const out = await hooks.run({ s: range.s, e: range.e, text }, instruction);
      if (my !== token) return;
      busy = false; answer = out.trim();
      if (!answer) { showError('L’IA n’a rien répondu.', instruction); return; }
      showAnswer(instruction);
    } catch (e) {
      if (my !== token) return;
      busy = false; showError(e instanceof Error ? e.message : String(e), instruction);
    }
  }

  function showAnswer(instruction: string) {
    box.innerHTML = `<div class="sa-q">${SPARK}<span>${esc(instruction)}</span></div><div class="sa-ans" tabindex="0">${esc(answer)}</div>`
      + `<div class="sa-actions"><button type="button" class="primary" data-a="replace">Remplacer</button><button type="button" data-a="after">Insérer dessous</button><button type="button" data-a="copy">Copier</button><span class="sa-sp"></span><button type="button" data-a="again" data-i="${esc(instruction)}" title="Relancer la même consigne">Relancer</button><button type="button" data-a="more" data-i="${esc(instruction)}" title="Continuer l’échange dans le panneau IA">Continuer…</button><button type="button" data-a="close" title="Fermer (Échap)">✕</button></div>`;
    place();
    box.querySelector<HTMLElement>('[data-a="replace"]')?.focus();
  }
  function showError(msg: string, instruction = '') {
    answer = ''; box.classList.add('wide');
    box.innerHTML = `<div class="sa-err">${esc(msg)}</div><div class="sa-actions">${instruction ? `<button type="button" class="primary" data-a="again" data-i="${esc(instruction)}">Réessayer</button>` : ''}<button type="button" data-a="new">Autre consigne</button><button type="button" data-a="close">Fermer</button></div>`;
    place();
  }

  function apply(kind: 'replace' | 'after') {
    if (changed()) { const a = answer; showError('Le texte a changé depuis la sélection : la réponse n’a pas été insérée.'); answer = a; return; }
    const out = answer, { s, e } = range;
    close();
    if (kind === 'replace') { hooks.replace(s, e, out); ta.setSelectionRange(s, s + out.length); }
    else { const sep = '\n\n'; hooks.replace(e, e, sep + out); ta.setSelectionRange(e + sep.length, e + sep.length + out.length); }
    ta.focus();
  }
  function reselect() { close(); ta.focus(); ta.setSelectionRange(range.s, range.e); show(); input()?.focus(); }
  function dismiss() { close(); ta.focus(); ta.setSelectionRange(range.e, range.e); }

  // Un clic dans la bulle (hors champ) ne doit pas retirer le focus ni la sélection du texte.
  box.addEventListener('mousedown', e => { if (!(e.target as HTMLElement).closest('input, .sa-ans')) e.preventDefault(); });
  box.addEventListener('submit', e => { e.preventDefault(); ask(input()?.value ?? ''); });
  box.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-q], button[data-a]'); if (!b) return;
    if (b.dataset.q) { if (hooks.locked?.()) { show(); return; } ask(QUICK[+b.dataset.q][1]); return; }
    switch (b.dataset.a) {
      case 'replace': case 'after': apply(b.dataset.a); break;
      case 'copy': navigator.clipboard?.writeText(answer).then(() => { b.textContent = 'Copié'; }, () => { b.textContent = 'Copie impossible'; }); break;
      case 'again': ask(b.dataset.i ?? ''); break;
      case 'more': { const a = answer, r = { s: range.s, e: range.e, text }; close(); hooks.more(r, b.dataset.i ?? '', a); break; }
      case 'new': reselect(); break;
      case 'unlock': hooks.unlock?.(); show(); input()?.focus(); break;
      case 'close': dismiss(); break;
    }
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && answer) { e.preventDefault(); apply('replace'); }
  });

  ta.addEventListener('mouseup', soon);
  ta.addEventListener('keyup', e => { if (e.key === 'Escape') { if (open && !busy) close(); } else soon(); });
  ta.addEventListener('input', () => { if (open && !busy && !answer) close(); });
  ta.addEventListener('scroll', () => { if (open) place(); });
  ta.addEventListener('blur', () => setTimeout(() => { if (open && !busy && !answer && !box.contains(document.activeElement)) close(); }, 150));
  new ResizeObserver(() => { if (open) place(); }).observe(ta);
  // Sélection au doigt (iPhone) ou au clavier : pas de mouseup, on suit `selectionchange`, une fois la sélection posée.
  let settle = 0;
  document.addEventListener('selectionchange', function onSel() {
    if (!ta.isConnected) return document.removeEventListener('selectionchange', onSel);
    if (document.activeElement === ta) { clearTimeout(settle); settle = window.setTimeout(soon, 350); }
  });
  document.addEventListener('mousedown', function onDown(e) {
    if (!ta.isConnected) return document.removeEventListener('mousedown', onDown); // le champ a été remplacé
    if (open && !busy && !box.contains(e.target as Node) && e.target !== ta) close();
  });
}
