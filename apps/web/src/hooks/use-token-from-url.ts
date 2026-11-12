import { useEffect, useState } from 'react';
import { readTokenFromUrl, removeTokenFromUrl } from '@/lib/account-links';

/**
 * The token from a reset or verify link's fragment, taken out of the address bar so it
 * is not left in history or copied from there. Removed in an effect and not while
 * rendering: StrictMode renders twice, and the second would find nothing left to read.
 */
export function useTokenFromUrl(): string | null {
  const [token] = useState(() => readTokenFromUrl(window));
  useEffect(() => removeTokenFromUrl(window), []);
  return token;
}
