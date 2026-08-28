#!/usr/bin/env bash
set -euo pipefail

# Ensure we are in the script's directory
cd "$(dirname "$0")"

echo "Building aarch64-apple-darwin..."
cargo build --release --target=aarch64-apple-darwin

echo "Building x86_64-apple-darwin..."
cargo build --release --target=x86_64-apple-darwin

echo "All macOS builds completed successfully!"
