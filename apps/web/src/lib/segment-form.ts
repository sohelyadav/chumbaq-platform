import type {
  SegmentAstNode,
  SegmentAttributeOp,
  SegmentOccurrence,
  SegmentBehaviourNode,
  SegmentAttributeNode,
  SegmentGroupNode,
  SegmentPropertyPredicate,
} from '@chumbaq/shared';
import { MAX_RULES, MAX_WITHIN_DAYS, opTakesNoValue } from '@/hooks/use-segments';

/**
 * The editor's model of a segment, and its translation to and from the AST
 * the API stores.
 *
 * Separate from the page because this is the part that has to be right. The
 * AST is a tree with depth and negation; the editor is a list of sentences.
 * Everything lossy or type-sensitive about that gap lives here.
 */

let counter = 0;
const nextId = () => `rule_${(counter += 1)}`;

export interface PropertyFilterForm {
  id: string;
  property: string;
  op: SegmentAttributeOp;
  value: string;
}

export interface EventRuleForm {
  id: string;
  kind: 'event';
  eventName: string;
  occurrence: SegmentOccurrence;
  count: string;
  withinDays: string;
  where: PropertyFilterForm[];
}

export interface AttributeRuleForm {
  id: string;
  kind: 'attribute';
  field: string;
  op: SegmentAttributeOp;
  value: string;
}

export type LeafRuleForm = EventRuleForm | AttributeRuleForm;

export interface GroupRuleForm {
  id: string;
  kind: 'group';
  operator: 'and' | 'or';
  children: LeafRuleForm[];
}

export type RuleForm = LeafRuleForm | GroupRuleForm;

export function newEventRule(eventName = ''): EventRuleForm {
  return {
    id: nextId(),
    kind: 'event',
    eventName,
    occurrence: 'at_least',
    count: '1',
    withinDays: '30',
    where: [],
  };
}

export function newAttributeRule(): AttributeRuleForm {
  return { id: nextId(), kind: 'attribute', field: 'country', op: 'eq', value: '' };
}

export function newGroupRule(): GroupRuleForm {
  return { id: nextId(), kind: 'group', operator: 'or', children: [newEventRule()] };
}

export function newPropertyFilter(): PropertyFilterForm {
  return { id: nextId(), property: '', op: 'eq', value: '' };
}

/**
 * A typed value for the AST.
 *
 * Ordered comparisons are coerced to a real number when the text parses as
 * one, and this is a correctness requirement rather than tidiness: the
 * compiler only casts a jsonb extraction to numeric when the bound value is
 * `typeof 'number'`. Left as a string, `traits.score > "9"` becomes a *text*
 * comparison, where "9" > "10" is true. `eq`, `contains` and `in` stay text
 * deliberately — the compiler's own comment notes that `traits.tier > 'b'` is
 * a legitimate text comparison that has to keep working.
 */
function typedValue(
  op: SegmentAttributeOp,
  raw: string,
): string | number | boolean | Array<string | number> | null {
  if (opTakesNoValue(op)) return null;

  if (op === 'in') {
    return raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  const ordered = op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte';
  if (ordered) {
    const asNumber = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(asNumber)) return asNumber;
  }

  return raw;
}

function leafToNode(rule: LeafRuleForm): SegmentAstNode {
  if (rule.kind === 'attribute') {
    const node: SegmentAttributeNode = {
      type: 'attribute',
      field: rule.field,
      op: rule.op,
      value: typedValue(rule.op, rule.value),
    };
    return node;
  }

  const where: SegmentPropertyPredicate[] = rule.where
    .filter((filter) => filter.property.trim() !== '')
    .map((filter) => ({
      property: filter.property.trim(),
      op: filter.op,
      value: typedValue(filter.op, filter.value),
    }));

  const node: SegmentBehaviourNode = {
    type: 'behaviour',
    eventName: rule.eventName.trim(),
    occurrence: rule.occurrence,
    // "never" is expressed as a count of zero; the compiler reads the
    // occurrence rather than the count, but the AST validator still requires a
    // non-negative integer, and 0 is the only honest one here.
    count: rule.occurrence === 'none' ? 0 : Math.trunc(Number(rule.count) || 0),
    withinDays: Math.trunc(Number(rule.withinDays) || 0),
    ...(where.length > 0 ? { where } : {}),
  };
  return node;
}

/** The form as the AST the API stores. */
export function toDefinition(
  matchAll: boolean,
  rules: RuleForm[],
): SegmentGroupNode {
  return {
    type: 'group',
    operator: matchAll ? 'and' : 'or',
    children: rules.map((rule) =>
      rule.kind === 'group'
        ? ({
            type: 'group',
            operator: rule.operator,
            children: rule.children.map(leafToNode),
          } satisfies SegmentGroupNode)
        : leafToNode(rule),
    ),
  };
}

/** How many rules an AST counts against the API's ceiling of 50. */
export function countRules(rules: RuleForm[]): number {
  let total = 0;
  for (const rule of rules) {
    if (rule.kind === 'group') {
      for (const child of rule.children) {
        total += 1 + (child.kind === 'event' ? child.where.length : 0);
      }
    } else {
      total += 1 + (rule.kind === 'event' ? rule.where.length : 0);
    }
  }
  return total;
}

/**
 * The first thing wrong with the audience, phrased for the person editing it.
 *
 * Mirrors the API's `validateAst` so a mistake is named next to the rule that
 * caused it rather than returned as a 400 after a round trip. The API stays
 * the authority — this is not a substitute for it.
 */
export function describeProblem(rules: RuleForm[]): string | null {
  if (rules.length === 0) return 'Add at least one rule to define who is in this audience.';

  const total = countRules(rules);
  if (total > MAX_RULES) {
    return `This audience has ${total} rules. The limit is ${MAX_RULES} — try splitting it into two audiences.`;
  }

  const checkLeaf = (rule: LeafRuleForm, where: string): string | null => {
    if (rule.kind === 'event') {
      if (rule.eventName.trim() === '') return `${where}: choose an event.`;

      const days = Number(rule.withinDays);
      if (!Number.isInteger(days) || days < 1 || days > MAX_WITHIN_DAYS) {
        return `${where}: the time window must be a whole number of days between 1 and ${MAX_WITHIN_DAYS}.`;
      }

      if (rule.occurrence !== 'none') {
        const count = Number(rule.count);
        if (!Number.isInteger(count) || count < 0) {
          return `${where}: the number of times must be a whole number, zero or more.`;
        }
      }

      for (const filter of rule.where) {
        if (filter.property.trim() === '') continue;
        if (!/^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,63}$/.test(filter.property.trim())) {
          return `${where}: "${filter.property}" is not a valid property name.`;
        }
        if (!opTakesNoValue(filter.op) && filter.value.trim() === '') {
          return `${where}: give a value for the "${filter.property}" filter.`;
        }
      }
      return null;
    }

    if (rule.field.trim() === '') return `${where}: choose a profile field.`;
    if (rule.field.startsWith('traits.')) {
      const key = rule.field.slice('traits.'.length);
      if (!/^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,63}$/.test(key)) {
        return `${where}: "${key}" is not a valid custom field name.`;
      }
    }
    if (!opTakesNoValue(rule.op) && rule.value.trim() === '') {
      return `${where}: give a value to compare against.`;
    }
    if (rule.op === 'in') {
      const items = rule.value.split(',').map((v) => v.trim()).filter(Boolean);
      if (items.length === 0) return `${where}: list at least one value, separated by commas.`;
    }
    return null;
  };

  for (const [index, rule] of rules.entries()) {
    const label = `Rule ${index + 1}`;
    if (rule.kind === 'group') {
      if (rule.children.length === 0) {
        return `${label}: an "any of" group needs at least one rule inside it.`;
      }
      for (const [childIndex, child] of rule.children.entries()) {
        const problem = checkLeaf(child, `${label}.${childIndex + 1}`);
        if (problem) return problem;
      }
      continue;
    }
    const problem = checkLeaf(rule, label);
    if (problem) return problem;
  }

  return null;
}

// ─── Reading a saved segment back into the editor ──────────────────────────

function nodeToLeaf(node: SegmentAstNode): LeafRuleForm | null {
  if (node.type === 'behaviour') {
    return {
      id: nextId(),
      kind: 'event',
      eventName: node.eventName,
      occurrence: node.occurrence,
      count: String(node.count),
      withinDays: String(node.withinDays),
      where: (node.where ?? []).map((predicate) => ({
        id: nextId(),
        property: predicate.property,
        op: predicate.op,
        value: valueToText(predicate.value),
      })),
    };
  }
  if (node.type === 'attribute') {
    return {
      id: nextId(),
      kind: 'attribute',
      field: node.field,
      op: node.op,
      value: valueToText(node.value),
    };
  }
  return null;
}

function valueToText(
  value: string | number | boolean | Array<string | number> | null,
): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export interface LoadedDefinition {
  matchAll: boolean;
  rules: RuleForm[];
}

/**
 * A saved AST as the editor's model, or null when the editor cannot represent
 * it faithfully.
 *
 * Null rather than a best effort. The AST permits depth 5 and negated groups;
 * this editor offers one level of grouping and no negation, because an
 * audience nobody can read is worse than one that needs the API. Flattening
 * the difference would quietly change who a campaign goes to, which is the one
 * thing an audience editor must never do — so the page shows the definition
 * read-only instead and says why.
 */
export function fromDefinition(node: SegmentAstNode): LoadedDefinition | null {
  // A bare leaf is a legal root, and reads as a single rule matched on its own.
  const asLeaf = nodeToLeaf(node);
  if (asLeaf) return { matchAll: true, rules: [asLeaf] };

  if (node.type !== 'group' || node.negate) return null;

  const rules: RuleForm[] = [];
  for (const child of node.children) {
    const leaf = nodeToLeaf(child);
    if (leaf) {
      rules.push(leaf);
      continue;
    }

    // One level of nesting is supported; anything inside it must be a leaf.
    if (child.type !== 'group' || child.negate) return null;
    const grandchildren: LeafRuleForm[] = [];
    for (const grandchild of child.children) {
      const inner = nodeToLeaf(grandchild);
      if (!inner) return null;
      grandchildren.push(inner);
    }
    rules.push({
      id: nextId(),
      kind: 'group',
      operator: child.operator,
      children: grandchildren,
    });
  }

  return { matchAll: node.operator === 'and', rules };
}
