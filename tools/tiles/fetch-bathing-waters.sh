#!/usr/bin/env bash
# Fetches the official EU bathing water locations (EEA, Bathing Water
# Directive) into one GeoJSON file for the tile build (CLAUDE.md §6, Phase 6).
#
#   tools/tiles/fetch-bathing-waters.sh OUT.geojson
#
# Source: the EEA's public ArcGIS service. Two quirks, both handled here:
#  - it holds a duplicate of every site with countryCode "EU", all placed at
#    one point in central Europe (14.47 E, 46.27 N) — filtered out;
#  - its newest classification year is read from the field alias of
#    `qualityStatus` (2022 at the time of writing) and stored per feature, so
#    the app always shows WHICH season a class belongs to.
#
# On any failure the previous OUT file is kept; if there is none (or it holds
# no real site), a placeholder is written so the tile build still succeeds (no
# bathing spots is "nothing drawn", which §6 allows; a broken build is not).
# The placeholder is ONE point without `bwid`, not an empty collection:
# Planetiler 0.10.2 crashes on a GeoJSON file with zero features (first real
# deploy, 2026-11-23), and the schema drops features without `bwid`.
#
# Needs: curl, jq.
set -euo pipefail

OUT=$1
SERVICE=${EEA_BATHING_SERVICE:-https://water.discomap.eea.europa.eu/arcgis/rest/services/BathingWater/BathingWater_Dyna_WM/MapServer/0}
PAGE=20000
MIN_EXPECTED=1000
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

log() { printf '[bathing %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

PLACEHOLDER='{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"placeholder":"true"}}]}'

keep_previous() {
  log "WARNING: $1 — keeping the previous bathing-water file"
  # No previous file, or an earlier empty one: write the placeholder.
  if [[ ! -s "$OUT" ]] || ! jq -e '[.features[] | select(.properties.bwid != null)] | length > 0' "$OUT" >/dev/null 2>&1; then
    echo "$PLACEHOLDER" > "$OUT"
    log "no usable previous file: wrote a placeholder (no bathing sites in this build)"
  fi
  exit 0
}

year=$(curl -fsS --retry 3 -m 60 "$SERVICE?f=json" \
  | jq -r '[.fields[] | select(.name == "qualityStatus") | .alias][0] // empty') || keep_previous "metadata request failed"
[[ "$year" =~ ^[0-9]{4}$ ]] || keep_previous "unexpected classification year '$year'"

offset=0
page=0
while :; do
  url="$SERVICE/query?where=countryCode%3C%3E%27EU%27&outFields=bathingWaterIdentifier,bathingWaterName,bwWaterCategory,qualityStatus,bwProfileLink,countryCode&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=$offset&resultRecordCount=$PAGE&f=geojson"
  curl -fsS --retry 3 --retry-delay 10 -m 300 -o "$TMP/page-$page.geojson" "$url" || keep_previous "page $page failed"
  count=$(jq '.features | length' "$TMP/page-$page.geojson") || keep_previous "page $page is not GeoJSON"
  more=$(jq -r '.exceededTransferLimit // false' "$TMP/page-$page.geojson")
  log "page $page: $count sites"
  page=$((page + 1))
  offset=$((offset + PAGE))
  [[ "$more" == "true" && "$count" -gt 0 ]] || break
done

# Merge pages and keep only what the tiles need, under short property names.
jq -s --arg year "$year" '{
  type: "FeatureCollection",
  features: [ .[].features[]
    | select(.geometry != null and .properties.countryCode != "EU")
    | { type: "Feature", geometry: .geometry, properties: {
        bwid: .properties.bathingWaterIdentifier,
        name: .properties.bathingWaterName,
        category: .properties.bwWaterCategory,
        quality: .properties.qualityStatus,
        quality_year: $year,
        profile: .properties.bwProfileLink,
        country: .properties.countryCode } } ]
}' "$TMP"/page-*.geojson > "$TMP/merged.geojson" || keep_previous "merge failed"

total=$(jq '.features | length' "$TMP/merged.geojson")
[[ "$total" -ge "$MIN_EXPECTED" ]] || keep_previous "only $total sites (expected ≥ $MIN_EXPECTED)"

mv -f "$TMP/merged.geojson" "$OUT"
log "wrote $total bathing sites (classification season $year) to $OUT"
