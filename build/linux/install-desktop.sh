#!/bin/sh
# Installs the taskbar/menu icon for Sliver GUI (Linux desktops that match
# windows to .desktop files by WM_CLASS, e.g. XFCE). Run as the DESKTOP user
# (not root), even though the app itself may be launched with sudo.
set -e
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons"
cp "$APP_DIR/frontend/dist/icons/ICON.png" "$HOME/.local/share/icons/sliver-gui.png"
sed "s#^Exec=.*#Exec=$APP_DIR/build/bin/sliver-gui#" "$APP_DIR/build/linux/sliver-gui.desktop" \
  | sed "s#^Icon=.*#Icon=$HOME/.local/share/icons/sliver-gui.png#" \
  > "$HOME/.local/share/applications/sliver-gui.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Installed. Restart the panel (xfce4-panel -r) or re-launch the app."
