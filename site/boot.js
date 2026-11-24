// Chargé avant le premier affichage, pour que les états de départ des animations ne clignotent pas :
// « js » dit que le script tourne, « calm » que rien ne doit bouger (préférence du système, ou script principal absent).
(() => {
  const root = document.documentElement;
  // Langue : l'anglais est la page de base. Un choix « fr » mémorisé par site.js renvoie vers fr.html, une seule fois
  // (fr.html n'a pas cette redirection, donc pas de boucle).
  try {
    if (root.lang === 'en' && localStorage.getItem('studio.site.lang') === 'fr') { location.replace('fr.html' + location.hash); return; }
  } catch { /* stockage indisponible : on reste en anglais */ }
  root.classList.add('js');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) root.classList.add('calm');
  // Garde-fou : si site.js n'a pas démarré au bout de quatre secondes, tout redevient visible et immobile.
  setTimeout(() => { if (!root.classList.contains('ready')) root.classList.add('calm'); }, 4000);
})();
