import {
  EndpointCooldown,
  WEBHOOK_COOLDOWN_MAX_ENTRIES_PER_PROJECT,
  WEBHOOK_COOLDOWN_MAX_PROJECTS,
  cooldownKey,
} from './webhook-cooldown';

// A tenant can add cool-down entries cheaply: point a webhook at a closed port
// or a refused host, change the URL, fire an event with their own API key.
// Keyed by the whole URL with no cap, that grew the process's memory without
// limit.
describe('EndpointCooldown memory', () => {
  const longUrl = (n: number) => `https://closed.example.com/${'a'.repeat(2000)}/${n}`;

  it('keys an entry by a fixed-size digest, however long the URL', () => {
    const short = cooldownKey('p1', 'https://x.example/');
    const long = cooldownKey('p1', longUrl(1));
    expect(long.digest).toHaveLength(43);
    expect(short.digest).toHaveLength(43);
    expect(JSON.stringify(long).length).toBeLessThan(200);
  });

  it('still tells endpoints and projects apart, and spellings of one URL together', () => {
    expect(cooldownKey('p1', longUrl(1)).digest).not.toBe(cooldownKey('p1', longUrl(2)).digest);
    expect(cooldownKey('p1', 'https://x.example/a').digest).not.toBe(cooldownKey('p2', 'https://x.example/a').digest);
    expect(cooldownKey('p1', 'HTTPS://X.example:443/a#f').digest).toBe(cooldownKey('p1', 'https://x.example/a').digest);
  });

  it('sizes the caps for an honest project and a bounded process', () => {
    // A project has at most 10 active webhooks (MAX_WEBHOOKS_PER_PROJECT).
    expect(WEBHOOK_COOLDOWN_MAX_ENTRIES_PER_PROJECT).toBeGreaterThanOrEqual(10);
    expect(WEBHOOK_COOLDOWN_MAX_PROJECTS * WEBHOOK_COOLDOWN_MAX_ENTRIES_PER_PROJECT).toBeLessThanOrEqual(100_000);
  });

  it('holds at most its project cap of maps, each at most its entry cap, however many projects flood it', () => {
    const cooldown = new EndpointCooldown(50, 4);
    for (let p = 0; p < 500; p++) {
      for (let n = 0; n < 10; n++) cooldown.slow(cooldownKey(`p${p}`, longUrl(n)), 0);
    }
    expect(cooldown.projectCount).toBe(50);
    expect(cooldown.size).toBe(50 * 4);
  });

  it('keeps an emptied project\'s place without growing per project ever seen', () => {
    const cooldown = new EndpointCooldown(3, 5);
    for (let p = 0; p < 100; p++) {
      const key = cooldownKey(`p${p}`, longUrl(p));
      cooldown.slow(key, 0);
      cooldown.answered(key, 1);
    }
    expect(cooldown.projectCount).toBe(3);
    expect(cooldown.size).toBe(0);
  });

  it('keeps at most the per-project cap for one project, forgetting its oldest first', () => {
    const cooldown = new EndpointCooldown(100, 3);
    const keys = [0, 1, 2, 3].map((n) => cooldownKey('flood', longUrl(n)));
    const evicted = keys.map((key) => cooldown.slow(key, 0));
    expect(evicted).toEqual([0, 0, 0, 1]);
    expect(cooldown.size).toBe(3);
    expect(cooldown.blocks(keys[0], 1)).toBe(false);
    expect(keys.slice(1).every((key) => cooldown.blocks(key, 1))).toBe(true);
  });

  it('counts an update as use, so the entry renewed last is kept', () => {
    const cooldown = new EndpointCooldown(100, 2);
    const [a, b, c] = [0, 1, 2].map((n) => cooldownKey('p', longUrl(n)));
    cooldown.slow(a, 0);
    cooldown.slow(b, 0);
    // a slows again after its cool-down, so b is now the oldest.
    cooldown.slow(a, 40_000);
    cooldown.slow(c, 40_000);
    expect(cooldown.blocks(a, 40_001)).toBe(true);
    expect(cooldown.blocks(b, 1)).toBe(false);
    expect(cooldown.blocks(c, 40_001)).toBe(true);
  });

  it('keeps at most the project cap, forgetting the least recently active project whole', () => {
    const cooldown = new EndpointCooldown(4, 3);
    const keys = [0, 1, 2, 3, 4].map((n) => cooldownKey(`p${n}`, longUrl(n)));
    cooldown.slow(cooldownKey('p0', longUrl(100)), 0);
    const evicted = keys.map((key) => cooldown.slow(key, 0));
    // p0 held two entries, both lost when p4 arrived.
    expect(evicted).toEqual([0, 0, 0, 0, 2]);
    expect(cooldown.size).toBe(4);
    expect(cooldown.blocks(keys[0], 1)).toBe(false);
    expect(keys.slice(1).every((key) => cooldown.blocks(key, 1))).toBe(true);
  });

  it('counts checking a cool-down as activity, so a delivering project keeps its place', () => {
    const cooldown = new EndpointCooldown(3, 5);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((p) => cooldownKey(p, 'https://slow.example.com/hook'));
    for (const key of [a, b, c]) cooldown.slow(key, 0);
    // a's next event checks its cool-down; b has been idle since.
    expect(cooldown.blocks(a, 1)).toBe(true);
    cooldown.slow(d, 1);
    expect(cooldown.blocks(a, 2)).toBe(true);
    expect(cooldown.blocks(b, 2)).toBe(false);
    expect(cooldown.blocks(c, 2)).toBe(true);
  });

  it('never lets a project flooding entries forget another project\'s before its own', () => {
    const cooldown = new EndpointCooldown(10, 3);
    const victim = cooldownKey('victim', 'https://slow.example.com/hook');
    cooldown.slow(victim, 0);
    for (let n = 0; n < 1000; n++) cooldown.slow(cooldownKey('flood', longUrl(n)), 0);
    expect(cooldown.blocks(victim, 1)).toBe(true);
    expect(cooldown.size).toBe(4);
  });

  it('keeps a victim\'s cool-down while projects at their caps fill the process and keep flooding', () => {
    const cooldown = new EndpointCooldown(6, 20);
    let next = 0;
    for (let p = 0; p < 5; p++) for (let n = 0; n < 20; n++) cooldown.slow(cooldownKey(`att${p}`, longUrl(next++)), 0);
    const victim = cooldownKey('victim', 'https://slow.example.com/hook');
    cooldown.slow(victim, 0);
    expect(cooldown.projectCount).toBe(6);
    for (let n = 0; n < 2000; n++) cooldown.slow(cooldownKey(`att${n % 5}`, longUrl(next++)), 0);
    expect(cooldown.blocks(victim, 1)).toBe(true);
    expect(cooldown.size).toBe(101);
  });

  // W3: once the map was full, a project with no entries pushed out the oldest
  // entry overall. Clearing its own entry (a fast answer) put it back at no
  // entries, so cycling slow/fast pushed out other projects' cool-downs again
  // and again, not once.
  it('does not let a project cycling slow and fast push out another project\'s cool-down', () => {
    // Room for four projects; v1, v2, v3 and a busy honest project fill it.
    const cooldown = new EndpointCooldown(4, 5);
    const victims = ['v1', 'v2', 'v3'].map((p) => cooldownKey(p, 'https://slow.example.com/hook'));
    for (const v of victims) cooldown.slow(v, 0);
    cooldown.slow(cooldownKey('busy', longUrl(0)), 0);
    for (let n = 1; n < 100; n++) {
      const own = cooldownKey('att', longUrl(n));
      cooldown.slow(own, 0);
      cooldown.answered(own, 1);
      // The busy project keeps the process full, using its own room.
      cooldown.slow(cooldownKey('busy', longUrl(1000 + n)), 0);
    }
    // Arriving, att took the place of the least recently active project, v1,
    // once. After that it was in the list and only ever used its own room.
    expect(cooldown.blocks(victims[0], 1)).toBe(false);
    expect(cooldown.blocks(victims[1], 1)).toBe(true);
    expect(cooldown.blocks(victims[2], 1)).toBe(true);
  });

  it('forgets an entry that answered, freeing its place', () => {
    const cooldown = new EndpointCooldown(100, 1);
    const [a, b] = [0, 1].map((n) => cooldownKey('p', longUrl(n)));
    cooldown.slow(a, 0);
    cooldown.answered(a, 1);
    expect(cooldown.slow(b, 1)).toBe(0);
    expect(cooldown.size).toBe(1);
  });
});
