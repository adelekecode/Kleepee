/**
 * Copies the given text to the system clipboard.
 * Throws `NotAllowedError` (DOMException) if clipboard permission is denied;
 * callers are responsible for catching and handling that error.
 */
export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
