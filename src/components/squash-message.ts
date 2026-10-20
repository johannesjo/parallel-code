import type { CommitInfo } from '../ipc/types';

export interface SquashMessage {
  title: string;
  body: string;
}

const CO_AUTHOR = /^co-authored-by:\s*(.+)$/i;

/**
 * Default squash commit message, the way GitHub builds it: a single commit
 * keeps its own title and body; several commits get `fallbackTitle` and a
 * `* subject` list with each body. Co-authored-by trailers move to the end,
 * deduplicated, because git only reads trailers in the last paragraph.
 */
export function buildSquashMessage(commits: CommitInfo[], fallbackTitle: string): SquashMessage {
  const coAuthors = new Map<string, string>();
  const stripCoAuthors = (body: string) =>
    body
      .split('\n')
      .filter((line) => {
        const match = CO_AUTHOR.exec(line.trim());
        if (!match) return true;
        const author = match[1].trim();
        if (!coAuthors.has(author.toLowerCase()))
          coAuthors.set(author.toLowerCase(), `Co-authored-by: ${author}`);
        return false;
      })
      .join('\n')
      .trim();

  const only = commits.length === 1 ? commits[0] : undefined;
  const title = only ? only.message : fallbackTitle;
  const parts = only
    ? [stripCoAuthors(only.body ?? '')]
    : commits.map((commit) => {
        const body = stripCoAuthors(commit.body ?? '');
        return body ? `* ${commit.message}\n\n${body}` : `* ${commit.message}`;
      });
  const trailers = [...coAuthors.values()].join('\n');
  const body = [...parts, trailers].filter(Boolean).join('\n\n');
  return { title: title.trim(), body };
}

/** Joins title and body into the message `git commit -m` takes. */
export function formatSquashMessage(message: SquashMessage): string {
  const body = message.body.trim();
  return body ? `${message.title.trim()}\n\n${body}` : message.title.trim();
}
