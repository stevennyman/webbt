#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
PRODUCT_VERSION="0.6.0"
OUTPUT_TARBALL="$BUILD_DIR/WebBT-Server-for-Firefox-$PRODUCT_VERSION-linux.tar.gz"

X86_64_BINARY="${LINUX_X86_64_BINARY:-$REPO_ROOT/rust_server/target/x86_64-unknown-linux-gnu/release/BLEServer}"
AARCH64_BINARY="${LINUX_AARCH64_BINARY:-$REPO_ROOT/rust_server/target/aarch64-unknown-linux-gnu/release/BLEServer}"
I686_BINARY="${LINUX_I686_BINARY:-$REPO_ROOT/rust_server/target/i686-unknown-linux-gnu/release/BLEServer}"

missing=0
for entry in \
  "x86_64-unknown-linux-gnu:$X86_64_BINARY" \
  "aarch64-unknown-linux-gnu:$AARCH64_BINARY" \
  "i686-unknown-linux-gnu:$I686_BINARY"
do
  target="${entry%%:*}"
  binary="${entry#*:}"
  if [[ ! -f "$binary" ]]; then
    echo "Missing binary for $target: $binary"
    echo "  Build with: (cd rust_server && cargo build --release --target $target)"
    missing=1
  fi
done
if [[ "$missing" -eq 1 ]]; then
  exit 1
fi

STAGING_DIR=$(mktemp -d)
trap 'rm -rf "$STAGING_DIR"' EXIT

STAGE="$STAGING_DIR/webbt-server"
mkdir -p "$STAGE/bin" "$BUILD_DIR"

install -m 755 "$X86_64_BINARY"  "$STAGE/bin/BLEServer-x86_64"
install -m 755 "$AARCH64_BINARY" "$STAGE/bin/BLEServer-aarch64"
install -m 755 "$I686_BINARY"    "$STAGE/bin/BLEServer-i686"

install -m 755 "$SCRIPT_DIR/scripts/install.sh"   "$STAGE/install.sh"
install -m 755 "$SCRIPT_DIR/scripts/uninstall.sh" "$STAGE/uninstall.sh"
install -m 644 "$SCRIPT_DIR/README.txt"           "$STAGE/README.txt"
install -m 644 "$REPO_ROOT/License.txt"           "$STAGE/LICENSE.txt"

tar -czf "$OUTPUT_TARBALL" -C "$STAGING_DIR" webbt-server

echo "Built $OUTPUT_TARBALL"
