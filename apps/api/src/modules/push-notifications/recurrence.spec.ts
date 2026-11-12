import {
  nextOccurrence,
  nextOccurrenceAfterNow,
  validateRecurrence,
  PushRecurrence,
} from './recurrence';

const wallClockIn = (instant: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);

const dateIn = (instant: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(instant);

const daily = (over: Partial<PushRecurrence> = {}): PushRecurrence => ({
  frequency: 'daily',
  interval: 1,
  atTime: '09:00',
  timezone: 'Asia/Kolkata',
  ...over,
});

describe('recurrence', () => {
  describe('nextOccurrence', () => {
    it('uses today when the slot is still ahead', () => {
      // 01:00 UTC = 06:30 in Kolkata, so 09:00 local is still to come.
      const from = new Date('2026-06-15T01:00:00Z');
      const next = nextOccurrence(daily(), from)!;
      expect(dateIn(next, 'Asia/Kolkata')).toBe('2026-06-15');
      expect(wallClockIn(next, 'Asia/Kolkata')).toBe('09:00');
    });

    it('rolls to the next day once today has passed', () => {
      // 08:00 UTC = 13:30 in Kolkata.
      const from = new Date('2026-06-15T08:00:00Z');
      const next = nextOccurrence(daily(), from)!;
      expect(dateIn(next, 'Asia/Kolkata')).toBe('2026-06-16');
    });

    it('honours an interval greater than one', () => {
      const from = new Date('2026-06-15T08:00:00Z');
      const next = nextOccurrence(daily({ interval: 3 }), from)!;
      expect(dateIn(next, 'Asia/Kolkata')).toBe('2026-06-18');
    });

    it('keeps the wall clock steady across a DST change', () => {
      // A daily 09:00 in New York must stay 09:00 either side of the
      // transition. Adding 24h of milliseconds would drift it by an hour.
      const before = new Date('2026-03-07T15:00:00Z');
      const next = nextOccurrence(
        daily({ timezone: 'America/New_York' }),
        before,
      )!;
      expect(wallClockIn(next, 'America/New_York')).toBe('09:00');
      expect(dateIn(next, 'America/New_York')).toBe('2026-03-08');
    });

    it('picks the next matching weekday for a weekly schedule', () => {
      // 2026-06-15 is a Monday. Wanting Wednesday (3) gives the 17th.
      const from = new Date('2026-06-15T08:00:00Z');
      const next = nextOccurrence(
        daily({ frequency: 'weekly', daysOfWeek: [3] }),
        from,
      )!;
      expect(dateIn(next, 'Asia/Kolkata')).toBe('2026-06-17');
    });

    it('wraps to next week when the wanted day has passed', () => {
      // Monday, wanting Sunday (0) — the coming Sunday is the 21st.
      const from = new Date('2026-06-15T08:00:00Z');
      const next = nextOccurrence(
        daily({ frequency: 'weekly', daysOfWeek: [0] }),
        from,
      )!;
      expect(dateIn(next, 'Asia/Kolkata')).toBe('2026-06-21');
    });

    it('takes the soonest of several wanted weekdays', () => {
      const from = new Date('2026-06-15T08:00:00Z');
      const next = nextOccurrence(
        daily({ frequency: 'weekly', daysOfWeek: [5, 2] }),
        from,
      )!;
      // Tuesday the 16th beats Friday the 19th.
      expect(dateIn(next, 'Asia/Kolkata')).toBe('2026-06-16');
    });

    it('steps a month for a monthly schedule', () => {
      const from = new Date('2026-06-15T08:00:00Z');
      const next = nextOccurrence(
        daily({ frequency: 'monthly' }),
        from,
      )!;
      expect(dateIn(next, 'Asia/Kolkata')).toBe('2026-07-15');
    });

    it('clamps a month-end day rather than sliding into the next month', () => {
      // The 31st plus one month has no 31st in November. Rolling over would
      // skip a month and then fire on the wrong day forever after.
      const from = new Date('2026-10-31T08:00:00Z');
      const next = nextOccurrence(
        daily({ frequency: 'monthly', timezone: 'UTC', atTime: '00:00' }),
        from,
      )!;
      expect(dateIn(next, 'UTC')).toBe('2026-11-30');
    });

    it('stops once the end date has passed', () => {
      const from = new Date('2026-06-15T08:00:00Z');
      expect(
        nextOccurrence(daily({ endsAt: '2026-06-15T23:00:00Z' }), from),
      ).toBeNull();
    });

    it('still returns an occurrence inside the end date', () => {
      const from = new Date('2026-06-15T08:00:00Z');
      expect(
        nextOccurrence(daily({ endsAt: '2026-12-31T00:00:00Z' }), from),
      ).not.toBeNull();
    });

    it('always moves strictly forward', () => {
      let cursor = new Date('2026-06-15T00:00:00Z');
      for (let i = 0; i < 20; i++) {
        const next = nextOccurrence(daily(), cursor)!;
        // A schedule that can return its own input would spawn occurrences in
        // a tight loop on every sweep.
        expect(next.getTime()).toBeGreaterThan(cursor.getTime());
        cursor = next;
      }
    });
  });

  describe('validateRecurrence', () => {
    it('accepts a well-formed schedule', () => {
      expect(validateRecurrence(daily())).toBeNull();
    });

    it('rejects an unknown frequency', () => {
      expect(
        validateRecurrence({ ...daily(), frequency: 'hourly' as never }),
      ).toMatch(/Frequency/);
    });

    it('rejects a non-positive or absurd interval', () => {
      expect(validateRecurrence(daily({ interval: 0 }))).toMatch(/Interval/);
      expect(validateRecurrence(daily({ interval: 99 }))).toMatch(/Interval/);
    });

    it('rejects a malformed time', () => {
      expect(validateRecurrence(daily({ atTime: '9am' }))).toMatch(/HH:MM/);
    });

    it('rejects an out-of-range weekday', () => {
      expect(
        validateRecurrence(daily({ frequency: 'weekly', daysOfWeek: [7] })),
      ).toMatch(/Days of week/);
    });

    it('rejects weekdays on a non-weekly schedule', () => {
      // Otherwise a daily schedule would silently ignore them, and the user
      // would believe the campaign was restricted to those days.
      expect(validateRecurrence(daily({ daysOfWeek: [1] }))).toMatch(
        /only apply to a weekly/,
      );
    });

    it('rejects an unparseable end date', () => {
      expect(validateRecurrence(daily({ endsAt: 'soon' }))).toMatch(/End date/);
    });
  });
});

describe('nextOccurrenceAfterNow', () => {
  const daily = { frequency: 'daily', interval: 2, atTime: '09:00', timezone: 'UTC' } as const;
  const now = new Date('2026-11-05T12:00:00Z');

  it('steps past now and stays in phase with an every-N schedule', () => {
    const next = nextOccurrenceAfterNow(daily, new Date('2026-11-01T09:00:00Z'), now);
    expect(next?.toISOString()).toBe('2026-11-07T09:00:00.000Z');
  });

  it('jumps rather than walks from a start date centuries ago', () => {
    const next = nextOccurrenceAfterNow(daily, new Date('0100-01-01T09:00:00Z'), now);
    expect(next?.getTime()).toBeGreaterThan(now.getTime());
  });

  it('is null once the schedule has ended', () => {
    const ended = { ...daily, endsAt: '2026-11-02T00:00:00Z' };
    expect(nextOccurrenceAfterNow(ended, new Date('2026-11-01T09:00:00Z'), now)).toBeNull();
  });
});

describe('validateRecurrence timezone', () => {
  const base = { frequency: 'daily', interval: 1, atTime: '09:00' } as const;

  it('refuses a zone Intl does not know', () => {
    expect(validateRecurrence({ ...base, timezone: 'Not/AZone' })).toBe('Timezone is not recognised.');
  });

  it('accepts a real zone, or none', () => {
    expect(validateRecurrence({ ...base, timezone: 'Asia/Kolkata' })).toBeNull();
    expect(validateRecurrence(base)).toBeNull();
  });
});

describe('a slot on a day whose midnight the clocks skip', () => {
  // Each of these returned the same instant, so anything stepping along never moved.
  it.each([
    ['America/Havana', '2026-03-08T04:00:00.000Z'],
    ['America/Asuncion', '2026-10-04T03:00:00.000Z'],
    ['America/Santiago', '2026-09-06T03:00:00.000Z'],
  ])('still moves forward in %s', (timezone, instant) => {
    const from = new Date(instant);
    const recurrence = { frequency: 'daily', interval: 1, atTime: '00:00', timezone } as const;

    expect(nextOccurrence(recurrence, from)?.getTime()).toBeGreaterThan(from.getTime());
  });

  it('does not hang catching up across one', () => {
    const recurrence = { frequency: 'daily', interval: 1, atTime: '00:00', timezone: 'America/Havana' } as const;
    const now = new Date('2026-03-20T12:00:00Z');

    const next = nextOccurrenceAfterNow(recurrence, new Date('2026-03-01T05:00:00Z'), now);

    expect(next?.getTime()).toBeGreaterThan(now.getTime());
  });
});
