import { GST_STATE_CODES, gstinMatchesState, isValidGstin, normaliseGstin } from './gstin';

describe('GSTIN', () => {
  it('accepts a well-formed GSTIN', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
  });

  it('refuses a lowercase copy until it is normalised', () => {
    expect(isValidGstin('27aapfu0939f1zv')).toBe(false);
    expect(isValidGstin(normaliseGstin(' 27aapfu0939f1zv '))).toBe(true);
  });

  it.each([
    ['14 characters', '27AAPFU0939F1Z'],
    ['16 characters', '27AAPFU0939F1ZVX'],
    ['a state code that does not exist', '00AAPFU0939F1ZV'],
    ['state 39', '39AAPFU0939F1ZV'],
    ['no Z in the 14th place', '27AAPFU0939F1YV'],
    ['a zero entity number', '27AAPFU0939F0ZV'],
    ['digits where the PAN has letters', '2712345U0939F1ZV'],
  ])('refuses %s', (_name, value) => {
    expect(isValidGstin(value)).toBe(false);
  });

  it('accepts the other-territory code 97', () => {
    expect(isValidGstin('97AAPFU0939F1ZV')).toBe(true);
  });

  it('matches a GSTIN to its state by the first two digits', () => {
    expect(gstinMatchesState('27AAPFU0939F1ZV', '27')).toBe(true);
    expect(gstinMatchesState('27AAPFU0939F1ZV', '29')).toBe(false);
  });

  it('lists 01 to 38 and 97', () => {
    expect(GST_STATE_CODES).toHaveLength(39);
    expect(GST_STATE_CODES[0]).toBe('01');
    expect(GST_STATE_CODES).toContain('38');
    expect(GST_STATE_CODES).toContain('97');
    expect(GST_STATE_CODES).not.toContain('00');
  });
});
