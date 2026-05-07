#!/usr/bin/env bash
# Generate build/icon.icns from a 1024x1024 PNG with transparency.
# Prefers ImageMagick (`magick`) which preserves alpha at any size.
# Falls back to `sips`, which loses alpha when upscaling — so source must
# be 1024x1024 (no upscaling needed).
#
# Usage: ./scripts/generate-icon.sh path/to/icon.png
set -euo pipefail

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  echo "Usage: $0 <path-to-icon.png>" >&2
  exit 1
fi
if [[ ! -f "$SRC" ]]; then
  echo "Error: $SRC not found" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/build"
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"

SIZES=(16 32 32 64 128 256 256 512 512 1024)
NAMES=(
  "icon_16x16.png"
  "icon_16x16@2x.png"
  "icon_32x32.png"
  "icon_32x32@2x.png"
  "icon_128x128.png"
  "icon_128x128@2x.png"
  "icon_256x256.png"
  "icon_256x256@2x.png"
  "icon_512x512.png"
  "icon_512x512@2x.png"
)

if command -v magick >/dev/null 2>&1; then
  echo "Using ImageMagick (alpha preserved)"
  for i in "${!SIZES[@]}"; do
    s="${SIZES[$i]}"
    n="${NAMES[$i]}"
    magick "$SRC" -resize "${s}x${s}" -alpha on "$ICONSET/$n"
  done
else
  # sips fallback. Verify source is 1024x1024 to avoid upscaling.
  W=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/ {print $2}')
  H=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/ {print $2}')
  if [[ "$W" != "1024" || "$H" != "1024" ]]; then
    echo "Error: source must be 1024x1024 PNG (got ${W}x${H})." >&2
    echo "Either resize source to 1024x1024 or install ImageMagick:" >&2
    echo "  brew install imagemagick" >&2
    exit 1
  fi
  echo "Using sips (source is 1024x1024, downscale-only)"
  for i in "${!SIZES[@]}"; do
    s="${SIZES[$i]}"
    n="${NAMES[$i]}"
    if [[ "$s" == "1024" ]]; then
      cp "$SRC" "$ICONSET/$n"
    else
      sips -s format png -z "$s" "$s" "$SRC" --out "$ICONSET/$n" > /dev/null
    fi
  done
fi

iconutil -c icns "$ICONSET" -o "$OUT_DIR/icon.icns"
rm -rf "$(dirname "$ICONSET")"

echo "Generated: $OUT_DIR/icon.icns"
