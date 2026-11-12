import { VolumeWatch } from './volume-watch';

describe('VolumeWatch', () => {
  const HOUR = 3600_000;

  it('says true once, when the running total first reaches the threshold', () => {
    const watch = new VolumeWatch(HOUR, 50_000);
    expect(watch.add('u1', 49_999, 0)).toBe(false);
    expect(watch.add('u1', 1, 10)).toBe(true);
    expect(watch.add('u1', 10_000, 20)).toBe(false);
  });

  it('counts each key on its own', () => {
    const watch = new VolumeWatch(HOUR, 10);
    expect(watch.add('a', 9, 0)).toBe(false);
    expect(watch.add('b', 9, 0)).toBe(false);
    expect(watch.add('a', 1, 1)).toBe(true);
  });

  it('starts again once the window is over', () => {
    const watch = new VolumeWatch(HOUR, 10);
    expect(watch.add('u1', 10, 0)).toBe(true);
    expect(watch.add('u1', 9, HOUR + 1)).toBe(false);
    expect(watch.add('u1', 1, HOUR + 2)).toBe(true);
  });

  it('keeps at most maxKeys keys, forgetting the least recently used', () => {
    const watch = new VolumeWatch(HOUR, 10, 3);
    watch.add('a', 9, 0);
    watch.add('b', 9, 1);
    watch.add('c', 9, 2);
    watch.add('a', 0, 3); // a is now the most recent
    watch.add('d', 9, 4); // pushes out b
    expect(watch.size).toBe(3);
    expect(watch.add('a', 1, 5)).toBe(true);
    expect(watch.add('b', 1, 6)).toBe(false); // b started again from 0
  });
});
