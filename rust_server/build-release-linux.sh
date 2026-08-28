#!/usr/bin/env bash
set -euo pipefail

# Ensure we are in the script's directory
cd "$(dirname "$0")"

echo "Building x86_64-unknown-linux-gnu..."
cargo build --release --target=x86_64-unknown-linux-gnu

echo "Building aarch64-unknown-linux-gnu..."
cargo build --release --target=aarch64-unknown-linux-gnu

echo "Building i686-unknown-linux-gnu..."
cargo build --release --target=i686-unknown-linux-gnu

echo "All Linux builds completed successfully!"
