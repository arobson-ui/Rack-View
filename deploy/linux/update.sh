#!/usr/bin/env bash
# Updates Rack View to the latest GitHub release. Keeps settings and data.
#   sudo <install folder>/update.sh
set -euo pipefail
# All in a function: bash reads scripts as it runs, and the install below replaces this file.
main() {
APP="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
CONF=/etc/rackview/config.env
get() { grep "^$1=" "$CONF" | head -1 | cut -d= -f2- | tr -d '\r'; }
REPO="$(get GITHUB_REPO)"; TOKEN="$(get GITHUB_TOKEN)"
command -v curl >/dev/null || { echo "Install curl first"; exit 1; }
# The repository is public, so no token is needed; GITHUB_TOKEN is only for a private fork
H=(-H "X-GitHub-Api-Version: 2022-11-28"); [ -z "$TOKEN" ] || H+=(-H "Authorization: Bearer $TOKEN")
JSON="$(curl -fsSL "${H[@]}" "https://api.github.com/repos/$REPO/releases/latest")"
RB="$APP/ruby/bin/ruby"; [ -x "$RB" ] || RB=ruby   # the bundled Ruby reads the release info, so nothing else is needed
VER="$(printf '%s' "$JSON" | "$RB" -rjson -e 'puts JSON.parse(STDIN.read)["tag_name"]')"
case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=x86_64 ;; esac   # releases carry one package per CPU type
URL="$(printf '%s' "$JSON" | "$RB" -rjson -e 'a=JSON.parse(STDIN.read)["assets"].find{|x| x["name"]=~/linux-#{ARGV[0]}.*\.tar\.gz$/}; puts a ? a["url"] : ""' "$ARCH")"
CUR="$(cat "$APP/VERSION" 2>/dev/null || echo none)"
echo "Installed: $CUR   Latest: $VER"
[ "$CUR" = "$VER" ] && [ "${1:-}" != "--force" ] && { echo "Already up to date."; exit 0; }
[ -n "$URL" ] || { echo "No Linux $ARCH package on release $VER"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL "${H[@]}" -H "Accept: application/octet-stream" -o "$TMP/pkg.tar.gz" "$URL"
tar -xzf "$TMP/pkg.tar.gz" -C "$TMP"
INSTALL_DIR="$APP" "$TMP"/rackview-linux-*/install.sh "$(get PORT)"
echo "Updated to $VER."
}
main "$@"; exit
