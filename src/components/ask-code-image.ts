import { askCodeImageMimeTypeForPath } from '../../electron/shared/ask-code-image';

/** Whether a clipboard file can be attached to an Ask Code image request. */
export function isSupportedAskCodeImagePath(filePath: string): boolean {
  return askCodeImageMimeTypeForPath(filePath) !== undefined;
}
