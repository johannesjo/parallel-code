#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEB_DIR="$SCRIPT_DIR/src-tauri/target/release/bundle/deb"

echo "Building release..."
cd "$SCRIPT_DIR"
pnpm tauri build --bundles deb

DEB_FILE=$(find "$DEB_DIR" -name '*.deb' -type f | head -1)

if [ -z "$DEB_FILE" ]; then
    echo "Error: no .deb found in $DEB_DIR"
    exit 1
fi

echo "Installing $DEB_FILE..."
sudo dpkg -i "$DEB_FILE"
