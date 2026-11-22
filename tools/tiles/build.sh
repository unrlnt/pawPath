#!/usr/bin/env bash
# Builds pawpath-YYYYMMDD.pmtiles from one or more OSM extracts.
#
#   tools/tiles/build.sh OUT_DIR SOURCE [SOURCE ...]
#
# SOURCE is a local .osm.pbf path or an https:// URL. Sources are processed ONE
# AT A TIME — download, filter to our tags, delete the original — so peak disk
# use is the largest single extract plus the small filtered files, not the
# whole planet. Overlapping extracts (neighbouring continents) are fine:
# `osmium merge` drops the duplicate objects.
#
# Examples:
#   tools/tiles/build.sh public/tiles data/flevoland.osm.pbf
#   tools/tiles/build.sh /srv/tiles $(grep -v '^#' tools/tiles/sources-planet.txt)
#
# Needs: java 21+, osmium-tool, curl, jq. No Node: the schema and the osmium filter
# are generated from src/data/layers.ts and committed (npm run tiles:schema).
# In Docker this runs inside the `tiles` image; see docs/deployment.md.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  sed -n '2,18p' "$0"
  exit 64
fi

OUT_DIR=$1
shift
TILES_DIR=$(cd "$(dirname "$0")" && pwd)
WORK_DIR=${WORK_DIR:-"$TILES_DIR/../../.tiles-work"}
PLANETILER_VERSION=${PLANETILER_VERSION:-0.10.2}
PLANETILER_JAR=${PLANETILER_JAR:-"$WORK_DIR/planetiler-$PLANETILER_VERSION.jar"}
JAVA_XMX=${JAVA_XMX:-4g}
STAMP=$(date -u +%Y%m%d)
OUT_NAME="pawpath-$STAMP.pmtiles"

mkdir -p "$WORK_DIR/filtered" "$OUT_DIR"

log() { printf '[tiles %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

if [[ ! -s "$PLANETILER_JAR" ]]; then
  log "fetching planetiler $PLANETILER_VERSION"
  curl -fsSL -o "$PLANETILER_JAR" \
    "https://github.com/onthegomap/planetiler/releases/download/v$PLANETILER_VERSION/planetiler.jar"
fi

rm -f "$WORK_DIR"/filtered/part-*.osm.pbf
i=0
for source in "$@"; do
  i=$((i + 1))
  filtered="$WORK_DIR/filtered/part-$i.osm.pbf"
  if [[ "$source" == https://* ]]; then
    input="$WORK_DIR/download-$i.osm.pbf"
    log "downloading $source"
    curl -fsSL --show-error --retry 3 --retry-delay 30 -o "$input" "$source"
    delete_after=1
  else
    input=$source
    delete_after=0
  fi
  log "filtering $(basename "$input") ($(du -h "$input" | cut -f1))"
  # Comment lines in the expressions file are ignored by osmium.
  osmium tags-filter --overwrite -e "$TILES_DIR/osmium-filters.txt" -o "$filtered" "$input"
  log "  → $(du -h "$filtered" | cut -f1)"
  if [[ $delete_after == 1 ]]; then rm -f "$input"; fi
done

# Official EU bathing sites (EEA). Never fails the build: on error the last
# good copy is kept, or an empty collection is used.
bathing="$WORK_DIR/bathing-waters.geojson"
"$TILES_DIR/fetch-bathing-waters.sh" "$bathing"

merged="$WORK_DIR/merged.osm.pbf"
if [[ $i -eq 1 ]]; then
  mv "$WORK_DIR/filtered/part-1.osm.pbf" "$merged"
else
  log "merging $i parts"
  osmium merge --overwrite -o "$merged" "$WORK_DIR"/filtered/part-*.osm.pbf
  rm -f "$WORK_DIR"/filtered/part-*.osm.pbf
fi

log "building $OUT_NAME"
# Write next to the final name and rename once complete, so the web server
# never serves a half-written archive.
java -Xmx"$JAVA_XMX" -jar "$PLANETILER_JAR" generate-custom \
  --schema="$TILES_DIR/pawpath.schema.yml" \
  --osm_path="$merged" \
  --bathing_path="$bathing" \
  --output="$OUT_DIR/.$OUT_NAME.partial.pmtiles" \
  --tmpdir="$WORK_DIR/tmp" \
  --force
mv -f "$OUT_DIR/.$OUT_NAME.partial.pmtiles" "$OUT_DIR/$OUT_NAME"

# The app reads this to find the current file. Short-cached; the .pmtiles it
# names is immutable, so a new build never mixes with old cached tiles.
sources_json=$(for s in "$@"; do printf '"%s",' "${s##*/}"; done)
cat > "$OUT_DIR/.manifest.json.tmp" <<JSON
{
  "url": "$OUT_NAME",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sources": [${sources_json%,}]
}
JSON
mv -f "$OUT_DIR/.manifest.json.tmp" "$OUT_DIR/manifest.json"

rm -rf "$WORK_DIR/tmp" "$merged"
log "done: $OUT_DIR/$OUT_NAME ($(du -h "$OUT_DIR/$OUT_NAME" | cut -f1))"
# Keep the previous build for a week so cached manifests still resolve.
find "$OUT_DIR" -maxdepth 1 -name 'pawpath-*.pmtiles' ! -name "$OUT_NAME" -mtime +7 -delete
