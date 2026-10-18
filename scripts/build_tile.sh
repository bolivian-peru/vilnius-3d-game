#!/bin/sh
# Rebuild one tile end to end: photomesh fetch, heights, vector layers, Blender scene, FBX export.
#   scripts/build_tile.sh [TILE]      e.g. scripts/build_tile.sh E000_N000
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TILE="${1:-E000_N000}"
BLENDER="${BLENDER:-$ROOT/tools/Blender.app/Contents/MacOS/Blender}"

cd "$ROOT/pipeline"
uv run vilnius photomesh --tile "$TILE"
uv run vilnius tiles --tile "$TILE"
"$BLENDER" -b -P "$ROOT/blender/build_tile.py" -- --tile "$TILE"
