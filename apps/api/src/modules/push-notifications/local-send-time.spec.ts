import {
  shiftOutOfQuietHours,
  isValidLocalTime,
  isValidTimezone,
  zonedTimeToUtc,
  localDateIn,
  nextLocalOccurrence,
} from './local-send-time';

/** Reads an instant back as a wall clock in a zone, for asserting round trips. */
function wallClockIn(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
}

describe('local send time', () => {
  describe('validation', () => {
    it.each(['00:00', '09:30', '23:59'])('accepts %s', (value) => {
      expect(isValidLocalTime(value)).toBe(true);
    });

    it.each(['24:00', '9:30', '09:60', '', 'noon', '09:30:00'])(
      'rejects %s',
      (value) => {
        expect(isValidLocalTime(value)).toBe(false);
      },
    );

    it('accepts real IANA zones and rejects invented ones', () => {
      expect(isValidTimezone('Asia/Kolkata')).toBe(true);
      expect(isValidTimezone('America/Sao_Paulo')).toBe(true);
      expect(isValidTimezone('Mars/Olympus')).toBe(false);
    });
  });

  describe('zonedTimeToUtc', () => {
    it('resolves a half-hour-offset zone correctly', () => {
      // Asia/Kolkata is UTC+5:30 with no DST, so 09:00 local is 03:30 UTC.
      const instant = zonedTimeToUtc(
        { year: 2026, month: 6, day: 15 },
        '09:00',
        'Asia/Kolkata',
      );
      expect(instant.toISOString()).toBe('2026-06-15T03:30:00.000Z');
    });

    it('resolves a whole-hour zone with no DST', () => {
      // Asia/Dubai is UTC+4 year round.
      const instant = zonedTimeToUtc(
        { year: 2026, month: 1, day: 5 },
        '09:00',
        'Asia/Dubai',
      );
      expect(instant.toISOString()).toBe('2026-01-05T05:00:00.000Z');
    });

    it('accounts for daylight saving, which a fixed offset would get wrong', () => {
      // New York is UTC-5 in January and UTC-4 in July. Both must read 09:00
      // locally — a naive fixed offset would be an hour out in one of them.
      const winter = zonedTimeToUtc(
        { year: 2026, month: 1, day: 15 },
        '09:00',
        'America/New_York',
      );
      const summer = zonedTimeToUtc(
        { year: 2026, month: 7, day: 15 },
        '09:00',
        'America/New_York',
      );

      expect(winter.toISOString()).toBe('2026-01-15T14:00:00.000Z');
      expect(summer.toISOString()).toBe('2026-07-15T13:00:00.000Z');
      expect(wallClockIn(winter, 'America/New_York')).toBe('09:00');
      expect(wallClockIn(summer, 'America/New_York')).toBe('09:00');
    });

    it('handles a southern-hemisphere zone whose DST runs the other way', () => {
      const jan = zonedTimeToUtc(
        { year: 2026, month: 1, day: 15 },
        '09:00',
        'Australia/Sydney',
      );
      const jul = zonedTimeToUtc(
        { year: 2026, month: 7, day: 15 },
        '09:00',
        'Australia/Sydney',
      );
      expect(wallClockIn(jan, 'Australia/Sydney')).toBe('09:00');
      expect(wallClockIn(jul, 'Australia/Sydney')).toBe('09:00');
      // Sydney is UTC+11 in January and UTC+10 in July, so the UTC instants differ.
      expect(jan.toISOString()).not.toBe(jul.toISOString());
    });

    it('lands on the right wall clock the day a zone springs forward', () => {
      // US DST begins 2026-03-08. 09:00 is safely after the 02:00 jump, but
      // the offset measured before the transition is the wrong one — this is
      // exactly what the second correction pass exists for.
      const instant = zonedTimeToUtc(
        { year: 2026, month: 3, day: 8 },
        '09:00',
        'America/New_York',
      );
      expect(wallClockIn(instant, 'America/New_York')).toBe('09:00');
    });

    it('lands on the right wall clock the day a zone falls back', () => {
      const instant = zonedTimeToUtc(
        { year: 2026, month: 11, day: 1 },
        '09:00',
        'America/New_York',
      );
      expect(wallClockIn(instant, 'America/New_York')).toBe('09:00');
    });

    it('handles midnight without rolling to the previous day', () => {
      const instant = zonedTimeToUtc(
        { year: 2026, month: 6, day: 15 },
        '00:00',
        'Asia/Tokyo',
      );
      expect(wallClockIn(instant, 'Asia/Tokyo')).toBe('00:00');
      expect(
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(
          instant,
        ),
      ).toBe('2026-06-15');
    });

    it('agrees with UTC for UTC', () => {
      const instant = zonedTimeToUtc(
        { year: 2026, month: 6, day: 15 },
        '09:00',
        'UTC',
      );
      expect(instant.toISOString()).toBe('2026-06-15T09:00:00.000Z');
    });
  });

  describe('localDateIn', () => {
    it('reports the calendar date on that zone, not the server', () => {
      // 22:00 UTC is already the next day in Tokyo (+9).
      const instant = new Date('2026-06-15T22:00:00Z');
      expect(localDateIn(instant, 'Asia/Tokyo')).toEqual({
        year: 2026,
        month: 6,
        day: 16,
      });
      expect(localDateIn(instant, 'UTC')).toEqual({
        year: 2026,
        month: 6,
        day: 15,
      });
    });
  });

  describe('nextLocalOccurrence', () => {
    it('uses today when the slot is still ahead', () => {
      // 06:00 UTC = 11:30 in Kolkata, so 14:00 local is still to come.
      const from = new Date('2026-06-15T06:00:00Z');
      const next = nextLocalOccurrence('14:00', 'Asia/Kolkata', from);
      expect(next.toISOString()).toBe('2026-06-15T08:30:00.000Z');
    });

    it('rolls to tomorrow when today has already passed', () => {
      // 06:00 UTC = 11:30 in Kolkata, so 09:00 local has gone.
      const from = new Date('2026-06-15T06:00:00Z');
      const next = nextLocalOccurrence('09:00', 'Asia/Kolkata', from);

      // Scheduling "09:00 local" at half past eleven must not fire instantly
      // for everyone already past nine.
      expect(next.toISOString()).toBe('2026-06-16T03:30:00.000Z');
      expect(next.getTime()).toBeGreaterThan(from.getTime());
    });

    it('always returns an instant in the future', () => {
      const from = new Date('2026-06-15T06:00:00Z');
      for (const tz of [
        'Asia/Kolkata',
        'America/New_York',
        'Europe/Berlin',
        'Australia/Sydney',
        'America/Sao_Paulo',
        'UTC',
      ]) {
        const next = nextLocalOccurrence('09:00', tz, from);
        expect(next.getTime()).toBeGreaterThan(from.getTime());
        expect(wallClockIn(next, tz)).toBe('09:00');
      }
    });

    it('gives every zone a different instant for the same local time', () => {
      const from = new Date('2026-06-15T00:00:00Z');
      const instants = ['Asia/Tokyo', 'Europe/Berlin', 'America/New_York'].map(
        (tz) => nextLocalOccurrence('09:00', tz, from).toISOString(),
      );
      // The whole point of the feature: one campaign becomes several sends.
      expect(new Set(instants).size).toBe(3);
    });
  });

  describe('shiftOutOfQuietHours', () => {
    const at = (localTime: string, tz: string) =>
      zonedTimeToUtc({ year: 2026, month: 6, day: 15 }, localTime, tz);

    it('leaves an instant outside the window alone', () => {
      const instant = at('14:00', 'Asia/Kolkata');
      expect(
        shiftOutOfQuietHours(instant, 'Asia/Kolkata', '22:00', '08:00'),
      ).toEqual(instant);
    });

    it('moves a late-night instant to the end of the window', () => {
      const instant = at('23:30', 'Asia/Kolkata');
      const shifted = shiftOutOfQuietHours(instant, 'Asia/Kolkata', '22:00', '08:00');

      expect(wallClockIn(shifted, 'Asia/Kolkata')).toBe('08:00');
      expect(shifted.getTime()).toBeGreaterThan(instant.getTime());
    });

    it('moves an early-morning instant to the end of the same window', () => {
      // 03:00 is inside a 22:00-08:00 window that started the previous evening.
      // A naive start <= t < end comparison gets exactly this case wrong.
      const instant = at('03:00', 'Asia/Kolkata');
      const shifted = shiftOutOfQuietHours(instant, 'Asia/Kolkata', '22:00', '08:00');

      expect(wallClockIn(shifted, 'Asia/Kolkata')).toBe('08:00');
      // Same morning, five hours later — not tomorrow.
      expect(shifted.getTime() - instant.getTime()).toBeLessThan(6 * 3600 * 1000);
    });

    it('handles a window that does not wrap midnight', () => {
      const instant = at('13:00', 'Europe/Berlin');
      const shifted = shiftOutOfQuietHours(instant, 'Europe/Berlin', '12:00', '14:00');
      expect(wallClockIn(shifted, 'Europe/Berlin')).toBe('14:00');
    });

    it('is a no-op when quiet hours are not configured', () => {
      const instant = at('03:00', 'Asia/Kolkata');
      expect(shiftOutOfQuietHours(instant, 'Asia/Kolkata', null, null)).toEqual(instant);
      expect(shiftOutOfQuietHours(instant, 'Asia/Kolkata', '22:00', null)).toEqual(instant);
    });

    it('is a no-op for a zero-length window rather than shifting forever', () => {
      const instant = at('03:00', 'Asia/Kolkata');
      expect(
        shiftOutOfQuietHours(instant, 'Asia/Kolkata', '08:00', '08:00'),
      ).toEqual(instant);
    });

    it('ignores a malformed window instead of throwing mid-campaign', () => {
      const instant = at('03:00', 'Asia/Kolkata');
      expect(
        shiftOutOfQuietHours(instant, 'Asia/Kolkata', 'nonsense', '08:00'),
      ).toEqual(instant);
    });

    it('respects each recipient timezone independently', () => {
      // The same UTC instant is the middle of the night in one zone and the
      // afternoon in another — which is the whole reason quiet hours has to be
      // applied per wave rather than once for the campaign.
      const instant = new Date('2026-06-15T20:00:00Z');
      const kolkata = shiftOutOfQuietHours(instant, 'Asia/Kolkata', '22:00', '08:00');
      const london = shiftOutOfQuietHours(instant, 'Europe/London', '22:00', '08:00');

      expect(kolkata.getTime()).toBeGreaterThan(instant.getTime()); // 01:30 local
      expect(london).toEqual(instant); // 21:00 local, still allowed
    });
  });
});
