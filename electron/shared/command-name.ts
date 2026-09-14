/** Basename of a CLI command on either host OS, without Windows shim suffixes. */
export function commandName(command: string): string {
  return (command.split(/[\\/]/).filter(Boolean).pop() ?? command)
    .replace(/\.(cmd|exe|bat)$/i, '')
    .toLowerCase();
}
