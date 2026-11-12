import { maskAddress } from './mask-address';

describe('maskAddress', () => {
  it('keeps the first character of an email and its domain', () => {
    expect(maskAddress('Sam@x.com')).toBe('S***@x.com');
    expect(maskAddress('a@example.com')).toBe('a***@example.com');
    expect(maskAddress('  priya.sharma@acme.co.in ')).toBe('p***@acme.co.in');
  });

  it('keeps a phone number’s plus, first two digits and last two, with a fixed run of stars', () => {
    expect(maskAddress('+919876543221')).toBe('+91******21');
    expect(maskAddress('+1 415 555 0132')).toBe('+14******32');
  });

  it('hides the length of the hidden part', () => {
    expect(maskAddress('+4479460000099')).toBe('+44******99');
    expect(maskAddress('verylonglocalpart@x.com')).toBe('v***@x.com');
  });

  it.each(['', '   ', 'not an address', '@x.com', 'sam@', '9876543221', '+12345', 'device-token-abc'])(
    'gives %p only stars',
    (value) => {
      expect(maskAddress(value)).toBe('***');
    },
  );

  it('never returns the unmasked local part or national number', () => {
    expect(maskAddress('secret-name@x.com')).not.toContain('secret-name');
    expect(maskAddress('+919876543221')).not.toContain('98765432');
  });
});
