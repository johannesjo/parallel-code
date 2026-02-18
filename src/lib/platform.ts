const isMac = navigator.userAgent.includes("Mac");

/** Display name for the primary modifier key: "Cmd" on macOS, "Ctrl" elsewhere. */
export const mod = isMac ? "Cmd" : "Ctrl";
