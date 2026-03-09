export const isMac = navigator.userAgent.includes('Mac');
export const isLinux = navigator.userAgent.includes('Linux');

/** Display name for the primary modifier key: "Cmd" on macOS, "Ctrl" elsewhere. */
export const mod = isMac ? 'Cmd' : 'Ctrl';

/** Display name for the Alt/Option key: "Opt" on macOS, "Alt" elsewhere. */
export const alt = isMac ? 'Opt' : 'Alt';
