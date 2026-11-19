// Captures d'écran du build de test, pour vérifier un rendu sans ouvrir l'app (et pour qu'un agent voie ce qu'il a fait).
// Aucune dépendance : sert dist-test/ sur 127.0.0.1, lance sans fenêtre un navigateur Chromium déjà installé
// (Chrome, Brave, Edge, Chromium, Arc) et le pilote par le protocole DevTools.
//
// Usage :
//   node scripts/build.ts --test
//   node scripts/shot.ts [--light] [--size 1280x800] [--out /tmp/studio-shots] [--pont scripts/shot-pont.js] étape…
//   --pont simule l'app Mac (projet, agents, sous-agents, tableau d'équipe) : sans lui, les écrans qui en dépendent sont vides.
// Étapes, jouées dans l'ordre :
//   view=projects          change de vue (window.__studio.app.setView({ type }))
//   click=<sélecteur|texte> clique le premier élément qui correspond au sélecteur CSS, sinon dont le texte est celui-là
//   js=<code>              évalue du code dans la page (window.__studio expose les modules) ; le résultat est affiché
//   wait=<ms>              attend
//   shot=<nom>             écrit <out>/<nom>.png
// Sans étape : une capture de l'accueil (accueil.png). Les erreurs de la page sont affichées.
// STUDIO_BROWSER=/chemin/du/programme choisit le navigateur. Dans la bulle d'un agent, Chromium ne peut pas poser son
// propre bac à sable : il tourne avec --no-sandbox, sur des pages locales seulement.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const DIST = join(ROOT, 'dist-test');
const argv = process.argv.slice(2);
const flag = (name: string): string | null => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1] ?? ''; };
const out = resolve(flag('--out') ?? '/tmp/studio-shots');
const [width, height] = (flag('--size') ?? '1280x800').split('x').map(Number);
const bridgeFile = flag('--pont');
const light = argv.includes('--light');
const steps = argv.filter(a => !a.startsWith('--'));
if (!steps.length) steps.push('shot=accueil');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fail = (text: string): never => { console.error('✗ ' + text); process.exit(1); };

if (!existsSync(join(DIST, 'index.html'))) fail('dist-test/ manque : lance d’abord `node scripts/build.ts --test`.');
const browser = [process.env.STUDIO_BROWSER ?? '', ...['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Arc'].map(n => `/Applications/${n}.app/Contents/MacOS/${n}`),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && existsSync(p)) ?? fail('Aucun navigateur Chromium trouvé (Chrome, Brave, Edge…) : indique-le par STUDIO_BROWSER.');

// Serveur de dist-test, limité à la machine.
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0]);
  let file = resolve(DIST, '.' + path);
  if (file !== DIST && !file.startsWith(DIST + '/')) { res.writeHead(404).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(readFileSync(file));
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Navigateur sans fenêtre, profil à part et navigation privée : aucune session du Mac n'y est, et rien ne reste d'une capture à l'autre.
// Un profil par lancement : deux captures en même temps ne se disputent pas le même navigateur.
const profile = join(tmpdir(), `studio-shot-${process.pid}`);
mkdirSync(profile, { recursive: true }); mkdirSync(out, { recursive: true });
const portFile = join(profile, 'DevToolsActivePort');
// Le fichier d'une fois précédente reste là : on attend que le navigateur le réécrive (rien n'est supprimé).
const started = Date.now() - 1000;
const fresh = (): boolean => existsSync(portFile) && statSync(portFile).mtimeMs >= started;
const child = spawn(browser, ['--headless=new', '--incognito', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
// Quoi qu'il arrive (erreur comprise), le navigateur ne survit pas au script.
process.on('exit', () => { child.kill('SIGKILL'); });
const quit = (code: number): never => { child.kill('SIGKILL'); server.close(); process.exit(code); };
for (let t = 0; !fresh(); t += 100) { if (t > 20000) { console.error('✗ Le navigateur n’a pas démarré.'); quit(1); } await sleep(100); }
const port = readFileSync(portFile, 'utf8').split('\n')[0];
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
const ws = new WebSocket(tabs.find(t => t.type === 'page')!.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });

let seq = 0;
const waiting = new Map<number, (m: any) => void>();
ws.onmessage = e => {
  const m = JSON.parse(String(e.data));
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') console.log('  erreur de la page :', String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 300));
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('  console.error :', m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
};
const send = (method: string, params: object = {}): Promise<any> => new Promise(r => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
/** Évalue une expression dans la page (les promesses sont attendues) et rend sa valeur. */
async function evaluate(expression: string): Promise<unknown> {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) { console.log('  ✗', String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text).slice(0, 300)); return undefined; }
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: light ? 'light' : 'dark' }] });
// --pont <fichier> : app Mac simulée. Le fichier vaut une fonction (msg) => réponse, appelée dans la page pour chaque
// demande { type, action, … } du pont natif ; undefined = non simulée (listée à la fin). Voir scripts/shot-pont.js.
await send('Page.enable'); // sans quoi le script ci-dessous n'est pas injecté
if (bridgeFile) await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const answer = (${readFileSync(resolve(bridgeFile), 'utf8').trim().replace(/;$/, '')});
  const mark = () => { if (document.documentElement) document.documentElement.dataset.native = 'mac'; };
  mark(); new MutationObserver(mark).observe(document, { childList: true });
  window.__pont = { inconnus: [] };
  window.webkit = { messageHandlers: { carnet: { postMessage(msg) {
    const key = msg.type + ' ' + msg.action; let r;
    try { r = answer(msg); } catch (e) { r = { ok: false, message: String(e) }; }
    if (r === undefined) { if (msg.id && !window.__pont.inconnus.includes(key)) window.__pont.inconnus.push(key); r = { ok: false, message: 'Non simulé.' }; }
    if (msg.id) setTimeout(() => window.carnet && window.carnet.reply({ ok: true, ...r, id: msg.id }), 20);
  } } } };
})()` });
await send('Page.navigate', { url: origin + '/' });
for (let t = 0; !(await evaluate('document.readyState === "complete" && !!window.__studio')); t += 150) { if (t > 15000) { console.error('✗ La page ne s’est pas chargée (build de test ?).'); quit(1); } await sleep(150); }
await sleep(600);

const CLICK = (q: string) => `(() => { const q = ${JSON.stringify(q)}; let el = null; try { el = document.querySelector(q); } catch {}
  if (!el) { const all = [...document.querySelectorAll('button, a, [role=button], [role=tab], [role=menuitem], summary, label, [data-view], li, span, div')].filter(e => e.offsetParent !== null);
    el = all.find(e => e.textContent.trim() === q) ?? all.filter(e => e.textContent.includes(q)).sort((a, b) => a.textContent.length - b.textContent.length)[0] ?? null; }
  if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`;

for (const step of steps) {
  const cut = step.indexOf('='), kind = cut < 0 ? step : step.slice(0, cut), arg = cut < 0 ? '' : step.slice(cut + 1);
  if (kind === 'view') { await evaluate(`window.__studio.app.setView({ type: ${JSON.stringify(arg)} })`); await sleep(500); }
  else if (kind === 'click') { if (!(await evaluate(CLICK(arg)))) console.log(`  ✗ rien à cliquer pour « ${arg} »`); await sleep(500); }
  else if (kind === 'js') { const v = await evaluate(arg); if (v !== undefined) console.log('  =', JSON.stringify(v)?.slice(0, 800)); await sleep(300); }
  else if (kind === 'wait') await sleep(Number(arg) || 500);
  else if (kind === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(out, (arg || 'capture').replace(/[^\w.-]+/g, '-') + '.png');
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('✓ ' + file);
  } else console.log(`  ✗ étape inconnue : ${step}`);
}
if (bridgeFile) { const unknown = await evaluate('window.__pont ? window.__pont.inconnus : []') as string[] | undefined; if (unknown?.length) console.log('  pont, demandes non simulées :', unknown.join(', ')); }
quit(0);
