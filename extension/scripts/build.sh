#!/usr/bin/env bash
# Builds an installable extension directory in build/.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf build
tsc
cp metadata.json stylesheet.css build/
mkdir -p build/schemas
cp schemas/*.gschema.xml build/schemas/
glib-compile-schemas --strict build/schemas
