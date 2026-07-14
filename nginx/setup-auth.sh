#!/bin/bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: setup-auth.sh <username> <password>"
  exit 1
fi

USER="$1"
PASS="$2"
OUT="/etc/nginx/.htpasswd-cherryagent"

HASH="$(openssl passwd -apr1 "$PASS")"
echo "${USER}:${HASH}" | sudo tee "$OUT" >/dev/null
sudo chmod 640 "$OUT"
sudo chown root:www-data "$OUT"
echo "Wrote ${OUT} for user ${USER}"
