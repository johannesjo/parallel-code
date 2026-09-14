/** Host filesystem paths arrive over IPC; keep this browser-safe. */
export function hostBasename(value: string): string {
  const parts = value.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

export function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}
