// Applique le thème avant le premier rendu pour éviter tout flash (fichier séparé : la CSP interdit les scripts inline).
try {
  const ui = JSON.parse(localStorage.getItem('carnet.ui') || '{}') as { theme?: string; backdrop?: string }, t = ui.theme || 'auto';
  document.documentElement.dataset.backdrop = ['image', 'sky', 'plain'].includes(ui.backdrop ?? '') && (ui.backdrop !== 'sky' || localStorage.getItem('studio.backdrop.v2')) ? ui.backdrop! : 'horizon';
  document.documentElement.dataset.theme = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
} catch { /* préférences illisibles : thème par défaut */ }
