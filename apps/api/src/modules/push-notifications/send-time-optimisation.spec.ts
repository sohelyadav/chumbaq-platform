import {
  bestHourPerDevice,
  groupBySendHour,
  hourToLocalTime,
  MIN_CLICKS_FOR_A_HABIT,
  DEFAULT_SEND_HOUR,
} from './send-time-optimisation';

describe('send-time optimisation', () => {
  describe('bestHourPerDevice', () => {
    it('picks the hour a device clicks most', () => {
      const best = bestHourPerDevice([
        { deviceIdentityId: 'd1', hour: 9, clicks: 2 },
        { deviceIdentityId: 'd1', hour: 19, clicks: 7 },
      ]);
      expect(best.get('d1')).toBe(19);
    });

    it('returns null when there is not enough history to call it a habit', () => {
      const best = bestHourPerDevice([
        { deviceIdentityId: 'd1', hour: 19, clicks: MIN_CLICKS_FOR_A_HABIT - 1 },
      ]);
      // The caller must be able to tell "opens things at 7pm" from "we are
      // guessing" — presenting a guess as a personalised time is the kind of
      // claim that erodes trust in the whole feature.
      expect(best.get('d1')).toBeNull();
    });

    it('counts clicks across hours toward the threshold', () => {
      const best = bestHourPerDevice([
        { deviceIdentityId: 'd1', hour: 8, clicks: 1 },
        { deviceIdentityId: 'd1', hour: 9, clicks: 1 },
        { deviceIdentityId: 'd1', hour: 20, clicks: 1 },
      ]);
      // Three clicks total is a habit even though no single hour has three.
      expect(best.get('d1')).toBe(8);
    });

    it('breaks ties to the earlier hour', () => {
      const best = bestHourPerDevice([
        { deviceIdentityId: 'd1', hour: 21, clicks: 3 },
        { deviceIdentityId: 'd1', hour: 8, clicks: 3 },
      ]);
      // No reason to prefer either; the earlier slot leaves more of the day
      // for a follow-up.
      expect(best.get('d1')).toBe(8);
    });

    it('keeps devices independent', () => {
      const best = bestHourPerDevice([
        { deviceIdentityId: 'd1', hour: 7, clicks: 5 },
        { deviceIdentityId: 'd2', hour: 22, clicks: 4 },
      ]);
      expect(best.get('d1')).toBe(7);
      expect(best.get('d2')).toBe(22);
    });

    it('handles an empty history', () => {
      expect(bestHourPerDevice([]).size).toBe(0);
    });
  });

  describe('groupBySendHour', () => {
    it('groups devices by their own best hour', () => {
      const best = new Map<string, number | null>([
        ['d1', 7],
        ['d2', 19],
        ['d3', 7],
      ]);
      const grouped = groupBySendHour(['d1', 'd2', 'd3'], best);

      expect(grouped.get(7)).toEqual(['d1', 'd3']);
      expect(grouped.get(19)).toEqual(['d2']);
    });

    it('sends devices with no habit at the fallback hour', () => {
      const best = new Map<string, number | null>([['d1', null]]);
      const grouped = groupBySendHour(['d1', 'd2'], best, 10);

      // Optimisation refines *when* a campaign goes out, never *who* receives
      // it — nobody is dropped for lacking history.
      expect(grouped.get(10)).toEqual(['d1', 'd2']);
    });

    it('loses nobody', () => {
      const audience = Array.from({ length: 50 }, (_, i) => `d${i}`);
      const best = new Map<string, number | null>(
        audience.map((id, i) => [id, i % 3 === 0 ? i % 24 : null]),
      );
      const grouped = groupBySendHour(audience, best);

      const assigned = [...grouped.values()].flat();
      expect(assigned).toHaveLength(audience.length);
      expect(new Set(assigned).size).toBe(audience.length);
    });

    it('defaults to a sensible hour when none is given', () => {
      const grouped = groupBySendHour(['d1'], new Map());
      expect(grouped.get(DEFAULT_SEND_HOUR)).toEqual(['d1']);
    });
  });

  describe('hourToLocalTime', () => {
    it('zero-pads to the HH:MM the scheduler expects', () => {
      expect(hourToLocalTime(7)).toBe('07:00');
      expect(hourToLocalTime(19)).toBe('19:00');
      expect(hourToLocalTime(0)).toBe('00:00');
    });
  });
});
