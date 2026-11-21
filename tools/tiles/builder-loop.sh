#!/usr/bin/env bash
# Entrypoint of the `tiles` container: keeps the tiles fresh, forever.
#
# Builds immediately when there is no manifest yet, then rebuilds whenever the
# current build is older than REBUILD_AFTER_DAYS. Checks every CHECK_INTERVAL.
# A failed build is logged and retried at the next check; the previous tiles
# stay in service meanwhile.
#
# Environment:
#   TILE_REGIONS        name of a tools/tiles/sources-<name>.txt list (default: planet)
#   OUT_DIR             shared tiles volume (default: /srv/tiles)
#   WORK_DIR            temporary space, ~50 GB for the planet (default: /work)
#   REBUILD_AFTER_DAYS  default 7
#   CHECK_INTERVAL      sleep(1) duration between checks (default: 6h)
#   JAVA_XMX            Planetiler heap (default: 4g)
set -uo pipefail

TILES_DIR=$(cd "$(dirname "$0")" && pwd)
TILE_REGIONS=${TILE_REGIONS:-planet}
OUT_DIR=${OUT_DIR:-/srv/tiles}
export WORK_DIR=${WORK_DIR:-/work}
REBUILD_AFTER_DAYS=${REBUILD_AFTER_DAYS:-7}
CHECK_INTERVAL=${CHECK_INTERVAL:-6h}
SOURCES_FILE="$TILES_DIR/sources-$TILE_REGIONS.txt"

log() { printf '[builder %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if [[ ! -f "$SOURCES_FILE" ]]; then
  log "no region list $SOURCES_FILE — set TILE_REGIONS to one of:"
  ls "$TILES_DIR"/sources-*.txt | sed 's#.*/sources-##; s#\.txt$##'
  exit 64
fi

needs_build() {
  [[ ! -f "$OUT_DIR/manifest.json" ]] && return 0
  [[ -n $(find "$OUT_DIR/manifest.json" -mtime "+$((REBUILD_AFTER_DAYS - 1))") ]] && return 0
  # A different region list than the one last built → rebuild now.
  [[ "$(cat "$OUT_DIR/.regions" 2>/dev/null)" != "$TILE_REGIONS" ]] && return 0
  return 1
}

log "watching $OUT_DIR (regions: $TILE_REGIONS, rebuild after ${REBUILD_AFTER_DAYS}d)"
while true; do
  if needs_build; then
    log "starting build"
    # shellcheck disable=SC2046 # one URL per word, by design
    if "$TILES_DIR/build.sh" "$OUT_DIR" $(grep -v '^\s*#' "$SOURCES_FILE"); then
      echo "$TILE_REGIONS" > "$OUT_DIR/.regions"
      log "build finished"
    else
      log "build FAILED — keeping the previous tiles, retrying after $CHECK_INTERVAL"
    fi
  fi
  sleep "$CHECK_INTERVAL"
done
