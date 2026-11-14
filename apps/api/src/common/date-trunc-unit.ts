/**
 * The units the dashboard's time series offer, and the only text a DATE_TRUNC
 * call may be built from.
 *
 * `granularity` reaches the services as a bare `@Query` value. Its
 * `'hour' | 'day' | 'week'` type exists only at compile time: the validation pipe
 * passes a string query value through unchanged, and a repeated parameter arrives
 * as an array. The services write the unit into the SQL text (Postgres needs the
 * same expression in SELECT and GROUP BY, which a bound parameter would not give),
 * so anything that is not exactly one of these units is replaced by the default.
 */
export const DATE_TRUNC_UNITS = ['hour', 'day', 'week'] as const;

export type DateTruncUnit = (typeof DATE_TRUNC_UNITS)[number];

export function dateTruncUnit(value: unknown, fallback: DateTruncUnit = 'day'): DateTruncUnit {
  return (DATE_TRUNC_UNITS as readonly unknown[]).includes(value) ? (value as DateTruncUnit) : fallback;
}
