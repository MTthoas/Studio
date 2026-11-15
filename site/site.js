// Site vitrine de Studio : aucun traceur, aucune requête, aucune bibliothèque.
// Sans ce script, la page reste entièrement lisible : boot.js pose « js », et « calm » dès que rien ne doit bouger.
// La CSP interdit les attributs style et eval : tout passe par des classes ou par le CSSOM (style.setProperty),
// et le calcul de l'éditeur a son propre analyseur.
// Peu de mouvement, exprès : une entrée et des apparitions (en CSS), l'écran du héros qui se redresse au défilement,
// la conversation rejouée, et deux démonstrations qui marchent vraiment (l'éditeur, le chiffrement).
(() => {
  'use strict';
  const root = document.documentElement;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canWatch = 'IntersectionObserver' in window;
  const wait = ms => new Promise(done => setTimeout(done, ms));
  const $ = (sel, from = document) => from.querySelector(sel);
  const $$ = (sel, from = document) => [...from.querySelectorAll(sel)];
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  /** Appelle fn au plus une fois par image, quel que soit le nombre d'événements reçus. */
  const perFrame = fn => { let queued = false; return () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(); }); }; };
  if (calm) root.classList.add('calm');

  // ---------- Maquettes de l'app : dessinées à la taille réelle (1152 px), puis réduites à la largeur disponible ----------
  // zoom et non transform : la hauteur occupée suit. Le ResizeObserver rattrape aussi un écran qui sort de display:none.
  const fit = box => {
    const app = box.firstElementChild, w = box.clientWidth;
    if (app && w) app.style.zoom = String(Math.min(1, w / (Number(box.dataset.fit) || 1152)));
  };
  for (const box of $$('[data-fit]')) {
    fit(box);
    if ('ResizeObserver' in window) new ResizeObserver(() => fit(box)).observe(box);
    else addEventListener('resize', () => fit(box));
  }

  // ---------- Barre fixe : givrée dès qu'on quitte le haut de page ; le lien de la section à l'écran s'allume ----------
  const bar = $('[data-nav]');
  if (bar) {
    const onScroll = perFrame(() => bar.classList.toggle('scrolled', scrollY > 16));
    addEventListener('scroll', onScroll, { passive: true });
    bar.classList.toggle('scrolled', scrollY > 16);
    const links = new Map();
    for (const a of $$('a[href^="#"]:not(.brand)', bar)) {
      const target = document.getElementById(a.getAttribute('href').slice(1));
      if (target) links.set(target, a);
    }
    if (canWatch && links.size) {
      // Une bande au milieu de l'écran : la section qui la traverse est la section courante.
      const spy = new IntersectionObserver(entries => {
        for (const e of entries) {
          const a = links.get(e.target);
          if (e.isIntersecting) a.setAttribute('aria-current', 'true');
          else a.removeAttribute('aria-current');
        }
      }, { rootMargin: '-45% 0px -50% 0px' });
      for (const target of links.keys()) spy.observe(target);
    }
  }

  // ---------- Héros : l'écran de l'app, penché en arrière, se redresse à mesure qu'il monte dans la fenêtre ----------
  // Le script ne pose que --tilt, de 1 (penché) à 0 (de face) ; l'angle et l'échelle sont dans site.css.
  const hero = $('[data-unfold]');
  if (hero && !calm) {
    const lean = () => {
      const top = hero.getBoundingClientRect().top;
      hero.style.setProperty('--tilt', clamp((top - innerHeight * .16) / (innerHeight * .62), 0, 1).toFixed(3));
    };
    const onMove = perFrame(lean);
    addEventListener('scroll', onMove, { passive: true });
    addEventListener('resize', onMove);
    lean();
  }

  // ---------- Apparition au défilement ----------
  const items = $$('[data-reveal]');
  if (calm || !canWatch) items.forEach(n => n.classList.add('in'));
  else {
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    items.forEach(n => io.observe(n));
  }

  // ---------- Séquences : les [data-step] d'un [data-seq] apparaissent l'un après l'autre ----------
  // data-step = délai avant l'étape (ms) ; data-type = le texte se tape ; data-stage = étape atteinte : elle allume
  // les lignes de [data-stages] et règle la pastille [data-pill] du même [data-stage-host] ; data-loop = la séquence
  // recommence tant qu'elle est à l'écran. Sans animation : tout est affiché, rien n'est estompé.
  const STAGE_PILL = ['Au travail', 'Au travail', 'Au travail', 'À publier', 'PR ouverte'];
  const setStage = (box, n) => {
    const host = box.closest('[data-stage-host]');
    if (!host) return;
    $$('[data-stages] > li', host).forEach((li, i) => {
      li.classList.toggle('on', i < n);
      li.classList.toggle('now', i === n - 1);
    });
    const pill = $('[data-pill]', host);
    if (pill) { pill.textContent = STAGE_PILL[n]; pill.dataset.s = String(n); }
  };
  const typeIn = async (node, alive) => {
    const full = node.dataset.full ?? (node.dataset.full = node.textContent);
    node.textContent = '';
    for (const ch of full) {
      if (!alive()) break;
      node.textContent += ch;
      await wait(26);
    }
    node.textContent = full;
  };
  for (const box of $$('[data-seq]')) {
    const steps = $$('[data-step]', box);
    if (calm || !canWatch) { steps.forEach(s => s.classList.add('show')); continue; }
    let run = 0, visible = false, idle = true;
    const play = async () => {
      const me = ++run;
      const alive = () => me === run;
      idle = false;
      box.closest('[data-stage-host]')?.querySelector('[data-stages]')?.classList.add('live');
      steps.forEach(s => s.classList.remove('show'));
      setStage(box, 0);
      for (const s of steps) {
        await wait(Number(s.dataset.step) || 500);
        if (!alive()) return;
        s.classList.add('show');
        if (s.dataset.stage) setStage(box, Number(s.dataset.stage));
        if (s.hasAttribute('data-type')) await typeIn(s, alive);
        if (!alive()) return;
      }
      idle = true;
      if (!box.hasAttribute('data-loop')) return;
      await wait(6500);
      if (alive() && visible) play();
    };
    let started = false;
    new IntersectionObserver(entries => {
      visible = entries[entries.length - 1].isIntersecting;
      if (!visible) return;
      if (!started) { started = true; play(); }
      else if (idle && box.hasAttribute('data-loop')) play();
    }, { threshold: 0.35 }).observe(box);
  }

  // ---------- Éditeur vivant : un petit rendu Markdown, celui des signes de Studio ----------
  const src = $('[data-pad-src]'), hl = $('[data-pad-hl]'), out = $('[data-pad-out]'), stat = $('[data-pad-stat]');

  /** Calcule une expression arithmétique (+ − × ÷, parenthèses, décimales). Rend null si elle n'est pas valide. */
  const calc = text => {
    const t = text.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '.');
    if (!t || /[^0-9.+\-*/()]/.test(t)) return null;
    let i = 0;
    const atom = () => {
      if (t[i] === '(') { i++; const v = sum(); if (t[i] !== ')') throw new Error('parenthèse'); i++; return v; }
      if (t[i] === '-') { i++; return -atom(); }
      const m = /^\d+(\.\d+)?/.exec(t.slice(i));
      if (!m) throw new Error('nombre');
      i += m[0].length;
      return Number(m[0]);
    };
    const product = () => { let v = atom(); while (t[i] === '*' || t[i] === '/') { const op = t[i++], r = atom(); v = op === '*' ? v * r : v / r; } return v; };
    const sum = () => { let v = product(); while (t[i] === '+' || t[i] === '-') { const op = t[i++], r = product(); v = op === '+' ? v + r : v - r; } return v; };
    try { const v = sum(); return i === t.length && Number.isFinite(v) ? v : null; } catch { return null; }
  };

  const INLINE = /\[\[([^\]\n]+)\]\]|(^|\s)#([\p{L}\d_/-]+)|`=([^`\n]+)`|\[timer\s+(\d+)\s?m\]|\*\*([^*\n]+)\*\*/gu;
  const TASK = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.*)$/;
  const HEAD = /^(#{1,3}\s+)(.*)$/;
  const count = { links: 0, tags: 0 };

  // Le rendu, à droite : les signes deviennent des objets.
  const inline = (text, parent) => {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      parent.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] != null) { parent.append(el('span', 'o-link', m[1])); count.links++; }
      else if (m[3] != null) { parent.append(m[2], el('span', 'o-tag', `#${m[3]}`)); count.tags++; }
      else if (m[4] != null) {
        const v = calc(m[4]);
        const box = el('span', 'o-calc');
        box.append(el('code', '', `=${m[4]}`));
        if (v != null) box.append(el('b', '', v.toLocaleString('fr-FR', { maximumFractionDigits: 2 })));
        parent.append(box);
      }
      else if (m[5] != null) parent.append(el('span', 'o-timer', `▶ ${String(m[5]).padStart(2, '0')}:00`));
      else parent.append(el('strong', '', m[6]));
    }
    parent.append(text.slice(last));
  };
  // La source, à gauche : les mêmes signes, seulement colorés (classes .t-*). Le texte ne change pas d'un caractère,
  // sinon le calque ne tomberait plus sous la zone de saisie.
  const tint = (text, parent, cls) => {
    let last = 0;
    const put = (t, c) => { if (t) parent.append(c ? el('span', c, t) : t); };
    for (const m of text.matchAll(INLINE)) {
      put(text.slice(last, m.index), cls);
      last = m.index + m[0].length;
      if (m[1] != null) { put('[[', 't-m'); put(m[1], 't-l'); put(']]', 't-m'); }
      else if (m[3] != null) { put(m[2], cls); put(`#${m[3]}`, 't-t'); }
      else if (m[4] != null) { put('`', 't-m'); put(`=${m[4]}`, 't-c'); put('`', 't-m'); }
      else if (m[5] != null) put(m[0], 't-c');
      else { put('**', 't-m'); put(m[6], 't-h'); put('**', 't-m'); }
    }
    put(text.slice(last), cls);
  };

  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const render = () => {
    if (!src || !out) return;
    count.links = count.tags = 0;
    let todo = 0;
    out.textContent = '';
    if (hl) hl.textContent = '';
    src.value.split('\n').forEach((line, i) => {
      const task = TASK.exec(line), head = task ? null : HEAD.exec(line);
      if (hl) {
        if (i) hl.append('\n');
        if (task) { hl.append(el('span', 't-m', task[1]), el('span', task[2] === ' ' ? 't-m' : 't-ok', task[2]), el('span', 't-m', task[3])); tint(task[4], hl, task[2] === ' ' ? '' : 't-x'); }
        else if (head) hl.append(el('span', 't-m', head[1]), el('span', 't-h', head[2]));
        else tint(line, hl, '');
      }
      if (task) {
        const done = task[2] !== ' ';
        if (!done) todo++;
        const row = el('p', `o-task${done ? ' done' : ''}`);
        const box = el('button', `box${done ? ' done' : ''}`);
        box.type = 'button';
        box.dataset.line = String(i);
        box.setAttribute('aria-label', done ? 'Marquer à faire' : 'Marquer comme fait');
        const label = el('span');
        inline(task[4], label);
        row.append(box, label);
        out.append(row);
      } else if (head) out.append(el('p', 'o-h', head[2]));
      else if (!line.trim()) out.append(el('div', 'o-gap'));
      else { const p = el('p', 'o-p'); inline(line, p); out.append(p); }
    });
    if (hl) hl.append('\n');
    if (stat) stat.textContent = [
      todo ? plural(todo, 'tâche à faire', 'tâches à faire') : 'Aucune tâche à faire',
      plural(count.links, 'lien', 'liens'), plural(count.tags, 'tag', 'tags'),
    ].join(' · ');
  };

  if (src && out) {
    src.addEventListener('input', render);
    // Cocher une case dans le rendu réécrit la ligne de la note, comme dans l'app.
    out.addEventListener('click', e => {
      const box = e.target instanceof Element ? e.target.closest('[data-line]') : null;
      if (!box) return;
      const lines = src.value.split('\n');
      const i = Number(box.dataset.line);
      lines[i] = lines[i].replace(/\[( |x|X)\]/, m => (m === '[ ]' ? '[x]' : '[ ]'));
      src.value = lines.join('\n');
      render();
    });
    for (const chip of $$('[data-pad-add]')) {
      chip.addEventListener('click', () => {
        src.value = `${src.value.replace(/\s+$/, '')}\n${chip.dataset.padAdd}`;
        render();
      });
    }
    render();
  }

  // ---------- Coffre : la phrase est chiffrée ici même, avec les réglages de l'app (src/core/crypto.ts) ----------
  // PBKDF2-SHA-256 à 600 000 itérations donne la clé, AES-256-GCM chiffre avec un IV neuf à chaque frappe : c'est pour
  // cela que tout le chiffré change quand une seule lettre change. Rien ne quitte la page.
  const vault = $('[data-vault]');
  if (vault && window.crypto?.subtle) {
    const text = $('[data-vault-text]', vault), pass = $('[data-vault-pass]', vault);
    const clear = $('[data-vault-clear]', vault), cipher = $('[data-vault-cipher]', vault), vstat = $('[data-vault-stat]', vault);
    const view = $('[data-vault-view]', vault), cut = $('[data-vault-cut]', vault);
    const ITER = 600000, bytes = new TextEncoder(), salt = crypto.getRandomValues(new Uint8Array(16));
    const hex = a => Array.from(a, b => b.toString(16).padStart(2, '0')).join(' ');
    let key = null, took = 0, job = 0, size = 0, woke = false;

    const report = () => {
      vstat.textContent = '';
      const part = (strong, rest) => { const s = el('span'); s.append(el('b', '', strong), rest); return s; };
      vstat.append(
        part('PBKDF2-SHA-256', key ? ` · 600 000 itérations · clé dérivée en ${Math.round(took)} ms` : ' · 600 000 itérations · dérivation de la clé…'),
        part('AES-256-GCM', size ? ` · IV de 96 bits · ${size} octets` : ' · IV de 96 bits'),
      );
    };
    const seal = async () => {
      clear.textContent = text.value || ' ';
      if (!key) return;
      const mine = key, iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, mine, bytes.encode(text.value)));
      if (mine !== key) return;
      size = iv.length + sealed.length;
      cipher.textContent = '';
      cipher.append(el('b', '', hex(iv)), ` ${hex(sealed)}`);
      report();
    };
    const derive = async () => {
      const me = ++job;
      key = null;
      report();
      const t0 = performance.now();
      const base = await crypto.subtle.importKey('raw', bytes.encode(pass.value), 'PBKDF2', false, ['deriveKey']);
      const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      if (me !== job) return;
      key = k;
      took = performance.now() - t0;
      seal();
    };
    let later = 0;
    text.addEventListener('input', () => { seal().catch(() => {}); });
    pass.addEventListener('input', () => { clearTimeout(later); later = setTimeout(() => derive().catch(() => {}), 260); });
    const setCut = v => view.style.setProperty('--cut', `${v}%`);
    cut.addEventListener('input', () => setCut(cut.value));

    // La clé n'est dérivée qu'à l'arrivée de la section : 600 000 itérations, c'est un vrai calcul.
    // La barre balaie alors la phrase une fois, du clair vers le chiffré, puis reste où tu la poses.
    const wake = () => {
      if (woke) return;
      woke = true;
      derive().catch(() => {});
      if (calm) return;
      const from = 96, to = Number(cut.value), t0 = performance.now() + 250, span = 1500;
      const sweep = now => {
        const p = clamp((now - t0) / span, 0, 1), eased = p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
        setCut(from + (to - from) * eased);
        if (p < 1 && Number(cut.value) === to) requestAnimationFrame(sweep);
      };
      setCut(from);
      requestAnimationFrame(sweep);
    };
    if (canWatch) new IntersectionObserver((entries, io) => { if (entries.some(e => e.isIntersecting)) { io.disconnect(); wake(); } }, { threshold: .3 }).observe(vault);
    else wake();
  }

  // ---------- Commandes : un clic les copie ----------
  for (const btn of $$('[data-copy]')) {
    if (!navigator.clipboard) { btn.hidden = true; continue; }
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(btn.previousElementSibling.textContent); } catch { return; }
      btn.textContent = 'Copié';
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = label; btn.classList.remove('done'); }, 1600);
    });
  }

  root.classList.add('ready');
})();
