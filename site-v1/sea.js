// L'océan de Studio : un plan d'eau en grain, peint par un shader WebGL dans chaque canvas [data-sea].
// La scène est une vraie vue en perspective : un horizon, une mer qui fuit vers lui, et le logo posé dessus comme
// une balise (le point pâle, la barre vermillon), dont les deux lumières se reflètent en traînées brisées par la houle.
// Réglages, tous dans ce fichier : SCENES (place de l'horizon et de la balise), les couleurs du shader, `grain`.
// Sans WebGL, ou si le shader ne compile pas, le canvas reste invisible et le dégradé CSS de .sea suffit.
(() => {
  'use strict';
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // x, y : place de la balise, en fraction de la largeur et de la hauteur du canvas (y compté depuis le haut) ;
  // size : hauteur de la barre en pixels CSS ; dim : assombrit la gauche pour laisser le texte lisible.
  const SCENES = {
    hero: { x: .76, y: .38, size: 46, dim: 1 },
    end: { x: .72, y: .46, size: 64, dim: .6 },
  };

  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FRAG = `
    #extension GL_OES_standard_derivatives : enable
    precision highp float;
    uniform vec2 r;      // taille du canvas, en pixels
    uniform float t;     // temps, en secondes
    uniform vec2 m;      // pointeur, de -1 à 1, lissé
    uniform float s;     // part du canvas déjà défilée, de 0 à 1
    uniform vec4 b;      // balise : x, y (0..1, y vers le haut), hauteur en pixels, assombrissement de la gauche

    float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vn(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3. - 2. * f);
      return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), f.x), f.y);
    }
    float fbm(vec2 p) {
      float a = .5, v = 0.;
      for (int i = 0; i < 5; i++) { v += a * vn(p); p = p * 2.03 + vec2(17.3, 9.1); a *= .5; }
      return v;
    }
    // Barre aux bouts ronds : distance signée, en pixels.
    float bar(vec2 p, vec2 hs, float rad) { vec2 d = abs(p) - hs + rad; return length(max(d, 0.)) + min(max(d.x, d.y), 0.) - rad; }

    const vec3 INK = vec3(.031, .035, .039);        // le fond de la page
    const vec3 VERMILLON = vec3(.94, .29, .137);
    const vec3 PEARL = vec3(.96, .945, .91);

    void main() {
      vec2 uv = gl_FragCoord.xy / r;
      float asp = r.x / r.y;
      // L'horizon descend un peu quand la page défile, et suit à peine le pointeur : la caméra a un corps.
      float hz = b.y - s * .1 + m.y * .006;
      float u = b.z / 18.;                             // l'unité du logo (sa barre fait 18 de haut)
      vec2 px = gl_FragCoord.xy - vec2(b.x * r.x, hz * r.y);
      float breath = .86 + .14 * sin(t * 1.15);

      vec3 col;
      float d = hz - uv.y;                             // > 0 : sous l'horizon, dans l'eau
      if (d > 0.) {
        float z = .36 / (d + .014);                    // profondeur : tout se resserre vers l'horizon
        vec2 q = vec2((uv.x - .5) * asp * z * .62 + m.x * .05 * z, z * 2.1 + s * 1.2);
        float warp = fbm(q * .6 + vec2(t * .03, -t * .05));
        float a = fbm(q + vec2(warp * 1.6, warp * .8 - t * .12));
        float c = fbm(q * 2.3 + vec2(-t * .07, t * .16) + a);
        float h = a * .7 + c * .3;
        float slope = dFdx(h) * r.x / (60. + z * 26.);

        col = mix(vec3(.012, .028, .04), vec3(.03, .14, .19), smoothstep(.28, .62, h));
        col = mix(col, vec3(.07, .3, .36), smoothstep(.5, .75, h) * .6);
        col += vec3(.5, .74, .76) * pow(smoothstep(.5, .78, h), 2.5) * .46;

        // Au loin, l'eau se confond avec la brume de l'horizon.
        float far = exp(-d * 15.);
        col = mix(col, vec3(.035, .085, .105), far * .9);
        // Vers le bas du canvas, l'eau s'éteint dans le fond de la page.
        col = mix(col, INK, smoothstep(.34, .0, uv.y) * .9);

        // Reflets : chaque lumière traîne sous elle, élargie vers nous et brisée par la pente des vagues.
        float crest = .3 + .7 * smoothstep(.36, .66, h);
        float dy = d * r.y;
        float jx = px.x + slope * (24. + dy * .9);
        float wv = 1.4 * u + dy * .045;
        float trail = exp(-jx * jx / (wv * wv)) * exp(-dy / (b.z * 5.5)) * crest;
        col += VERMILLON * trail * 1.15 * breath;
        float jx2 = px.x + 7. * u + slope * (24. + dy * .9);
        float wv2 = 2.6 * u + dy * .05;
        float dy2 = max(dy - 6.3 * u, 0.);
        float trail2 = exp(-jx2 * jx2 / (wv2 * wv2)) * exp(-dy2 / (b.z * 2.6)) * smoothstep(3. * u, 9. * u, dy) * crest;
        col += PEARL * trail2 * .34;
      } else {
        // Le ciel : la brume de l'horizon, puis le noir de la page.
        col = mix(vec3(.035, .085, .105), INK, smoothstep(0., .34, -d));
        col = mix(col, INK, smoothstep(.0, .5, -d) * .6);
      }
      // La gauche s'assombrit pour laisser le texte lisible.
      col *= mix(1. - .5 * b.w, 1., smoothstep(0., .75, uv.x));

      // Le logo, posé sur l'horizon : la barre vermillon les pieds dans l'eau, le point pâle à mi-hauteur.
      float sb = bar(px - vec2(0., 9.4 * u), vec2(1.2 * u, 9. * u), 1.2 * u);
      float sd = length(px - vec2(-7. * u, 9.4 * u)) - 2.7 * u;
      col += VERMILLON * exp(-max(sb, 0.) / (2.2 * u)) * .16 * breath;         // une lueur très courte, pas un halo

      float g = h21(gl_FragCoord.xy + floor(t * 14.) * 7.13);
      col *= .76 + .48 * g;
      col += (g - .5) * .035;
      // Le logo reçoit moins de grain que l'eau : il doit rester net.
      float lg = .93 + .14 * g;
      col = mix(col, VERMILLON * (.92 + .08 * breath) * lg, 1. - smoothstep(-.6, .6, sb));
      col = mix(col, PEARL * .93 * lg, 1. - smoothstep(-.6, .6, sd));
      gl_FragColor = vec4(col, 1.);
    }`;

  // Pointeur lissé, partagé par tous les canvas.
  const aim = { x: 0, y: 0 }, eye = { x: 0, y: 0 };
  if (!calm) addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    aim.x = e.clientX / innerWidth * 2 - 1;
    aim.y = 1 - e.clientY / innerHeight * 2;
  }, { passive: true });

  for (const cv of document.querySelectorAll('[data-sea]')) {
    const scene = SCENES[cv.dataset.sea] ?? SCENES.hero;
    let gl = null;
    try { gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }); } catch { /* pas de WebGL */ }
    if (!gl || !gl.getExtension('OES_standard_derivatives')) continue;
    const shader = (type, code) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, code);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT), fs = shader(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) continue;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) continue;
    gl.useProgram(prog);
    // Un seul triangle, plus grand que l'écran : il couvre tout le canvas.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    const U = name => gl.getUniformLocation(prog, name);
    const uSize = U('r'), uTime = U('t'), uPointer = U('m'), uScroll = U('s'), uBeacon = U('b');
    let dpr = 1;
    const size = () => {
      dpr = Math.min(devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
    };
    const draw = now => {
      size();
      const box = cv.getBoundingClientRect();
      // Sur un écran étroit, la balise se range à droite du texte et rapetisse.
      const narrow = box.width < 720;
      gl.uniform2f(uSize, cv.width, cv.height);
      gl.uniform1f(uTime, now / 1000);
      gl.uniform2f(uPointer, eye.x, eye.y);
      gl.uniform1f(uScroll, Math.min(1, Math.max(0, -box.top / Math.max(1, box.height))));
      gl.uniform4f(uBeacon, narrow ? .84 : scene.x, 1 - (narrow ? scene.y - .07 : scene.y), scene.size * (narrow ? .62 : 1) * dpr, scene.dim);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    draw(0);
    cv.classList.add('on');
    if (calm || !('IntersectionObserver' in window)) { addEventListener('resize', () => draw(0)); continue; }
    // Trente images par seconde suffisent à une houle lente ; rien n'est calculé quand l'eau est hors de l'écran.
    let seen = false, last = 0, frame = 0;
    const tick = now => {
      frame = 0;
      if (!seen) return;
      if (now - last >= 32) {
        last = now;
        eye.x += (aim.x - eye.x) * .05;
        eye.y += (aim.y - eye.y) * .05;
        draw(now);
      }
      frame = requestAnimationFrame(tick);
    };
    new IntersectionObserver(entries => {
      seen = entries[entries.length - 1].isIntersecting;
      if (seen && !frame) frame = requestAnimationFrame(tick);
    }).observe(cv);
  }
})();
