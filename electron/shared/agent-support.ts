/** Kimi's project MCP/trust flow is only supported by the pinned Docker image. */
export function isAgentSupportedInMode(command: string, dockerMode = false): boolean {
  return dockerMode || command.split('/').pop() !== 'kimi';
}
