const PR_LINK_PATTERN = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** The last GitHub pull request URL in terminal or chat output, without Markdown or URL decoration. */
export function lastPrintedPrUrl(text: string): string | undefined {
  if (!text.includes('/pull/')) return;
  const links = text.match(PR_LINK_PATTERN);
  return links?.[links.length - 1];
}
