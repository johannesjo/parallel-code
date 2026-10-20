/** How much of a provider's error output is kept for display and logs. */
export const PROVIDER_ERROR_CHARS = 4_000;

/**
 * Why a model CLI failed: what it printed to stderr and stdout, else
 * `fallback`. Both are kept because the Claude CLI prints API errors and usage
 * limits to stdout in text mode, while stderr may hold only an unrelated
 * warning or a tagged error code. Stderr leads: providers that stream model
 * output to stdout would otherwise push their error past the length cap.
 */
export function providerFailureMessage(stderr: string, stdout: string, fallback: string): string {
  const printed = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
  return printed.slice(0, PROVIDER_ERROR_CHARS) || fallback;
}
