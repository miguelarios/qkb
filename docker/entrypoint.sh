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

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
# PUID=0 means "run as root": nothing to drop to.
if [ "$(id -u)" = 0 ] && [ "$PUID" != 0 ]; then
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
  # the single vault at /vault. `init` leaves an existing config alone.
  if [ -n "$(find /vaults -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | head -n 1)" ]; then
    seed_flag=--vaults-dir seed_value=/vaults
  else
    seed_flag=--vault seed_value="${QKB_VAULT_NAME:-Notes}=/vault"
  fi
  if ! node /app/dist/cli.js init --quiet "$seed_flag" "$seed_value"; then
    # No config could be written (read-only or unwritable /config). Without
    # one qkb would index its built-in default, a folder that does not exist
    # here, so point it at the single vault and say what to fix.
    echo "qkb: could not write a starter config to ${QKB_CONFIG:-/config/config.yaml} (is /config writable by uid $(id -u)?)" >&2
    echo "qkb: serving /vault only; mount a writable /config, or provide a config.yaml, to index the folders under /vaults" >&2
    export QKB_VAULT_PATH=/vault QKB_VAULT_NAME="${QKB_VAULT_NAME:-Notes}"
  fi
fi

exec node /app/dist/cli.js "$@"
