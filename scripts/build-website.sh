#!/usr/bin/env bash
set -euo pipefail

output=${1:?Usage: bash scripts/build-website.sh OUTPUT_DIRECTORY}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

node --check "$root/website/site.mjs"
node --check "$root/website/ambient.mjs"
node --check "$root/website/language.mjs"
mkdir -p "$output"
node "$root/website/build.mjs" "$output"
cp "$root"/website/{site.css,showcase.css,ambient.mjs,site.mjs,language.mjs,messages.mjs,logo.png,google1f24642ba4569e92.html} "$output/"
cp "$root/docs/guides/assets/dota2-short-film-canvas.jpg" "$output/canvas.jpg"
mkdir -p "$output/film"
cp "$root"/website/film/*.jpg "$output/film/"
cp "$root/website/film/office-preview.mp4" "$output/film/"
cp "$root/docs/guides/assets/dota2-short-film.mp4" "$output/film/we-can-still-win.mp4"
