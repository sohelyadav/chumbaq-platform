const HIDDEN = '***';
const HIDDEN_DIGITS = '******';

/**
 * An end user's email or phone as the activity log may hold it: enough for a team member
 * to recognise an address they already have, too little to recover it. The run of stars
 * is fixed, so the hidden part's length isn't shown either.
 *
 * - `sam@example.com` → `s***@example.com` (first character, then the domain);
 * - `+919876543221` → `+91******21` (the plus, the first two digits, the last two);
 * - anything else → `***`.
 */
export function maskAddress(address: string): string {
  const value = address.trim();

  const at = value.lastIndexOf('@');
  if (at > 0 && at < value.length - 1 && !/\s/.test(value)) {
    return `${Array.from(value)[0]}${HIDDEN}${value.slice(at)}`;
  }

  // E.164 has at most 15 digits. Eight or more, so the four shown are never most of it.
  const phone = value.replace(/[\s().-]/g, '');
  if (/^\+\d{8,15}$/.test(phone)) {
    return `+${phone.slice(1, 3)}${HIDDEN_DIGITS}${phone.slice(-2)}`;
  }

  return HIDDEN;
}
