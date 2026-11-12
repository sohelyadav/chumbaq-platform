import { Injectable } from '@nestjs/common';
import {
  ATTRIBUTE_COLUMNS,
  AttributeOp,
  AttributeRule,
  BehaviourRule,
  PropertyPredicate,
  SegmentGroup,
  SegmentNode,
  isSafeKey,
  isTraitsPath,
} from './segment-ast';

export interface CompiledSegment {
  sql: string;
  params: unknown[];
}

/**
 * Attribute columns that are behaviour by another name: counted or stamped
 * from what a person did, not told to us. A do-not-track person is judged on
 * none of them, as on no behaviour rule (see `unlessDoNotTrack`).
 */
const BEHAVIOURAL_ATTRIBUTES = new Set<string>([
  'totalSessions',
  'totalRevenue',
  'lastSeenAt',
  'lastEventAt',
]);

interface Ctx {
  params: unknown[];
  ctes: string[];
}

/**
 * Compiles a segment AST into parameterised SQL selecting one column,
 * person_key.
 *
 * Pure: no database, no I/O, no injected dependencies. That is deliberate —
 * it makes the hardest part of the engine exhaustively testable without
 * infrastructure, and lets the integration suite focus on whether the emitted
 * SQL actually runs.
 *
 * Only two kinds of value ever reach the SQL string: allow-listed column names
 * from ATTRIBUTE_COLUMNS, and traits/property keys checked here against
 * isSafeKey (segment-ast.ts's strict identifier pattern) rather than merely
 * trusted from an earlier validateAst call. Everything a user supplies is a
 * bound parameter.
 */
@Injectable()
export class SegmentCompilerService {
  compile(ast: SegmentNode, projectId: string): CompiledSegment {
    const ctx: Ctx = { params: [projectId], ctes: [] };
    const predicate = this.node(ast, ctx);

    const joins = ctx.ctes
      .map((_, i) => `  LEFT JOIN b${i} ON b${i}.person_key = p.person_key`)
      .join('\n');

    const allCtes = [this.personCte(), ...ctx.ctes].join(',\n');

    const sql = `WITH ${allCtes}
SELECT DISTINCT p.person_key
FROM person p
${joins}
WHERE ${predicate}`;

    return { sql, params: ctx.params };
  }

  /**
   * Establishes the person grain once; every rule composes against it.
   *
   * `row_dnt` is true on a row that is not to be judged on behaviour: the
   * device set do-not-track itself (that row only; an SDK-set flag never
   * spreads, see the trust model in tracking-consent.service.ts), or a
   * trusted objection covers its external id (every row of that person).
   */
  private personCte(): string {
    const cols = Object.values(ATTRIBUTE_COLUMNS).join(', ');
    return `person AS (
  SELECT id, COALESCE(external_user_id, 'device:' || id::text) AS person_key,
         ${cols}, traits,
         (do_not_track OR EXISTS (
            SELECT 1 FROM tracking_objections o
             WHERE o.project_id = $1 AND o.external_user_id = device_identities.external_user_id
         )) AS row_dnt
  FROM device_identities
  WHERE project_id = $1
)`;
  }

  /**
   * A rule about behaviour is unknown (SQL NULL) on a do-not-track row,
   * rather than true or false.
   *
   * Do-not-track withdraws consent to profiling, so whether a row puts its
   * person in an audience must not depend on what was done there, in either
   * direction: "bought in the last 30 days" must not pick it, and neither must
   * "has not bought", which a count of zero would. NULL does that through
   * ordinary three-valued logic: it fails a WHERE, stays NULL under NOT, and is
   * decided by the other side of an OR. Events from do-not-track rows are also
   * left out of every count (see `behaviour`), so they do not reach a person
   * through their other devices either. This covers events stored before the
   * switch and behaviour-derived columns (BEHAVIOURAL_ATTRIBUTES).
   */
  private unlessDoNotTrack(predicate: string): string {
    return `(CASE WHEN p.row_dnt THEN NULL ELSE (${predicate}) END)`;
  }

  /** Appends a value and returns its placeholder. */
  private bind(ctx: Ctx, value: unknown): string {
    ctx.params.push(value);
    return `$${ctx.params.length}`;
  }

  private node(node: SegmentNode, ctx: Ctx): string {
    if (node.type === 'group') return this.group(node, ctx);
    if (node.type === 'attribute') return this.attribute(node, ctx);
    return this.behaviour(node, ctx);
  }

  private group(node: SegmentGroup, ctx: Ctx): string {
    const joiner = node.operator === 'and' ? ' AND ' : ' OR ';
    const inner = node.children.map((c) => this.node(c, ctx)).join(joiner);
    return node.negate ? `NOT (${inner})` : `(${inner})`;
  }

  private attribute(rule: AttributeRule, ctx: Ctx): string {
    const predicate = this.attributePredicate(rule, ctx);
    return BEHAVIOURAL_ATTRIBUTES.has(rule.field) ? this.unlessDoNotTrack(predicate) : predicate;
  }

  private attributePredicate(rule: AttributeRule, ctx: Ctx): string {
    const traits = isTraitsPath(rule.field);
    const key = traits ? rule.field.slice('traits.'.length) : null;
    // Safe to interpolate: allow-listed column, or a key already matched
    // against /^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,63}$/ during validation.
    // `doNotTrack` means "is this row do-not-track", which is its own flag
    // or a dashboard objection on its person (`row_dnt`), not the column alone.
    const expr = traits
      ? `p.traits ->> '${key}'`
      : rule.field === 'doNotTrack'
        ? 'p.row_dnt'
        : `p.${ATTRIBUTE_COLUMNS[rule.field as keyof typeof ATTRIBUTE_COLUMNS]}`;

    if (rule.op === 'exists') {
      return traits ? `p.traits ? '${key}'` : `${expr} IS NOT NULL`;
    }
    if (rule.op === 'not_exists') {
      return traits ? `NOT (p.traits ? '${key}')` : `${expr} IS NULL`;
    }

    return this.comparison(expr, rule.op, rule.value, ctx, traits);
  }

  /**
   * Wraps a jsonb-extracted value so an ordered comparison sorts as a number.
   *
   * `->>` yields text, so `traits.score > 100` compared '99' against '100'
   * lexicographically and answered true. That is a wrong audience delivered
   * with no error anywhere — the worst shape of bug this compiler can emit.
   *
   * The cast has to be guarded, because one row holding a non-numeric value
   * for the key would raise and abort the entire segment query. CASE is the
   * idiom Postgres documents for exactly this: it evaluates the THEN arm only
   * for rows that passed the WHEN test, whereas the obvious
   * `expr ~ '...' AND expr::numeric > $n` gives the planner licence to
   * evaluate the cast first. (The documented caveat on CASE — that constant
   * subexpressions may still be folded at plan time — does not reach here;
   * this subexpression reads a column.)
   *
   * The regex admits what ::numeric admits, so a trait stored as the string
   * "99" is compared as 99 rather than skipped; mobile SDKs routinely send
   * numbers that way. Anything else yields NULL, and the row simply does not
   * match.
   */
  private numericFromJsonb(expr: string): string {
    return `(CASE WHEN ${expr} ~ '^[+-]?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
              THEN (${expr})::numeric END)`;
  }

  private comparison(
    expr: string,
    op: AttributeOp,
    value: unknown,
    ctx: Ctx,
    /** True when `expr` is a `->>` extraction, whose static type is text. */
    jsonbText = false,
  ): string {
    // Ordered operators only, and only against a numeric parameter. eq / neq /
    // contains / in stay text: they are correct today, and `traits.tier > 'b'`
    // is a legitimate text comparison that must keep working.
    const ordered = op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte';
    const lhs =
      jsonbText && ordered && typeof value === 'number'
        ? this.numericFromJsonb(expr)
        : expr;

    switch (op) {
      case 'eq':
        return `${expr} = ${this.bind(ctx, value)}`;
      // IS DISTINCT FROM, not <>: a NULL column must count as "not equal to
      // 'US'", which <> would silently drop.
      case 'neq':
        return `${expr} IS DISTINCT FROM ${this.bind(ctx, value)}`;
      case 'gt':
        return `${lhs} > ${this.bind(ctx, value)}`;
      case 'gte':
        return `${lhs} >= ${this.bind(ctx, value)}`;
      case 'lt':
        return `${lhs} < ${this.bind(ctx, value)}`;
      case 'lte':
        return `${lhs} <= ${this.bind(ctx, value)}`;
      case 'contains':
        return `${expr} ILIKE ${this.bind(ctx, `%${String(value)}%`)}`;
      case 'in':
        return `${expr} = ANY(${this.bind(ctx, value)})`;
      default:
        throw new Error(`comparison received unsupported op "${op}"`);
    }
  }

  private behaviour(rule: BehaviourRule, ctx: Ctx): string {
    const index = ctx.ctes.length;
    const alias = `b${index}`;
    // Reserve the slot so nested compilation cannot steal this index.
    ctx.ctes.push('');

    const nameParam = this.bind(ctx, rule.eventName);
    const daysParam = this.bind(ctx, rule.withinDays);

    const wherePredicates = (rule.where ?? []).map((p: PropertyPredicate) => {
      // Self-defending, same as attribute()'s traits key: never trust that
      // the caller already ran validateAst.
      if (!isSafeKey(p.property)) {
        throw new Error(`behaviour rule "where" has an unsafe property name "${p.property}"`);
      }
      if (p.op === 'exists') return `e.properties ? '${p.property}'`;
      if (p.op === 'not_exists') return `NOT (e.properties ? '${p.property}')`;
      // Same text-sort trap as traits: an event property is extracted with ->>
      // through the same comparison(), so the guard belongs here too.
      return this.comparison(
        `(e.properties ->> '${p.property}')`, p.op, p.value, ctx, true,
      );
    });
    const extra = wherePredicates.length ? `\n    AND ${wherePredicates.join('\n    AND ')}` : '';

    ctx.ctes[index] = `${alias} AS (
  SELECT p.person_key, count(*) AS c
  FROM user_events e JOIN person p ON p.id = e.device_identity_id
  WHERE e.event_name = ${nameParam}
    AND NOT p.row_dnt
    AND e.timestamp >= NOW() - (${daysParam}::int * INTERVAL '1 day')${extra}
  GROUP BY p.person_key
)`;

    // LEFT JOIN + COALESCE is what lets 'none' be = 0 on the same path as
    // every other occurrence, instead of a special-cased anti-join.
    if (rule.occurrence === 'none') {
      return this.unlessDoNotTrack(`COALESCE(${alias}.c, 0) = 0`);
    }
    const cmp =
      rule.occurrence === 'at_least' ? '>=' : rule.occurrence === 'at_most' ? '<=' : '=';
    return this.unlessDoNotTrack(`COALESCE(${alias}.c, 0) ${cmp} ${this.bind(ctx, rule.count)}`);
  }
}
