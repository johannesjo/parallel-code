#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

cd "$SCRIPT_DIR"

case "$OS" in
    Darwin)
        echo "Building release for macOS..."
        rm -f "$SCRIPT_DIR"/release/*.dmg
        npm run build:frontend && npm run compile && npx electron-builder --config.mac.identity=null

        DMG_FILE=$(find "$SCRIPT_DIR/release" -name '*.dmg' -type f | head -1)

        if [ -z "$DMG_FILE" ]; then
            echo "Error: no .dmg found in release/"
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
        echo "Building release for Linux..."
        rm -f "$SCRIPT_DIR"/release/*.deb
        npm run build

        DEB_FILE=$(find "$SCRIPT_DIR/release" -name '*.deb' -type f | head -1)

        if [ -z "$DEB_FILE" ]; then
            echo "Error: no .deb found in release/"
            exit 1
        fi

        echo "Installing $DEB_FILE..."
        sudo dpkg -i "$DEB_FILE"

        echo "Installed successfully via dpkg"
        ;;

    *)
        echo "Error: unsupported OS '$OS'"
        exit 1
        ;;
esac
