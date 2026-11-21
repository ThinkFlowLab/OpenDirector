#!/usr/bin/env bash
set -euo pipefail

output=${1:?Usage: bash scripts/build-website.sh OUTPUT_DIRECTORY}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

node --check "$root/website/site.mjs"
node --check "$root/website/ambient.mjs"
mkdir -p "$output"
node "$root/website/build.mjs" "$output/index.html"
cp "$root"/website/{site.css,showcase.css,ambient.mjs,site.mjs,logo.png} "$output/"
cp "$root/docs/guides/assets/dota2-short-film-canvas.jpg" "$output/canvas.jpg"
mkdir -p "$output/film"
cp "$root"/website/film/*.jpg "$output/film/"
cp "$root/website/film/office-preview.mp4" "$output/film/"
cp "$root/docs/guides/assets/dota2-short-film.mp4" "$output/film/we-can-still-win.mp4"
