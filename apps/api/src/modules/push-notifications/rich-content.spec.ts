import {
  validateCarousel,
  validateTimer,
  resolveTimer,
  MAX_CAROUSEL_SLIDES,
  MIN_TIMER_DURATION_SECONDS,
} from './rich-content';

describe('carousel validation', () => {
  const slide = (imageUrl = 'https://cdn.test/a.png') => ({ imageUrl });

  it('accepts a well-formed carousel', () => {
    expect(validateCarousel([slide(), slide()])).toBeNull();
  });

  it('rejects one slide, which is not a carousel', () => {
    expect(validateCarousel([slide()])).toMatch(/at least/);
  });

  it('rejects a slide with no image', () => {
    // A slide with no image is a blank frame the user swipes into.
    expect(validateCarousel([slide(), { imageUrl: '  ' }])).toMatch(/needs an image/);
  });

  it('rejects more slides than a notification can show', () => {
    const many = Array.from({ length: MAX_CAROUSEL_SLIDES + 1 }, () => slide());
    expect(validateCarousel(many)).toMatch(/at most/);
  });

  it('rejects a non-array rather than trusting the shape', () => {
    // This arrives over the wire; `whitelist` has stripped worse.
    expect(validateCarousel(null as never)).toMatch(/at least/);
  });
});

describe('timer validation', () => {
  const sendAt = new Date('2026-06-01T10:00:00Z');

  it('accepts a countdown that ends after the send', () => {
    expect(
      validateTimer({ endsAt: '2026-06-01T12:00:00Z' }, sendAt),
    ).toBeNull();
  });

  it('rejects a countdown that would arrive already expired', () => {
    // The case worth catching: a campaign scheduled for next week with a
    // countdown ending tomorrow passes at compose time and is useless on
    // arrival.
    expect(
      validateTimer({ endsAt: '2026-05-30T10:00:00Z' }, sendAt),
    ).toMatch(/must end after/);
  });

  it('rejects a countdown ending exactly at send', () => {
    expect(
      validateTimer({ endsAt: sendAt.toISOString() }, sendAt),
    ).toMatch(/must end after/);
  });

  it('rejects an unparseable end time', () => {
    expect(validateTimer({ endsAt: 'next tuesday' }, sendAt)).toMatch(
      /not a valid date/,
    );
  });

  it('rejects a missing end time', () => {
    expect(validateTimer({} as never, sendAt)).toMatch(/needs an end time/);
  });
});

describe('relative countdowns', () => {
  const sendAt = new Date('2026-06-01T10:00:00Z');

  describe('validation', () => {
    it('accepts a duration without asking when it will be sent', () => {
      // The whole point of a duration is that it is measured from whenever
      // each send happens, so there is nothing to compare it against.
      expect(validateTimer({ durationSeconds: 86_400 }, sendAt)).toBeNull();
    });

    it('rejects a duration too short to be read', () => {
      expect(validateTimer({ durationSeconds: 5 }, sendAt)).toMatch(/at least/);
      expect(
        validateTimer({ durationSeconds: MIN_TIMER_DURATION_SECONDS }, sendAt),
      ).toBeNull();
    });

    it('refuses both a fixed end and a duration', () => {
      // They disagree by design, and storing both leaves the winner to
      // whichever branch happens to run.
      expect(
        validateTimer(
          { endsAt: '2026-07-01T00:00:00Z', durationSeconds: 3600 },
          sendAt,
        ),
      ).toMatch(/not both/);
    });

    it('still requires one of them', () => {
      expect(validateTimer({}, sendAt)).toMatch(/end time or a duration/);
    });
  });

  describe('resolution', () => {
    it('measures a duration from the send, not from the campaign', () => {
      const resolved = resolveTimer({ durationSeconds: 3600 }, sendAt);

      expect(resolved?.endsAt).toBe('2026-06-01T11:00:00.000Z');
    });

    it('gives each send its own deadline', () => {
      const timer = { durationSeconds: 86_400 };
      const monday = resolveTimer(timer, new Date('2026-06-01T09:00:00Z'));
      const tuesday = resolveTimer(timer, new Date('2026-06-02T09:00:00Z'));

      // This is the fix: a recurring occurrence a day later counts down from
      // its own send rather than inheriting a deadline that has passed.
      expect(monday?.endsAt).toBe('2026-06-02T09:00:00.000Z');
      expect(tuesday?.endsAt).toBe('2026-06-03T09:00:00.000Z');
    });

    it('leaves a fixed end time exactly where it was', () => {
      const resolved = resolveTimer({ endsAt: '2026-07-01T00:00:00Z' }, sendAt);

      // A real deadline is the same moment for everyone, which is the reason
      // to have chosen one.
      expect(resolved?.endsAt).toBe('2026-07-01T00:00:00Z');
    });

    it('carries the expired copy through either way', () => {
      expect(
        resolveTimer({ durationSeconds: 60, expiredTitle: 'Gone' }, sendAt),
      ).toMatchObject({ expiredTitle: 'Gone' });
      expect(
        resolveTimer({ endsAt: '2026-07-01T00:00:00Z', expiredBody: 'Over' }, sendAt),
      ).toMatchObject({ expiredBody: 'Over' });
    });

    it('sends without a countdown rather than not sending', () => {
      // Validation refuses this on the way in; a row written before it existed
      // should still reach the device.
      expect(resolveTimer({}, sendAt)).toBeNull();
    });
  });
});
