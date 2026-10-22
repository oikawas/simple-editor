#!/bin/sh
set -e
# Docker creates a missing bind-mounted data directory as root. Hand it to the
# unprivileged user, then drop privileges before starting the server.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
