// Petits graphiques de Studio, en HTML (pas de bibliothèque) : histogramme d'une série, jauge, bande d'états.
// Règles : une seule couleur par série, barres fines à bout arrondi posées sur une ligne de base discrète,
// étiquettes sélectives (total en titre, maximum), infobulle au survol, et un tableau lisible par les lecteurs d'écran.
import { esc } from '../lib/markdown.ts';

export interface Point { key: string; label: string; value: number }

export const fmt = (n: number): string => n >= 1e6 ? `${(n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M` : n >= 1e4 ? `${Math.round(n / 1e3)} k` : n >= 1e3 ? `${(n / 1e3).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k` : String(n);

/** Les `days` derniers jours (du plus ancien à aujourd'hui), au format AAAA-MM-JJ. */
export function lastDays(days: number, values: Record<string, number>): Point[] {
  const out: Point[] = [], d = new Date();
  d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - days + 1);
  for (let i = 0; i < days; i++) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ key, label: d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }), value: values[key] ?? 0 });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Histogramme d'une série : `unit` nomme ce qui est compté (« commit », « token »). */
export function bars(points: Point[], { color, unit, units = unit + 's', summary }: { color: string; unit: string; units?: string; summary: string }): string {
  const max = Math.max(1, ...points.map(p => p.value)), peak = points.reduce((a, b) => (b.value > a.value ? b : a), points[0] ?? { key: '', label: '', value: 0 });
  const word = (n: number) => `${fmt(n)} ${n > 1 ? units : unit}`;
  return `<figure class="ch" style="--c:var(--c-${color})" role="img" aria-label="${esc(summary)}">
    <div class="ch-plot">${peak.value ? `<span class="ch-max">max ${esc(fmt(peak.value))}</span>` : ''}
      ${points.map(p => `<span class="ch-col" data-tip="${esc(`${p.label} · ${word(p.value)}`)}"><i style="height:${p.value ? Math.max(3, p.value / max * 100) : 0}%"></i></span>`).join('')}</div>
    <figcaption class="ch-x"><span>${esc(points[0]?.label ?? '')}</span><span>aujourd’hui</span></figcaption>
    <table class="sr-only"><caption>${esc(summary)}</caption>${points.filter(p => p.value).map(p => `<tr><th>${esc(p.label)}</th><td>${esc(word(p.value))}</td></tr>`).join('')}</table></figure>`;
}

/** Une série d'un histogramme empilé : un dépôt, une source… */
export interface Series { label: string; color: string; points: Point[] }
/** Repères de l'axe des X : une date par semaine en remontant depuis aujourd'hui, la plus récente étant « aujourd’hui ». */
function ticks(points: Point[]): string {
  const n = points.length; if (!n) return '';
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 7) {
    const p = points[i]; if (!p) continue;
    const short = i === n - 1 ? 'aujourd’hui' : new Date(`${p.key}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    out.push(`<span style="--x:${((i + .5) / n * 100).toFixed(2)}%">${esc(short)}</span>`);
  }
  return `<figcaption class="ch-ticks">${out.reverse().join('')}</figcaption>`;
}
/**
 * Histogramme empilé : une couleur par série (ex. un dépôt par rôle), lignes de repère, une date par semaine,
 * infobulle détaillée par jour. Une seule série donne un histogramme simple.
 */
export function stacked(series: Series[], { unit, units = unit + 's', summary }: { unit: string; units?: string; summary: string }): string {
  const days = series[0]?.points ?? [];
  const totals = days.map((_, i) => series.reduce((a, s) => a + (s.points[i]?.value ?? 0), 0));
  const max = Math.max(1, ...totals), peak = Math.max(0, ...totals);
  const word = (n: number) => `${fmt(n)} ${n > 1 ? units : unit}`;
  const cols = days.map((d, i) => {
    const tot = totals[i] ?? 0;
    const detail = series.length > 1 ? series.filter(s => s.points[i]?.value).map(s => `${s.label} ${fmt(s.points[i]?.value ?? 0)}`).join(' · ') : '';
    const segs = series.map(s => { const v = s.points[i]?.value ?? 0; return v ? `<i style="--c:var(--c-${s.color});flex-grow:${v}"></i>` : ''; }).join('');
    return `<span class="ch-col${i === days.length - 1 ? ' now' : ''}" data-tip="${esc(`${d.label} · ${word(tot)}${detail ? ` (${detail})` : ''}`)}"><b style="height:${tot ? Math.max(4, tot / max * 100) : 0}%">${segs}</b></span>`;
  }).join('');
  return `<figure class="ch ch-stack" role="img" aria-label="${esc(summary)}">
    <div class="ch-plot"><span class="ch-grid" aria-hidden="true"><i></i><i></i><i></i></span>${peak ? `<span class="ch-max">${esc(fmt(peak))}</span>` : ''}${cols}</div>${ticks(days)}
    <table class="sr-only"><caption>${esc(summary)}</caption>${days.map((d, i) => totals[i] ? `<tr><th>${esc(d.label)}</th><td>${esc(word(totals[i] ?? 0))}</td></tr>` : '').join('')}</table></figure>`;
}
/** Somme des `n` derniers jours, et des `n` d'avant (pour une tendance). */
export function lastVsPrev(points: Point[], n = 7): [number, number] {
  const v = points.map(p => p.value), len = v.length;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return [sum(v.slice(len - n)), sum(v.slice(Math.max(0, len - 2 * n), len - n))];
}
/** Pastille de tendance « ↑ 40 % » sur 7 jours ; une baisse reste neutre (moins de commits n'est pas une alerte). */
export function trend(cur: number, prev: number, span = '7 j'): string {
  if (!cur && !prev) return '';
  if (!prev) return `<span class="ch-trend up" title="Rien les ${span} précédents">nouveau · ${span}</span>`;
  const pct = Math.round((cur - prev) / prev * 100);
  if (pct === 0) return `<span class="ch-trend" title="Par rapport aux ${span} précédents">= · ${span}</span>`;
  return `<span class="ch-trend ${pct > 0 ? 'up' : 'down'}" title="Par rapport aux ${span} précédents">${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)} % · ${span}</span>`;
}
/** Barre segmentée (répartition) et sa légende. */
export function segments(parts: { label: string; value: number; color: string }[]): string {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return `<div class="ch-segs" role="img" aria-label="${esc(parts.map(p => `${p.label} ${p.value}`).join(', '))}">${parts.filter(p => p.value).map(p => `<i style="--c:var(--c-${p.color});flex-grow:${p.value}" data-tip="${esc(`${p.label} · ${p.value} (${Math.round(p.value / total * 100)} %)`)}"></i>`).join('')}</div>
    <ul class="ch-legend">${parts.map(p => `<li style="--c:var(--c-${p.color})"><i></i>${esc(p.label)}<b>${p.value}</b></li>`).join('')}</ul>`;
}

/** Jauge d'avancement (une seule couleur) : `done` sur `total`. */
export function meter(done: number, total: number, color = 'green'): string {
  const pct = total ? Math.round(done / total * 100) : 0;
  return `<div class="ch-meter" style="--c:var(--c-${color})" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Avancement ${pct} %"><i style="width:${pct}%"></i></div>`;
}

export interface Run { at: string; state: 'success' | 'failure' | 'pending'; label: string; url?: string }
const STATE: Record<Run['state'], [string, string]> = { success: ['green', 'réussie'], failure: ['red', 'en échec'], pending: ['amber', 'en cours'] };
/** Bande des dernières exécutions de CI, de la plus ancienne à la plus récente (couleur + libellé au survol). */
export function strip(runs: Run[]): string {
  return `<div class="ch-strip" role="list">${runs.map(r => `<a role="listitem" class="ch-run" style="--c:var(--c-${STATE[r.state][0]})" ${r.url ? `href="${esc(r.url)}" target="_blank" rel="noopener"` : ''} data-tip="${esc(`${r.label} · ${STATE[r.state][1]}`)}" aria-label="${esc(`${r.label} : ${STATE[r.state][1]}`)}"></a>`).join('')}</div>`;
}

// ---------- Infobulle partagée ----------
let tip: HTMLElement | null = null;
function show(t: HTMLElement): void {
  tip ??= Object.assign(document.createElement('div'), { className: 'ch-tip' });
  if (!tip.isConnected) document.body.append(tip);
  tip.textContent = t.dataset.tip ?? '';
  const r = t.getBoundingClientRect(), w = tip.offsetWidth;
  tip.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
  tip.style.top = `${r.top - tip.offsetHeight - 8}px`;
  tip.classList.add('on');
}
/** Active les infobulles des graphiques dans `root` (une seule fois par élément). */
let global = false;
export function bindTips(root: HTMLElement): void {
  if (!global) {
    global = true;
    // L'infobulle disparaît dès que le pointeur quitte un graphique, qu'on fait défiler ou qu'on change de vue.
    document.addEventListener('pointerover', e => { if (!(e.target as HTMLElement).closest?.('[data-tip]')) tip?.classList.remove('on'); }, true);
    addEventListener('scroll', () => tip?.classList.remove('on'), true);
    document.addEventListener('pointerdown', () => tip?.classList.remove('on'), true);
  }
  if (root.dataset.tips) return;
  root.dataset.tips = '1';
  root.addEventListener('pointerover', e => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]'); if (t && root.contains(t)) show(t); });
  root.addEventListener('pointerout', e => { if ((e.target as HTMLElement).closest('[data-tip]')) tip?.classList.remove('on'); });
}
