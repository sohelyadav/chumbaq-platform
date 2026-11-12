/**
 * The segment query AST and its validation.
 *
 * This module is pure — no NestJS, no database, no I/O — so it can be shared
 * with the dashboard and exhaustively tested without infrastructure.
 */

/** Attribute fields a rule may address, mapped to their device_identities column. */
export const ATTRIBUTE_COLUMNS = {
  externalUserId: 'external_user_id',
  distinctId: 'distinct_id',
  platform: 'platform',
  appVersion: 'app_version',
  country: 'country',
  countryCode: 'country_code',
  region: 'region',
  city: 'city',
  timezone: 'timezone',
  locale: 'locale',
  language: 'language',
  totalSessions: 'total_sessions',
  totalRevenue: 'total_revenue',
  firstSeenAt: 'first_seen_at',
  lastSeenAt: 'last_seen_at',
  lastEventAt: 'last_event_at',
  emailOptIn: 'email_opt_in',
  pushOptIn: 'push_opt_in',
  doNotTrack: 'do_not_track',
} as const;

export type AttributeField = keyof typeof ATTRIBUTE_COLUMNS;

export const ATTRIBUTE_OPS = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'contains', 'in', 'exists', 'not_exists',
] as const;
export type AttributeOp = (typeof ATTRIBUTE_OPS)[number];

export const OCCURRENCES = ['at_least', 'at_most', 'exactly', 'none'] as const;
export type Occurrence = (typeof OCCURRENCES)[number];

/** Guardrails. A marketer can author arbitrarily expensive queries. */
export const MAX_AST_DEPTH = 5;
export const MAX_AST_RULES = 50;
export const MAX_WITHIN_DAYS = 365;

/** A traits/property key must be a safe identifier — it is interpolated as a jsonb key. */
const TRAITS_KEY = /^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,63}$/;

/**
 * True for any string safe to interpolate directly into SQL as a jsonb key —
 * a traits path segment or an event property name. Anchored, so it excludes
 * quotes, semicolons, whitespace, comment markers and backslashes.
 */
export function isSafeKey(key: string): boolean {
  return TRAITS_KEY.test(key);
}

export interface SegmentGroup {
  type: 'group';
  operator: 'and' | 'or';
  negate?: boolean;
  children: SegmentNode[];
}

export interface AttributeRule {
  type: 'attribute';
  field: string;
  op: AttributeOp;
  value: string | number | boolean | Array<string | number> | null;
}

export interface PropertyPredicate {
  property: string;
  op: AttributeOp;
  value: string | number | boolean | Array<string | number> | null;
}

export interface BehaviourRule {
  type: 'behaviour';
  eventName: string;
  occurrence: Occurrence;
  count: number;
  withinDays: number;
  where?: PropertyPredicate[];
}

export type SegmentNode = SegmentGroup | AttributeRule | BehaviourRule;

/** Carries the path to the offending node so the UI can highlight one rule. */
export class SegmentAstError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'SegmentAstError';
  }
}

/** True for `traits.someKey` with a safe key. */
export function isTraitsPath(field: string): boolean {
  if (!field.startsWith('traits.')) return false;
  return isSafeKey(field.slice('traits.'.length));
}

function validateValue(rule: AttributeRule | PropertyPredicate, path: string): void {
  if (rule.op === 'exists' || rule.op === 'not_exists') return;
  if (rule.op === 'in') {
    if (!Array.isArray(rule.value) || rule.value.length === 0) {
      throw new SegmentAstError(`op "in" requires a non-empty array value`, path);
    }
    return;
  }
  if (rule.value === null || rule.value === undefined) {
    throw new SegmentAstError(`op "${rule.op}" requires a value`, path);
  }
  if (Array.isArray(rule.value)) {
    throw new SegmentAstError(`op "${rule.op}" does not take an array`, path);
  }
}

function walk(node: SegmentNode, path: string, depth: number, counter: { n: number }): void {
  if (depth > MAX_AST_DEPTH) {
    throw new SegmentAstError(`segment exceeds maximum depth of ${MAX_AST_DEPTH}`, path);
  }
  if (!node || typeof node !== 'object') {
    throw new SegmentAstError('node must be an object', path);
  }

  if (node.type === 'group') {
    if (node.operator !== 'and' && node.operator !== 'or') {
      throw new SegmentAstError(`group operator must be "and" or "or"`, path);
    }
    if (!Array.isArray(node.children) || node.children.length === 0) {
      throw new SegmentAstError('group must have at least one child', path);
    }
    node.children.forEach((child, i) =>
      walk(child, `${path}.children[${i}]`, depth + 1, counter),
    );
    return;
  }

  counter.n += 1;
  if (counter.n > MAX_AST_RULES) {
    throw new SegmentAstError(`segment exceeds maximum of ${MAX_AST_RULES} rules`, path);
  }

  if (node.type === 'attribute') {
    const known = Object.prototype.hasOwnProperty.call(ATTRIBUTE_COLUMNS, node.field);
    if (!known && !isTraitsPath(node.field)) {
      throw new SegmentAstError(`unknown attribute field "${node.field}"`, path);
    }
    if (!ATTRIBUTE_OPS.includes(node.op)) {
      throw new SegmentAstError(`unknown operator "${node.op}"`, path);
    }
    validateValue(node, path);
    return;
  }

  if (node.type === 'behaviour') {
    if (typeof node.eventName !== 'string' || node.eventName.trim() === '') {
      throw new SegmentAstError('behaviour rule requires an eventName', path);
    }
    if (!OCCURRENCES.includes(node.occurrence)) {
      throw new SegmentAstError(`unknown occurrence "${node.occurrence}"`, path);
    }
    if (!Number.isInteger(node.count) || node.count < 0) {
      throw new SegmentAstError('count must be a non-negative integer', path);
    }
    if (
      !Number.isInteger(node.withinDays) ||
      node.withinDays < 1 ||
      node.withinDays > MAX_WITHIN_DAYS
    ) {
      throw new SegmentAstError(`withinDays must be between 1 and ${MAX_WITHIN_DAYS}`, path);
    }
    (node.where ?? []).forEach((p, i) => {
      counter.n += 1;
      if (counter.n > MAX_AST_RULES) {
        throw new SegmentAstError(`segment exceeds maximum of ${MAX_AST_RULES} rules`, `${path}.where[${i}]`);
      }
      if (!isSafeKey(p.property)) {
        throw new SegmentAstError(`unsafe property name "${p.property}"`, `${path}.where[${i}]`);
      }
      if (!ATTRIBUTE_OPS.includes(p.op)) {
        throw new SegmentAstError(`unknown operator "${p.op}"`, `${path}.where[${i}]`);
      }
      validateValue(p, `${path}.where[${i}]`);
    });
    return;
  }

  throw new SegmentAstError(`unknown node type "${(node as { type: string }).type}"`, path);
}

export function validateAst(node: SegmentNode): void {
  walk(node, 'root', 0, { n: 0 });
}
