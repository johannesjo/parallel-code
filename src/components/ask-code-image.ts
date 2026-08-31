const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Whether a clipboard file can be attached to an Ask Code image request. */
export function isSupportedAskCodeImagePath(filePath: string): boolean {
  const match = /\.[^./\\]+$/.exec(filePath);
  return match ? SUPPORTED_IMAGE_EXTENSIONS.has(match[0].toLowerCase()) : false;
}
