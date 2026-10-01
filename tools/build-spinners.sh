#!/usr/bin/env bash
#
# Rebuild the bundled styles.
#
#   bash tools/build-spinners.sh              # every style
#   bash tools/build-spinners.sh fold spiral  # just these
#
# Two stages per style, both from this repository and nothing else:
#
#   tools/make-placeholder.py   draws raw grayscale frames for one shape
#   tools/apng-palette.py build quantises them into a palette APNG
#
# The file name is the style's identity: tools/embed-asset.mjs derives the id
# from everything before the `-160x160` part, and that id is what the picker
# shows, what localStorage stores and what `--fallback=` takes. Renaming a file
# here renames the style everywhere, so name them for the shape, not for
# anything else.
#
# `--levels 4` is four alpha levels, i.e. 2 bits per pixel. Measured at the
# delivered icon size, 4 / 16 / 256 levels are indistinguishable, so the smallest
# wins. At the full 160px the steps do become visible, and they read as a
# deliberately faceted edge rather than as damage -- which is why the cheap
# encoding is defensible here. A style with soft gradients would need 16.
#
# Gain is 1 because make-placeholder.py already emits the alpha it wants. Gain is
# only interesting when alpha has to be *manufactured* out of a video's luma,
# which is what tools/build-asset.sh does.
#
# Deterministic: same python, same output, byte for byte. That is the whole point
# of shipping a generator rather than only the PNGs -- the bundled styles are a
# claim about provenance, and a claim like that has to be checkable.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
PYTHON=${PYTHON:-python}

SIZE=160
FPS=15
FRAMES=60
LEVELS=4
# Keep in step with BIT_DEPTH_FOR_LEVELS in apng-palette.py; it is part of the
# file name, so it has to be right or the name lies.
case "$LEVELS" in
  4) BITS=2 ;;
  16) BITS=4 ;;
  256) BITS=8 ;;
  *) echo "LEVELS=$LEVELS has no bit depth" >&2; exit 2 ;;
esac

# comet-ring first: it is the one a fresh install shows, and the order here is
# the order the picker uses when the whole set is rebuilt.
DEFAULT_SHAPES="comet-ring rounding cutout fold cross dots spiral"
SHAPES=${*:-$DEFAULT_SHAPES}

# A repo-relative temp file, not `mktemp -t`: on Windows that yields a path like
# `C:\Users\...\Temp/foo.raw`, whose mixed separators a delete guard rejects, and
# the EXIT trap then turns a successful build into exit 1.
RAW=$(mktemp -p "$ROOT" .frames-XXXXXX.raw)
trap 'rm -f "$RAW"' EXIT

for SHAPE in $SHAPES; do
  OUT="asset/${SHAPE}-${SIZE}x${SIZE}-${FPS}fps-${BITS}bpp.png"
  echo "=== $SHAPE -> $OUT"
  "$PYTHON" "$HERE/make-placeholder.py" \
    --shape "$SHAPE" --out "$RAW" --w "$SIZE" --h "$SIZE" --frames "$FRAMES"
  "$PYTHON" "$HERE/apng-palette.py" build \
    --raw "$RAW" --w "$SIZE" --h "$SIZE" --fps "$FPS" \
    --floor 0 --gain 1 --levels "$LEVELS" --out "$ROOT/$OUT"
  echo
done

echo "next: node tools/embed-asset.mjs"
