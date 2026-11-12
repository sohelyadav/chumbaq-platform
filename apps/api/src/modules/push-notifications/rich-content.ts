/**
 * Rich notification content — a carousel of images, or a countdown.
 *
 * No push provider carries either natively, so both travel as data keys and
 * are rendered by the client. That is also why they are validated here: a
 * malformed carousel reaches the device and is silently dropped, so the
 * campaign has to be rejected at compose time or not at all.
 */

/** One frame of a carousel. */
export interface PushCarouselSlide {
  imageUrl: string;
  /** Shown under the image. Optional — an image alone is a valid slide. */
  caption?: string;
  /**
   * Where this slide leads. Falls back to the campaign's own deep link, so a
   * carousel that is one story rather than five products needs only the one.
   */
  deepLinkUrl?: string;
}

/**
 * A countdown shown in the notification.
 *
 * Android renders this natively with a chronometer; iOS needs a notification
 * content extension, which is a host-app target.
 */
export interface PushTimer {
  /**
   * A fixed moment the countdown runs to. ISO 8601.
   *
   * Right for a real deadline — a launch, an event, a sale that ends when it
   * ends — and wrong for anything that sends more than once, because every
   * occurrence and every timezone wave shares the one instant and the later
   * ones arrive already past it.
   */
  endsAt?: string;

  /**
   * A countdown measured from when each send actually goes out.
   *
   * The answer for a recurring campaign or one delivered in each recipient's
   * own timezone: "24 hours from now" means something to every occurrence and
   * every wave, where a fixed instant only means something to the first.
   * Resolved to a real `endsAt` when the campaign is dispatched, so the device
   * still receives one absolute moment.
   */
  durationSeconds?: number;

  /** Copy to show once it has. Falls back to the campaign's own. */
  expiredTitle?: string;
  expiredBody?: string;
}

/** Shorter than this and the countdown is over before it is read. */
export const MIN_TIMER_DURATION_SECONDS = 60;

/**
 * Turns a countdown into the absolute moment the device is told about.
 *
 * Called with the instant a particular send goes out, which is what makes a
 * relative countdown work at all: each recurring occurrence and each timezone
 * wave resolves against its own send time rather than inheriting the first
 * one's.
 */
export function resolveTimer(
  timer: PushTimer,
  sendAt: Date,
): { endsAt: string; expiredTitle?: string; expiredBody?: string } | null {
  const { expiredTitle, expiredBody } = timer;

  if (timer.durationSeconds !== undefined) {
    return {
      endsAt: new Date(
        sendAt.getTime() + timer.durationSeconds * 1000,
      ).toISOString(),
      expiredTitle,
      expiredBody,
    };
  }

  if (timer.endsAt) {
    return { endsAt: timer.endsAt, expiredTitle, expiredBody };
  }

  // Validation refuses this on the way in; a campaign stored before it existed
  // is better sent without a countdown than not sent.
  return null;
}

/** Below two there is no carousel, and past this a notification is unusable. */
export const MIN_CAROUSEL_SLIDES = 2;
export const MAX_CAROUSEL_SLIDES = 10;

export function validateCarousel(slides: PushCarouselSlide[]): string | null {
  if (!Array.isArray(slides) || slides.length < MIN_CAROUSEL_SLIDES) {
    return `A carousel needs at least ${MIN_CAROUSEL_SLIDES} slides.`;
  }
  if (slides.length > MAX_CAROUSEL_SLIDES) {
    return `A carousel supports at most ${MAX_CAROUSEL_SLIDES} slides.`;
  }
  if (slides.some((slide) => !slide?.imageUrl?.trim())) {
    // A slide with no image is a blank frame the user swipes into.
    return 'Every carousel slide needs an image.';
  }
  return null;
}

/**
 * Checked against send time, not compose time.
 *
 * A campaign scheduled for next week with a countdown ending tomorrow would
 * pass at compose and arrive already expired, which is the failure worth
 * catching — so callers pass the instant the campaign will actually go out.
 */
export function validateTimer(timer: PushTimer, sendAt: Date): string | null {
  if (!timer) return 'A countdown needs an end time or a duration.';

  const hasEndsAt = !!timer.endsAt;
  const hasDuration = timer.durationSeconds !== undefined;

  if (hasEndsAt && hasDuration) {
    // Storing both would leave which one wins to whichever branch ran, and the
    // two disagree by design.
    return 'A countdown has either a fixed end time or a duration, not both.';
  }
  if (!hasEndsAt && !hasDuration) {
    return 'A countdown needs an end time or a duration.';
  }

  if (hasDuration) {
    const seconds = timer.durationSeconds as number;
    if (!Number.isFinite(seconds) || seconds < MIN_TIMER_DURATION_SECONDS) {
      return `A countdown must run for at least ${MIN_TIMER_DURATION_SECONDS} seconds.`;
    }
    // Deliberately not checked against `sendAt`: a duration is measured from
    // whenever each send happens, which is the reason to use one.
    return null;
  }

  const endsAt = new Date(timer.endsAt as string);
  if (Number.isNaN(endsAt.getTime())) {
    return 'The countdown end time is not a valid date.';
  }
  if (endsAt.getTime() <= sendAt.getTime()) {
    return 'The countdown must end after the campaign is sent.';
  }
  return null;
}
