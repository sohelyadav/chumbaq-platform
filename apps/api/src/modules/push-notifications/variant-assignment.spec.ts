import {
  bucketFor,
  assignVariant,
  splitAudience,
  validateVariants,
  PushVariant,
} from './variant-assignment';

const twoWay: PushVariant[] = [
  { key: 'A', title: 'First', weight: 50 },
  { key: 'B', title: 'Second', weight: 50 },
];

const devices = (n: number) =>
  Array.from({ length: n }, (_, i) => `device-${i}`);

describe('variant assignment', () => {
  describe('bucketFor', () => {
    it('is stable for the same device and campaign', () => {
      // An experiment that reshuffles on retry is not an experiment.
      const first = bucketFor('camp-1', 'device-1');
      const second = bucketFor('camp-1', 'device-1');
      expect(first).toBe(second);
    });

    it('puts the same device somewhere else in a different campaign', () => {
      // Salted by campaign so one device is not permanently in the same
      // position across every test that is ever run.
      const a = bucketFor('camp-1', 'device-1');
      const b = bucketFor('camp-2', 'device-1');
      expect(a).not.toBe(b);
    });

    it('stays inside [0, 100)', () => {
      for (const id of devices(500)) {
        const bucket = bucketFor('camp-1', id);
        expect(bucket).toBeGreaterThanOrEqual(0);
        expect(bucket).toBeLessThan(100);
      }
    });

    it('spreads roughly evenly across the range', () => {
      const counts = new Array(10).fill(0);
      for (const id of devices(5000)) {
        counts[Math.floor(bucketFor('camp-1', id) / 10)] += 1;
      }
      // 5000 devices over 10 deciles is 500 each; a badly biased hash would
      // show up as a decile far outside this band.
      for (const count of counts) {
        expect(count).toBeGreaterThan(380);
        expect(count).toBeLessThan(620);
      }
    });
  });

  describe('assignVariant', () => {
    it('always returns the same arm for the same device', () => {
      for (const id of devices(200)) {
        const first = assignVariant('camp-1', id, twoWay);
        const second = assignVariant('camp-1', id, twoWay);
        expect(first).toEqual(second);
      }
    });

    it('never leaves a device unassigned', () => {
      // A device assigned to nothing is a recipient silently dropped from the
      // send, which would look like a delivery failure that never happened.
      for (const id of devices(1000)) {
        const assignment = assignVariant('camp-1', id, twoWay, 10);
        expect(['control', 'variant']).toContain(assignment.arm);
        if (assignment.arm === 'variant') {
          expect(['A', 'B']).toContain(assignment.key);
        }
      }
    });

    it('respects an even split', () => {
      const counts = { A: 0, B: 0 };
      for (const id of devices(4000)) {
        const a = assignVariant('camp-1', id, twoWay);
        if (a.arm === 'variant') counts[a.key as 'A' | 'B'] += 1;
      }
      expect(counts.A / 4000).toBeGreaterThan(0.45);
      expect(counts.A / 4000).toBeLessThan(0.55);
    });

    it('respects an uneven split', () => {
      const skewed: PushVariant[] = [
        { key: 'A', title: 'A', weight: 90 },
        { key: 'B', title: 'B', weight: 10 },
      ];
      let a = 0;
      for (const id of devices(4000)) {
        const assignment = assignVariant('camp-1', id, skewed);
        if (assignment.arm === 'variant' && assignment.key === 'A') a += 1;
      }
      expect(a / 4000).toBeGreaterThan(0.86);
      expect(a / 4000).toBeLessThan(0.94);
    });

    it('holds back roughly the requested control share', () => {
      let control = 0;
      for (const id of devices(4000)) {
        if (assignVariant('camp-1', id, twoWay, 20).arm === 'control') control += 1;
      }
      expect(control / 4000).toBeGreaterThan(0.17);
      expect(control / 4000).toBeLessThan(0.23);
    });

    it('splits variants evenly *within* the treated audience', () => {
      const counts = { A: 0, B: 0 };
      for (const id of devices(4000)) {
        const a = assignVariant('camp-1', id, twoWay, 20);
        if (a.arm === 'variant') counts[a.key as 'A' | 'B'] += 1;
      }
      const treated = counts.A + counts.B;
      // 50/50 of the treated 80%, not 50/50 of everyone — otherwise a control
      // group would silently starve the later arms.
      expect(counts.A / treated).toBeGreaterThan(0.45);
      expect(counts.A / treated).toBeLessThan(0.55);
    });

    it('keeps control membership stable when variant weights change', () => {
      const rebalanced: PushVariant[] = [
        { key: 'A', title: 'A', weight: 80 },
        { key: 'B', title: 'B', weight: 20 },
      ];
      for (const id of devices(300)) {
        const before = assignVariant('camp-1', id, twoWay, 20).arm === 'control';
        const after = assignVariant('camp-1', id, rebalanced, 20).arm === 'control';
        // Control is taken off the top of the range, so re-weighting the arms
        // must not move anyone in or out of the held-back group.
        expect(before).toBe(after);
      }
    });
  });

  describe('splitAudience', () => {
    it('partitions the audience with nobody lost or duplicated', () => {
      const audience = devices(1000);
      const { control, byVariant } = splitAudience('camp-1', audience, twoWay, 15);

      const assigned = [...control, ...[...byVariant.values()].flat()];
      expect(assigned).toHaveLength(audience.length);
      expect(new Set(assigned).size).toBe(audience.length);
    });

    it('returns a bucket for every variant even when one draws nobody', () => {
      const { byVariant } = splitAudience('camp-1', ['device-0'], twoWay, 0);
      // The report renders a row per arm; a missing key would render as
      // undefined rather than as zero.
      expect([...byVariant.keys()].sort()).toEqual(['A', 'B']);
    });

    it('handles an empty audience', () => {
      const { control, byVariant } = splitAudience('camp-1', [], twoWay, 10);
      expect(control).toEqual([]);
      expect([...byVariant.values()].flat()).toEqual([]);
    });
  });

  describe('validateVariants', () => {
    it('accepts a well-formed experiment', () => {
      expect(validateVariants(twoWay, 10)).toBeNull();
    });

    it('rejects weights that do not total 100', () => {
      // A client could otherwise post arms summing to 90 and quietly lose a
      // tenth of the audience.
      const bad: PushVariant[] = [
        { key: 'A', title: 'A', weight: 50 },
        { key: 'B', title: 'B', weight: 40 },
      ];
      expect(validateVariants(bad, 0)).toMatch(/total 100/);
    });

    it('rejects fewer than two variants', () => {
      expect(validateVariants([twoWay[0]], 0)).toMatch(/at least two/);
    });

    it('rejects duplicate keys', () => {
      const dup: PushVariant[] = [
        { key: 'A', title: 'A', weight: 50 },
        { key: 'A', title: 'B', weight: 50 },
      ];
      expect(validateVariants(dup, 0)).toMatch(/unique/);
    });

    it('rejects a variant with no title', () => {
      const untitled: PushVariant[] = [
        { key: 'A', title: '', weight: 50 },
        { key: 'B', title: 'B', weight: 50 },
      ];
      expect(validateVariants(untitled, 0)).toMatch(/title/);
    });

    it('rejects a zero or negative weight', () => {
      const zero: PushVariant[] = [
        { key: 'A', title: 'A', weight: 0 },
        { key: 'B', title: 'B', weight: 100 },
      ];
      expect(validateVariants(zero, 0)).toMatch(/weight/);
    });

    it('rejects a control group over half the audience', () => {
      expect(validateVariants(twoWay, 60)).toMatch(/between 0 and 50/);
      expect(validateVariants(twoWay, -1)).toMatch(/between 0 and 50/);
    });
  });
});
