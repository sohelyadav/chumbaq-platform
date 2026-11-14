import { annualisedPaise, assertPaise, formatRupees, GST_RATE_BPS, gstInclusive, netOfTax } from './money';

describe('money', () => {
  it('adds GST rounded half up', () => {
    expect(gstInclusive(99900, 1800)).toBe(117882);
    expect(gstInclusive(1, 1800)).toBe(1); // 0.18 rounds down
    expect(gstInclusive(3, 1800)).toBe(4); // 0.54 rounds up
    expect(gstInclusive(25, 200)).toBe(26); // exactly 0.5 rounds up
    expect(gstInclusive(24, 200)).toBe(24); // 0.48 rounds down
    expect(gstInclusive(100, 0)).toBe(100);
    expect(gstInclusive(100, 10000)).toBe(200);
    expect(GST_RATE_BPS).toBe(1800);
  });

  it('takes GST back out', () => {
    expect(netOfTax(117882, 1800)).toBe(99900);
    expect(netOfTax(4, 1800)).toBe(3);
    expect(netOfTax(100, 0)).toBe(100);
  });

  it('netOfTax inverts gstInclusive', () => {
    for (let p = 1; p <= 200_000; p++) {
      if (netOfTax(gstInclusive(p, GST_RATE_BPS), GST_RATE_BPS) !== p) {
        throw new Error(`netOfTax(gstInclusive(${p})) !== ${p}`);
      }
    }
    // A fixed-seed generator, so a failure names a price that can be rerun.
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    for (let i = 0; i < 10_000; i++) {
      const p = 1 + Math.floor(next() * 1_000_000_000);
      expect([p, netOfTax(gstInclusive(p, GST_RATE_BPS), GST_RATE_BPS)]).toEqual([p, p]);
    }
    for (const bps of [0, 1, 500, 1200, 2800, 9999, 10000]) {
      for (const p of [1, 2, 3, 7, 99, 100, 101, 99_999, 123_456_789]) {
        expect([bps, p, netOfTax(gstInclusive(p, bps), bps)]).toEqual([bps, p, p]);
      }
    }
  });

  it('stays exact for large amounts', () => {
    // Computed in arbitrary precision: 4503599627370 * 1800 + 5000, divided by 10000.
    const p = 4_503_599_627_370;
    expect(gstInclusive(p, 1800)).toBe(p + 810_647_932_927);
    expect(netOfTax(gstInclusive(p, 1800), 1800)).toBe(p);
  });

  it('annualises a price', () => {
    expect(annualisedPaise(1000, 'monthly')).toBe(12000);
    expect(annualisedPaise(1000, 'yearly')).toBe(1000);
  });

  it('refuses anything that is not a whole, non-negative, safe number of paise', () => {
    for (const bad of [1.5, -1, 2 ** 53, NaN, Infinity, -0.5]) {
      expect(() => assertPaise(bad)).toThrow();
    }
    expect(() => assertPaise(0)).not.toThrow();
    expect(() => assertPaise(Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(() => gstInclusive(1.5, 1800)).toThrow();
    expect(() => gstInclusive(100, 10001)).toThrow();
    expect(() => gstInclusive(100, -1)).toThrow();
    expect(() => netOfTax(-1, 1800)).toThrow();
    expect(() => annualisedPaise(0.1, 'monthly')).toThrow();
    // A result past the safe range is refused rather than returned rounded.
    expect(() => gstInclusive(Number.MAX_SAFE_INTEGER, 1800)).toThrow();
  });

  it('formats paise as rupees with Indian grouping, exactly', () => {
    expect(formatRupees(117882)).toBe('₹1,178.82');
    expect(formatRupees(5)).toBe('₹0.05');
    expect(formatRupees(0)).toBe('₹0.00');
    expect(formatRupees(1234567800)).toBe('₹1,23,45,678.00');
    expect(formatRupees(10000000)).toBe('₹1,00,000.00');
    expect(formatRupees(-117882)).toBe('-₹1,178.82');
    expect(() => formatRupees(1.5)).toThrow();
  });
});
