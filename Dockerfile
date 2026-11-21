# syntax=docker/dockerfile:1.7
#
# Two images from one Dockerfile (see docker-compose.yml, docs/deployment.md):
#   --target web    Caddy serving the static app and the tile volume
#   --target tiles  the weekly OSM → .pmtiles builder
# Nothing runs per request (CLAUDE.md §2.4): `web` only serves files.

# ---------------------------------------------------------------- app build
FROM node:22-bookworm-slim AS app-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Optional build-time overrides (all public — VITE_ values ship to browsers).
ARG VITE_MAP_STYLE_URL
ARG VITE_MAPTILER_KEY
ARG VITE_TILES_MANIFEST_URL
ARG VITE_PHOTON_URL
ARG VITE_ADS_ENABLED
RUN npm run build && rm -rf dist/tiles

# ---------------------------------------------------------------- web
FROM caddy:2.10-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=app-build /app/dist /srv/www
RUN mkdir -p /srv/tiles
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1

# ---------------------------------------------------------------- tiles
FROM eclipse-temurin:21-jre-noble AS tiles
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG PLANETILER_VERSION=0.10.2
RUN curl -fsSL -o /opt/planetiler.jar \
      "https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar"
ENV PLANETILER_JAR=/opt/planetiler.jar \
    PLANETILER_VERSION=${PLANETILER_VERSION} \
    OUT_DIR=/srv/tiles \
    WORK_DIR=/work
COPY tools/tiles /opt/pawpath/tools/tiles
RUN chmod +x /opt/pawpath/tools/tiles/*.sh && mkdir -p /srv/tiles /work
WORKDIR /opt/pawpath
ENTRYPOINT ["/opt/pawpath/tools/tiles/builder-loop.sh"]
