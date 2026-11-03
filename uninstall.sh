#!/usr/bin/env bash
set -euo pipefail
UUID="display-brightness-control@sasikaa073.github.io"
gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
echo "Removed. Log out and back in to fully unload it."
