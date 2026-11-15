#!/bin/sh
# Installe la dernière version publiée de Studio pour Mac :
#   curl -fsSL https://mtthoas.github.io/Studio/install.sh | sh
#
# Pourquoi une commande plutôt qu'un double-clic sur le zip : tant que l'app n'est pas notarisée par Apple,
# macOS marque tout ce qu'un navigateur télécharge (« quarantaine ») et refuse alors de l'ouvrir. Un fichier
# récupéré par curl ne porte pas cette marque. Le script vérifie que le paquet est bien une app Studio intacte
# avant de toucher à quoi que ce soit.
set -eu

URL="https://github.com/MTthoas/Studio/releases/latest/download/Studio-macOS.zip"
BUNDLE="app.carnet.notes"

fail() { echo "✗ $1" >&2; exit 1; }

# Tout est dans une fonction, appelée à la dernière ligne : un script coupé en cours de téléchargement ne fait rien.
main() {
  [ "$(uname -s)" = "Darwin" ] || fail "Studio pour Mac ne s'installe que sur macOS."

  DEST="/Applications"
  if [ ! -w "$DEST" ]; then DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
  TARGET="$DEST/Studio.app"

  if pgrep -f "$TARGET/Contents/MacOS/Studio" >/dev/null 2>&1; then
    fail "Studio est ouvert : quitte-le (⌘Q), puis relance cette commande."
  fi

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  echo "→ Téléchargement"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/Studio.zip" "$URL" || fail "Téléchargement impossible : vérifie ta connexion."

  echo "→ Vérification"
  ditto -x -k "$TMP/Studio.zip" "$TMP/new" || fail "Le paquet téléchargé est illisible : rien n'a été changé."
  APP="$TMP/new/Studio.app"
  ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)"
  [ "$ID" = "$BUNDLE" ] || fail "Le paquet téléchargé n'est pas une app Studio : rien n'a été changé."
  codesign --verify --deep --strict "$APP" 2>/dev/null || fail "Le paquet téléchargé n'est pas intact : rien n'a été changé."

  echo "→ Installation"
  if [ -d "$TARGET" ]; then mv "$TARGET" "$TMP/old"; fi
  if ! ditto "$APP" "$TARGET"; then
    rm -rf "$TARGET"
    if [ -d "$TMP/old" ]; then mv "$TMP/old" "$TARGET"; fi
    fail "Copie impossible dans $DEST : rien n'a été changé."
  fi
  # Sans effet la plupart du temps (curl ne pose pas la marque), mais certains réglages de terminal la propagent.
  xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

  echo "✓ Installé dans $TARGET"
  open "$TARGET" || true
}

main
