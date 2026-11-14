// Site vitrine de Studio : aucun traceur, aucune requête.
// Sans ce script, la page reste entièrement lisible : boot.js pose « js », et « calm » dès que rien ne doit bouger.
// La CSP interdit les attributs style et eval : tout passe par des classes ou par le CSSOM (c'est aussi ce que fait GSAP),
// et le calcul de l'éditeur a son propre analyseur. L'océan est dans sea.js.
// Animation : GSAP + ScrollTrigger pour les scènes liées au défilement, SplitText pour les titres, Lenis pour lisser
// le défilement à la souris. Si l'une de ces bibliothèques manque, la page se replie sur ses états finaux.
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
  const G = window.gsap, ST = window.ScrollTrigger, Split = window.SplitText;
  const motion = !calm && !!G && !!ST;
  if (!motion) root.classList.add('calm');
  else G.registerPlugin(...[ST, Split].filter(Boolean));

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

  // ---------- Défilement lissé (souris et pavé tactile seulement : au doigt, le natif est meilleur) ----------
  if (motion && window.Lenis && matchMedia('(pointer: fine)').matches) {
    const lenis = new window.Lenis({ lerp: .12, anchors: true });
    lenis.on('scroll', ST.update);
    G.ticker.add(time => lenis.raf(time * 1000));
    G.ticker.lagSmoothing(0);
  }

  // ---------- Barre fixe : givrée dès qu'on quitte le haut de page ; le lien de la section à l'écran s'allume ----------
  const bar = $('[data-nav]');
  if (bar) {
    const onScroll = () => bar.classList.toggle('scrolled', scrollY > 16);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
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

  // ---------- Ouverture : le titre monte ligne à ligne, puis la plaque de l'app se redresse au défilement ----------
  if (motion) {
    G.timeline({ defaults: { ease: 'expo.out' } })
      .to('.hero .ln > span', { y: 0, duration: 1.4, stagger: .1 }, .1)
      .to('.hero .lead, .hero .acts, .facts > div', { opacity: 1, y: 0, duration: 1.1, stagger: .07 }, .5)
      .to('.shot-hero', { opacity: 1, duration: 1.2, ease: 'power2.out' }, .7);

    // Couchée sur l'eau quand la page s'ouvre, la plaque se lève face à toi à mesure qu'elle monte dans l'écran.
    const fig = $('[data-unfold]'), plate = fig && $('.studio-fit', fig);
    if (plate) {
      G.fromTo(plate, { rotationX: 58, scale: .8, transformOrigin: '50% 0%' }, {
        rotationX: 0, scale: 1, ease: 'power1.out',
        scrollTrigger: { trigger: fig, start: 0, end: () => `+=${Math.max(320, fig.getBoundingClientRect().top + scrollY - innerHeight * .14)}`, scrub: .5, invalidateOnRefresh: true },
      });
    }
    // Les autres plaques arrivent penchées en arrière et se posent en entrant dans l'écran.
    for (const shot of $$('.sec .shot')) {
      const sheet = $('.studio-fit', shot);
      G.fromTo(sheet, { rotationX: 16, scale: .94, transformOrigin: '50% 100%' }, {
        rotationX: 0, scale: 1, ease: 'power1.out',
        scrollTrigger: { trigger: shot, start: 'top bottom', end: 'top 45%', scrub: .5 },
      });
    }
    // La fin referme la page comme elle s'est ouverte.
    const endLines = $$('.end .ln > span');
    if (endLines.length) G.to(endLines, { y: 0, duration: 1.4, stagger: .1, ease: 'expo.out', scrollTrigger: { trigger: '.end h2', start: 'top 86%', once: true } });
  }

  // ---------- Titres de section : chaque ligne monte derrière son masque ----------
  if (motion && Split) {
    (document.fonts?.ready ?? Promise.resolve()).then(() => {
      for (const h of $$('.sec h2')) {
        h.classList.add('split');
        Split.create(h, {
          type: 'lines', mask: 'lines', linesClass: 'sl', autoSplit: true,
          onSplit: self => {
            h.classList.add('ready');
            return G.from(self.lines, { yPercent: 115, duration: 1.2, stagger: .09, ease: 'expo.out', scrollTrigger: { trigger: h, start: 'top 90%', once: true } });
          },
        });
      }
    });
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

  // ---------- Le curseur de lecture descend le long de la marge ----------
  const thumb = $('[data-thumb]');
  if (motion && thumb) {
    ST.create({
      trigger: 'main', start: 'top 55%', endTrigger: '.end', end: 'top 75%',
      onToggle: self => thumb.classList.toggle('on', self.isActive),
      onUpdate: self => G.set(thumb, { y: self.progress * (innerHeight - 64 - 22 - 24) + 12 }),
    });
  }

  // ---------- Déléguer : le dépôt, sa copie isolée et la pull request, trois plaques dans l'espace ----------
  // Sur un grand écran, le bloc s'épingle et le défilement déroule l'histoire ; ailleurs, elle se joue une fois, seule.
  const wt = $('[data-wt]');
  if (wt && motion) {
    const flow = $('[data-stages]', wt), steps = $$('[data-stages] > li', wt);
    const world = $('[data-wt-world]', wt), tilt = world.parentElement;
    const main = $('[data-wt-main]', wt), copy = $('[data-wt-copy]', wt), pr = $('[data-wt-pr]', wt), ask = $('[data-wt-ask]', wt);
    const born = $$('.f-add', copy), marks = $$('.wt-tree s', copy), touched = $$('.f-add, .f-mod', copy);
    const pill = name => $(`.p-${name}`, copy), tests = $('[data-wt-tests]', copy), scan = $('.wt-scan', copy), intact = $('footer span:last-child', main);
    const mark = n => steps.forEach((li, i) => { li.classList.toggle('on', i < n); li.classList.toggle('now', i === n - 1); });
    flow.classList.add('live');

    // Deux dispositions : en éventail vers la droite sur un grand écran, en pile vers le bas sur un téléphone.
    // Les mêmes valeurs sont l'état final de site.css (.wt-main, .wt-copy, .wt-pr), celui qu'on voit sans script.
    const WIDE = { rx: -10, ry: 27, main: [-150, -76, -190], copy: [10, -24, 60], pr: [150, 92, 230], ask: [-262, -200, 150], from: -30 };
    const TALL = { rx: -7, ry: 12, main: [-4, -150, -170], copy: [0, -8, 0], pr: [24, 150, 110], ask: [-40, -292, 110], from: -60 };
    const at = ([x, y, z]) => ({ x, y, z });

    const story = (trigger, L) => {
      const tl = G.timeline({ defaults: { ease: 'power2.inOut', duration: 1 }, scrollTrigger: trigger, onUpdate: () => mark(Math.min(4, 1 + Math.floor(tl.time()))) });
      G.set(world, { rotationX: L.rx * .3, rotationY: L.ry * .33 });
      G.set(main, { x: 0, y: L.from, z: 0, opacity: 1 });
      G.set(copy, { x: 0, y: L.from, z: 0, autoAlpha: 0 });
      G.set(pr, { ...at(L.copy), z: L.copy[2] + 10, autoAlpha: 0 });
      G.set(ask, { ...at(L.ask), y: L.ask[1] + 30, autoAlpha: 0 });
      G.set(born, { height: 0, autoAlpha: 0 });
      G.set([marks, tests, pill('ready'), pill('pr'), scan], { autoAlpha: 0 });
      G.set(pill('work'), { autoAlpha: 1 });
      G.set(touched, { color: '#969aa2' });
      mark(1);
      // 1 · Consigne
      tl.to(ask, { autoAlpha: 1, y: L.ask[1], duration: .45, ease: 'power2.out' }, .08)
        // 2 · Copie isolée : elle se détache du dossier, qui recule ; la consigne entre dedans, les fichiers s'écrivent
        .to(world, { rotationX: L.rx, rotationY: L.ry }, 1)
        .to(main, at(L.main), 1)
        .to(copy, { autoAlpha: 1, duration: .2 }, 1)
        .to(copy, at(L.copy), 1)
        .to(ask, { x: L.copy[0] - 50, y: L.copy[1] - 46, z: L.copy[2] + 10, autoAlpha: 0, duration: .7 }, 1.15)
        .to(born, { height: 26, autoAlpha: 1, duration: .25 }, 1.6)
        .to(touched, { color: '#f1f2f4', duration: .15, stagger: .1 }, 1.7)
        .to(marks, { autoAlpha: 1, duration: .15, stagger: .1 }, 1.7)
        // 3 · Revue : un trait relit la copie, les tests passent, elle devient « à publier »
        .fromTo(scan, { top: 40, autoAlpha: 0 }, { top: 170, autoAlpha: 1, duration: .5, ease: 'none' }, 2.05)
        .to(scan, { autoAlpha: 0, duration: .12 }, 2.5)
        .to(tests, { autoAlpha: 1, duration: .2 }, 2.5)
        .to(pill('work'), { autoAlpha: 0, duration: .15 }, 2.55)
        .to(pill('ready'), { autoAlpha: 1, duration: .15 }, 2.6)
        // 4 · Pull request : elle sort de la copie, vers toi ; le dossier, lui, n'a pas bougé
        .to(pr, { autoAlpha: 1, duration: .2 }, 3)
        .to(pr, at(L.pr), 3)
        .to(main, { opacity: .72 }, 3)
        .to(pill('ready'), { autoAlpha: 0, duration: .15 }, 3.5)
        .to(pill('pr'), { autoAlpha: 1, duration: .15 }, 3.55)
        .to(intact, { color: '#4cb782', duration: .2 }, 3.6)
        .to({}, { duration: .45 });
      return tl;
    };

    const mm = G.matchMedia();
    mm.add('(min-width: 1041px) and (min-height: 620px)', () => {
      wt.classList.add('pin');
      story({ trigger: wt, start: 'top top', end: '+=240%', pin: true, scrub: .6, anticipatePin: 1 }, WIDE);
      // La scène tourne un peu sous le pointeur : c'est là que la profondeur se voit.
      const rx = G.quickTo(tilt, 'rotationX', { duration: .9, ease: 'power3.out' }), ry = G.quickTo(tilt, 'rotationY', { duration: .9, ease: 'power3.out' });
      const onMove = e => { ry((e.clientX / innerWidth - .5) * 9); rx((.5 - e.clientY / innerHeight) * 6); };
      addEventListener('pointermove', onMove, { passive: true });
      // Sur un écran bas, la scène rapetisse pour tenir entre le texte et le bas de l'écran.
      const room = () => G.set(tilt, { scale: Math.min(1, Math.max(.6, $('.wt', wt).clientHeight / 470)) });
      room();
      ST.addEventListener('refresh', room);
      return () => { wt.classList.remove('pin'); removeEventListener('pointermove', onMove); ST.removeEventListener('refresh', room); G.set(tilt, { clearProps: 'transform' }); };
    });
    // Ailleurs, l'histoire se joue une fois, seule, quand la scène arrive à l'écran.
    const solo = L => () => { story({ trigger: $('.wt', wt), start: 'top 70%', once: true }, L).timeScale(.5); };
    mm.add('(min-width: 681px) and (max-width: 1040px), (min-width: 1041px) and (max-height: 619px)', solo(WIDE));
    mm.add('(max-width: 680px)', solo(TALL));
  }

  // ---------- Séquences : les [data-step] d'un [data-seq] apparaissent l'un après l'autre ----------
  // data-step = délai avant l'étape (ms) ; data-type = le texte se tape ; data-stage = étape (elle règle la pastille
  // [data-pill] du même [data-stage-host]) ; data-loop = la séquence recommence tant qu'elle est à l'écran.
  const STAGE_PILL = ['Au travail', 'Au travail', 'Au travail', 'À publier', 'PR ouverte'];
  const setStage = (box, n) => {
    const pill = box.closest('[data-stage-host]')?.querySelector('[data-pill]');
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
        el('span', '', 'Calculé dans cette page. Rien n’est envoyé.'),
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
    const wake = () => {
      if (woke) return;
      woke = true;
      derive().catch(() => {});
      if (!motion) return;
      const sweep = { v: 96 };
      G.to(sweep, { v: Number(cut.value), duration: 1.8, ease: 'expo.inOut', delay: .25, onUpdate: () => setCut(sweep.v) });
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

  // Les positions des scènes dépendent des hauteurs : on les recalcule quand la police et la page sont là.
  if (motion) {
    document.fonts?.ready.then(() => ST.refresh());
    addEventListener('load', () => ST.refresh());
  }
  root.classList.add('ready');
})();
