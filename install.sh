#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

cd "$SCRIPT_DIR"

case "$OS" in
    Darwin)
        DMG_DIR="$SCRIPT_DIR/src-tauri/target/release/bundle/dmg"

        echo "Building release for macOS..."
        npm run tauri build -- --bundles dmg

        DMG_FILE=$(find "$DMG_DIR" -name '*.dmg' -type f | head -1)

        if [ -z "$DMG_FILE" ]; then
            echo "Error: no .dmg found in $DMG_DIR"
            exit 1
        fi

        echo "Mounting $DMG_FILE..."
        MOUNT_DIR=$(hdiutil attach "$DMG_FILE" -nobrowse | tail -1 | sed 's/.*[[:space:]]\/Volumes/\/Volumes/')
        APP_FILE=$(find "$MOUNT_DIR" -name '*.app' -maxdepth 1 | head -1)

        if [ -z "$APP_FILE" ]; then
            echo "Error: no .app found in mounted DMG"
            hdiutil detach "$MOUNT_DIR"
            exit 1
        fi

        echo "Installing to /Applications..."
        cp -R "$APP_FILE" /Applications/
        hdiutil detach "$MOUNT_DIR"

        echo "Installed successfully to /Applications/"
        ;;

    Linux)
        DEB_DIR="$SCRIPT_DIR/src-tauri/target/release/bundle/deb"

        echo "Building release for Linux..."
        npm run tauri build -- --bundles deb

        DEB_FILE=$(find "$DEB_DIR" -name '*.deb' -type f | head -1)

        if [ -z "$DEB_FILE" ]; then
            echo "Error: no .deb found in $DEB_DIR"
            exit 1
        fi

        echo "Installing $DEB_FILE..."
        sudo dpkg -i "$DEB_FILE"
        ;;

    *)
        echo "Error: unsupported OS '$OS'"
        exit 1
        ;;
esac
