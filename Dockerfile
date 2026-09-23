# qkb as a network MCP service: Streamable HTTP on :8181, re-indexing the
# mounted vault(s) on a timer. See the README's "Running as a service".
#
#   docker build -t qkb .
#   docker run -p 8181:8181 -v /path/to/vault:/vault:ro -v qkb-data:/data \
#     -e QKB_VAULT_PATH=/vault -e QKB_EMBEDDING_PROVIDER=ollama \
#     -e QKB_EMBEDDING_MODEL=embeddinggemma -e QKB_OLLAMA_HOST=http://gpu-host:11434 qkb

# Override to build from a registry mirror, e.g.
#   --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
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
# The CUDA builds of node-llama-cpp (~530 MB) are dropped: this image is meant
# to embed through a remote Ollama. The CPU/Vulkan builds stay, so
# provider = "llama" still works (slower, CPU).
RUN npm ci --omit=dev \
 && rm -rf node_modules/@node-llama-cpp/*-cuda* \
 && npm cache clean --force
COPY --from=build /app/dist ./dist

# Index + model cache live on /data (mount a volume); the vault is mounted
# read-only (qkb never writes to it). A config file, if any, goes at
# /config/config.toml — use it for [[vaults]] or [frontmatter.fields].
ENV QKB_CONFIG=/config/config.toml \
    QKB_DB_PATH=/data/qkb.db \
    QKB_MODEL_CACHE_DIR=/data/models \
    QKB_MCP_HOST=0.0.0.0 \
    QKB_MCP_PORT=8181
RUN mkdir -p /data /config /vault && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8181

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.QKB_MCP_PORT||8181)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["mcp", "--http", "--watch"]
