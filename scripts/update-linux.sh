#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Futtasd rootként: sudo bash scripts/update-linux.sh" >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${HANGTAR_INSTALL_DIR:-/opt/hangtar}"
SERVICE_USER="${HANGTAR_SERVICE_USER:-hangtar}"
BUILD_USER="${SUDO_USER:-root}"

if [[ ! -f /etc/systemd/system/hangtar.service ]]; then
  echo "A HANGTAR nincs telepítve. Először futtasd a scripts/install-linux.sh szkriptet." >&2
  exit 1
fi

if [[ "$BUILD_USER" != root ]]; then
  runuser -u "$BUILD_USER" -- npm --prefix "$SOURCE_DIR" ci
  runuser -u "$BUILD_USER" -- npm --prefix "$SOURCE_DIR" run build
else
  npm --prefix "$SOURCE_DIR" ci
  npm --prefix "$SOURCE_DIR" run build
fi

install -d -o root -g root -m 0755 "$APP_DIR/server" "$APP_DIR/dist"
cp -a "$SOURCE_DIR/server/." "$APP_DIR/server/"
cp -a "$SOURCE_DIR/dist/." "$APP_DIR/dist/"
chown -R root:root "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
find "$APP_DIR" -type f -exec chmod 0644 {} +
systemctl restart hangtar.service
systemctl is-active --quiet hangtar.service
echo "HANGTAR frissítve. Állapot: $(systemctl is-active hangtar.service)"