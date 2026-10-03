#!/bin/sh
# Installs the latest cmd release into /Applications (or ~/Applications) on macOS
# (Windows: scripts/install.ps1):
#   curl -fsSL https://raw.githubusercontent.com/janoelze/cmd/master/scripts/install.sh | sh
# curl doesn't quarantine what it downloads, so this also works for builds that
# aren't notarized. CMD_VERSION=0.2.3 installs a specific release.
set -eu

repo=janoelze/cmd
[ "$(uname -s)" = Darwin ] || { echo "this installs cmd on macOS; on Windows run in PowerShell: irm https://raw.githubusercontent.com/$repo/master/scripts/install.ps1 | iex" >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "cmd needs an Apple Silicon Mac" >&2; exit 1; }

if [ -n "${CMD_VERSION:-}" ]; then
  api="https://api.github.com/repos/$repo/releases/tags/v${CMD_VERSION#v}"
else
  api="https://api.github.com/repos/$repo/releases/latest"
fi
url=$(curl -fsSL "$api" | grep -o '"browser_download_url": *"[^"]*-arm64\.zip"' | head -n 1 | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$url" ] || { echo "no arm64 .zip found in $api" >&2; exit 1; }

dest=/Applications
[ -w "$dest" ] || dest="$HOME/Applications"
mkdir -p "$dest"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "downloading $url"
curl -fL --progress-bar -o "$tmp/cmd.zip" "$url"
ditto -x -k "$tmp/cmd.zip" "$tmp"

# The core outlives the app, so a running cmd keeps working; it offers a restart on the next launch.
if [ -d "$dest/cmd.app" ]; then
  osascript -e 'tell application id "dev.janoelze.cmd" to quit' >/dev/null 2>&1 || true
  rm -rf "$dest/cmd.app"
fi
ditto "$tmp/cmd.app" "$dest/cmd.app"
xattr -dr com.apple.quarantine "$dest/cmd.app" 2>/dev/null || true

echo "installed $dest/cmd.app"
open "$dest/cmd.app"
