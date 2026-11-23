#!/usr/bin/env bash
# Entrypoint of the `tiles` container: keeps the tiles fresh, forever.
#
# Builds immediately when there is no manifest yet, then rebuilds whenever the
# current build is older than REBUILD_AFTER_DAYS. Checks every CHECK_INTERVAL.
# A failed build is logged and retried at the next check; the previous tiles
# stay in service meanwhile.
#
# Environment:
#   TILE_REGIONS        either the name of a preset list tools/tiles/sources-<name>.txt
#                       (planet, nl-de, flevoland), or a comma-separated list of
#                       Geofabrik region ids, e.g. "europe/netherlands,europe/belgium".
#                       See https://download.geofabrik.de for the ids. Default: nl-de
#   OUT_DIR             shared tiles volume (default: /srv/tiles)
#   WORK_DIR            temporary space, ~50 GB for the planet (default: /work)
#   REBUILD_AFTER_DAYS  default 7
#   CHECK_INTERVAL      sleep(1) duration between checks (default: 6h)
#   RETRY_EMPTY         retry delay after a failed build while no tiles exist
#                       yet (default: 30m) — a fresh server should not wait 6 h
#   JAVA_XMX            Planetiler heap (default: 4g)
set -uo pipefail

TILES_DIR=$(cd "$(dirname "$0")" && pwd)
TILE_REGIONS=${TILE_REGIONS:-nl-de}
OUT_DIR=${OUT_DIR:-/srv/tiles}
export WORK_DIR=${WORK_DIR:-/work}
REBUILD_AFTER_DAYS=${REBUILD_AFTER_DAYS:-7}
CHECK_INTERVAL=${CHECK_INTERVAL:-6h}
RETRY_EMPTY=${RETRY_EMPTY:-30m}
log() { printf '[builder %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Resolve TILE_REGIONS to a list of extract URLs, once, at start-up.
PRESET="$TILES_DIR/sources-$TILE_REGIONS.txt"
if [[ -f "$PRESET" ]]; then
  mapfile -t SOURCES < <(grep -v '^\s*#' "$PRESET" | grep -v '^\s*$')
elif [[ "$TILE_REGIONS" =~ ^[a-z0-9/-]+(,[a-z0-9/-]+)*$ ]]; then
  SOURCES=()
  IFS=',' read -ra IDS <<< "$TILE_REGIONS"
  for id in "${IDS[@]}"; do SOURCES+=("https://download.geofabrik.de/$id-latest.osm.pbf"); done
else
  log "TILE_REGIONS='$TILE_REGIONS' is neither a preset nor a list of Geofabrik ids."
  log "presets: $(ls "$TILES_DIR"/sources-*.txt | sed 's#.*/sources-##; s#\.txt$##' | tr '\n' ' ')"
  log "or e.g.: europe/netherlands,europe/germany,europe/belgium"
  exit 64
fi

needs_build() {
  [[ ! -f "$OUT_DIR/manifest.json" ]] && return 0
  [[ -n $(find "$OUT_DIR/manifest.json" -mtime "+$((REBUILD_AFTER_DAYS - 1))") ]] && return 0
  # A different region list than the one last built → rebuild now.
  [[ "$(cat "$OUT_DIR/.regions" 2>/dev/null)" != "$TILE_REGIONS" ]] && return 0
  return 1
}

# No warnings source exists yet (docs/water-warnings.md). An empty, valid file
# saves every browser a 404 on each refresh; a real connector overwrites it.
mkdir -p "$OUT_DIR"
if [[ ! -f "$OUT_DIR/water-warnings.json" ]]; then
  printf '{"updatedAt":null,"source":null,"warnings":[]}\n' > "$OUT_DIR/.water-warnings.json.tmp"
  mv -f "$OUT_DIR/.water-warnings.json.tmp" "$OUT_DIR/water-warnings.json"
fi

log "watching $OUT_DIR (regions: $TILE_REGIONS → ${#SOURCES[@]} extract(s), rebuild after ${REBUILD_AFTER_DAYS}d)"
while true; do
  wait_for=$CHECK_INTERVAL
  if needs_build; then
    log "starting build"
    if "$TILES_DIR/build.sh" "$OUT_DIR" "${SOURCES[@]}"; then
      echo "$TILE_REGIONS" > "$OUT_DIR/.regions"
      log "build finished"
    elif [[ -f "$OUT_DIR/manifest.json" ]]; then
      log "build FAILED — keeping the previous tiles, retrying after $CHECK_INTERVAL"
    else
      wait_for=$RETRY_EMPTY
      log "build FAILED — no tiles yet, retrying after $RETRY_EMPTY"
    fi
  fi
  sleep "$wait_for"
done
