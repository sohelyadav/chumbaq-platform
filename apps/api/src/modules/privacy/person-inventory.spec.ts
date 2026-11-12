import * as fs from 'fs';
import * as path from 'path';
import {
  INVENTORY_TOKENS,
  PERSON_INVENTORY,
  PROJECT_PREDICATES,
  bindKeys,
  eraseStatement,
  eraseWhere,
  exportWhere,
  exportStatements,
} from './person-inventory';
import type { PersonKeys } from './person-scope';
import { PrivacyHashService } from './privacy-hash.service';

const keys: PersonKeys = {
  projectId: 'p',
  identityIds: ['i'],
  fingerprints: ['f'],
  externalUserIds: ['u'],
  personKeys: ['u'],
  emails: ['e@x.test'],
  phones: ['+919876543210'],
  exclusiveEmails: ['e@x.test'],
  exclusivePhones: ['+919876543210'],
};

describe('person inventory', () => {
  /**
   * Structurally "<project predicate> AND <rest>", where <rest> has no OR at
   * its top level: an OR outside the parentheses would let the second branch
   * match rows of any project.
   */
  const topLevelOr = (sql: string): boolean => {
    let depth = 0;
    const flat = sql.replace(/\s+/g, ' ');
    for (let i = 0; i < flat.length; i++) {
      const c = flat[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === "'") i = flat.indexOf("'", i + 1);
      else if (depth === 0 && /^ OR /i.test(flat.slice(i, i + 4))) return true;
    }
    return false;
  };
  const isProjectScoped = (where: string): boolean => {
    const flat = where.replace(/\s+/g, ' ').trim();
    const prefix = PROJECT_PREDICATES.find((p) => flat.startsWith(`${p} AND `));
    return !!prefix && !topLevelOr(flat.slice(prefix.length + 5));
  };

  it('constrains every statement to the project, structurally', () => {
    for (const entry of PERSON_INVENTORY) {
      expect([entry.name, (PROJECT_PREDICATES as readonly string[]).includes(entry.project)]).toEqual([entry.name, true]);
      expect([entry.name, isProjectScoped(exportWhere(entry))]).toEqual([entry.name, true]);
      expect([entry.name, isProjectScoped(eraseWhere(entry))]).toEqual([entry.name, true]);
      if (typeof entry.erase === 'function') {
        // A custom statement must end on the entry's own (checked) predicate.
        const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
        const statement = entry.erase(eraseWhere(entry));
        expect([entry.name, flat(statement).endsWith(`WHERE ${flat(eraseWhere(entry))}`)]).toEqual([entry.name, true]);
      }
    }
  });

  /**
   * The structural rule: no predicate matches a person's rows by a
   * distinct_id or alias id except the erase-only orphan branch keyed by the
   * verified external id. merge rewrites distinct_id for any value, so any
   * other distinct_id key reaches someone else's rows.
   */
  it('never keys a row by distinct_id or an alias id except by the verified external id, on erase only', () => {
    const LINK = /distinct_?id|anonymous_id|mixpanelDistinctId/i;
    const VERIFIED_ONLY = /(\w+\.)?"?(distinct_id|mixpanelDistinctId)"? = ANY\(\$externalUserIds\)/gi;
    for (const entry of PERSON_INVENTORY) {
      // What export matches on, and any subquery in its columns, never
      // touches a link id except comparing with the verified external id.
      // (A plain exported column is shown, and withheld by the service.)
      const subqueries = entry.export?.columns.split(/, (?=[^)]*(?:\(|$))/).filter((c) => /SELECT/i.test(c)).join(' ') ?? '';
      const exported = entry.export ? `${exportWhere(entry)} ${subqueries}` : '';
      expect([entry.name, LINK.test(exported.replace(VERIFIED_ONLY, ''))]).toEqual([entry.name, false]);
      // Erasure may use the verified external id as a distinct_id, nothing else.
      const erased = `${eraseWhere(entry)} ${typeof entry.erase === 'function' ? entry.erase(eraseWhere(entry)) : ''}`;
      expect([entry.name, LINK.test(erased.replace(VERIFIED_ONLY, ''))]).toEqual([entry.name, false]);
    }
  });


  it('the structural check catches a predicate that escapes the project', () => {
    expect(isProjectScoped('project_id = $project AND a = ANY($ids)')).toBe(true);
    expect(isProjectScoped('project_id = $project AND (a = 1 OR b = 2)')).toBe(true);
    expect(isProjectScoped('project_id = $project AND a = 1 OR b = 2')).toBe(false);
    expect(isProjectScoped('a = 1 AND project_id = $project')).toBe(false);
    expect(isProjectScoped('$project IS NOT NULL AND a = 1')).toBe(false);
  });

  /**
   * jsonb columns that can hold a person's identity ids, addresses or tokens
   * inside rows that are not the person's (campaign lists, failure records).
   * Each must be handled by some erase statement. A new one goes here and in
   * the inventory, or this fails when it is found in an entity.
   */
  it('scrubs every jsonb column known to hold person references', () => {
    const PERSON_JSONB = ['target_device_ids', 'control_device_ids', 'failure_details'];
    const erases = PERSON_INVENTORY.map((e) => (typeof e.erase === 'function' ? e.erase(eraseWhere(e)) : '')).join('\n');
    for (const column of PERSON_JSONB) {
      expect([column, new RegExp(`${column} = `).test(erases)]).toEqual([column, true]);
    }
    const SUSPECT = /name: '([a-z_]*(device_ids|recipient|address|failure|token)[a-z_]*)'/g;
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.entity.ts')) {
          const source = fs.readFileSync(full, 'utf8');
          for (const m of source.matchAll(/@Column\(\{ type: 'jsonb'[^}]*name: '([a-z_]+)'/g)) {
            if (SUSPECT.test(`name: '${m[1]}'`)) found.add(m[1]);
            SUSPECT.lastIndex = 0;
          }
        }
      }
    };
    walk(path.join(__dirname, '..'));
    expect([...found].filter((c) => !PERSON_JSONB.includes(c)).sort()).toEqual([]);
    expect(found.size).toBeGreaterThanOrEqual(3);
  });

  it('binds only the tokens a statement uses, as typed positional parameters', () => {
    const bound = bindKeys('a = $project AND b = ANY($ids) AND c = $project', keys);
    expect(bound.sql).toBe('a = $1::uuid AND b = ANY($2::uuid[]) AND c = $1::uuid');
    expect(bound.params).toEqual(['p', ['i']]);
    expect(() => bindKeys('a = $projct', keys)).toThrow('Unknown inventory token $projct');
  });

  it('compiles every erase and export statement', () => {
    for (const entry of PERSON_INVENTORY) {
      const erase = eraseStatement(entry, keys);
      if (erase) expect(erase.sql).not.toMatch(/\$[a-zA-Z]/);
      const exported = exportStatements(entry, keys, 10);
      if (exported) {
        expect(exported.rows.sql).not.toMatch(/\$[a-zA-Z]/);
        expect(exported.rows.params[exported.rows.params.length - 1]).toBe(10);
      }
    }
    expect(INVENTORY_TOKENS).toContain('project');
  });

  it('erases children before parents and identities last', () => {
    const order = PERSON_INVENTORY.filter((e) => e.erase).map((e) => e.name);
    expect(order[order.length - 1]).toBe('device_identities');
    expect(order.indexOf('attribution_results')).toBeLessThan(order.indexOf('conversion_events'));
    expect(order.indexOf('conversion_events')).toBeLessThan(order.indexOf('click_events'));
    expect(order.indexOf('push_tokens')).toBeLessThan(order.indexOf('device_identities'));
  });

  it('never exports a push token value', () => {
    const tokens = PERSON_INVENTORY.find((e) => e.name === 'push_tokens');
    expect(tokens?.export?.columns).not.toMatch(/(^|, )token AS/);
    expect(tokens?.export?.columns).toContain('right(token, 6)');
  });

  /**
   * A table added later with a column naming a person must be added to the
   * inventory, or erasure silently leaves it behind. Read from the entity
   * sources, as the DTO checks are, so a new entity is caught without anyone
   * remembering this list.
   */
  it('covers every entity with a column that names a person', () => {
    const PERSON_COLUMNS = /name: '(device_identity_id|distinct_id|person_key|device_fingerprint|external_user_id|anonymous_id)'|deviceIdentityId: string/;
    // Tables with such a column that are deliberately not erased, and why.
    const EXEMPT: Record<string, string> = {};
    const modules = path.join(__dirname, '..');
    const tables: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.entity.ts')) {
          const source = fs.readFileSync(full, 'utf8');
          const table = /@Entity\('([a-z_]+)'\)/.exec(source)?.[1];
          if (table && PERSON_COLUMNS.test(source)) tables.push(table);
        }
      }
    };
    walk(modules);

    expect(tables.length).toBeGreaterThan(10);
    const covered = new Set(PERSON_INVENTORY.map((e) => e.name));
    expect(tables.filter((t) => !covered.has(t) && !EXEMPT[t]).sort()).toEqual([]);
  });
});

describe('PrivacyHashService', () => {
  const crypto = (key: string) => ({ deriveKey: (purpose: string) => Buffer.from(`${key}:${purpose}`) }) as never;
  const hashes = new PrivacyHashService(crypto('k1'));

  it('is deterministic, keyed, and bound to the project and channel', () => {
    const h = hashes.suppressionHash('p1', 'email', 'a@x.test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes.suppressionHash('p1', 'email', 'a@x.test')).toBe(h);
    expect(hashes.suppressionHash('p2', 'email', 'a@x.test')).not.toBe(h);
    expect(hashes.suppressionHash('p1', 'sms', 'a@x.test')).not.toBe(h);
    expect(new PrivacyHashService(crypto('k2')).suppressionHash('p1', 'email', 'a@x.test')).not.toBe(h);
  });

  it('uses a different key for subjects than for suppressions', () => {
    expect(hashes.subjectHash('p1', 'externalUserId', 'u')).not.toBe(
      hashes.suppressionHash('p1', 'email' as never, 'u'),
    );
  });
});
