/**
 * Choosing when an individual is most likely to open a notification.
 *
 * The signal is their own past clicks, bucketed by the hour on *their* clock.
 * Nothing here is predictive in any sophisticated sense — it is "when has this
 * person engaged before", which is what the feature is honestly able to say.
 */

/** Hours with fewer clicks than this are treated as noise, not a habit. */
export const MIN_CLICKS_FOR_A_HABIT = 3;

/** Used for anyone without enough history to have a habit. */
export const DEFAULT_SEND_HOUR = 9;

export interface ClickHour {
  deviceIdentityId: string;
  /** 0–23 on the recipient's own clock. */
  hour: number;
  clicks: number;
}

/**
 * Picks each device's best hour, or null when there is not enough evidence.
 *
 * Returning null rather than a default is deliberate: the caller needs to know
 * the difference between "this person opens things at 7pm" and "we are
 * guessing", because presenting a guess as a personalised send time is the
 * kind of claim that quietly erodes trust in the whole feature.
 */
export function bestHourPerDevice(
  rows: ClickHour[],
): Map<string, number | null> {
  const byDevice = new Map<string, ClickHour[]>();
  for (const row of rows) {
    const bucket = byDevice.get(row.deviceIdentityId) ?? [];
    bucket.push(row);
    byDevice.set(row.deviceIdentityId, bucket);
  }

  const best = new Map<string, number | null>();
  for (const [deviceIdentityId, hours] of byDevice) {
    const total = hours.reduce((sum, h) => sum + h.clicks, 0);
    if (total < MIN_CLICKS_FOR_A_HABIT) {
      best.set(deviceIdentityId, null);
      continue;
    }

    // Ties break to the earlier hour: given no reason to prefer one, the
    // earlier slot leaves more of the day for a follow-up.
    const winner = hours.reduce((a, b) =>
      b.clicks > a.clicks || (b.clicks === a.clicks && b.hour < a.hour) ? b : a,
    );
    best.set(deviceIdentityId, winner.hour);
  }

  return best;
}

/**
 * Groups an audience by the hour each recipient should be sent at.
 *
 * Devices with no habit fall into `fallbackHour` rather than being dropped or
 * held back — send-time optimisation is a refinement of when a campaign goes
 * out, never a filter on who receives it.
 */
export function groupBySendHour(
  deviceIdentityIds: string[],
  bestHours: Map<string, number | null>,
  fallbackHour: number = DEFAULT_SEND_HOUR,
): Map<number, string[]> {
  const grouped = new Map<number, string[]>();

  for (const deviceIdentityId of deviceIdentityIds) {
    const hour = bestHours.get(deviceIdentityId) ?? fallbackHour;
    const bucket = grouped.get(hour) ?? [];
    bucket.push(deviceIdentityId);
    grouped.set(hour, bucket);
  }

  return grouped;
}

/** `HH:00` for an hour bucket, matching the localSendTime format. */
export function hourToLocalTime(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}
