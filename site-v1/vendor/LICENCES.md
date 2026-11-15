# Bibliothèques embarquées

Le site ne charge rien d'un autre domaine (sa CSP l'interdit) : ces fichiers sont servis depuis ce dossier, tels que publiés sur npm, sans modification. Pour en mettre un à jour : `npm pack <paquet>@<version>`, puis recopier le fichier `dist/*.min.js`.

| Fichier | Paquet | Version | Licence |
| --- | --- | --- | --- |
| `gsap.min.js`, `ScrollTrigger.min.js`, `SplitText.min.js` | [gsap](https://gsap.com) | 3.13.0 | [Standard « no charge » de GSAP](https://gsap.com/standard-license) : usage gratuit, y compris commercial ; ce n'est pas une licence libre, et elle ne couvre que ces fichiers, pas le reste du dépôt (AGPL-3.0) |
| `lenis.min.js` | [lenis](https://github.com/darkroomengineering/lenis) | 1.3.4 | MIT |

## Lenis

The MIT License

Copyright (c) 2024 darkroom.engineering

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
