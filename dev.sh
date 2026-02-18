#!/usr/bin/env bash
set -euo pipefail

# Strip AppImage environment variables so Tauri dev uses system libraries.
# Without this, running `tauri dev` from inside the AppImage causes WebKit
# to resolve subprocess paths relative to the AppImage mount point.
if [ -n "${APPDIR:-}" ]; then
    echo "Detected AppImage environment, cleaning env vars..."
    unset APPDIR APPIMAGE LD_LIBRARY_PATH
    unset GDK_PIXBUF_MODULE_FILE GIO_EXTRA_MODULES
    unset GSETTINGS_SCHEMA_DIR GST_PLUGIN_SYSTEM_PATH GST_PLUGIN_SYSTEM_PATH_1_0
    unset GTK_DATA_PREFIX GTK_EXE_PREFIX GTK_IM_MODULE_FILE GTK_PATH
    unset PERLLIB PYTHONHOME PYTHONPATH QT_PLUGIN_PATH

    # Filter AppImage mount paths from PATH and XDG_DATA_DIRS
    PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '.mount_parallel-cod' | tr '\n' ':' | sed 's/:$//')
    XDG_DATA_DIRS=$(echo "${XDG_DATA_DIRS:-}" | tr ':' '\n' | grep -v '.mount_parallel-cod' | tr '\n' ':' | sed 's/:$//')
    export PATH XDG_DATA_DIRS
fi

exec pnpm tauri dev "$@"
