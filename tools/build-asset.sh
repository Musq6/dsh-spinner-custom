#!/usr/bin/env bash
#
# Rebuild an icon asset from a source video.
#
#   bash tools/build-asset.sh <video> <asset-px> <fps> <gain> <levels> <out.png>
#
# Two stages:
#
#   stage 1  ffmpeg          video -> raw grayscale frames at <asset-px>
#   stage 2  apng-palette.py those frames -> palette APNG
#
# A mask reads the alpha channel only, and video has no alpha -- so the alpha
# has to be *manufactured* out of luminance. That is what `gain` is for, and it
# is the knob that decides whether the result looks like anything:
#
#   too little  faint content fades to nothing after downscaling
#   too much    the brightest areas saturate and merge into solid shapes
#
# Gain interacts with size, because what survives a downscale falls roughly
# with the square of the scale factor. Expect to tune it per clip and per
# size; start near 1.0 and raise it until the shape reads.
#
# The crop is expressed as `crop=W:H:X:Y` further down. The default is the
# full frame. `cropdetect` is worth a try on your clip but it reports the
# bounding box of *anything* moving, so on a clip with a drifting background
# it will happily hand you the whole picture -- check it by eye.
#
# `levels` is the alpha quantisation: 4 (four levels, 2bpp), 16 (4bpp) or 256
# (8bpp). Smaller is smaller; whether you can see it depends on the content.
# Flat shapes survive 4; soft gradients do not.
#
#   bash tools/build-asset.sh clip.mp4 160 12 1.0 4 asset/mine.png
#
# Then inline it -- that step is what actually ships:
#
#   node tools/embed-asset.mjs asset/mine.png
#
# NOTE: the shipped default is generated, not converted -- see
# tools/build-spinners.sh. This script is for artwork you bring yourself.
set -euo pipefail

VIDEO=${1:?usage: build-asset.sh <video> <asset-px> <fps> <gain> <levels> <out.png>}
SIZE=${2:?missing asset size}
FPS=${3:?missing fps}
GAIN=${4:?missing gain}
LEVELS=${5:?missing levels: 4 (four alpha levels), 16, or 256}
OUT=${6:?missing output path}

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
FFMPEG=${FFMPEG:-ffmpeg}
PYTHON=${PYTHON:-python}

# Crop applied before the downscale. Full frame by default: cropping to the
# moving content is a judgement call about your clip, and a wrong guess clips
# the extremes of the animation rather than failing loudly.
CROP=${CROP:-}

# A repo-relative temp file, not `mktemp -t`: on Windows that yields a path
# like `C:\Users\...\Temp/foo.raw`, whose mixed separators a delete guard
# rejects, and the EXIT trap then turns a successful build into exit 1.
RAW=$(mktemp -p "$ROOT" .frames-XXXXXX.raw)
trap 'rm -f "$RAW"' EXIT

FILTER="fps=${FPS},format=gray"
if [ -n "$CROP" ]; then
  FILTER="${FILTER},${CROP}"
fi
FILTER="${FILTER},scale=${SIZE}:${SIZE}:flags=lanczos"

echo "stage 1: $VIDEO -> ${SIZE}x${SIZE} gray @ ${FPS}fps"
"$FFMPEG" -v error -i "$VIDEO" -vf "$FILTER" -f rawvideo -pix_fmt gray -y "$RAW"

echo "stage 2: palette APNG, levels=${LEVELS}, gain=${GAIN}"
"$PYTHON" "$HERE/apng-palette.py" build \
  --raw "$RAW" --w "$SIZE" --h "$SIZE" --fps "$FPS" \
  --floor 0 --gain "$GAIN" --levels "$LEVELS" --out "$ROOT/$OUT"

echo
echo "next: node tools/embed-asset.mjs $OUT"
