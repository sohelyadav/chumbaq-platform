import * as crypto from 'crypto';

/**
 * A fixed-size key (43 characters) for in-memory delivery state. Keys are
 * built from what a tenant typed (URLs up to 2048 characters, hostnames of any
 * length the URL parser accepts), so used as they are, each entry cost as much
 * memory as the tenant chose. JSON, so no two lists of parts spell the same
 * text, whatever characters they hold.
 */
export function webhookCacheKey(...parts: string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}

/**
 * Delivery state kept per project: each project has its own small map (at
 * most `maxPerProject` entries, least recently set goes first), and the
 * process keeps the maps of at most `maxProjects` projects, least recently
 * active (any get or set) going first.
 *
 * The guarantee: a project's entries are added and pushed out only by that
 * project's own calls, except that its whole map is dropped when it is the
 * least recently active of `maxProjects` projects and a project not in the
 * list arrives. So pushing out one project's entries takes `maxProjects` other
 * projects, each active more recently than it; nothing one project does, nor
 * any number of its own entries, reaches another project's map.
 *
 * Earlier this was one shared map with a per-project cap, where a project with
 * no entries pushed out the oldest entry overall. Clearing its own entry, or
 * another project re-storing a shared key it held, put it back at no entries,
 * so it could push out other projects' entries again and again. Here a
 * project's map stays in the list when it empties, for that reason, and no key
 * is shared between projects.
 *
 * Memory is at most `maxProjects` maps of `maxPerProject` entries.
 * `set` returns how many entries it pushed out, for the caller to report.
 */
export class PerProjectLru<V> {
  /** In order of last activity, least recent first, which is Map's insertion order. */
  private readonly projects = new Map<string, Map<string, V>>();

  constructor(
    private readonly maxProjects: number,
    private readonly maxPerProject: number,
  ) {}

  /** Entries held across all projects; walks every project, so for tests. */
  get size(): number {
    let total = 0;
    for (const own of this.projects.values()) total += own.size;
    return total;
  }

  /** Projects with a map, empty or not. */
  get projectCount(): number {
    return this.projects.size;
  }

  /** Counts as the project's activity, so a project that is delivering keeps its place. */
  get(projectId: string, key: string): V | undefined {
    const own = this.touch(projectId);
    return own?.get(key);
  }

  /** Stores the value in the project's own map, as its newest entry. */
  set(projectId: string, key: string, value: V): number {
    let evicted = 0;
    let own = this.touch(projectId);
    if (!own) {
      if (this.projects.size >= this.maxProjects) {
        const [idleId, idle] = this.projects.entries().next().value!;
        this.projects.delete(idleId);
        evicted += idle.size;
      }
      own = new Map<string, V>();
      this.projects.set(projectId, own);
    }
    own.delete(key);
    if (own.size >= this.maxPerProject) {
      own.delete(own.keys().next().value!);
      evicted++;
    }
    own.set(key, value);
    return evicted;
  }

  /**
   * Leaves the project's map in the list even when it empties. Removed, the
   * project would arrive anew on its next set and, if others had filled the
   * list meanwhile, push out the least recently active project; kept, clearing
   * and refilling its own entries never costs another project anything, and
   * the list still holds at most `maxProjects` maps.
   */
  delete(projectId: string, key: string): void {
    this.projects.get(projectId)?.delete(key);  }

  /** Moves the project to the most recently active end; its map, if it has one. */
  private touch(projectId: string): Map<string, V> | undefined {
    const own = this.projects.get(projectId);
    if (!own) return undefined;
    this.projects.delete(projectId);
    this.projects.set(projectId, own);
    return own;
  }
}
