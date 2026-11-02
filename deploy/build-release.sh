#!/usr/bin/env bash
# Builds the two release packages into dist/:  ./deploy/build-release.sh v1.0.0
# Each package carries its own Ruby (in ruby/), so servers need nothing installed:
#   Linux:   Homebrew's relocatable portable Ruby (x86_64; LINUX_ARCH=arm64 for ARM servers)
#   Windows: RubyInstaller's portable 7z build (x64)
# Both are the 3.4 series (RUBY_SERIES to change). Downloads are cached in dist/cache/.
set -euo pipefail
VER="${1:?version, e.g. v1.0.0}"
SERIES="${RUBY_SERIES:-3.4}"
ARCH="${LINUX_ARCH:-x86_64}"
cd "$(dirname "$0")/.."
RUBY="$(command -v ruby)"
mkdir -p dist/cache && rm -rf dist/stage && mkdir -p dist/stage

# Find the newest release asset whose name matches, in a public GitHub repo
asset_url() { # repo, name regex
  curl -fsSL "https://api.github.com/repos/$1/releases?per_page=30" | "$RUBY" -rjson -e '
    re = Regexp.new(ARGV[0])
    JSON.parse(STDIN.read).reject { |r| r["prerelease"] || r["draft"] }.each do |r|
      a = r["assets"].find { |x| x["name"] =~ re } and (puts a["browser_download_url"]; exit)
    end
    abort "no release asset matching #{ARGV[0]}"' "$2"
}
fetch() { # url -> cached file path
  local f="dist/cache/$(basename "$1")"
  [ -s "$f" ] || { echo "Downloading $(basename "$1")..." >&2; curl -fsSL -o "$f.part" "$1" && mv "$f.part" "$f"; }
  echo "$f"
}
S="${SERIES//./\\.}"
LINUX_RUBY="$(fetch "$(asset_url Homebrew/homebrew-portable-ruby "^portable-ruby-$S\\.[0-9]+\\.${ARCH}_linux\\.bottle\\.tar\\.gz\$")")"
WIN_RUBY="$(fetch "$(asset_url oneclick/rubyinstaller2 "^rubyinstaller-$S\\.[0-9]+-[0-9]+-x64\\.7z\$")")"

for os in windows linux; do
  d="dist/stage/rackview-$os-$VER"
  mkdir -p "$d/ruby"
  git archive HEAD serve.rb unifi.rb sso.rb index.html css js img vendor | tar -x -C "$d"
  echo "$VER" > "$d/VERSION"
  cp deploy/config.example.env deploy/README-deploy.md deploy/IT-HANDOVER.md deploy/$os/* "$d"/
  if [ "$os" = linux ]; then
    tar -xzf "$LINUX_RUBY" -C "$d/ruby" --strip-components=2   # portable-ruby/<version>/{bin,lib,...}
  else
    tar -xf "$WIN_RUBY" -C "$d/ruby" --strip-components=1        # rubyinstaller-<version>-x64/{bin,lib,...}
  fi
  [ -e "$d/ruby/bin/ruby" ] || [ -e "$d/ruby/bin/ruby.exe" ] || { echo "Bundled Ruby missing for $os"; exit 1; }
done
cd dist/stage
win="rackview-windows-$VER"
if command -v zip >/dev/null; then zip -qr "../$win.zip" "$win"; else python3 -m zipfile -c "../$win.zip" "$win"; fi
tar -czf "../rackview-linux-$ARCH-$VER.tar.gz" "rackview-linux-$VER"
cd ../..
rm -rf dist/stage && ls -lh dist
