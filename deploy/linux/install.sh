#!/usr/bin/env bash
# Installs (or upgrades) WCC Rack View as a systemd service.
# Run from the unpacked release folder:  sudo ./install.sh [port]
# Asks where to install, defaulting to this folder (the app then runs from here).
# INSTALL_DIR=/opt/rackview skips the question.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${INSTALL_DIR:-}"
if [ -z "$APP" ]; then
  read -rp "Install location [$HERE]: " APP || true
  APP="${APP:-$HERE}"
fi
mkdir -p "$APP"; APP="$(cd "$APP" && pwd)"
CONF=/etc/rackview
DATA=/var/lib/rackview
PORT="${1:-}"

# The package carries its own Ruby (ruby/), so nothing needs installing. Without it (e.g. running from a
# source checkout), fall back to a system Ruby 3.0+; RUBY=/path/to/ruby picks a specific one.
ruby3() { # prints the first usable Ruby 3+
  for r in "$APP/ruby/bin/ruby" "$HERE/ruby/bin/ruby" ${RUBY:-} "$(command -v ruby 2>/dev/null || true)" /usr/local/bin/ruby /usr/bin/ruby3* /usr/bin/ruby; do
    [ -n "$r" ] && [ -x "$r" ] && "$r" -e 'exit(Gem::Version.new(RUBY_VERSION) >= Gem::Version.new("3.0") ? 0 : 1)' 2>/dev/null && { echo "$r"; return 0; }
  done
  return 1
}

id rackview >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin rackview
mkdir -p "$APP" "$CONF" "$DATA"
if [ "$APP" != "$HERE" ]; then
  for item in serve.rb unifi.rb sso.rb index.html update.sh uninstall.sh VERSION css js img vendor ruby; do
    if [ -d "$HERE/$item" ]; then mkdir -p "$APP/$item" && cp -R "$HERE/$item/." "$APP/$item/"   # merge, never nest
    elif [ -e "$HERE/$item" ]; then cp "$HERE/$item" "$APP"/; fi
  done
fi
RUBY_BIN="$(ruby3 || true)"
[ -n "$RUBY_BIN" ] || { echo "No Ruby 3 found: this package should include one in ruby/. Re-download the release, or point at one: sudo RUBY=/path/to/ruby ./install.sh"; exit 1; }
echo "Using $("$RUBY_BIN" -v)"
if [ ! -f "$CONF/config.env" ]; then
  # Release: https on port 443, sign-in required. A certificate (.crt/.pem + .key) dropped in the app
  # folder is used for https; without one, put IIS/nginx in front (see README-deploy.md).
  CERT="$(cd "$APP" && ls *.crt *.pem 2>/dev/null | head -1 || true)"; KEY="$(cd "$APP" && ls *.key 2>/dev/null | head -1 || true)"
  [ -n "$CERT" ] && echo "Using certificate $CERT for https."
  sed -e "s|^RACK_DATA_DIR=.*|RACK_DATA_DIR=$DATA|" -e "s|^PORT=.*|PORT=${PORT:-443}|" -e "s|^TLS_CERT=.*|TLS_CERT=$CERT|" -e "s|^TLS_KEY=.*|TLS_KEY=$KEY|" "$HERE/config.example.env" > "$CONF/config.env"
fi
# Add any settings that are new in this version, keeping existing values
while IFS= read -r line; do
  if [[ "$line" =~ ^([A-Z_]+)= ]] && ! grep -q "^${BASH_REMATCH[1]}=" "$CONF/config.env"; then echo "$line" >> "$CONF/config.env"; fi
done < "$HERE/config.example.env"
chown -R rackview:rackview "$DATA"
chown root:rackview "$CONF/config.env"; chmod 640 "$CONF/config.env"
for f in "$APP"/*.key "$APP"/*.pem; do if [ -f "$f" ]; then chown root:rackview "$f"; chmod 640 "$f"; fi; done
sed -e "s|/usr/bin/env ruby|$RUBY_BIN|" -e "s|/opt/rackview|$APP|g" "$HERE/rackview.service" > /etc/systemd/system/rackview.service
# The service user must be able to reach the app folder (e.g. not inside a private home folder)
runuser -u rackview -- test -r "$APP/serve.rb" || echo "Warning: user rackview cannot read $APP; pick a location such as /opt/rackview"
systemctl daemon-reload
systemctl enable --now rackview
systemctl restart rackview
echo "Installed in $APP. Settings: $CONF/config.env   Data: $DATA"
echo "Status: systemctl status rackview   Logs: journalctl -u rackview -f"
command -v ufw >/dev/null && ufw status | grep -q active && echo "ufw is on: sudo ufw allow $(grep ^PORT= "$CONF/config.env" | cut -d= -f2)/tcp"
exit 0
