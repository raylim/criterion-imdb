#!/bin/bash

set -euo pipefail

REPO_DIR="/Users/rlim/repos/criterion-imdb"
EXT_DIR="$REPO_DIR/firefox-extension"
DIST_DIR="$EXT_DIR/dist"

cd "$REPO_DIR"

VERSION="$(node -p "require('./firefox-extension/manifest.json').version")"
ARTIFACT="$DIST_DIR/criterion-imdb-overlay-$VERSION.xpi"

mkdir -p "$DIST_DIR"
rm -f "$ARTIFACT"

(
  cd "$EXT_DIR"
  zip -qr "$ARTIFACT" manifest.json data src
)

echo "$ARTIFACT"
