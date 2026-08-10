#!/usr/bin/env bash
# Forward the Spark's inference port to the MacBook's localhost.
# Needed when the server binds to 127.0.0.1 on the Spark (the default for
# many serve scripts) — that port is not reachable over the LAN otherwise.
set -euo pipefail

[ -f "$(dirname "$0")/../.env" ] && set -a && . "$(dirname "$0")/../.env" && set +a

SPARK_SSH="${SPARK_SSH:-sna@spark.local}"
REMOTE="${SPARK_REMOTE_PORT:-8000}"
LOCAL="${LOCAL_PORT:-8000}"

echo "Tunnel: localhost:${LOCAL}  ->  ${SPARK_SSH}:${REMOTE}"
echo "Leave this running in its own terminal. Ctrl-C to close."

exec ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L "${LOCAL}:127.0.0.1:${REMOTE}" \
  "${SPARK_SSH}"
