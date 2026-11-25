// Pont simulé pour scripts/shot.ts --pont : une expression JavaScript unique, (msg) => réponse.
// Elle s'exécute dans la page (pas d'import, pas de Node). Jeu de données fictif : projet « Atelier Lumière »,
// quelques sessions Claude Code dont une en cours avec trois sous-agents (un fini, deux au travail), un tableau
// d'équipe et des échanges. Valable pour n'importe quel `msg.project`. Les dates sont relatives à Date.now().
// Rendre undefined = demande non simulée (listée en fin de course par shot.ts).
(msg) => {
  const now = Date.now();
  const at = (sec) => new Date(now - sec * 1000).toISOString();
  const pid = msg.project || '';
  const home = '/Users/demo/projets/atelier-lumiere';
  const WT = 'panier-express';
  const S_LIVE = 'f3a1c8e2-5b7d-4e90-a1c4-2d6e9b0a7f11', S_2 = '0c5d9e41-77aa-4b1e-9f02-6a3b1d8c2e55', S_3 = '9e2b7a60-31cd-4f58-b6a9-c04d5e7f1a23', S_4 = '4b8f1d3c-92e6-4a07-8d15-e7c2a9b60f48';
  const SUB_A = 'a7f21c9d04b3e8561', SUB_B = 'ab34e90f17c2d5d68', SUB_C = 'a1c5d7e2b9f04a3c7';
  const day = (back) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - back); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const wk = (back) => { const w = new Date(Date.now() - back * 864e5).getDay(); return w === 0 || w === 6; };

  // ---------- Conversations ----------
  const sess = (id, o) => ({ branch: '', worktree: '', models: ['claude-opus-4-7'], tools: {}, files: [], lines: { add: 0, del: 0 }, tokens: { input: 1200, output: 9000, cacheRead: 400000, cacheWrite: 30000 }, aiTitle: '', ...o, id });
  const sessions = [
    sess(S_LIVE, { title: 'Panier express : codes promo et totaux', firstPrompt: 'Ajoute les codes promo au panier express et recalcule les totaux côté API.', lastPrompt: 'Ajoute les codes promo au panier express et recalcule les totaux côté API.',
      worktree: WT, branch: 'claude/panier-express', started: at(22 * 60), updated: at(4), active: at(4), live: true, prompts: 2,
      tools: { Read: 9, Grep: 5, Edit: 6, Write: 2, Bash: 4, Agent: 3 }, files: [`${home}/.claude/worktrees/${WT}/src/panier/remises.ts`, `${home}/.claude/worktrees/${WT}/src/api/coupon.ts`, `${home}/.claude/worktrees/${WT}/src/panier/total.ts`], lines: { add: 118, del: 21 },
      tokens: { input: 3400, output: 21800, cacheRead: 912000, cacheWrite: 61000 } }),
    sess(S_2, { title: 'Refonte de la page d’accueil', firstPrompt: 'Refais la section héros de la page d’accueil, plus sobre.', lastPrompt: 'Parfait, publie.',
      worktree: 'refonte-accueil', branch: 'claude/refonte-accueil', started: at(5 * 3600 + 1800), updated: at(3 * 3600), active: at(3 * 3600), live: false, prompts: 4,
      tools: { Read: 12, Edit: 9, Bash: 3 }, files: [`${home}/.claude/worktrees/refonte-accueil/src/pages/accueil.ts`], lines: { add: 64, del: 38 } }),
    sess(S_3, { title: 'Corriger le décalage de TVA sur les factures', firstPrompt: 'Les factures affichent une TVA décalée d’un centime, trouve pourquoi.', lastPrompt: 'Merci, c’est corrigé.',
      worktree: 'tva-factures', branch: 'claude/tva-factures', started: at(30 * 3600), updated: at(29 * 3600), active: at(29 * 3600), live: false, prompts: 3,
      tools: { Read: 6, Grep: 4, Edit: 3 }, files: [`${home}/.claude/worktrees/tva-factures/src/factures/tva.ts`], lines: { add: 12, del: 9 } }),
    sess(S_4, { title: 'Documentation de l’API publique', firstPrompt: 'Écris la documentation des routes publiques.', lastPrompt: 'Ajoute un exemple de pagination.',
      started: at(80 * 3600), updated: at(78 * 3600), active: at(78 * 3600), live: false, prompts: 2, branch: 'main',
      tools: { Read: 4, Write: 2 }, files: [`${home}/docs/api.md`], lines: { add: 210, del: 0 } }),
  ];
  const find = (id) => sessions.find((s) => s.id === id);

  // ---------- Sous-agents de la conversation en cours ----------
  const root = `${home}/.claude/worktrees/${WT}`;
  const subs = [
    { id: SUB_A, title: 'Cartographier le calcul des totaux', type: 'Explore', started: at(20 * 60), updated: at(14 * 60), live: false, tokens: 3100, steps: 11,
      prompt: 'Cartographie le calcul du total du panier : quelles fonctions interviennent, dans quel ordre, et où s’appliquent les remises existantes. Ne modifie rien.',
      last: { at: at(14 * 60), kind: 'text', text: 'Le total est calculé dans total.ts, les remises sont appliquées avant la TVA.' }, files: [], lines: { add: 0, del: 0 },
      report: 'Le total est assemblé dans `src/panier/total.ts` :\n\n1. `sousTotal(lignes)` additionne prix × quantité ;\n2. `appliquerRemises(sousTotal, remises)` retire les remises fixes puis en pourcentage ;\n3. `ajouterTva(montant, taux)` arrondit au centime.\n\nIl n’existe aucun point d’entrée pour un code promo : il faut ajouter une étape entre 1 et 2. Les montants sont en centimes (entiers), à conserver.' },
    { id: SUB_B, title: 'Ajouter la route POST /panier/coupon', type: 'api-dev', started: at(13 * 60), updated: at(6), live: true, tokens: 5400, steps: 14,
      prompt: 'Ajoute la route POST /panier/coupon : elle reçoit { code }, vérifie le code dans la table des coupons et renvoie la remise. Réponds 404 si le code est inconnu. Reste dans src/api/.',
      last: { at: at(6), kind: 'tool:Edit', text: `${root}/src/api/coupon.ts` },
      files: [{ path: `${root}/src/api/coupon.ts`, add: 47, del: 3 }, { path: `${root}/src/api/routes.ts`, add: 2, del: 0 }, { path: `${root}/src/panier/remises.ts`, add: 31, del: 6 }], lines: { add: 80, del: 9 } },
    { id: SUB_C, title: 'Écrire les tests des remises', type: 'test-writer', started: at(9 * 60), updated: at(12), live: true, tokens: 2600, steps: 8,
      prompt: 'Écris les tests de appliquerRemises : remise fixe, remise en pourcentage, cumul, code expiré. Utilise le même style que tests/total.test.ts.',
      last: { at: at(12), kind: 'tool:Write', text: `${root}/tests/remises.test.ts` },
      files: [{ path: `${root}/tests/remises.test.ts`, add: 58, del: 0 }], lines: { add: 58, del: 0 } },
  ];

  const couponOld = "router.post('/panier/coupon', (req, res) => {\n  res.status(501).json({ erreur: 'à faire' });\n});";
  const couponNew = "router.post('/panier/coupon', async (req, res) => {\n  const code = String(req.body.code ?? '').trim().toUpperCase();\n  const coupon = await coupons.trouver(code);\n  if (!coupon || coupon.expire < Date.now()) return res.status(404).json({ erreur: 'Code inconnu' });\n  res.json({ code, remise: coupon.remise, type: coupon.type });\n});";
  const remisesOld = 'export function appliquerRemises(sousTotal: number, remises: Remise[]): number {\n  let total = sousTotal;\n  for (const r of remises) total -= r.montant;\n  return total;\n}';
  const remisesNew = "export function appliquerRemises(sousTotal: number, remises: Remise[]): number {\n  let total = sousTotal;\n  for (const r of remises.filter((x) => x.type === 'fixe')) total -= r.montant;\n  for (const r of remises.filter((x) => x.type === 'pourcent')) total -= Math.round(total * r.montant / 100);\n  return Math.max(0, total);\n}";

  const actions = [
    { at: at(22 * 60), kind: 'prompt', text: 'Ajoute les codes promo au panier express et recalcule les totaux côté API.' },
    { at: at(22 * 60 - 8), kind: 'text', text: 'Je commence par repérer où le total est calculé, puis je répartis le travail.' },
    { at: at(21 * 60), kind: 'tool:Grep', text: 'appliquerRemises' },
    { at: at(20 * 60 + 30), kind: 'tool:Read', text: `${root}/src/panier/total.ts` },
    { at: at(20 * 60), kind: 'tool:Agent', text: 'Cartographier le calcul des totaux', to: 'Explore', body: 'Cartographie le calcul du total du panier : quelles fonctions interviennent, dans quel ordre, et où s’appliquent les remises existantes. Ne modifie rien.' },
    { at: at(14 * 60), kind: 'text', text: 'Le calcul est clair : il manque une étape pour les codes promo. Je délègue la route et les tests.' },
    { at: at(13 * 60), kind: 'tool:Agent', text: 'Ajouter la route POST /panier/coupon', to: 'api-dev', body: 'Ajoute la route POST /panier/coupon : elle reçoit { code }, vérifie le code dans la table des coupons et renvoie la remise. Réponds 404 si le code est inconnu. Reste dans src/api/.' },
    { at: at(9 * 60), kind: 'tool:Agent', text: 'Écrire les tests des remises', to: 'test-writer', body: 'Écris les tests de appliquerRemises : remise fixe, remise en pourcentage, cumul, code expiré. Utilise le même style que tests/total.test.ts.' },
    { at: at(7 * 60), kind: 'tool:Edit', text: `${root}/src/panier/remises.ts`, file: `${root}/src/panier/remises.ts`, old: remisesOld, new: remisesNew, add: 4, del: 2 },
    { at: at(5 * 60), kind: 'tool:Bash', text: 'npm test -- remises' },
    { at: at(3 * 60), kind: 'tool:Edit', text: `${root}/src/api/coupon.ts`, file: `${root}/src/api/coupon.ts`, old: couponOld, new: couponNew, add: 5, del: 3 },
    { at: at(90), kind: 'tool:Read', text: `${root}/src/api/routes.ts` },
    { at: at(40), kind: 'tool:Edit', text: `${root}/src/panier/total.ts`, file: `${root}/src/panier/total.ts`, old: '  return ajouterTva(appliquerRemises(sousTotal(lignes), []), TAUX);', new: '  return ajouterTva(appliquerRemises(sousTotal(lignes), remises), TAUX);', add: 1, del: 1 },
    { at: at(4), kind: 'tool:Edit', text: `${root}/src/api/routes.ts`, file: `${root}/src/api/routes.ts`, old: "router.use('/panier', panier);", new: "router.use('/panier', panier);\nrouter.use('/panier/coupon', coupon);", add: 1, del: 0 },
  ];

  // Fils des sous-agents (même forme que les actions d'une conversation).
  const subActions = {
    [SUB_A]: [
      { at: at(20 * 60), kind: 'prompt', text: subs[0].prompt },
      { at: at(19 * 60), kind: 'tool:Read', text: `${root}/src/panier/total.ts` },
      { at: at(18 * 60), kind: 'tool:Grep', text: 'appliquerRemises' },
      { at: at(16 * 60), kind: 'tool:Read', text: `${root}/src/panier/remises.ts` },
      { at: at(14 * 60), kind: 'text', text: subs[0].report },
    ],
    [SUB_B]: [
      { at: at(13 * 60), kind: 'prompt', text: subs[1].prompt },
      { at: at(12 * 60), kind: 'tool:Read', text: `${root}/src/api/routes.ts` },
      { at: at(10 * 60), kind: 'text', text: 'Je crée le gestionnaire du coupon puis je le branche sur le routeur.' },
      { at: at(8 * 60), kind: 'tool:Write', text: `${root}/src/api/coupon.ts`, file: `${root}/src/api/coupon.ts`, new: `import { coupons } from '../donnees/coupons';\n\nexport const coupon = Router();\n\n${couponNew}\n`, add: 8, del: 0 },
      { at: at(3 * 60), kind: 'tool:Edit', text: `${root}/src/api/coupon.ts`, file: `${root}/src/api/coupon.ts`, old: couponOld, new: couponNew, add: 5, del: 3 },
      { at: at(6), kind: 'tool:Edit', text: `${root}/src/api/coupon.ts`, file: `${root}/src/api/coupon.ts`, old: "  res.json({ code, remise: coupon.remise, type: coupon.type });", new: "  res.json({ code, remise: coupon.remise, type: coupon.type, expire: coupon.expire });", add: 1, del: 1 },
    ],
    [SUB_C]: [
      { at: at(9 * 60), kind: 'prompt', text: subs[2].prompt },
      { at: at(8 * 60), kind: 'tool:Read', text: `${root}/tests/total.test.ts` },
      { at: at(5 * 60), kind: 'tool:Write', text: `${root}/tests/remises.test.ts`, file: `${root}/tests/remises.test.ts`, new: "import { appliquerRemises } from '../src/panier/remises';\n\ntest('remise fixe', () => {\n  expect(appliquerRemises(5000, [{ type: 'fixe', montant: 500 }])).toBe(4500);\n});\n\ntest('remise en pourcentage', () => {\n  expect(appliquerRemises(5000, [{ type: 'pourcent', montant: 10 }])).toBe(4500);\n});", add: 9, del: 0 },
      { at: at(12), kind: 'tool:Bash', text: 'npm test -- remises' },
    ],
  };

  // Fils des autres conversations : un échange court.
  const quick = (s) => [
    { at: s.started, kind: 'prompt', text: s.firstPrompt },
    { at: s.updated, kind: 'text', text: `C’est fait : les changements sont dans la copie, prêts à être relus.\n\n![Panier avec le code promo](${home}/.git/studio-images/captures/demo/panier.png)\n![Panier sur iPhone](${home}/.git/studio-images/captures/demo/panier-etroit.png)` },
  ];

  // ---------- Agents lancés depuis Studio ----------
  const runs = [
    { run: 'run-3d91', project: pid, mode: 'edit', prompt: 'Ajoute les codes promo au panier express et recalcule les totaux côté API.', status: 'running', session: S_LIVE, worktree: WT,
      started: at(22 * 60), finished: '', result: '', lastText: 'Je branche la route sur le routeur.', cost: 0, turns: 7, denials: [], quota: null, machine: '', host: '', items: { tasks: 0, notes: 0 } },
    { run: 'run-2c07', project: pid, mode: 'edit', prompt: 'Refais la section héros de la page d’accueil, plus sobre.', status: 'done', session: S_2, worktree: 'refonte-accueil',
      started: at(5 * 3600 + 1800), finished: at(3 * 3600), result: 'Section héros refaite.', lastText: 'Section héros refaite, prête à publier.', cost: 0, turns: 5, denials: [], quota: null, machine: '', host: '', items: { tasks: 0, notes: 0 } },
  ];

  // ---------- Tableau d'équipe de la copie ----------
  const min = (m) => now - m * 60000;
  const hhmm = (m) => { const d = new Date(min(m)); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const messages = [
    { at: min(21), from: 'utilisateur', to: 'principal', text: 'Garde les montants en centimes, et pas de nouvelle dépendance.' },
    { at: min(19), from: 'principal', to: 'tous', text: 'Plan : un sous-agent explore le calcul, un autre écrit la route, un troisième les tests. Chacun reste dans ses fichiers.' },
    { at: min(12), from: 'agent-1-api', to: 'principal', text: 'La route /panier/coupon est branchée. Il me faut le format exact d’un coupon expiré.\n  Je pars sur un champ `expire` en millisecondes, dis-moi si c’est faux.' },
    { at: min(10), from: 'principal', to: 'agent-1-api', text: 'Oui, `expire` en millisecondes, et 404 si dépassé.' },
    { at: min(5), from: 'agent-2-tests', to: 'principal', text: 'Les tests de remise fixe et en pourcentage passent. J’attends la route pour le cas du code expiré.' },
    { at: min(1), from: 'agent-1-api', to: '', text: 'Route terminée, lancement des tests d’intégration.' },
  ];
  const fileText = (from) => messages.filter((m) => m.from === from).map((m) => `- [${hhmm((now - m.at) / 60000)}] → ${m.to || 'tous'} : ${m.text}`).join('\n');
  const board = ['principal', 'agent-1-api', 'agent-2-tests', 'utilisateur'].map((n) => ({ name: `${n}.md`, text: `# ${n}\n\n${fileText(n)}\n`, at: Math.max(...messages.filter((m) => m.from === n).map((m) => m.at)) }));

  // ---------- Copies ----------
  const worktrees = [
    { name: WT, branch: 'claude/panier-express', head: '3f9c2ab', changes: 6, ahead: 0, behind: 0, pushed: false, subject: '' },
    { name: 'refonte-accueil', branch: 'claude/refonte-accueil', head: '81d4e07', changes: 0, ahead: 2, behind: 0, pushed: true, upToDate: true, merged: false, subject: 'Section héros plus sobre' },
  ];

  // ---------- Activité ----------
  const commits = {}, tokens = {}, ses = {};
  for (let i = 0; i < 30; i++) {
    if (wk(i) && i % 3) continue;
    commits[day(i)] = ((i * 7 + 3) % 6) + (i < 7 ? 2 : 0);
    if (!wk(i)) { tokens[day(i)] = (((i * 13 + 5) % 9) + 1) * 4200; ses[day(i)] = ((i * 5) % 3) + 1; }
  }

  const type = msg.type, action = msg.action;
  const none = { containers: [], images: [] };
  if (type === 'project') {
    if (action === 'info') return { path: home, name: 'atelier-lumiere', git: true, branch: 'main', ahead: 0, behind: 0, changes: 3, remote: 'demo/atelier-lumiere', home: '~/projets', homeSet: true };
    if (action === 'sessions') return { found: true, sessions, quota: null };
    if (action === 'session') {
      const s = find(msg.session);
      if (!s) return { ok: false, message: 'Session introuvable.' };
      return { ...s, actions: s.id === S_LIVE ? actions : quick(s), subagents: s.id === S_LIVE ? subs : [] };
    }
    if (action === 'subagent') {
      const a = subs.find((x) => x.id === msg.agent);
      if (!a) return { ok: false, message: 'Sous-agent introuvable.' };
      // Comme le Mac : le résumé de la réponse est celui du fil du sous-agent lui-même, pas de la conversation.
      return { ...find(S_LIVE), title: a.title, started: a.started, updated: a.updated, live: a.live, prompts: 1, lastPrompt: a.prompt, firstPrompt: a.prompt,
        tokens: { input: 800, output: a.tokens, cacheRead: 90000, cacheWrite: 6000 }, lines: a.lines, files: a.files.map((f) => f.path), tools: { [a.type === 'Explore' ? 'Read' : 'Edit']: a.steps },
        agent: a, actions: subActions[a.id], subagents: subs };
    }
    if (action === 'repos') return { repos: [], found: [], missing: [] };
    if (action === 'mobile') {
      // Onglet Mobile : une app Expo, deux simulateurs dont un démarré, un émulateur Android éteint ; l'écran n'est pas simulé.
      if (msg.op === 'probe') return { folder: true, count: 1 };
      if (msg.op === 'screen') return { ok: false, message: 'Écran non simulé' };
      if (msg.op) return {};
      return { folder: true, tools: { xcode: true, android: true },
        apps: [{ rel: 'apps/mobile', kind: 'expo', label: 'Expo', platforms: ['ios', 'android'], commands: { ios: 'npx expo start --ios', android: 'npx expo start --android' } }],
        devices: [{ id: 'SIM-1', name: 'iPhone 17 Pro', os: 'ios', runtime: 'iOS 26.5', booted: true, tablet: false },
          { id: 'SIM-2', name: 'iPhone 17 Pro Max', os: 'ios', runtime: 'iOS 26.5', booted: false, tablet: false },
          { id: 'SIM-3', name: 'iPad Air 11 pouces (M3)', os: 'ios', runtime: 'iOS 26.5', booted: false, tablet: true },
          { id: 'avd:Pixel_9', name: 'Pixel 9', os: 'android', runtime: 'Émulateur', booted: false, tablet: false }] };
    }
    if (action === 'stack') {
      const W = (window.__stack = window.__stack || { runs: {}, t0: {} });
      const sc = (name, command, pm, risky) => ({ name, command, run: pm + ' run ' + name, risky: !!risky });
      const pk = (rel, name, role, frameworks, data, port, node, tool, scripts, uses) => ({ rel, name, kind: 'node', tool, frameworks, data, role, node, port, scripts: Object.assign({ dev: [], build: [], test: [], quality: [], data: [], other: [] }, scripts), runnable: true, uses: uses || [] });
      const f = (name, type, o) => Object.assign({ name, type, optional: false, list: false, key: false, unique: false, owns: false }, o || {});
      const repo = {
        name: 'demo/atelier-lumiere', role: 'app', path: '~/projets/atelier-lumiere', main: true, truncated: false,
        packages: [
          pk('apps/api', '@atelier/api', 'api', ['Express'], ['Prisma', 'Postgres'], 4000, '20', 'pnpm', { dev: [sc('dev', 'tsx watch src/index.ts --port 4000', 'pnpm')], build: [sc('build', 'tsc -p .', 'pnpm')], test: [sc('test', 'vitest run', 'pnpm'), sc('test:e2e', 'playwright test', 'pnpm')], quality: [sc('lint', 'eslint .', 'pnpm'), sc('typecheck', 'tsc --noEmit', 'pnpm')], data: [sc('db:migrate', 'prisma migrate dev', 'pnpm'), sc('db:seed', 'tsx prisma/seed.ts', 'pnpm'), sc('db:reset', 'prisma migrate reset --force', 'pnpm', true)] }, ['packages/shared']),
          pk('apps/web', '@atelier/web', 'site', ['Next.js', 'React'], [], 3000, '20', 'pnpm', { dev: [sc('dev', 'next dev', 'pnpm')], build: [sc('build', 'next build', 'pnpm')], test: [sc('test', 'vitest run', 'pnpm')], quality: [sc('lint', 'next lint', 'pnpm')] }, ['packages/shared']),
          pk('apps/mobile', '@atelier/mobile', 'mobile', ['Expo', 'React Native'], [], 8081, '20', 'pnpm', { dev: [sc('start', 'expo start', 'pnpm')], test: [sc('test', 'jest', 'pnpm')] }, ['packages/shared']),
          pk('packages/shared', '@atelier/shared', 'lib', [], [], 0, '20', 'pnpm', { build: [sc('build', 'tsup src/index.ts', 'pnpm')], test: [sc('test', 'vitest run', 'pnpm')] }, []),
        ],
        deploy: [{ rel: 'apps/web/vercel.json', kind: 'vercel', host: 'Vercel' }, { rel: 'apps/api/Dockerfile', kind: 'docker', host: 'Docker' }, { rel: 'apps/mobile/eas.json', kind: 'eas', host: 'Expo EAS' }],
        hosts: ['Vercel', 'Docker', 'Expo EAS'],
        workflows: [{ rel: '.github/workflows/ci.yml', name: 'CI', triggers: ['push', 'pull_request'], deploy: false }, { rel: '.github/workflows/deploy.yml', name: 'Déploiement production', triggers: ['push', 'workflow_dispatch'], deploy: true }],
        api: {
          routes: [
            { method: 'GET', path: '/health', source: 'apps/api/src/index.ts', params: false },
            { method: 'GET', path: '/products', summary: 'Liste des produits', source: 'apps/api/src/routes/products.ts', params: false },
            { method: 'POST', path: '/products', summary: 'Crée un produit', source: 'apps/api/src/routes/products.ts', params: false },
            { method: 'GET', path: '/products/:id', summary: 'Détail d’un produit', source: 'apps/api/src/routes/products.ts', params: true },
            { method: 'PATCH', path: '/products/:id', source: 'apps/api/src/routes/products.ts', params: true },
            { method: 'DELETE', path: '/products/:id', source: 'apps/api/src/routes/products.ts', params: true },
            { method: 'GET', path: '/orders', summary: 'Commandes du compte', source: 'apps/api/src/routes/orders.ts', params: false },
            { method: 'POST', path: '/orders', summary: 'Passe une commande', source: 'apps/api/src/routes/orders.ts', params: false },
            { method: 'GET', path: '/orders/:id', source: 'apps/api/src/routes/orders.ts', params: true },
            { method: 'POST', path: '/auth/login', source: 'apps/api/src/routes/auth.ts', params: false },
            { method: 'GET', path: '/api/revalidate', source: 'apps/web/app/api/revalidate/route.ts', params: false },
          ],
          specs: [{ rel: 'apps/api/openapi.yaml', title: 'Atelier Lumière API', version: '1.2.0', servers: ['http://localhost:4000'], count: 9 }],
          files: [{ rel: 'apps/api/requests.http', kind: 'http', count: 6 }], truncated: false,
        },
        data: {
          schemas: [{ kind: 'prisma', rel: 'apps/api/prisma/schema.prisma', provider: 'postgresql', enums: [{ name: 'OrderStatus', values: ['PENDING', 'PAID', 'SHIPPED', 'CANCELLED'] }], models: [
            { name: 'User', fields: [f('id', 'String', { key: true }), f('email', 'String', { unique: true }), f('name', 'String', { optional: true }), f('orders', 'Order', { list: true, ref: 'Order' })] },
            { name: 'Product', fields: [f('id', 'String', { key: true }), f('title', 'String'), f('price', 'Int'), f('items', 'OrderItem', { list: true, ref: 'OrderItem' })] },
            { name: 'Order', fields: [f('id', 'String', { key: true }), f('status', 'OrderStatus'), f('user', 'User', { ref: 'User', owns: true }), f('userId', 'String'), f('items', 'OrderItem', { list: true, ref: 'OrderItem' })] },
            { name: 'OrderItem', fields: [f('id', 'String', { key: true }), f('order', 'Order', { ref: 'Order', owns: true }), f('product', 'Product', { ref: 'Product', owns: true }), f('qty', 'Int')] },
          ] }],
          migrations: [{ rel: 'apps/api/prisma/migrations', tool: 'Prisma', count: 7, last: { name: '20261112_add_order_status', at: now - 9 * 86400000 }, items: ['20261112_add_order_status', '20261030_order_items', '20261015_orders', '20260921_products', '20260918_users', '20260910_init', '20260901_extensions'].map((n, i) => ({ name: n, at: now - (9 + i * 12) * 86400000 })) }],
          tools: ['Prisma', 'Postgres'], supabase: false,
          scripts: [{ rel: 'apps/api', name: 'db:migrate', command: 'prisma migrate dev', run: 'pnpm run db:migrate', risky: false }, { rel: 'apps/api', name: 'db:seed', command: 'tsx prisma/seed.ts', run: 'pnpm run db:seed', risky: false }, { rel: 'apps/api', name: 'db:reset', command: 'prisma migrate reset --force', run: 'pnpm run db:reset', risky: true }],
        },
        env: {
          files: [
            { rel: 'apps/api/.env.example', stage: 'example', count: 4, set: 0, tracked: false, ignored: false, vars: [{ key: 'DATABASE_URL', set: false, note: 'Adresse Postgres' }, { key: 'JWT_SECRET', set: false, note: 'Clé de signature des sessions' }, { key: 'STRIPE_SECRET_KEY', set: false }, { key: 'SMTP_URL', set: false }] },
            { rel: 'apps/api/.env', stage: 'dev', count: 3, set: 3, tracked: true, ignored: false, vs: 'apps/api/.env.example', missing: ['SMTP_URL'], extra: [], vars: [{ key: 'DATABASE_URL', set: true }, { key: 'JWT_SECRET', set: true }, { key: 'STRIPE_SECRET_KEY', set: true }] },
            { rel: 'apps/web/.env.local', stage: 'dev', count: 2, set: 2, tracked: false, ignored: true, vars: [{ key: 'NEXT_PUBLIC_API_URL', set: true }, { key: 'REVALIDATE_TOKEN', set: true }] },
            { rel: 'apps/api/.env.production', stage: 'prod', count: 4, set: 3, tracked: false, ignored: true, vs: 'apps/api/.env.example', missing: [], extra: [], vars: [{ key: 'DATABASE_URL', set: true }, { key: 'JWT_SECRET', set: true }, { key: 'STRIPE_SECRET_KEY', set: true }, { key: 'SMTP_URL', set: false }] },
          ],
          alerts: [], undocumented: ['SENTRY_DSN'], used: 7,
        },
        tests: { frameworks: [{ name: 'Vitest', command: 'pnpm run test', rel: 'apps/api' }, { name: 'Playwright', command: 'pnpm run test:e2e', rel: 'apps/api' }, { name: 'Vitest', command: 'pnpm run test', rel: 'apps/web' }, { name: 'Jest', command: 'pnpm run test', rel: 'apps/mobile' }, { name: 'Vitest', command: 'pnpm run test', rel: 'packages/shared' }], files: 31, byPackage: { 'apps/api': 14, 'apps/web': 9, 'apps/mobile': 5, 'packages/shared': 3 }, coverage: [{ rel: 'apps/api', source: 'apps/api/coverage/coverage-summary.json', at: now - 2 * 86400000, lines: 78.4, statements: 77.9, functions: 71.2, branches: 64.5 }] },
        compose: [{ rel: 'docker-compose.yml', services: [{ name: 'db', image: 'postgres:16', build: false, ports: ['5432:5432'], kind: 'Postgres', db: true }, { name: 'cache', image: 'redis:7', build: false, ports: ['6379:6379'], kind: 'Redis', db: true }, { name: 'mail', image: 'axllent/mailpit', build: false, ports: ['8025:8025'], kind: 'Mailpit', db: false }] }],
      };
      repo.env.alerts = [
        { level: 'danger', code: 'tracked', rel: 'apps/api/.env', text: 'apps/api/.env est suivi par Git : ses secrets sont dans l’historique du dépôt.', fix: 'git rm --cached apps/api/.env  puis ajoute-le au .gitignore, et change les secrets déjà publiés.' },
        { level: 'warn', code: 'missing', rel: 'apps/api/.env', text: 'apps/api/.env : 1 variable de l’exemple absente.', fix: 'Ajoute SMTP_URL à apps/api/.env.' },
      ];
      const key = (m) => (m.repo || 'demo/atelier-lumiere') + '|' + (m.rel || '') + '|' + m.script;
      const FAIL = '\n> @atelier/api@1.0.0 test\n> vitest run\n\n RUN  v1.6.0 /Users/demo/projets/atelier-lumiere/apps/api\n\n ✓ src/routes/products.test.ts (6)\n ✓ src/lib/prix.test.ts (4)\n ❯ src/routes/orders.test.ts (5 | 1 failed)\n   ✓ crée une commande\n   × refuse une commande vide\n     → expected 201 to be 400 // Object.is equality\n\n FAIL  src/routes/orders.test.ts > refuse une commande vide\nAssertionError: expected 201 to be 400\n ❯ src/routes/orders.test.ts:42:24\n\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 14 passed (15)\n   Duration  2.31s\n';
      const OK = '\n> @atelier/web@0.4.0 test\n> vitest run\n\n ✓ app/page.test.tsx (3)\n ✓ lib/format.test.ts (6)\n\n Test Files  2 passed (2)\n      Tests  9 passed (9)\n   Duration  1.12s\n';
      if (msg.op === 'run') {
        const k = key(msg); W.t0[k] = Date.now();
        const bad = msg.rel === 'apps/api' && msg.script === 'test';
        W.runs[k] = { repo: 'demo/atelier-lumiere', rel: msg.rel, script: msg.script, command: 'pnpm run ' + msg.script, family: /^test/.test(msg.script) ? 'test' : 'data', status: 'running', code: 0, since: Date.now(), took: 0, log: '\n> ' + msg.script + '\n> démarrage…\n', bad };
      } else if (msg.op === 'stop') { const r = W.runs[key(msg)]; if (r) { r.status = 'stopped'; r.ended = Date.now(); } }
      const runs = {};
      for (const [k, r] of Object.entries(W.runs)) {
        const el = Date.now() - W.t0[k];
        if (r.status === 'running' && el > 2500) { r.status = r.bad ? 'failed' : 'done'; r.code = r.bad ? 1 : 0; r.ended = Date.now(); r.log = r.bad ? FAIL : OK; r.summary = r.family === 'test' ? (r.bad ? { passed: 14, failed: 1, skipped: 0 } : { passed: 9, failed: 0, skipped: 0 }) : undefined; }
        const { bad, ...o } = r; runs[k] = Object.assign(o, { took: Math.round(((o.ended || Date.now()) - o.since) / 1000) });
      }
      return { ok: true, folder: true, at: now, repos: [repo], runs, alerts: repo.env.alerts.map((a) => Object.assign({ repo: repo.name }, a)) };
    }
    if (action === 'branches') return { branches: ['main'] };
    if (action === 'journal') return { stats: [] };
    return undefined;
  }
  if (type === 'agent') {
    if (action === 'list') return { runs, queued: [] };
    // Captures d'agent (salon.ts `captures`) : l'image vient de `window.__shotImage` (base64 PNG), posée par un `js=`.
    if (action === 'image') return window.__shotImage ? { ok: true, type: 'image/png', data: window.__shotImage } : { ok: false, message: 'Image introuvable.' };
    if (action === 'worktrees') return { worktrees, fetching: false };
    if (action === 'jobs') return { jobs: [] };
    if (action === 'items') return { pending: [] };
    if (action === 'board') return msg.note ? { files: board, messages } : { key: msg.worktree || WT, files: board, messages };
    if (action === 'commits') return { found: true, days: commits };
    if (action === 'daily') return { tokens, sessions: ses };
    if (action === 'run') { const r = runs.find((x) => x.run === msg.run); return r ? { ...r, actions } : { ok: false, message: 'Agent introuvable.' }; }
    if (action === 'server') return msg.op === 'list' ? { servers: [] } : msg.op === 'hosts' || msg.op === 'keys' ? { hosts: [], keys: [] } : { ok: false, message: 'Aucun serveur relié.' };
    if (action === 'stop' || action === 'unqueue' || action === 'itemsDone') return {};
    if (action === 'pushcheck') return { ok: false, message: 'Rien à vérifier.' };
    return undefined;
  }
  if (type === 'claude') {
    if (action === 'limits') return { enabled: false };
    if (action === 'status') return { installed: true, loggedIn: true, version: '2.1.0', plan: 'max' };
    if (action === 'usage') return { h5: { input: 0, output: 0 }, today: { input: 0, output: 0 }, d7: { input: 0, output: 0 }, models: [] };
    return undefined;
  }
  if (type === 'docker') return { available: false, reason: 'Docker n’est pas lancé.', ...none };
  if (type === 'update') return { available: false };
  return undefined;
}
