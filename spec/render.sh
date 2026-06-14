#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/build"

command -v asciidoctor >/dev/null 2>&1 || {
  echo "Error: asciidoctor is required. Install with: gem install asciidoctor"
  exit 1
}

mkdir -p "$OUTPUT_DIR"

echo "Rendering spec.adoc -> HTML"
asciidoctor \
  --attribute sectnums \
  --attribute sectlinks \
  --attribute toclevels=4 \
  --destination-dir "$OUTPUT_DIR" \
  "${SCRIPT_DIR}/spec.adoc"

echo "Output: ${OUTPUT_DIR}/spec.html"