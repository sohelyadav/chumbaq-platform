import { SegmentCompilerService } from './segment-compiler.service';
import { SegmentNode } from './segment-ast';

const PROJECT = '11111111-1111-1111-1111-111111111111';

describe('SegmentCompilerService', () => {
  let compiler: SegmentCompilerService;

  beforeEach(() => {
    compiler = new SegmentCompilerService();
  });

  const compile = (ast: SegmentNode) => compiler.compile(ast, PROJECT);
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

  it('always binds projectId as $1 and selects only person_key', () => {
    const { sql, params } = compile({
      type: 'attribute', field: 'country', op: 'eq', value: 'US',
    } as SegmentNode);

    expect(params[0]).toBe(PROJECT);
    expect(squash(sql)).toContain('SELECT DISTINCT p.person_key');
    expect(squash(sql)).toContain('WHERE project_id = $1');
  });

  it('derives person_key as external_user_id falling back to device', () => {
    const { sql } = compile({
      type: 'attribute', field: 'country', op: 'eq', value: 'US',
    } as SegmentNode);

    expect(squash(sql)).toContain(
      "COALESCE(external_user_id, 'device:' || id::text) AS person_key",
    );
  });

  it('binds attribute values as parameters, never interpolating them', () => {
    const { sql, params } = compile({
      type: 'attribute', field: 'country', op: 'eq', value: "US'; DROP TABLE x--",
    } as SegmentNode);

    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain("US'; DROP TABLE x--");
    expect(squash(sql)).toContain('p.country = $2');
  });

  it('compiles nested and/or groups with parentheses', () => {
    const { sql, params } = compile({
      type: 'group',
      operator: 'and',
      children: [
        { type: 'attribute', field: 'country', op: 'eq', value: 'US' },
        {
          type: 'group',
          operator: 'or',
          children: [
            { type: 'attribute', field: 'platform', op: 'eq', value: 'ios' },
            { type: 'attribute', field: 'platform', op: 'eq', value: 'android' },
          ],
        },
      ],
    } as SegmentNode);

    expect(squash(sql)).toContain(
      '(p.country = $2 AND (p.platform = $3 OR p.platform = $4))',
    );
    expect(params.slice(1)).toEqual(['US', 'ios', 'android']);
  });

  it('wraps a negated group in NOT', () => {
    const { sql } = compile({
      type: 'group',
      operator: 'and',
      negate: true,
      children: [{ type: 'attribute', field: 'country', op: 'eq', value: 'US' }],
    } as SegmentNode);

    expect(squash(sql)).toContain('NOT (p.country = $2)');
  });

  it('maps camelCase fields to snake_case columns', () => {
    const { sql } = compile({
      type: 'attribute', field: 'totalRevenue', op: 'gt', value: 100,
    } as SegmentNode);

    expect(squash(sql)).toContain('p.total_revenue > $2');
  });

  it('reads a traits path out of jsonb', () => {
    const { sql, params } = compile({
      type: 'attribute', field: 'traits.plan', op: 'eq', value: 'pro',
    } as SegmentNode);

    expect(squash(sql)).toContain("p.traits ->> 'plan' = $2");
    expect(params[1]).toBe('pro');
  });

  it('casts an ordered traits comparison to numeric, guarded', () => {
    const { sql, params } = compile({
      type: 'attribute', field: 'traits.score', op: 'gt', value: 100,
    } as SegmentNode);

    // The behaviour that matters is proven in segment-compiler.int-spec.ts —
    // only Postgres can show that '99' > '100' stopped being true. This case
    // just pins the shape: guarded, so one non-numeric row cannot abort the
    // whole query.
    expect(squash(sql)).toContain("CASE WHEN p.traits ->> 'score' ~");
    expect(squash(sql)).toContain("THEN (p.traits ->> 'score')::numeric END) > $2");
    expect(params[1]).toBe(100);
  });

  it('leaves an ordered traits comparison against a string as text', () => {
    const { sql } = compile({
      type: 'attribute', field: 'traits.tier', op: 'gt', value: 'gold',
    } as SegmentNode);

    expect(squash(sql)).not.toContain('::numeric');
    expect(squash(sql)).toContain("p.traits ->> 'tier' > $2");
  });

  it('leaves eq on a traits path as a text comparison', () => {
    const { sql } = compile({
      type: 'attribute', field: 'traits.score', op: 'eq', value: 100,
    } as SegmentNode);

    // eq / neq / contains / in are correct as text; only ordering was wrong.
    expect(squash(sql)).not.toContain('::numeric');
  });

  it('compiles in to = ANY with an array parameter', () => {
    const { sql, params } = compile({
      type: 'attribute', field: 'country', op: 'in', value: ['US', 'GB'],
    } as SegmentNode);

    expect(squash(sql)).toContain('p.country = ANY($2)');
    expect(params[1]).toEqual(['US', 'GB']);
  });

  it('compiles contains to a case-insensitive LIKE with a bound pattern', () => {
    const { sql, params } = compile({
      type: 'attribute', field: 'city', op: 'contains', value: 'york',
    } as SegmentNode);

    expect(squash(sql)).toContain('p.city ILIKE $2');
    expect(params[1]).toBe('%york%');
  });

  it('compiles exists and not_exists without a value parameter', () => {
    const exists = compile({
      type: 'attribute', field: 'country', op: 'exists', value: null,
    } as SegmentNode);
    expect(squash(exists.sql)).toContain('p.country IS NOT NULL');
    expect(exists.params).toHaveLength(1);

    const missing = compile({
      type: 'attribute', field: 'country', op: 'not_exists', value: null,
    } as SegmentNode);
    expect(squash(missing.sql)).toContain('p.country IS NULL');
  });

  it('uses the jsonb key operator for traits existence', () => {
    const { sql, params } = compile({
      type: 'attribute', field: 'traits.plan', op: 'exists', value: null,
    } as SegmentNode);

    expect(squash(sql)).toContain("p.traits ? 'plan'");
    expect(params).toHaveLength(1);
  });

  it('uses IS DISTINCT FROM for neq so NULLs are not silently excluded', () => {
    const { sql } = compile({
      type: 'attribute', field: 'country', op: 'neq', value: 'US',
    } as SegmentNode);

    expect(squash(sql)).toContain('p.country IS DISTINCT FROM $2');
  });

  describe('behaviour rules', () => {
    const beh = (over: Record<string, unknown> = {}): SegmentNode =>
      ({
        type: 'behaviour',
        eventName: 'purchase',
        occurrence: 'at_least',
        count: 2,
        withinDays: 7,
        ...over,
      } as SegmentNode);

    it('emits one CTE per behaviour rule and left-joins it', () => {
      const { sql, params } = compile(beh());
      const flat = squash(sql);

      expect(flat).toContain('b0 AS (');
      expect(flat).toContain('FROM user_events e JOIN person p ON p.id = e.device_identity_id');
      expect(flat).toContain('WHERE e.event_name = $2');
      expect(flat).toContain("e.timestamp >= NOW() - ($3::int * INTERVAL '1 day')");
      expect(flat).toContain('GROUP BY p.person_key');
      expect(flat).toContain('LEFT JOIN b0 ON b0.person_key = p.person_key');
      expect(flat).toContain('COALESCE(b0.c, 0) >= $4');
      expect(params.slice(1)).toEqual(['purchase', 7, 2]);
    });

    it('compiles occurrence none to = 0 rather than a nested NOT', () => {
      const { sql } = compile(beh({ occurrence: 'none', count: 0 }));
      const flat = squash(sql);

      expect(flat).toContain('COALESCE(b0.c, 0) = 0');
      expect(flat).not.toContain('NOT (');
    });

    it('compiles at_most and exactly', () => {
      expect(squash(compile(beh({ occurrence: 'at_most' })).sql)).toContain(
        'COALESCE(b0.c, 0) <= $4',
      );
      expect(squash(compile(beh({ occurrence: 'exactly' })).sql)).toContain(
        'COALESCE(b0.c, 0) = $4',
      );
    });

    it('numbers multiple behaviour CTEs independently', () => {
      const { sql } = compile({
        type: 'group',
        operator: 'and',
        children: [beh(), beh({ eventName: 'refund', occurrence: 'none', count: 0 })],
      } as SegmentNode);
      const flat = squash(sql);

      expect(flat).toContain('b0 AS (');
      expect(flat).toContain('b1 AS (');
      expect(flat).toContain('LEFT JOIN b0 ON');
      expect(flat).toContain('LEFT JOIN b1 ON');
    });

    it('binds event property predicates as parameters', () => {
      const { sql, params } = compile(
        beh({ where: [{ property: 'tier', op: 'eq', value: 'gold' }] }),
      );

      expect(squash(sql)).toContain("(e.properties ->> 'tier') = $4");
      expect(params).toContain('gold');
    });

    it('compiles exists on a where predicate without a value parameter', () => {
      const { sql, params } = compile(
        beh({ where: [{ property: 'tier', op: 'exists', value: null }] }),
      );

      expect(squash(sql)).toContain("e.properties ? 'tier'");
      // projectId, eventName, withinDays, occurrence count — the exists
      // predicate itself contributes no parameter.
      expect(params).toEqual([PROJECT, 'purchase', 7, 2]);
    });

    it('compiles not_exists on a where predicate to the negated form', () => {
      const { sql } = compile(
        beh({ where: [{ property: 'tier', op: 'not_exists', value: null }] }),
      );

      expect(squash(sql)).toContain("NOT (e.properties ? 'tier')");
    });

    it('rejects an unsafe property name, naming it in the error', () => {
      expect(() =>
        compile(beh({ where: [{ property: "tier'; DROP TABLE x--", op: 'eq', value: 'gold' }] })),
      ).toThrow(/unsafe property name "tier';/);
    });
  });

  it('produces SQL with no parameter gaps', () => {
    const { sql, params } = compile({
      type: 'group',
      operator: 'and',
      children: [
        { type: 'attribute', field: 'country', op: 'eq', value: 'US' },
        {
          type: 'behaviour',
          eventName: 'purchase',
          occurrence: 'at_least',
          count: 1,
          withinDays: 30,
        },
      ],
    } as SegmentNode);

    for (let i = 1; i <= params.length; i++) {
      expect(sql).toContain(`$${i}`);
    }
    expect(sql).not.toContain(`$${params.length + 1}`);
  });

  describe('do-not-track', () => {
    it('marks a row do-not-track by its own flag or a trusted objection on its person', () => {
      const flat = squash(compile({ type: 'attribute', field: 'country', op: 'eq', value: 'US' } as SegmentNode).sql);
      expect(flat).toContain(
        '(do_not_track OR EXISTS ( SELECT 1 FROM tracking_objections o WHERE o.project_id = $1 AND o.external_user_id = device_identities.external_user_id )) AS row_dnt',
      );
      // Never spread through shared ids: no window or join over other rows.
      expect(flat).not.toContain('OVER (');
    });

    it('leaves do-not-track rows out of every behaviour count', () => {
      const flat = squash(compile({
        type: 'behaviour', eventName: 'purchase', occurrence: 'at_least', count: 1, withinDays: 30,
      } as SegmentNode).sql);
      expect(flat).toContain('AND NOT p.row_dnt');
    });

    it.each(['at_least', 'at_most', 'exactly', 'none'])(
      'makes a %s behaviour rule unknown on such a row, not true or false',
      (occurrence) => {
        const flat = squash(
          compile({
            type: 'behaviour', eventName: 'purchase', occurrence, count: 1, withinDays: 30,
          } as SegmentNode).sql,
        );
        expect(flat).toMatch(/\(CASE WHEN p\.row_dnt THEN NULL ELSE \(COALESCE\(b0\.c, 0\) (>=|<=|=) (\$4|0)\) END\)/);
      },
    );

    it.each(['totalSessions', 'totalRevenue', 'lastSeenAt', 'lastEventAt'])(
      'treats %s, counted from behaviour, the same way',
      (field) => {
        const flat = squash(compile({ type: 'attribute', field, op: 'gt', value: 1 } as SegmentNode).sql);
        expect(flat).toContain('CASE WHEN p.row_dnt THEN NULL ELSE (');
      },
    );

    it.each(['country', 'platform', 'pushOptIn', 'doNotTrack', 'traits.plan'])(
      'leaves %s, which the person or their device told us, as it was',
      (field) => {
        const flat = squash(compile({ type: 'attribute', field, op: 'eq', value: 'x' } as SegmentNode).sql);
        expect(flat).not.toContain('CASE WHEN p.row_dnt');
      },
    );
  });
});
