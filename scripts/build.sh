#!/usr/bin/env bash
# Packages the game for upload to a portal such as CrazyGames.
# Produces dist/war-of-dots.zip with index.html at the archive root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist"
ZIP="$OUT/war-of-dots.zip"

rm -rf "$OUT"
mkdir -p "$OUT"

cd "$ROOT/game"
zip -r -q "$ZIP" index.html style.css src

SIZE=$(du -h "$ZIP" | cut -f1)
echo "built $ZIP ($SIZE)"
echo
echo "Contents:"
unzip -l "$ZIP" | tail -n +4 | head -n -2
