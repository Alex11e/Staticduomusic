#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Futtasd rootként: sudo bash scripts/install-linux.sh" >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${HANGTAR_INSTALL_DIR:-/opt/hangtar}"
DATA_DIR="${HANGTAR_DATA_DIR:-/var/lib/hangtar}"
SERVICE_USER="${HANGTAR_SERVICE_USER:-hangtar}"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 20 vagy újabb szükséges. Telepítsd a disztribúciód csomagkezelőjével, majd próbáld újra." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p "Number(process.versions.node.split('.')[0])")"
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 20 vagy újabb szükséges; a megtalált verzió: $("$NODE_BIN" --version)." >&2
  exit 1
fi

if [[ "$NODE_BIN" == /root/* || "$NODE_BIN" == /home/* ]]; then
  echo "A systemd szolgáltatás nem tudja használni a felhasználói könyvtárban lévő Node.js-t. Telepíts rendszer szintű Node.js-t, például /usr/bin/node helyre." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1 || ! command -v runuser >/dev/null 2>&1; then
  echo "Az npm és a runuser parancs szükséges a telepítéshez." >&2
  exit 1
fi

BUILD_USER="${SUDO_USER:-root}"
if [[ "$BUILD_USER" != root ]]; then
  runuser -u "$BUILD_USER" -- npm --prefix "$SOURCE_DIR" ci
  runuser -u "$BUILD_USER" -- npm --prefix "$SOURCE_DIR" run build
else
  npm --prefix "$SOURCE_DIR" ci
  npm --prefix "$SOURCE_DIR" run build
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -o root -g root -m 0755 "$APP_DIR/server" "$APP_DIR/dist"
cp -a "$SOURCE_DIR/server/." "$APP_DIR/server/"
cp -a "$SOURCE_DIR/dist/." "$APP_DIR/dist/"
chown -R root:root "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
find "$APP_DIR" -type f -exec chmod 0644 {} +

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR/music"
install -d -o root -g root -m 0755 /etc/hangtar
if [[ ! -f /etc/hangtar/hangtar.env ]]; then
  printf 'HOST=127.0.0.1\nPORT=4000\nMUSIC_DIR=%s/music\n' "$DATA_DIR" > /etc/hangtar/hangtar.env
  chmod 0640 /etc/hangtar/hangtar.env
  chown root:"$SERVICE_USER" /etc/hangtar/hangtar.env
fi

cat > /etc/systemd/system/hangtar.service <<UNIT
[Unit]
Description=HANGTAR private music server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/hangtar/hangtar.env
ExecStart=$NODE_BIN $APP_DIR/server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=$APP_DIR
ReadOnlyPaths=$DATA_DIR/music
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now hangtar.service
echo "HANGTAR telepítve és elindítva."
echo "Könyvtár: $DATA_DIR/music"
echo "Állapot: sudo systemctl status hangtar"
echo "Beállítások: /etc/hangtar/hangtar.env"