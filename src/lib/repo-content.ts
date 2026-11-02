/** Repository text must not be able to close the data block it sits in. */
export function repoContent(text: string): string {
  const safe = text.replace(/<\/?repo-content/gi, (tag) => tag.replace('<', '&lt;'));
  return `<repo-content>\n${safe}\n</repo-content>`;
}
