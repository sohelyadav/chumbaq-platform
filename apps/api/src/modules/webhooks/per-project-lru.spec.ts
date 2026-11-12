import { PerProjectLru } from './per-project-lru';

// The guarantee (per-project-lru.ts): a project's entries leave only through
// its own calls, or with its whole map when it is the least recently active of
// maxProjects and a project not in the list arrives.
describe('PerProjectLru', () => {
  it('takes room for a project only from its own map', () => {
    const map = new PerProjectLru<number>(10, 3);
    map.set('victim', 'v', 0);
    let evicted = 0;
    for (let n = 0; n < 1000; n++) evicted += map.set('flood', `f${n}`, n);
    expect(evicted).toBe(997);
    expect(map.get('victim', 'v')).toBe(0);
    expect(map.size).toBe(4);
  });

  it('pushes out a whole project only when a new one arrives at a full list, least recently active first', () => {
    const map = new PerProjectLru<number>(2, 3);
    map.set('a', 'x', 1);
    map.set('a', 'y', 2);
    map.set('b', 'x', 3);
    // a is used again, so b is now the least recently active.
    expect(map.get('a', 'x')).toBe(1);
    expect(map.set('c', 'x', 4)).toBe(1);
    expect(map.get('b', 'x')).toBeUndefined();
    expect(map.get('a', 'y')).toBe(2);
  });

  it('keeps a project in the list once its map empties, so clearing and refilling pushes nobody out', () => {
    const map = new PerProjectLru<number>(3, 3);
    map.set('v1', 'k', 1);
    map.set('v2', 'k', 2);
    map.set('att', 'k0', 0);
    for (let n = 1; n < 200; n++) {
      map.delete('att', `k${n - 1}`);
      expect(map.set('att', `k${n}`, n)).toBe(0);
    }
    expect(map.get('v1', 'k')).toBe(1);
    expect(map.get('v2', 'k')).toBe(2);
  });

  it('keeps an emptied project listed, so refilling it is not an arrival that pushes anyone out', () => {
    const map = new PerProjectLru<number>(3, 3);
    map.set('v1', 'k', 1);
    map.set('v2', 'k', 2);
    map.set('att', 'k', 0);
    map.delete('att', 'k');
    // Still listed with an empty map, holding its place.
    expect(map.projectCount).toBe(3);
    // A new project arriving now takes the least recently active place, v1.
    expect(map.set('new', 'k', 3)).toBe(1);
    expect(map.get('v1', 'k')).toBeUndefined();
    // The emptied project refills without arriving anew: nobody else's map goes.
    expect(map.set('att', 'k', 4)).toBe(0);
    expect(map.get('v2', 'k')).toBe(2);
    expect(map.get('new', 'k')).toBe(3);
    expect(map.projectCount).toBe(3);
  });

  it('keeps the same key apart for different projects', () => {
    const map = new PerProjectLru<number>(10, 1);
    map.set('a', 'shared', 1);
    for (let n = 0; n < 50; n++) {
      expect(map.set('b', 'shared', n)).toBe(0);
      expect(map.set('a', 'shared', n)).toBe(0);
    }
    expect(map.size).toBe(2);
  });

  it('counts re-setting a key as use, so it becomes the project\'s newest', () => {
    const map = new PerProjectLru<number>(10, 2);
    map.set('p', 'x', 1);
    map.set('p', 'y', 2);
    map.set('p', 'x', 3);
    expect(map.set('p', 'z', 4)).toBe(1);
    expect(map.get('p', 'x')).toBe(3);
    expect(map.get('p', 'y')).toBeUndefined();
  });

  it('holds at most maxProjects maps of maxPerProject entries', () => {
    const map = new PerProjectLru<number>(20, 5);
    for (let p = 0; p < 1000; p++) for (let n = 0; n < 50; n++) map.set(`p${p}`, `k${n}`, n);
    expect(map.projectCount).toBe(20);
    expect(map.size).toBe(100);
  });

  it('does not add a project by reading it', () => {
    const map = new PerProjectLru<number>(1, 1);
    map.set('a', 'x', 1);
    expect(map.get('b', 'x')).toBeUndefined();
    map.delete('c', 'x');
    expect(map.projectCount).toBe(1);
    expect(map.get('a', 'x')).toBe(1);
  });
});
