export const ASK_CODE_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Return the supported image MIME type for a file path, if any. */
export function askCodeImageMimeTypeForPath(filePath: string): string | undefined {
  const match = /\.[^./\\]+$/.exec(filePath);
  return match ? ASK_CODE_IMAGE_MIME_TYPES[match[0].toLowerCase()] : undefined;
}
