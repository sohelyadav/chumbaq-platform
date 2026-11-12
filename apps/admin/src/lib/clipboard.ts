/**
 * Copies text, reporting failure instead of rejecting.
 *
 * `navigator.clipboard` is missing outside a secure context (plain HTTP on a
 * LAN host) and its write is refused without permission. Where the text is a
 * secret shown once, a silent failure means the person closes the dialog
 * believing they have something they do not, so callers must say so.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | null | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
