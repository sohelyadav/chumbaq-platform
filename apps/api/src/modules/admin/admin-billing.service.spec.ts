import { netOfTax } from '../billing/money';
import { keptMoney, summariseMoney } from './admin-billing.service';

describe('admin billing arithmetic', () => {
  it('MRR is the floor of the annualised sum over twelve, excluding GST, with the GST derived', () => {
    const { mrr, arr, byPlan } = summariseMoney([
      { planCode: 'a', interval: 'monthly', pricePaise: 99900, amountPaise: 117882 },
      { planCode: 'a', interval: 'monthly', pricePaise: 99900, amountPaise: 117882 },
      { planCode: 'b', interval: 'yearly', pricePaise: 999000, amountPaise: 1178820 },
    ]);
    expect(arr).toEqual({ netPaise: 3396600, grossPaise: 4007988, taxPaise: 4007988 - 3396600 });
    expect(mrr).toEqual({ netPaise: 283050, grossPaise: 333999, taxPaise: 333999 - 283050 });
    expect(mrr.netPaise).toBe(Math.floor((2 * 99900 * 12 + 999000) / 12));
    expect(byPlan.get('a')).toEqual({ accounts: 2, mrrNetPaise: 199800 });
    expect(byPlan.get('b')).toEqual({ accounts: 1, mrrNetPaise: 83250 });
  });

  it('divides once, after summing, so small yearly prices are not rounded away one by one', () => {
    const { mrr, byPlan } = summariseMoney([
      { planCode: 'y', interval: 'yearly', pricePaise: 100, amountPaise: 118 },
      { planCode: 'y', interval: 'yearly', pricePaise: 100, amountPaise: 118 },
      { planCode: 'y', interval: 'yearly', pricePaise: 100, amountPaise: 118 },
    ]);
    expect(mrr.netPaise).toBe(25);
    expect(mrr.grossPaise).toBe(29);
    expect(byPlan.get('y')).toEqual({ accounts: 3, mrrNetPaise: 25 });
  });

  it('is zero for no subscriptions', () => {
    const { mrr, arr, byPlan } = summariseMoney([]);
    expect(mrr).toEqual({ netPaise: 0, taxPaise: 0, grossPaise: 0 });
    expect(arr).toEqual({ netPaise: 0, taxPaise: 0, grossPaise: 0 });
    expect(byPlan.size).toBe(0);
  });

  it('a payment keeps what was not refunded, split by its GST rate', () => {
    const kept = keptMoney({ amountPaise: 117882, refundedPaise: 17882, taxRateBps: 1800 });
    expect(kept).toEqual({ grossPaise: 100000, netPaise: netOfTax(100000, 1800), taxPaise: 100000 - netOfTax(100000, 1800) });
    expect(keptMoney({ amountPaise: 117882, refundedPaise: 0, taxRateBps: 1800 })).toEqual({
      grossPaise: 117882,
      netPaise: 99900,
      taxPaise: 17982,
    });
    expect(keptMoney({ amountPaise: 117882, refundedPaise: 117882, taxRateBps: 1800 })).toEqual({
      grossPaise: 0,
      netPaise: 0,
      taxPaise: 0,
    });
  });
});
