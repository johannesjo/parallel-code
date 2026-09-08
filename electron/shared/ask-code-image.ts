/**
 * Extensions the Ask Code image input accepts. This is only a cheap pre-filter
 * so the renderer can reject a paste without touching disk — the MIME type
 * actually sent to the provider is derived from the file's signature bytes.
 */
const ASK_CODE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
]);

/** Whether a file path carries an extension the Ask Code image input accepts. */
export function isSupportedAskCodeImageExtension(filePath: string): boolean {
  const match = /\.[^./\\]+$/.exec(filePath);
  return match !== null && ASK_CODE_IMAGE_EXTENSIONS.has(match[0].toLowerCase());
}
