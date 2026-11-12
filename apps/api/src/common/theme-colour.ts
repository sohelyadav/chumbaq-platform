import { Matches, ValidationOptions } from 'class-validator';

/**
 * The colour forms campaign theming may use: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()` and `rgba()`.
 *
 * **Adding an HSL picker to the dashboard means widening this pattern first.**
 * `hsl()` and `hsla()` are deliberately absent because nothing emits them and
 * nothing has ever stored one, and a pattern is only worth having if it is
 * tight. If you have arrived here from a 400 on a colour that looks perfectly
 * valid, that is the answer: add the form here, and check the column it is
 * stored in is wide enough for it.
 *
 * A named colour like `red` is refused for the same reason — allowing bare
 * words widens this back to arbitrary text, which is what it replaced.
 *
 * ## Why the server validates a colour at all
 *
 * Because it did run as script, once. The web SDK's renderers used to build
 * markup as strings and escape it with a `textContent` → `innerHTML` round
 * trip, which leaves quotes alone — harmless between tags, useless in the
 * attribute position it was used in — and theme colours were interpolated
 * with no escaping whatever. A `titleColor` of `#000"><img src=q onerror=…>`
 * ran its handler in the host page's origin.
 *
 * Those renderers now assign style properties one at a time, so CSSOM drops a
 * value it cannot parse and the worst a bad colour does is not apply. This is
 * the other half: the half a client cannot forget to apply, the half that
 * holds for the native SDKs and any future renderer that builds a declaration
 * as a string again, and the half that keeps the value out of the database in
 * the first place.
 */
export const THEME_COLOUR =
  /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|[01]?\.\d+)\s*)?\))$/;

/** `@themeColour()` — {@link THEME_COLOUR} as a reusable property decorator. */
export const themeColour = (options?: ValidationOptions) =>
  Matches(THEME_COLOUR, {
    message: '$property must be a hex, rgb() or rgba() colour',
    ...options,
  });
