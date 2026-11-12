import { ProjectBoundedMap } from './project-bounded-map';

// The order entries leave in is what keeps one tenant flooding the SES dedupe
// store from pushing out another tenant's message ids.
describe('ProjectBoundedMap', () => {
  const fill = (map: ProjectBoundedMap<number>, projectId: string, count: number, from = 0) => {
    let evicted = 0;
    for (let n = from; n < from + count; n++) evicted += map.set(projectId, `${projectId}/${n}`, n);
    return evicted;
  };

  it('with the map full, takes room from the project itself even below its cap', () => {
    const map = new ProjectBoundedMap<number>(10, 5);
    map.set('victim', 'victim/0', 0);
    fill(map, 'h1', 4);
    fill(map, 'h2', 4);
    map.set('att', 'att/0', 0);
    expect(map.size).toBe(10);
    // att has 1 of its 5, but the map is full, so its own entry goes, not the victim's.
    expect(map.set('att', 'att/1', 1)).toBe(1);
    expect(map.get('victim/0')).toBe(0);
    expect(map.get('att/0')).toBeUndefined();
    expect(map.get('att/1')).toBe(1);
  });

  it('with the map full, a project at its cap takes room only from itself', () => {
    const map = new ProjectBoundedMap<number>(6, 3);
    map.set('victim', 'victim/0', 0);
    fill(map, 'a', 3);
    fill(map, 'b', 2);
    expect(map.size).toBe(6);
    expect(fill(map, 'a', 50, 3)).toBe(50);
    expect(map.get('victim/0')).toBe(0);
    expect(map.get('b/0')).toBe(0);
    expect(map.size).toBe(6);
  });

  it('lets a newcomer to a full map push out one entry, and nothing more of others after', () => {
    // Five projects at their cap fill the map; a victim arrives, then they keep going.
    const map = new ProjectBoundedMap<number>(10, 2);
    for (let p = 0; p < 5; p++) fill(map, `att${p}`, 2);
    map.set('victim', 'victim/0', 0);
    // The victim had nothing of its own, so the oldest overall went.
    expect(map.get('att0/0')).toBeUndefined();
    // att0 is now below its cap; the flood that follows must not cascade onto the victim.
    for (let round = 0; round < 100; round++) {
      for (let p = 0; p < 5; p++) fill(map, `att${p}`, 1, 2 + round);
    }
    expect(map.get('victim/0')).toBe(0);
    expect(map.size).toBe(10);
  });

  it('pushes out the oldest overall when a project with nothing in it needs room', () => {
    const map = new ProjectBoundedMap<number>(3, 3);
    fill(map, 'a', 3);
    expect(map.set('b', 'b/0', 0)).toBe(1);
    expect(map.get('a/0')).toBeUndefined();
    expect(map.get('a/1')).toBe(1);
  });

  it('counts re-setting a key as use, so it becomes the newest', () => {
    const map = new ProjectBoundedMap<number>(100, 2);
    map.set('p', 'x', 1);
    map.set('p', 'y', 2);
    map.set('p', 'x', 3);
    expect(map.set('p', 'z', 4)).toBe(1);
    expect(map.get('x')).toBe(3);
    expect(map.get('y')).toBeUndefined();
  });

  it('forgets a project once its last entry is deleted, so the index does not grow per project ever seen', () => {
    const map = new ProjectBoundedMap<number>(100, 5);
    for (let p = 0; p < 50; p++) map.set(`p${p}`, `k${p}`, p);
    expect(map.projectCount).toBe(50);
    for (let p = 0; p < 50; p++) map.delete(`k${p}`);
    expect(map.size).toBe(0);
    expect(map.projectCount).toBe(0);
  });

  it('forgets a project whose last entry was pushed out by another', () => {
    const map = new ProjectBoundedMap<number>(2, 2);
    for (let p = 0; p < 50; p++) map.set(`p${p}`, `k${p}`, p);
    expect(map.size).toBe(2);
    expect(map.projectCount).toBe(2);
  });

  // SES dedupe re-stores a message's id when it is done or tried again. If
  // that counted as a project with nothing in it, each re-store at a full map
  // would push out another project's entry.
  it("pushes nothing out when re-setting a project's only key at a full map", () => {
    const map = new ProjectBoundedMap<number>(3, 3);
    map.set('other', 'o1', 1);
    map.set('other', 'o2', 2);
    map.set('p', 'k', 0);
    for (let n = 1; n <= 5; n++) expect(map.set('p', 'k', n)).toBe(0);
    expect(map.get('o1')).toBe(1);
    expect(map.get('k')).toBe(5);
  });
});
