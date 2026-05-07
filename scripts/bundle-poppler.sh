#!/bin/bash
# Compatible with macOS system bash 3.2 (no associative arrays).
#
# Bundle poppler (pdftotext + pdftoppm + their dylib chain) into build/poppler/
# so electron-builder can ship them as extraResources.
#
# Source: Homebrew's poppler install on the build machine.
# Layout:
#   build/poppler/bin/{pdftotext,pdftoppm}
#   build/poppler/lib/<every non-system dylib reachable from the binaries>
#
# All install_name_tool rewrites use @executable_path/../lib so the bundle is
# fully relocatable inside the .app's Resources folder.
#
# Usage: scripts/bundle-poppler.sh [DEST_DIR]
#   DEST_DIR defaults to build/poppler.

set -euo pipefail

DEST="${1:-build/poppler}"
SRC_PREFIX="$(brew --prefix poppler 2>/dev/null || true)"

if [ -z "$SRC_PREFIX" ] || [ ! -x "$SRC_PREFIX/bin/pdftotext" ]; then
  echo "error: poppler not found via Homebrew. Install with: brew install poppler" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/bin" "$DEST/lib"

cp "$SRC_PREFIX/bin/pdftotext" "$DEST/bin/pdftotext"
cp "$SRC_PREFIX/bin/pdftoppm"  "$DEST/bin/pdftoppm"
chmod u+w "$DEST/bin/pdftotext" "$DEST/bin/pdftoppm"

is_system_dylib() {
  case "$1" in
    /usr/lib/*|/System/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Resolve a dependency path (which may be absolute, @rpath/, @loader_path/, or
# @executable_path/) to a real file in the Homebrew install. Echoes the path or
# nothing if it can't be found.
resolve_dep_path() {
  local dep="$1"
  case "$dep" in
    @rpath/*)
      local base="${dep#@rpath/}"
      # Search common Homebrew layouts. The poppler binary's rpath is
      # /opt/homebrew/opt/poppler/lib; transitive deps live in their own
      # /opt/homebrew/opt/<formula>/lib dirs.
      for cand in "$SRC_PREFIX/lib/$base" "/opt/homebrew/lib/$base"; do
        [ -f "$cand" ] && { echo "$cand"; return; }
      done
      # Last resort: scan every Homebrew opt dir.
      local hit
      hit="$(find /opt/homebrew/opt -maxdepth 3 -name "$base" -type f 2>/dev/null | head -1)"
      [ -n "$hit" ] && { echo "$hit"; return; }
      return
      ;;
    @loader_path/*|@executable_path/*)
      # Treat like @rpath — look in standard Homebrew lib dirs.
      local base
      base="$(basename "$dep")"
      for cand in "/opt/homebrew/lib/$base"; do
        [ -f "$cand" ] && { echo "$cand"; return; }
      done
      return
      ;;
    /*)
      [ -f "$dep" ] && echo "$dep"
      return
      ;;
  esac
}

# Recursively copy every non-system dylib reachable from $1 into $DEST/lib.
# Dedup is by basename — we only ever ship one copy of any given dylib name.
collect_deps() {
  local file="$1"
  while IFS= read -r dep; do
    dep="${dep##*$'\t'}"
    dep="${dep%% (*}"
    [ -z "$dep" ] && continue
    is_system_dylib "$dep" && continue
    local base
    base="$(basename "$dep")"
    if [ -f "$DEST/lib/$base" ]; then
      continue
    fi
    local src
    src="$(resolve_dep_path "$dep")"
    if [ -z "$src" ]; then
      echo "warning: could not resolve dep '$dep' referenced by $(basename "$file")" >&2
      continue
    fi
    cp "$src" "$DEST/lib/$base"
    chmod u+w "$DEST/lib/$base"
    collect_deps "$DEST/lib/$base"
  done < <(otool -L "$file" | tail -n +2 | awk -F' ' '{print $1}')
}

collect_deps "$DEST/bin/pdftotext"
collect_deps "$DEST/bin/pdftoppm"

# Rewrite paths so the bundle is relocatable.
rewrite_paths() {
  local file="$1"
  # Set the binary's own ID (only meaningful for dylibs, no-op for executables).
  install_name_tool -id "@rpath/$(basename "$file")" "$file" 2>/dev/null || true
  # Rewrite every dependency that we copied to point inside the bundle.
  while IFS= read -r dep; do
    dep="${dep##*$'\t'}"
    dep="${dep%% (*}"
    local base
    base="$(basename "$dep")"
    if [ -f "$DEST/lib/$base" ]; then
      install_name_tool -change "$dep" "@executable_path/../lib/$base" "$file" 2>/dev/null || true
    fi
  done < <(otool -L "$file" | tail -n +2 | awk -F' ' '{print $1}')
}

for f in "$DEST/bin/pdftotext" "$DEST/bin/pdftoppm"; do
  rewrite_paths "$f"
done
for f in "$DEST/lib"/*.dylib; do
  rewrite_paths "$f"
done

# Re-sign every binary touched by install_name_tool (required on macOS arm64;
# any code-signature is invalidated by load-command edits).
codesign --force --sign - "$DEST/bin/pdftotext" "$DEST/bin/pdftoppm" "$DEST/lib"/*.dylib >/dev/null 2>&1 || true

# Smoke-test: the bundled pdftotext must exit 0 on `-v`.
if ! "$DEST/bin/pdftotext" -v >/dev/null 2>&1; then
  echo "error: bundled pdftotext failed smoke test" >&2
  exit 1
fi
if ! "$DEST/bin/pdftoppm" -v >/dev/null 2>&1; then
  echo "error: bundled pdftoppm failed smoke test" >&2
  exit 1
fi

echo "bundled poppler → $DEST ($(du -sh "$DEST" | awk '{print $1}'))"
