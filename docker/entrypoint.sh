#!/bin/sh
# Container entrypoint, installed as `qkb` on PATH, so `docker exec <c> qkb
# status` goes through the same steps as the server.
#
# 1. Started as root (the image default): make /config and /data writable by
#    PUID:PGID (default 1000:1000), then drop to that user. With `user:` set
#    in compose / `docker run --user`, this step is skipped.
# 2. Starting the server with no config file: write a starter
#    /config/config.yaml listing the mounted vaults.
set -eu

if [ "$(id -u)" = 0 ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  for dir in /config /data; do
    if [ -d "$dir" ] && [ "$(stat -c %u:%g "$dir")" != "$PUID:$PGID" ]; then
      # /data is qkb's own (index, models); /config is the user's directory,
      # so only the directory itself changes owner. A read-only mount fails
      # here and is left alone.
      if [ "$dir" = /data ]; then
        chown -R "$PUID:$PGID" "$dir" 2>/dev/null || true
      else
        chown "$PUID:$PGID" "$dir" 2>/dev/null || true
      fi
    fi
  done
  exec setpriv --reuid "$PUID" --regid "$PGID" --clear-groups "$0" "$@"
fi

if [ "${1:-}" = mcp ] && [ -z "${QKB_VAULT_PATH:-}" ] && [ "${QKB_SEED_CONFIG:-1}" != 0 ]; then
  # Every folder mounted under /vaults is a vault named after it; otherwise
  # the single vault at /vault. `init` leaves an existing config alone. A
  # failure (read-only /config) must not stop the server: it then runs on
  # defaults and environment variables.
  if [ -n "$(ls -A /vaults 2>/dev/null)" ]; then
    seed_flag=--vaults-dir seed_value=/vaults
  else
    seed_flag=--vault seed_value="${QKB_VAULT_NAME:-Notes}=/vault"
  fi
  node /app/dist/cli.js init --quiet "$seed_flag" "$seed_value" ||
    echo "qkb: could not write a starter config to ${QKB_CONFIG:-/config/config.yaml}; continuing without one" >&2
fi

exec node /app/dist/cli.js "$@"
