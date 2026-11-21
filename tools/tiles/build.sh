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
#   tools/tiles/build.sh /srv/pawpath/tiles $(cat tools/tiles/sources-planet.txt)
#
# Needs: java 21+, osmium-tool, node (npx tsx), curl. Planetiler is fetched to
# $PLANETILER_JAR on first use. See docs/deployment.md.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  sed -n '2,17p' "$0"
  exit 64
fi

OUT_DIR=$1
shift
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK_DIR=${WORK_DIR:-"$REPO_ROOT/.tiles-work"}
PLANETILER_JAR=${PLANETILER_JAR:-"$WORK_DIR/planetiler.jar"}
PLANETILER_URL=${PLANETILER_URL:-https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar}
JAVA_XMX=${JAVA_XMX:-4g}
STAMP=$(date -u +%Y%m%d)
OUT_NAME="pawpath-$STAMP.pmtiles"

mkdir -p "$WORK_DIR/filtered" "$OUT_DIR"
cd "$REPO_ROOT"

log() { printf '[tiles %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# The schema and the osmium filter are both generated from src/data/layers.ts.
npx --no-install tsx tools/tiles/generateSchema.ts --check
npx --no-install tsx tools/tiles/generateSchema.ts --osmium-filters > "$WORK_DIR/filters.txt"

if [[ ! -s "$PLANETILER_JAR" ]]; then
  log "fetching planetiler"
  curl -fsSL -o "$PLANETILER_JAR" "$PLANETILER_URL"
fi

i=0
for source in "$@"; do
  i=$((i + 1))
  filtered="$WORK_DIR/filtered/part-$i.osm.pbf"
  if [[ "$source" == https://* ]]; then
    input="$WORK_DIR/download-$i.osm.pbf"
    log "downloading $source"
    curl -fSL --retry 3 -o "$input" "$source"
    delete_after=1
  else
    input=$source
    delete_after=0
  fi
  log "filtering $(basename "$input") ($(du -h "$input" | cut -f1))"
  osmium tags-filter --overwrite -e "$WORK_DIR/filters.txt" -o "$filtered" "$input"
  log "  → $(du -h "$filtered" | cut -f1)"
  if [[ $delete_after == 1 ]]; then rm -f "$input"; fi
done

merged="$WORK_DIR/merged.osm.pbf"
if [[ $i -eq 1 ]]; then
  mv "$WORK_DIR/filtered/part-1.osm.pbf" "$merged"
else
  log "merging $i parts"
  osmium merge --overwrite -o "$merged" "$WORK_DIR"/filtered/part-*.osm.pbf
  rm -f "$WORK_DIR"/filtered/part-*.osm.pbf
fi

log "building $OUT_NAME"
java -Xmx"$JAVA_XMX" -jar "$PLANETILER_JAR" generate-custom \
  --schema=tools/tiles/pawpath.schema.yml \
  --osm_path="$merged" \
  --output="$OUT_DIR/$OUT_NAME" \
  --tmpdir="$WORK_DIR/tmp" \
  --force

# The app reads this to find the current file. Short-cached; the .pmtiles it
# names is immutable, so a new build never mixes with old cached tiles.
cat > "$OUT_DIR/manifest.json" <<JSON
{
  "url": "$OUT_NAME",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sources": $(printf '%s\n' "$@" | sed 's#.*/##' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim().split("\n"))))')
}
JSON

rm -rf "$WORK_DIR/tmp" "$merged"
log "done: $OUT_DIR/$OUT_NAME ($(du -h "$OUT_DIR/$OUT_NAME" | cut -f1))"
# Keep the previous build for a week so cached manifests still resolve.
find "$OUT_DIR" -name 'pawpath-*.pmtiles' ! -name "$OUT_NAME" -mtime +7 -delete
