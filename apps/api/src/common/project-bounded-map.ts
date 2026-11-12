/**
 * A Map with a cap on its total size and on how many entries one project
 * holds. Least recently set goes first. A project that needs room loses its
 * own oldest entry whenever it has one: at its own cap, and also below it when
 * the whole map is full. Only a project with no entries at all, arriving at a
 * full map, pushes out the oldest entry overall, which may be another
 * project's. So a project adding entries as fast as it can never pushes out
 * another project's entry before its own: past its first entry it only ever
 * replaces its own. Setting a key that is already stored frees its own slot
 * first, so it pushes out nothing.
 *
 * That "once" holds only while the caller never deletes a project's entries
 * and keys are never shared between projects: a project emptied by a delete,
 * or by another project re-storing a key it held, arrives anew and can push
 * out the oldest entry overall again, as often as it can repeat that. The
 * webhook cool-down and DNS cache used this and fell to exactly that, so they
 * moved to `PerProjectLru` (modules/webhooks/per-project-lru.ts). SES dedupe
 * (`SeenMessages`) still uses it, keyed by project and message id and never
 * deleting.
 *
 * `set` returns how many entries it pushed out, for the caller to report.
 */
export class ProjectBoundedMap<V> {
  /** In order of last `set`, oldest first, which is Map's insertion order. */
  private readonly entries = new Map<string, { projectId: string; value: V }>();
  /** Each project's keys, oldest first, so its own oldest is found at once. */
  private readonly byProject = new Map<string, Set<string>>();

  constructor(
    private readonly maxEntries: number,
    private readonly maxPerProject: number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** How many projects hold entries; for tests, which check none is left behind. */
  get projectCount(): number {
    return this.byProject.size;
  }

  get(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  /** Stores the value under `projectId`, moving the key to the back of both orders. */
  set(projectId: string, key: string, value: V): number {
    this.delete(key);
    let evicted = 0;
    const own = this.byProject.get(projectId);
    const full = this.entries.size >= this.maxEntries;
    if (own && (own.size >= this.maxPerProject || full)) {
      this.delete(own.values().next().value!);
      evicted++;
    } else if (full) {
      this.delete(this.entries.keys().next().value!);
      evicted++;
    }
    this.entries.set(key, { projectId, value });
    const keys = this.byProject.get(projectId) ?? new Set<string>();
    keys.add(key);
    this.byProject.set(projectId, keys);
    return evicted;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    const keys = this.byProject.get(entry.projectId);
    keys?.delete(key);
    // An empty set would leave one entry per project ever seen.
    if (keys && keys.size === 0) this.byProject.delete(entry.projectId);
  }
}
