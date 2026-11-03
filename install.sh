#!/usr/bin/env bash
# Installs the Display Brightness Control GNOME Shell extension for the current user.
set -euo pipefail

UUID="display-brightness-control@sasikaa073.github.io"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if ! command -v ddcutil >/dev/null; then
    echo "ddcutil is required for external monitors. Installing (needs sudo)…"
    sudo apt-get install -y ddcutil
fi

if ! ls /dev/i2c-* >/dev/null 2>&1; then
    echo "Loading the i2c-dev kernel module (needs sudo)…"
    sudo modprobe i2c-dev
    echo i2c-dev | sudo tee /etc/modules-load.d/i2c-dev.conf >/dev/null
fi

# The Ubuntu ddcutil package grants the logged-in user access to /dev/i2c-*
# through a udev "uaccess" rule. Fall back to the i2c group if that's missing.
if ! ddcutil detect --brief >/dev/null 2>&1 && getent group i2c >/dev/null && ! id -nG | grep -qw i2c; then
    echo "Adding $USER to the i2c group (needs sudo; log out and back in afterwards)…"
    sudo usermod -aG i2c "$USER"
fi

mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/
glib-compile-schemas "$DEST/schemas"

echo
echo "Detected DDC/CI monitors:"
ddcutil detect --brief 2>/dev/null | grep -E '^Display|Monitor:' || echo "  (none)"
echo

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Extension enabled."
else
    # GNOME Shell only picks up newly installed extensions at login on Wayland.
    gsettings set org.gnome.shell enabled-extensions \
        "$(python3 -c "import ast,sys; l=ast.literal_eval(sys.argv[1] if sys.argv[1] != '@as []' else '[]'); l.append('$UUID') if '$UUID' not in l else None; print(l)" "$(gsettings get org.gnome.shell enabled-extensions)")"
    echo "Installed. Log out and back in to load it (required on Wayland)."
fi
