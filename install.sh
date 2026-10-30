#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

usage() {
    cat <<EOF
Usage: $0 [--no-install]

Build and install Parallel Code locally.

Options:
  --no-install  Build the package without installing it (Linux only).
EOF
}

NO_INSTALL=0
for arg in "$@"; do
    case "$arg" in
        --no-install)
            NO_INSTALL=1
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Error: unknown option '$arg'" >&2
            usage >&2
            exit 1
            ;;
    esac
done

cd "$SCRIPT_DIR"

case "$OS" in
    Darwin)
        if [ "$NO_INSTALL" = "1" ]; then
            echo "Note: --no-install is only supported on Linux; continuing with the macOS install."
        fi

        echo "Building release for macOS..."
        rm -f "$SCRIPT_DIR"/release/*.dmg
        npm run build:frontend && npm run build:remote && npm run compile && npm run build:mcp && npx electron-builder --config.mac.identity=null

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

        APP_NAME=$(basename "$APP_FILE")
        echo "Installing to /Applications..."
        rm -rf "/Applications/$APP_NAME"
        cp -R "$APP_FILE" /Applications/
        hdiutil detach "$MOUNT_DIR"

        echo "Installed successfully to /Applications/"
        ;;

    Linux)
        echo "Building release for Linux..."

        if command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
            RPM_BASED=1
        else
            RPM_BASED=0
        fi

        if [ "$RPM_BASED" = "1" ] && ! command -v rpmbuild >/dev/null 2>&1; then
            echo "Error: rpmbuild is required to build the rpm package." >&2
            echo "Install it first, for example with 'sudo dnf install rpm-build' or 'sudo zypper install rpm-build'." >&2
            exit 1
        fi

        rm -f "$SCRIPT_DIR"/release/*.deb "$SCRIPT_DIR"/release/*.rpm

        if [ "$RPM_BASED" = "1" ]; then
            npm run build -- --linux rpm --publish never

            RPM_FILE=$(find "$SCRIPT_DIR/release" -name '*.rpm' -type f | head -1)

            if [ -z "$RPM_FILE" ]; then
                echo "Error: no .rpm found in release/"
                exit 1
            fi

            if [ "$NO_INSTALL" = "1" ]; then
                echo "Built $RPM_FILE (not installed)."
                exit 0
            fi

            echo "Installing $RPM_FILE..."
            if command -v dnf >/dev/null 2>&1; then
                sudo dnf install "$RPM_FILE"
            else
                sudo zypper install "$RPM_FILE"
            fi

            echo "Installed successfully"
        else
            npm run build -- --linux AppImage deb --publish never

            DEB_FILE=$(find "$SCRIPT_DIR/release" -name '*.deb' -type f | head -1)

            if [ -z "$DEB_FILE" ]; then
                echo "Error: no .deb found in release/"
                exit 1
            fi

            if [ "$NO_INSTALL" = "1" ]; then
                echo "Built $DEB_FILE (not installed)."
                exit 0
            fi

            echo "Installing $DEB_FILE..."
            sudo dpkg -i "$DEB_FILE"

            echo "Installed successfully via dpkg"
        fi
        ;;

    *)
        echo "Error: unsupported OS '$OS'"
        exit 1
        ;;
esac
