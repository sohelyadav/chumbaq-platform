import { logValue } from './log-value';

describe('logValue', () => {
  it('quotes a value so a newline in it cannot start a forged log line', () => {
    const quoted = logValue('a@b.co\n[Nest] 1 - ERROR [Auth] admin logged in');
    expect(quoted).not.toMatch(/[\r\n]/);
    expect(quoted).toBe('"a@b.co\\n[Nest] 1 - ERROR [Auth] admin logged in"');
  });

  it('escapes carriage returns, terminal escapes and Unicode line breaks', () => {
    const quoted = logValue('a\rb\u001b[31mc\u2028d\u2029e\u0085f');
    expect(quoted).not.toMatch(/[\r\n\u001b\u2028\u2029\u0085]/);
    expect(quoted).toBe('"a\\rb\\u001b[31mc\\u2028d\\u2029e\\u0085f"');
  });

  it('keeps at most 320 characters of the value', () => {
    expect(logValue('x'.repeat(1000))).toBe(`"${'x'.repeat(320)}"`);
  });

  it('keeps a longer value when asked, still escaped', () => {
    expect(logValue(`${'x'.repeat(499)}\u2028yy`, 500)).toBe(`"${'x'.repeat(499)}\\u2028"`);
  });

  it('accepts anything, not only strings', () => {
    expect(logValue(undefined)).toBe('"undefined"');
    expect(logValue({ a: 1 })).toBe('"[object Object]"');
  });
});
