#!/bin/bash
# install.sh — WebBT Server for Firefox installer (Linux)
# Usage: ./install.sh [--system|--user]
#   (no flag)  Install for all users if run as root (via sudo), otherwise for the current user only
#   --system   Force install for all users (requires root)
#   --user     Force install for the current user only

set -euo pipefail

PRODUCT_VERSION="0.6.0"
echo "=== WebBT Server for Firefox Installer (v$PRODUCT_VERSION) ==="
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SYSTEM_INSTALL_DIR="/opt/webbt-server"
USER_INSTALL_DIR="$HOME/.local/share/webbt-server"
SYSTEM_MANIFEST_DIR_32="/usr/lib/mozilla/native-messaging-hosts"
SYSTEM_MANIFEST_DIR_64="/usr/lib64/mozilla/native-messaging-hosts"
USER_MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
USER_MANIFEST="$USER_MANIFEST_DIR/webbt.server.json"

SYSTEM_MANIFEST_32="$SYSTEM_MANIFEST_DIR_32/webbt.server.json"
SYSTEM_MANIFEST_64="$SYSTEM_MANIFEST_DIR_64/webbt.server.json"

# Flatpak Firefox paths (per-user only; system installs are invisible to Flatpak Firefox)
FLATPAK_FIREFOX_DATA="$HOME/.var/app/org.mozilla.firefox"
FLATPAK_MANIFEST_DIR="$FLATPAK_FIREFOX_DATA/.mozilla/native-messaging-hosts"
FLATPAK_MANIFEST="$FLATPAK_MANIFEST_DIR/webbt.server.json"
FLATPAK_WRAPPER_DIR="$FLATPAK_FIREFOX_DATA/data/webbt-server"
FLATPAK_WRAPPER="$FLATPAK_WRAPPER_DIR/launch.sh"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
# Default to system-wide install if running as root (e.g. via sudo)
if [[ "$(id -u)" -eq 0 ]]; then
  SYSTEM_INSTALL=true
else
  SYSTEM_INSTALL=false
fi

for arg in "$@"; do
  case "$arg" in
    --system) SYSTEM_INSTALL=true ;;
    --user)   SYSTEM_INSTALL=false ;;
    --help|-h)
      echo "Usage: $0 [--system|--user]"
      echo "  (default)  Install for all users if run as root, otherwise for the current user only"
      echo "  --system   Force install for all users (requires root)"
      echo "  --user     Force install for the current user only"
      exit 0
      ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

if $SYSTEM_INSTALL && [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: System-wide installation requires root. Re-run with sudo."
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { printf '%s\n' "$1"; }
warn() { printf 'Warning: %s\n' "$1" >&2; }
err()  { printf 'Error: %s\n' "$1" >&2; exit 1; }

confirm() {
  local prompt="$1"
  read -r -p "$prompt [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ---------------------------------------------------------------------------
# Prerequisite: architecture detection
# ---------------------------------------------------------------------------
MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64)          ARCH_SUFFIX="x86_64" ;;
  aarch64|arm64)   ARCH_SUFFIX="aarch64" ;;
  i686|i386)       ARCH_SUFFIX="i686" ;;
  *)
    err "Unsupported CPU architecture: $MACHINE. Supported architectures: x86_64, aarch64, i686."
    ;;
esac

BINARY_SRC="$SCRIPT_DIR/bin/BLEServer-$ARCH_SUFFIX"
if [[ ! -f "$BINARY_SRC" ]]; then
  err "Binary not found in tarball for architecture '$ARCH_SUFFIX': $BINARY_SRC"
fi

# ---------------------------------------------------------------------------
# Prerequisite: BlueZ
# ---------------------------------------------------------------------------
BLUETOOTHD_PATH=""
for candidate in /usr/sbin/bluetoothd /usr/bin/bluetoothd; do
  if [[ -x "$candidate" ]]; then
    BLUETOOTHD_PATH="$candidate"
    break
  fi
done
if [[ -z "$BLUETOOTHD_PATH" ]] && command -v bluetoothd &>/dev/null; then
  BLUETOOTHD_PATH="$(command -v bluetoothd)"
fi

if [[ -z "$BLUETOOTHD_PATH" ]]; then
  echo ""
  echo "Error: BlueZ (bluetoothd) is not installed, but it is required by WebBT Server."
  echo "Install it with the package manager for your distribution:"
  echo "  Debian / Ubuntu:     sudo apt install bluez"
  echo "  Fedora / RHEL:       sudo dnf install bluez"
  echo "  Arch Linux:          sudo pacman -S bluez bluez-utils"
  echo "  openSUSE:            sudo zypper install bluez"
  echo "Then re-run this installer."
  exit 1
fi

# Warn (non-fatal) if the bluetooth service is not running
if command -v systemctl &>/dev/null; then
  if ! systemctl is-active --quiet bluetooth 2>/dev/null; then
    warn "The bluetooth systemd service is not currently running."
    warn "To start and enable it: sudo systemctl enable --now bluetooth"
  fi
fi

# Warn if the target user is not in the bluetooth group
TARGET_USER="${SUDO_USER:-$USER}"
if [[ "$TARGET_USER" != "root" ]]; then
  if ! id -nG "$TARGET_USER" 2>/dev/null | grep -qw bluetooth; then
    echo ""
    echo "Warning: User '$TARGET_USER' is not in the 'bluetooth' group."
    echo "On many Linux distributions this is required for WebBT Server to access"
    echo "Bluetooth. To fix this, run:"
    echo "  sudo usermod -aG bluetooth $TARGET_USER"
    echo "Then log out and back in for the change to take effect."
    echo ""
  fi
fi

# ---------------------------------------------------------------------------
# BLEServer running check (like macOS preinstall)
# ---------------------------------------------------------------------------
if pgrep -x BLEServer >/dev/null 2>&1; then
  err "WebBT Server is currently running in Firefox. Close any pages that use Web Bluetooth, then run this installer again."
fi

# ---------------------------------------------------------------------------
# Conflict detection (mirrors macOS preinstall logic)
# ---------------------------------------------------------------------------
if $SYSTEM_INSTALL; then
  # Installing system-wide: warn if a per-user install exists
  REAL_HOME="$(eval echo ~"${SUDO_USER:-$USER}")"
  EXISTING_USER_DIR="$REAL_HOME/.local/share/webbt-server"
  EXISTING_USER_MANIFEST="$REAL_HOME/.mozilla/native-messaging-hosts/webbt.server.json"
  EXISTING_FLATPAK_MANIFEST="$REAL_HOME/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/webbt.server.json"
  EXISTING_FLATPAK_WRAPPER_DIR="$REAL_HOME/.var/app/org.mozilla.firefox/data/webbt-server"
  if [[ -d "$EXISTING_USER_DIR" || -f "$EXISTING_USER_MANIFEST" || -f "$EXISTING_FLATPAK_MANIFEST" ]]; then
    echo "A current-user WebBT Server installation already exists."
    echo "It will be removed so this all-users installation can be used."
    if ! confirm "Continue?"; then
      log "Installation cancelled."
      exit 1
    fi
    rm -rf "$EXISTING_USER_DIR" "$EXISTING_USER_MANIFEST" \
           "$EXISTING_FLATPAK_MANIFEST" "$EXISTING_FLATPAK_WRAPPER_DIR"
    log "Removed existing user installation."
  fi
else
  # Installing per-user: inform if a system-wide install exists
  if [[ -d "$SYSTEM_INSTALL_DIR" || -f "$SYSTEM_MANIFEST_32" || -f "$SYSTEM_MANIFEST_64" ]]; then
    echo ""
    echo "Note: A system-wide WebBT Server installation already exists."
    echo "Firefox will prefer this per-user installation for your account."
    echo "To remove the system-wide installation, run:"
    echo "  sudo \"$SYSTEM_INSTALL_DIR/uninstall.sh\""
    echo ""
  fi
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
MANIFEST_PATHS=()
if $SYSTEM_INSTALL; then
  INSTALL_DIR="$SYSTEM_INSTALL_DIR"
  MANIFEST_PATHS+=("$SYSTEM_MANIFEST_32")
  if [[ -d "/usr/lib64" ]]; then
    MANIFEST_PATHS+=("$SYSTEM_MANIFEST_64")
  fi
else
  INSTALL_DIR="$USER_INSTALL_DIR"
  MANIFEST_PATHS+=("$USER_MANIFEST")
fi

mkdir -p "$INSTALL_DIR"

install -m 755 "$BINARY_SRC"                 "$INSTALL_DIR/BLEServer"
install -m 755 "$SCRIPT_DIR/uninstall.sh"    "$INSTALL_DIR/uninstall.sh"

for manifest_path in "${MANIFEST_PATHS[@]}"; do
  mkdir -p "$(dirname "$manifest_path")"
  cat > "$manifest_path" <<EOF
{
  "name": "webbt.server",
  "description": "Web Bluetooth Extension Server",
  "path": "$INSTALL_DIR/BLEServer",
  "type": "stdio",
  "allowed_extensions": [
    "webbt@ff"
  ]
}
EOF
done

# ---------------------------------------------------------------------------
# Sandboxed Firefox detection
# ---------------------------------------------------------------------------

# --- Flatpak Firefox ---
# Flatpak Firefox cannot exec host binaries directly. It needs:
#   1. A wrapper script inside its app data dir that calls flatpak-spawn --host.
#   2. A manifest inside its app data dir pointing to that wrapper.
#   3. The D-Bus permission --talk-name=org.freedesktop.Flatpak so it can
#      call flatpak-spawn. No --filesystem or --system-talk-name=org.bluez
#      overrides are needed: BLEServer runs on the host outside the sandbox
#      and talks to BlueZ directly.
FLATPAK_FIREFOX_INSTALLED=false
if [[ -d "$FLATPAK_FIREFOX_DATA" ]]; then
  FLATPAK_FIREFOX_INSTALLED=true
elif command -v flatpak &>/dev/null && flatpak list --app 2>/dev/null | grep -q 'org.mozilla.firefox'; then
  FLATPAK_FIREFOX_INSTALLED=true
fi

if $FLATPAK_FIREFOX_INSTALLED && ! $SYSTEM_INSTALL; then
  mkdir -p "$FLATPAK_WRAPPER_DIR" "$FLATPAK_MANIFEST_DIR"

  # Wrapper: calls the real host binary via flatpak-spawn --host so it runs
  # outside the Flatpak sandbox with full host BlueZ / D-Bus access.
  cat > "$FLATPAK_WRAPPER" <<'WRAPPER'
#!/bin/bash
exec flatpak-spawn --host "$HOME/.local/share/webbt-server/BLEServer" "$@"
WRAPPER
  chmod 755 "$FLATPAK_WRAPPER"

  cat > "$FLATPAK_MANIFEST" <<EOF
{
  "name": "webbt.server",
  "description": "Web Bluetooth Extension Server",
  "path": "$FLATPAK_WRAPPER",
  "type": "stdio",
  "allowed_extensions": [
    "webbt@ff"
  ]
}
EOF

  echo ""
  echo "Flatpak Firefox detected."
  echo "A launcher wrapper has been installed for Flatpak Firefox."
  log "Applying Flatpak override to allow Firefox to spawn the host process..."
  if flatpak override --user --talk-name=org.freedesktop.Flatpak org.mozilla.firefox 2>/dev/null; then
    log "Flatpak override applied successfully."
  else
    warn "Failed to apply Flatpak override automatically. Please run this command manually:"
    warn "  flatpak override --user --talk-name=org.freedesktop.Flatpak org.mozilla.firefox"
  fi
  echo ""
  echo "Security note: this permission allows Firefox to run processes on your"
  echo "host system, which is how native messaging hosts work, but it reduces"
  echo "the Flatpak sandbox. If you wish to revoke this permission later, run:"
  echo ""
  echo "  flatpak override --user --unset-talk-name=org.freedesktop.Flatpak org.mozilla.firefox"
  echo ""
elif $FLATPAK_FIREFOX_INSTALLED && $SYSTEM_INSTALL; then
  echo ""
  echo "Note: Flatpak Firefox was detected, but system-wide installations are"
  echo "not visible inside the Flatpak sandbox. Re-run this installer as your"
  echo "normal user (without --system and without sudo) to also configure"
  echo "WebBT Server for Flatpak Firefox."
  echo ""
fi

# --- Snap Firefox ---
# Snap Firefox uses xdg-desktop-portal to launch native messaging hosts.
# The manifest at ~/.mozilla/native-messaging-hosts/ is already written above.
# No extra overrides are needed, but the portal must be installed.
SNAP_FIREFOX_INSTALLED=false
if [[ -d "/snap/firefox" ]]; then
  SNAP_FIREFOX_INSTALLED=true
elif command -v snap &>/dev/null && snap list 2>/dev/null | grep -q '^firefox '; then
  SNAP_FIREFOX_INSTALLED=true
fi

if $SNAP_FIREFOX_INSTALLED; then
  # Check whether xdg-desktop-portal is present
  if ! command -v xdg-desktop-portal &>/dev/null && ! systemctl is-active --quiet xdg-desktop-portal 2>/dev/null; then
    echo ""
    echo "Snap Firefox detected."
    echo "Snap Firefox uses xdg-desktop-portal to launch native messaging hosts."
    echo "Ensure it is installed:"
    echo "  sudo apt install xdg-desktop-portal   # Debian / Ubuntu"
    echo "  sudo dnf install xdg-desktop-portal   # Fedora / RHEL"
    echo ""
  fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "WebBT Server for Firefox $PRODUCT_VERSION has been installed."
echo ""
echo "Important: WebBT Server requires the WebBT for Firefox extension:"
echo "  Mozilla Add-ons:   https://addons.mozilla.org/firefox/addon/webbt/"
echo "  Or GitHub Release:  https://github.com/stevennyman/webbt/releases"
echo ""
if $SYSTEM_INSTALL; then
  echo "To uninstall later (all users):"
  echo "  sudo \"$INSTALL_DIR/uninstall.sh\""
else
  echo "To uninstall later:"
  echo "  \"$INSTALL_DIR/uninstall.sh\""
fi
echo ""
