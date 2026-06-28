#!/bin/bash
# uninstall.sh — WebBT Server for Firefox uninstaller (Linux)
# Run as your normal user to remove a per-user installation.
# Run with sudo to also remove a system-wide installation.

set -euo pipefail

echo "=== WebBT Server for Firefox Uninstaller ==="
echo ""

SYSTEM_INSTALL_DIR="/opt/webbt-server"
SYSTEM_MANIFEST_32="/usr/lib/mozilla/native-messaging-hosts/webbt.server.json"
SYSTEM_MANIFEST_64="/usr/lib64/mozilla/native-messaging-hosts/webbt.server.json"

REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME="$(eval echo ~"$REAL_USER")"
USER_INSTALL_DIR="$REAL_HOME/.local/share/webbt-server"
USER_MANIFEST="$REAL_HOME/.mozilla/native-messaging-hosts/webbt.server.json"
FLATPAK_MANIFEST="$REAL_HOME/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/webbt.server.json"
FLATPAK_WRAPPER_DIR="$REAL_HOME/.var/app/org.mozilla.firefox/data/webbt-server"

log() { printf '%s\n' "$1" >&2; }

# ---------------------------------------------------------------------------
# BLEServer running check (mirrors macOS uninstall.sh)
# ---------------------------------------------------------------------------
if pgrep -x BLEServer >/dev/null 2>&1; then
  log "WebBT Server is currently running in Firefox. Close any pages that use Web Bluetooth, then run this uninstall script again."
  exit 1
fi

# ---------------------------------------------------------------------------
# Detect what is installed
# ---------------------------------------------------------------------------
user_exists=false
system_exists=false
[[ -d "$USER_INSTALL_DIR" || -f "$USER_MANIFEST" || -f "$FLATPAK_MANIFEST" ]] && user_exists=true
[[ -d "$SYSTEM_INSTALL_DIR" || -f "$SYSTEM_MANIFEST_32" || -f "$SYSTEM_MANIFEST_64" ]] && system_exists=true

if ! $user_exists && ! $system_exists; then
  log "No WebBT Server for Firefox installation was found."
  exit 0
fi

# ---------------------------------------------------------------------------
# Remove user installation
# ---------------------------------------------------------------------------
removed_user=false
removed_system=false

if $user_exists; then
  rm -rf "$USER_INSTALL_DIR" "$USER_MANIFEST" "$FLATPAK_MANIFEST" "$FLATPAK_WRAPPER_DIR"
  removed_user=true
fi

# ---------------------------------------------------------------------------
# Remove system installation (requires root)
# ---------------------------------------------------------------------------
if $system_exists; then
  if [[ "$(id -u)" -eq 0 ]]; then
    rm -rf "$SYSTEM_INSTALL_DIR" "$SYSTEM_MANIFEST_32" "$SYSTEM_MANIFEST_64"
    removed_system=true
  else
    $removed_user && log "The user installation was removed."
    log "A system-wide WebBT Server for Firefox installation was found at $SYSTEM_INSTALL_DIR."
    log "Re-run this uninstall script with sudo to remove it."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if $removed_user && $removed_system; then
  log "Removed user and system-wide WebBT Server for Firefox installations."
elif $removed_user; then
  log "Removed user WebBT Server for Firefox installation."
else
  log "Removed system-wide WebBT Server for Firefox installation."
fi

log "If you encountered a bug, please feel free to open an issue at https://github.com/stevennyman/webbt/issues."
