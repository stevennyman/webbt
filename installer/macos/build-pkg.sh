#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
RESOURCES_DIR="$SCRIPT_DIR/resources"
PRODUCT_VERSION="0.6.0"
OUTPUT_PKG="$BUILD_DIR/WebBT-Server-for-Firefox-$PRODUCT_VERSION.pkg"
ARM64_BINARY="${MACOS_ARM64_BINARY:-$REPO_ROOT/rust_server/target/aarch64-apple-darwin/release/BLEServer}"
X64_BINARY="${MACOS_X64_BINARY:-$REPO_ROOT/rust_server/target/x86_64-apple-darwin/release/BLEServer}"

for binary in "$ARM64_BINARY" "$X64_BINARY"; do
  if [[ ! -f "$binary" ]]; then
    echo "Missing binary: $binary"
    echo "Build with: (cd rust_server && cargo build --release --target aarch64-apple-darwin && cargo build --release --target x86_64-apple-darwin)"
    exit 1
  fi
done

STAGING_DIR=$(mktemp -d)
trap 'rm -rf "$STAGING_DIR"' EXIT
mkdir -p \
  "$STAGING_DIR/staging-arm64/WebBT Server.app/Contents/MacOS" \
  "$STAGING_DIR/staging-arm64/WebBT Server.app/Contents/Resources" \
  "$STAGING_DIR/staging-x86_64/WebBT Server.app/Contents/MacOS" \
  "$STAGING_DIR/staging-x86_64/WebBT Server.app/Contents/Resources" \
  "$STAGING_DIR/scripts" \
  "$BUILD_DIR" \
  "$RESOURCES_DIR"

install -m 755 "$ARM64_BINARY" "$STAGING_DIR/staging-arm64/WebBT Server.app/Contents/MacOS/BLEServer"
install -m 755 "$X64_BINARY"   "$STAGING_DIR/staging-x86_64/WebBT Server.app/Contents/MacOS/BLEServer"
install -m 755 "$SCRIPT_DIR/uninstall.sh" "$STAGING_DIR/staging-arm64/uninstall.sh"
install -m 755 "$SCRIPT_DIR/uninstall.sh" "$STAGING_DIR/staging-x86_64/uninstall.sh"

sed "s/{{PRODUCT_VERSION}}/$PRODUCT_VERSION/g" \
  "$SCRIPT_DIR/Info.plist.template" \
  > "$STAGING_DIR/staging-arm64/WebBT Server.app/Contents/Info.plist"
cp "$STAGING_DIR/staging-arm64/WebBT Server.app/Contents/Info.plist" \
   "$STAGING_DIR/staging-x86_64/WebBT Server.app/Contents/Info.plist"
install -m 644 "$SCRIPT_DIR/AppIcon.icns" \
  "$STAGING_DIR/staging-arm64/WebBT Server.app/Contents/Resources/AppIcon.icns"
cp "$STAGING_DIR/staging-arm64/WebBT Server.app/Contents/Resources/AppIcon.icns" \
   "$STAGING_DIR/staging-x86_64/WebBT Server.app/Contents/Resources/AppIcon.icns"

install -m 755 "$SCRIPT_DIR/scripts/preinstall" "$STAGING_DIR/scripts/preinstall"
install -m 755 "$SCRIPT_DIR/scripts/postinstall" "$STAGING_DIR/scripts/postinstall"

license_title=$(awk 'NF { print; exit }' "$REPO_ROOT/License.txt")
license_title_escaped=$(printf '%s' "$license_title" | sed -e 's/&/&amp;/g' -e 's/</&lt;/g' -e 's/>/&gt;/g')
license_body=$(awk '
  function flush() {
    if (p != "") {
      gsub(/^[ \t]+|[ \t]+$/, "", p)
      print "  <p>" p "</p>"
      p = ""
    }
  }
  {
    if (!title_skipped) {
      if ($0 ~ /^[[:space:]]*$/) {
        next
      }
      title_skipped = 1
      next
    }
    if ($0 ~ /^[[:space:]]*$/) {
      flush()
      next
    }
    line = $0
    gsub(/&/, "&amp;", line)
    gsub(/</, "&lt;", line)
    gsub(/>/, "&gt;", line)
    if (p == "") {
      p = line
    } else {
      p = p " " line
    }
  }
  END { flush() }
' "$REPO_ROOT/License.txt")

cat > "$RESOURCES_DIR/license.html" <<EOF
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 28px; line-height: 1.5; color: #1d1d1f; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    p { margin: 0 0 12px; }
    a { color: #0b57d0; }
  </style>
</head>
<body>
  <h1>$license_title_escaped</h1>
$license_body
</body>
</html>
EOF

cat > "$RESOURCES_DIR/welcome.html" <<EOF
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 28px; line-height: 1.5; color: #1d1d1f; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    p { margin: 0 0 12px; }
    a { color: #0b57d0; }
  </style>
</head>
<body>
  <h1>WebBT Server for Firefox</h1>
  <p>Version $PRODUCT_VERSION</p>
  <p>This is the installer for the native application component needed to use the <a href="https://addons.mozilla.org/firefox/addon/webbt/">WebBT Firefox extension</a>.</p>
  <p>You can install it for the current user or for all users on this Mac.</p>
</body>
</html>
EOF

cat > "$RESOURCES_DIR/conclusion.html" <<EOF
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 28px; line-height: 1.5; color: #1d1d1f; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    p { margin: 0 0 12px; }
    a { color: #0b57d0; }
  </style>
</head>
<body>
  <h1>Installation Complete</h1>
  <p>WebBT Server for Firefox $PRODUCT_VERSION has been installed.</p>
  <p>To uninstall later, run the command for the installation type you chose:</p>
  <p>Current user: <code>"\$HOME/Library/Application Support/WebBT Server for Firefox/uninstall.sh"</code></p>
  <p>All users: <code>sudo "/Library/Application Support/WebBT Server for Firefox/uninstall.sh"</code></p>
  <p><u><b>Important</b></u>: WebBT server requires the <a href="https://addons.mozilla.org/firefox/addon/webbt/">WebBT for Firefox</a> extension installed for Web Bluetooth to be used.</p>
</body>
</html>
EOF

sed "s/{{PRODUCT_VERSION}}/$PRODUCT_VERSION/" \
  "$SCRIPT_DIR/distribution.xml.template" > "$STAGING_DIR/distribution.xml"

pkgbuild \
  --identifier webbt.server.macos.arm64 \
  --version "$PRODUCT_VERSION" \
  --install-location "/Library/Application Support/WebBT Server for Firefox" \
  --root "$STAGING_DIR/staging-arm64" \
  --scripts "$STAGING_DIR/scripts" \
  "$STAGING_DIR/webbt-arm64.pkg"

pkgbuild \
  --identifier webbt.server.macos.x86_64 \
  --version "$PRODUCT_VERSION" \
  --install-location "/Library/Application Support/WebBT Server for Firefox" \
  --root "$STAGING_DIR/staging-x86_64" \
  --scripts "$STAGING_DIR/scripts" \
  "$STAGING_DIR/webbt-x86_64.pkg"

productbuild \
  --distribution "$STAGING_DIR/distribution.xml" \
  --resources "$RESOURCES_DIR" \
  --package-path "$STAGING_DIR" \
  "$OUTPUT_PKG"

echo "Built $OUTPUT_PKG"
