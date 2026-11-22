// Applique le thème avant le premier rendu pour éviter tout flash (fichier séparé : la CSP interdit les scripts inline).
try {
  const ui = JSON.parse(localStorage.getItem('carnet.ui') || '{}') as { theme?: string; backdrop?: string }, t = ui.theme || 'auto';
  document.documentElement.dataset.backdrop = ui.backdrop === 'plain' ? 'plain' : 'sky';
  document.documentElement.dataset.theme = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
} catch { /* préférences illisibles : thème par défaut */ }
