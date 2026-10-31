#!/usr/bin/env bash
# One-time setup on the Raspberry Pi, run from your normal account:
#   sudo bash deploy/setup-pi.sh https://example.com
# Safe to run again (e.g. after changing your domain); it keeps your password and lists.
set -euo pipefail

ORIGIN="${1:?Usage: sudo bash deploy/setup-pi.sh https://example.com   (the address of your site, without /todo/)}"
RUN_USER="${SUDO_USER:?Run this with sudo from your normal account, not as root}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR=/var/lib/drift-lists
NODE="$(command -v node || true)"

[ -n "$NODE" ] || { echo "Node.js isn't installed. Run: sudo apt install -y nodejs"; exit 1; }
case "$ORIGIN" in https://*) ;; *) echo "Use your https:// address, e.g. https://example.com"; exit 1;; esac
ORIGIN="${ORIGIN%/}"

echo "App folder:  $APP_DIR"
echo "Data folder: $DATA_DIR (not in git)"
echo "Runs as:     $RUN_USER"

install -d -o "$RUN_USER" -m 700 "$DATA_DIR"

for unit in drift-lists.service drift-lists-restart.service drift-lists-restart.path; do
  sed -e "s#@USER@#$RUN_USER#g" -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@ORIGIN@#$ORIGIN#g" \
      -e "s#@NODE@#$NODE#g" -e "s#@DATA_DIR@#$DATA_DIR#g" \
      "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
done

if [ ! -f "$DATA_DIR/auth.json" ]; then
  echo; echo "Choose your Drift Lists password (at least 10 characters):"
  sudo -u "$RUN_USER" "$NODE" "$APP_DIR/set-password.js" --data "$DATA_DIR"
fi
# Files made by running set-password.js with sudo belong to root, which the
# service can't read. Hand everything in the data folder to the service user.
chown -R "$RUN_USER": "$DATA_DIR"

systemctl daemon-reload
systemctl enable drift-lists.service drift-lists-restart.path
systemctl restart drift-lists.service
systemctl start drift-lists-restart.path
sleep 1
systemctl --no-pager --lines=3 status drift-lists.service || true
echo
echo "Done. Next: add deploy/nginx-drift-lists.conf to your nginx site, then: sudo nginx -t && sudo systemctl reload nginx"
