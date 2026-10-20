/** Storage keys for agent-published GitHub lists; a leaf so project removal can clear them. */
const KEY_PREFIX = 'github-custom-lists:';

export function githubListsKey(projectId: string, repository: string): string {
  return `${KEY_PREFIX}${projectId}:${repository.toLowerCase()}`;
}

/** Drops every saved list of a removed project; nothing else would ever read them. */
export function forgetGitHubLists(projectId: string): void {
  const prefix = `${KEY_PREFIX}${projectId}:`;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}
