#!/bin/bash

set -euo pipefail

PACKAGE_ID="webbt.server.macos"

REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(dscl . -read "/Users/$REAL_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
REAL_HOME="${REAL_HOME:-/Users/$REAL_USER}"

USER_INSTALL_ROOT="$REAL_HOME/Library/Application Support/WebBT Server for Firefox"
USER_MANIFEST="$REAL_HOME/Library/Application Support/Mozilla/NativeMessagingHosts/webbt.server.json"
SYSTEM_INSTALL_ROOT="/Library/Application Support/WebBT Server for Firefox"
SYSTEM_MANIFEST="/Library/Application Support/Mozilla/NativeMessagingHosts/webbt.server.json"

log() { printf '%s\n' "$1" >&2; }

if pgrep -x BLEServer >/dev/null 2>&1; then
  log "WebBT Server is currently running in Firefox. Close any pages that use Web Bluetooth, then run this uninstall script again."
  exit 1
fi

user_exists=false
system_exists=false
[[ -d "$USER_INSTALL_ROOT" || -f "$USER_MANIFEST" ]] && user_exists=true
[[ -d "$SYSTEM_INSTALL_ROOT" || -f "$SYSTEM_MANIFEST" ]] && system_exists=true

if ! $user_exists && ! $system_exists; then
  log "No WebBT Server for Firefox installation was found."
  exit 0
fi

removed_user=false
removed_system=false
user_removal_failed=false

if $user_exists; then
  if rm -rf "$USER_INSTALL_ROOT" "$USER_MANIFEST" 2>/dev/null &&
     [[ ! -e "$USER_INSTALL_ROOT" && ! -e "$USER_MANIFEST" ]]; then
    removed_user=true
  else
    log "The user installation could not be removed. It may require sudo."
    user_removal_failed=true
  fi
fi

if $user_removal_failed && ! $system_exists; then
  exit 1
fi

if $system_exists; then
  if [[ "$(id -u)" -eq 0 ]]; then
    rm -rf "$SYSTEM_INSTALL_ROOT" "$SYSTEM_MANIFEST"
    removed_system=true
  else
    $removed_user && log "The user installation was removed."
    log "A systemwide WebBT Server for Firefox installation was found. Re-run this uninstall script with sudo to remove it."
    exit 1
  fi
fi

pkgutil --forget "$PACKAGE_ID" >/dev/null 2>&1 || true

if $removed_user && $removed_system; then
  log "Removed user and global WebBT Server for Firefox installations."
elif $removed_user; then
  log "Removed user WebBT Server for Firefox installation."
else
  log "Removed global WebBT Server for Firefox installation."
fi

log "If you encountered a bug, please feel free to open an issue at https://github.com/stevennyman/webbt/issues."
