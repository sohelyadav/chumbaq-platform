interface Tally {
  windowStart: number;
  total: number;
  alarmed: boolean;
}

/**
 * Counts amounts per key in fixed windows and says `true` exactly once per window, when
 * the key's running total first reaches `threshold`. In memory, bounded to `maxKeys`
 * keys (least recently used first out), so it cannot grow without limit; a key pushed
 * out simply starts again from zero, which can delay an alarm but never raise a false one.
 */
export class VolumeWatch {
  private readonly tallies = new Map<string, Tally>();

  constructor(
    private readonly windowMs: number,
    private readonly threshold: number,
    private readonly maxKeys = 10_000,
  ) {}

  get size(): number {
    return this.tallies.size;
  }

  add(key: string, amount: number, now = Date.now()): boolean {
    let tally = this.tallies.get(key);
    if (tally) this.tallies.delete(key);
    if (!tally || now - tally.windowStart >= this.windowMs) {
      tally = { windowStart: now, total: 0, alarmed: false };
    }
    tally.total += amount;
    this.tallies.set(key, tally);
    if (this.tallies.size > this.maxKeys) {
      this.tallies.delete(this.tallies.keys().next().value as string);
    }
    if (!tally.alarmed && tally.total >= this.threshold) {
      tally.alarmed = true;
      return true;
    }
    return false;
  }
}
