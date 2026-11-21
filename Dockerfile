# qkb as a network MCP service: Streamable HTTP on :8181, re-indexing the
# mounted vault(s) on a timer. See the README's "Running as a service".
#
#   docker run -p 8181:8181 -v ./config:/config -v qkb-data:/data \
#     -v /path/to/Notes:/vaults/Notes:ro ghcr.io/miguelarios/qkb
#
# The first start writes a starter /config/config.yaml listing the vaults
# mounted under /vaults; edit it and restart.

# Override to build from a registry mirror, e.g.
#   --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

# Compiling TypeScript gives the same output on every platform, so in a
# multi-platform build this stage runs once, on the build machine.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# node-llama-cpp's CUDA builds (~530 MB) are dropped: they also need the CUDA
# runtime libraries, which this image does not carry. `provider: llama` runs
# on the CPU here; for a GPU, embed through Ollama (see the README).
RUN npm ci --omit=dev \
 && rm -rf node_modules/@node-llama-cpp/*-cuda* \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/qkb
COPY docker/obsidian-sync.mjs ./docker/obsidian-sync.mjs

# /config holds config.yaml (seeded on first start), /data the index and
# model cache (mount a volume), /vaults/<Name> the vaults, read-only (qkb
# never writes to them). A single vault can also be mounted at /vault.
# HOME is /data so anything written under ~ lands on the volume, whatever
# user the container runs as.
ENV QKB_CONFIG=/config/config.yaml \
    QKB_DB_PATH=/data/qkb.db \
    QKB_MODEL_CACHE_DIR=/data/models \
    QKB_MCP_HOST=0.0.0.0 \
    QKB_MCP_PORT=8181 \
    HOME=/data
RUN chmod +x /usr/local/bin/qkb \
 && mkdir -p /data /config /vault /vaults \
 && chown node:node /data /config
VOLUME ["/data"]
EXPOSE 8181

LABEL org.opencontainers.image.source="https://github.com/miguelarios/qkb" \
      org.opencontainers.image.description="qkb: hybrid search for Obsidian vaults, served as a Streamable HTTP MCP server" \
      org.opencontainers.image.licenses="MIT"

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.QKB_MCP_PORT||8181)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Starts as root only to fix volume ownership, then runs qkb as PUID:PGID
# (default 1000:1000) — see docker/entrypoint.sh.
ENTRYPOINT ["qkb"]
CMD ["mcp", "--http", "--watch"]
