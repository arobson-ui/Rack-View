#!/usr/bin/env bash
# Removes the service. Keeps the app folder, settings (/etc/rackview) and data (/var/lib/rackview).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
systemctl disable --now rackview 2>/dev/null || true
rm -f /etc/systemd/system/rackview.service
systemctl daemon-reload
echo "Service removed. App folder, settings and data were kept."
