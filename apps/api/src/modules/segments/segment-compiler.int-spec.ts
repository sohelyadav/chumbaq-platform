import { DataSource } from 'typeorm';
import { SegmentCompilerService } from './segment-compiler.service';
import { SegmentNode } from './segment-ast';
import {
  openIntDb, closeIntDb, resetFixtures, seedPerson, seedEvent, INT_PROJECT_ID,
} from '../../test-support/int-db';

const D1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const D2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const D3 = 'aaaaaaaa-0000-0000-0000-000000000003';

describe('SegmentCompilerService (integration)', () => {
  let ds: DataSource;
  const compiler = new SegmentCompilerService();

  const run = async (ast: SegmentNode): Promise<string[]> => {
    const { sql, params } = compiler.compile(ast, INT_PROJECT_ID);
    const rows: { person_key: string }[] = await ds.query(sql, params);
    return rows.map((r) => r.person_key).sort();
  };

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    // D1 and D2 are the SAME person (user-1) on two devices.
    await seedPerson(ds, { id: D1, externalUserId: 'user-1', country: 'US', platform: 'ios', totalRevenue: 150, traits: { plan: 'pro' } });
    await seedPerson(ds, { id: D2, externalUserId: 'user-1', country: 'US', platform: 'android', totalRevenue: 150 });
    // D3 is anonymous.
    await seedPerson(ds, { id: D3, externalUserId: null, country: 'GB', platform: 'ios', totalRevenue: 0 });
  });

  it('collapses one person across their devices and keys anonymous by device', async () => {
    const keys = await run({ type: 'attribute', field: 'platform', op: 'exists', value: null } as SegmentNode);
    expect(keys).toEqual([`device:${D3}`, 'user-1']);
  });

  it('matches a person when any of their devices matches', async () => {
    const keys = await run({ type: 'attribute', field: 'platform', op: 'eq', value: 'android' } as SegmentNode);
    expect(keys).toEqual(['user-1']);
  });

  it('filters on an attribute', async () => {
    expect(await run({ type: 'attribute', field: 'country', op: 'eq', value: 'GB' } as SegmentNode))
      .toEqual([`device:${D3}`]);
  });

  it('handles neq without dropping NULLs', async () => {
    await seedPerson(ds, { id: 'aaaaaaaa-0000-0000-0000-000000000004', externalUserId: 'user-4', country: null });
    const keys = await run({ type: 'attribute', field: 'country', op: 'neq', value: 'US' } as SegmentNode);
    expect(keys).toEqual([`device:${D3}`, 'user-4']);
  });

  it('filters on a numeric comparison', async () => {
    expect(await run({ type: 'attribute', field: 'totalRevenue', op: 'gt', value: 100 } as SegmentNode))
      .toEqual(['user-1']);
  });

  it('filters on a traits path', async () => {
    expect(await run({ type: 'attribute', field: 'traits.plan', op: 'eq', value: 'pro' } as SegmentNode))
      .toEqual(['user-1']);
  });

  it('supports traits existence', async () => {
    expect(await run({ type: 'attribute', field: 'traits.plan', op: 'exists', value: null } as SegmentNode))
      .toEqual(['user-1']);
  });

  /**
   * `->>` returns text, so an ordered comparison on a traits path sorted
   * lexicographically: '9' > '100' is true, '99' >= '100' is true. A wrong
   * audience with nothing raised anywhere. These cases only mean something
   * executed against Postgres — asserting on the generated SQL string cannot
   * tell a correct cast from a plausible-looking one.
   */
  describe('ordered comparisons on numeric traits', () => {
    const S = (n: number) => `bbbbbbbb-0000-0000-0000-00000000000${n}`;

    beforeEach(async () => {
      await resetFixtures(ds);
      await seedPerson(ds, { id: S(1), externalUserId: 'n-9', traits: { score: 9 } });
      await seedPerson(ds, { id: S(2), externalUserId: 'n-99', traits: { score: 99 } });
      await seedPerson(ds, { id: S(3), externalUserId: 'n-100', traits: { score: 100 } });
      await seedPerson(ds, { id: S(4), externalUserId: 'n-250', traits: { score: 250 } });
    });

    const score = (op: 'gt' | 'gte' | 'lt' | 'lte', value: number) =>
      run({ type: 'attribute', field: 'traits.score', op, value } as SegmentNode);

    it('gt orders numerically, not as text', async () => {
      // As text every one of these four sorts above '99'; numerically two do.
      expect(await score('gt', 99)).toEqual(['n-100', 'n-250']);
    });

    it('gte orders numerically, not as text', async () => {
      // As text all four are >= '100'.
      expect(await score('gte', 100)).toEqual(['n-100', 'n-250']);
    });

    it('lt orders numerically, not as text', async () => {
      // As text none is < '100'.
      expect(await score('lt', 100)).toEqual(['n-9', 'n-99']);
    });

    it('lte orders numerically, not as text', async () => {
      expect(await score('lte', 99)).toEqual(['n-9', 'n-99']);
    });

    it('reads a trait stored as a numeric string as a number', async () => {
      await seedPerson(ds, { id: S(5), externalUserId: 'n-str', traits: { score: '150' } });

      expect(await score('gte', 100)).toEqual(['n-100', 'n-250', 'n-str']);
    });

    it('tolerates a non-numeric value for the same key instead of aborting the query', async () => {
      // Unguarded, this row's ::numeric raises and takes the whole segment
      // down — every audience using the key stops resolving because one
      // person's trait is a word.
      await seedPerson(ds, { id: S(6), externalUserId: 'n-word', traits: { score: 'high' } });
      await seedPerson(ds, { id: S(7), externalUserId: 'n-empty', traits: { score: '' } });

      expect(await score('gte', 100)).toEqual(['n-100', 'n-250']);
    });

    it('leaves a person without the key out rather than matching them', async () => {
      await seedPerson(ds, { id: S(8), externalUserId: 'n-none', traits: { other: 1 } });

      expect(await score('lt', 100)).toEqual(['n-9', 'n-99']);
    });

    it('keeps eq on the same key a text match', async () => {
      expect(await run({
        type: 'attribute', field: 'traits.score', op: 'eq', value: 99,
      } as SegmentNode)).toEqual(['n-99']);
    });

    it('still compares a non-numeric traits value as text for an ordered op', async () => {
      await seedPerson(ds, { id: S(9), externalUserId: 'n-tier', traits: { tier: 'gold' } });

      // The parameter is a string, so no cast is applied and 'gold' > 'a'.
      expect(await run({
        type: 'attribute', field: 'traits.tier', op: 'gt', value: 'a',
      } as SegmentNode)).toEqual(['n-tier']);
    });
  });

  it('supports in', async () => {
    expect(await run({ type: 'attribute', field: 'country', op: 'in', value: ['GB', 'FR'] } as SegmentNode))
      .toEqual([`device:${D3}`]);
  });

  it('supports contains, matching a case-insensitive partial string', async () => {
    await seedPerson(ds, { id: 'aaaaaaaa-0000-0000-0000-000000000005', externalUserId: 'user-5', city: 'San Francisco' });
    await seedPerson(ds, { id: 'aaaaaaaa-0000-0000-0000-000000000006', externalUserId: 'user-6', city: 'New York' });

    const keys = await run({ type: 'attribute', field: 'city', op: 'contains', value: 'franc' } as SegmentNode);
    expect(keys).toEqual(['user-5']);
  });

  it('evaluates nested and/or', async () => {
    const keys = await run({
      type: 'group', operator: 'and',
      children: [
        { type: 'attribute', field: 'country', op: 'eq', value: 'US' },
        { type: 'group', operator: 'or', children: [
          { type: 'attribute', field: 'platform', op: 'eq', value: 'android' },
          { type: 'attribute', field: 'platform', op: 'eq', value: 'web' },
        ]},
      ],
    } as SegmentNode);
    expect(keys).toEqual(['user-1']);
  });

  it('evaluates a negated group', async () => {
    const keys = await run({
      type: 'group', operator: 'and', negate: true,
      children: [{ type: 'attribute', field: 'country', op: 'eq', value: 'US' }],
    } as SegmentNode);
    expect(keys).toEqual([`device:${D3}`]);
  });

  describe('behaviour', () => {
    beforeEach(async () => {
      await seedEvent(ds, { deviceIdentityId: D1, eventName: 'purchase', daysAgo: 1 });
      await seedEvent(ds, { deviceIdentityId: D2, eventName: 'purchase', daysAgo: 2 });
      await seedEvent(ds, { deviceIdentityId: D3, eventName: 'purchase', daysAgo: 40 });
    });

    it('counts events across all of a person’s devices', async () => {
      const keys = await run({
        type: 'behaviour', eventName: 'purchase', occurrence: 'at_least', count: 2, withinDays: 7,
      } as SegmentNode);
      expect(keys).toEqual(['user-1']);
    });

    it('respects the withinDays window', async () => {
      expect(await run({
        type: 'behaviour', eventName: 'purchase', occurrence: 'at_least', count: 1, withinDays: 7,
      } as SegmentNode)).toEqual(['user-1']);

      expect(await run({
        type: 'behaviour', eventName: 'purchase', occurrence: 'at_least', count: 1, withinDays: 60,
      } as SegmentNode)).toEqual([`device:${D3}`, 'user-1']);
    });

    it('occurrence none returns people with zero matching events', async () => {
      expect(await run({
        type: 'behaviour', eventName: 'refund', occurrence: 'none', count: 0, withinDays: 30,
      } as SegmentNode)).toEqual([`device:${D3}`, 'user-1']);
    });

    it('occurrence none includes people who did it outside the window', async () => {
      expect(await run({
        type: 'behaviour', eventName: 'purchase', occurrence: 'none', count: 0, withinDays: 7,
      } as SegmentNode)).toEqual([`device:${D3}`]);
    });

    it('at_most and exactly', async () => {
      expect(await run({
        type: 'behaviour', eventName: 'purchase', occurrence: 'exactly', count: 2, withinDays: 7,
      } as SegmentNode)).toEqual(['user-1']);
      expect(await run({
        type: 'behaviour', eventName: 'purchase', occurrence: 'at_most', count: 0, withinDays: 7,
      } as SegmentNode)).toEqual([`device:${D3}`]);
    });

    it('filters on an event property', async () => {
      await seedEvent(ds, { deviceIdentityId: D1, eventName: 'checkout', daysAgo: 1, properties: { tier: 'gold' } });
      await seedEvent(ds, { deviceIdentityId: D3, eventName: 'checkout', daysAgo: 1, properties: { tier: 'free' } });

      expect(await run({
        type: 'behaviour', eventName: 'checkout', occurrence: 'at_least', count: 1, withinDays: 7,
        where: [{ property: 'tier', op: 'eq', value: 'gold' }],
      } as SegmentNode)).toEqual(['user-1']);
    });

    it('filters on event property existence', async () => {
      // D1's checkout carries "tier"; D3's carries other properties but not "tier".
      await seedEvent(ds, { deviceIdentityId: D1, eventName: 'checkout', daysAgo: 1, properties: { tier: 'gold' } });
      await seedEvent(ds, { deviceIdentityId: D3, eventName: 'checkout', daysAgo: 1, properties: { color: 'blue' } });

      expect(await run({
        type: 'behaviour', eventName: 'checkout', occurrence: 'at_least', count: 1, withinDays: 7,
        where: [{ property: 'tier', op: 'exists', value: null }],
      } as SegmentNode)).toEqual(['user-1']);

      expect(await run({
        type: 'behaviour', eventName: 'checkout', occurrence: 'at_least', count: 1, withinDays: 7,
        where: [{ property: 'tier', op: 'not_exists', value: null }],
      } as SegmentNode)).toEqual([`device:${D3}`]);
    });

    it('orders a numeric event property numerically, not as text', async () => {
      // The behaviour path extracts with ->> through the same comparison(),
      // so it carried the identical trap.
      await seedEvent(ds, {
        deviceIdentityId: D1, eventName: 'checkout', daysAgo: 1, properties: { total: 9 },
      });
      await seedEvent(ds, {
        deviceIdentityId: D3, eventName: 'checkout', daysAgo: 1, properties: { total: 100 },
      });

      expect(await run({
        type: 'behaviour', eventName: 'checkout', occurrence: 'at_least', count: 1, withinDays: 7,
        where: [{ property: 'total', op: 'gte', value: 100 }],
      } as SegmentNode)).toEqual([`device:${D3}`]);
    });

    it('combines behaviour with attributes and a second behaviour', async () => {
      const keys = await run({
        type: 'group', operator: 'and',
        children: [
          { type: 'attribute', field: 'country', op: 'eq', value: 'US' },
          { type: 'behaviour', eventName: 'purchase', occurrence: 'at_least', count: 1, withinDays: 7 },
          { type: 'behaviour', eventName: 'refund', occurrence: 'none', count: 0, withinDays: 30 },
        ],
      } as SegmentNode);
      expect(keys).toEqual(['user-1']);
    });
  });

  it('scopes strictly to the project', async () => {
    const { sql, params } = compiler.compile(
      { type: 'attribute', field: 'platform', op: 'exists', value: null } as SegmentNode,
      '99999999-9999-9999-9999-999999999999',
    );
    const rows = await ds.query(sql, params);
    expect(rows).toEqual([]);
  });
});
