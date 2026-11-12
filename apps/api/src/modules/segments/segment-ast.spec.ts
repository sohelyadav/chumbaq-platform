import {
  validateAst,
  SegmentAstError,
  ATTRIBUTE_COLUMNS,
  MAX_AST_DEPTH,
  MAX_AST_RULES,
  SegmentNode,
} from './segment-ast';

const attr = (field: string, op = 'eq', value: unknown = 'x'): SegmentNode =>
  ({ type: 'attribute', field, op, value } as SegmentNode);

describe('validateAst', () => {
  it('accepts a single attribute rule on an allow-listed field', () => {
    expect(() => validateAst(attr('country'))).not.toThrow();
  });

  it('accepts a traits path', () => {
    expect(() => validateAst(attr('traits.plan'))).not.toThrow();
  });

  it('rejects a field that is not allow-listed, naming the path', () => {
    try {
      validateAst({
        type: 'group',
        operator: 'and',
        children: [attr('country'), attr('password')],
      } as SegmentNode);
      throw new Error('expected validateAst to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SegmentAstError);
      expect((e as SegmentAstError).path).toBe('root.children[1]');
      expect((e as SegmentAstError).message).toMatch(/password/);
    }
  });

  it('rejects a traits path with unsafe characters', () => {
    expect(() => validateAst(attr("traits.a';DROP"))).toThrow(SegmentAstError);
  });

  it('requires an array value for the in operator', () => {
    expect(() => validateAst(attr('country', 'in', 'US'))).toThrow(SegmentAstError);
    expect(() => validateAst(attr('country', 'in', ['US', 'GB']))).not.toThrow();
  });

  it('ignores value for exists', () => {
    expect(() => validateAst(attr('country', 'exists', null))).not.toThrow();
  });

  it('rejects an empty group', () => {
    expect(() =>
      validateAst({ type: 'group', operator: 'and', children: [] } as SegmentNode),
    ).toThrow(SegmentAstError);
  });

  it('rejects nesting deeper than MAX_AST_DEPTH', () => {
    let node: SegmentNode = attr('country');
    for (let i = 0; i <= MAX_AST_DEPTH; i++) {
      node = { type: 'group', operator: 'and', children: [node] } as SegmentNode;
    }
    expect(() => validateAst(node)).toThrow(/depth/i);
  });

  it('rejects more than MAX_AST_RULES rules', () => {
    const children = Array.from({ length: 51 }, () => attr('country'));
    expect(() =>
      validateAst({ type: 'group', operator: 'and', children } as SegmentNode),
    ).toThrow(/rules/i);
  });

  describe('behaviour rules', () => {
    const beh = (over: Record<string, unknown> = {}): SegmentNode =>
      ({
        type: 'behaviour',
        eventName: 'purchase',
        occurrence: 'at_least',
        count: 1,
        withinDays: 7,
        ...over,
      } as SegmentNode);

    it('accepts a well-formed behaviour rule', () => {
      expect(() => validateAst(beh())).not.toThrow();
    });

    it('accepts occurrence none with count 0', () => {
      expect(() => validateAst(beh({ occurrence: 'none', count: 0 }))).not.toThrow();
    });

    it('rejects an empty event name', () => {
      expect(() => validateAst(beh({ eventName: '' }))).toThrow(SegmentAstError);
    });

    it('rejects a negative count', () => {
      expect(() => validateAst(beh({ count: -1 }))).toThrow(SegmentAstError);
    });

    it('rejects withinDays outside 1..365', () => {
      expect(() => validateAst(beh({ withinDays: 0 }))).toThrow(SegmentAstError);
      expect(() => validateAst(beh({ withinDays: 366 }))).toThrow(SegmentAstError);
    });

    it('rejects an unknown occurrence', () => {
      expect(() => validateAst(beh({ occurrence: 'sometimes' }))).toThrow(SegmentAstError);
    });

    it('accepts a behaviour rule with a few where predicates', () => {
      expect(() =>
        validateAst(
          beh({
            where: [
              { property: 'plan', op: 'eq', value: 'pro' },
              { property: 'seats', op: 'gte', value: 10 },
              { property: 'active', op: 'exists', value: null },
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('rejects when where predicates push total rule count past MAX_AST_RULES', () => {
      try {
        validateAst(
          beh({
            where: Array.from({ length: MAX_AST_RULES }, () => ({
              property: 'prop',
              op: 'eq' as const,
              value: 'x',
            })),
          }),
        );
        throw new Error('expected validateAst to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SegmentAstError);
        expect((e as SegmentAstError).path).toMatch(/root\.where/);
        expect((e as SegmentAstError).message).toMatch(/rules/i);
      }
    });
  });

  it('maps every allow-listed field to a snake_case column', () => {
    expect(ATTRIBUTE_COLUMNS.totalRevenue).toBe('total_revenue');
    expect(ATTRIBUTE_COLUMNS.lastSeenAt).toBe('last_seen_at');
    expect(ATTRIBUTE_COLUMNS.country).toBe('country');
  });
});
