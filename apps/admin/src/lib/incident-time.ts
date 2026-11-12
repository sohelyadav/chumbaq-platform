/** CERT-In: report within 6 hours of noticing (or being told of) an incident. */
export const REPORT_WITHIN_HOURS = 6;

export function deadlineOf(noticedAt: string): Date {
  return new Date(Date.parse(noticedAt) + REPORT_WITHIN_HOURS * 3600_000);
}

function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** `5 h 12 min left`, or `Overdue by 40 min` once the deadline has passed. */
export function remaining(deadline: Date, now: Date): { overdue: boolean; text: string } {
  const ms = deadline.getTime() - now.getTime();
  return ms >= 0 ? { overdue: false, text: `${span(ms)} left` } : { overdue: true, text: `Overdue by ${span(-ms)}` };
}

/** `11 Nov 2026, 14:05 IST (08:35 UTC)`: CERT-In works in IST; the logs are in UTC. */
export function formatIstAndUtc(iso: string): string {
  const at = new Date(iso);
  const ist = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return `${ist} IST (${at.toISOString().slice(11, 16)} UTC)`;
}

/** A `<input type="datetime-local">` value in the browser's own time zone. */
export function toLocalInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Back to an ISO time, or null for an empty field. */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
