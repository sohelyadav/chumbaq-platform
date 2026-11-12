import { DataSource } from 'typeorm';
import { SegmentCompilerService } from './segment-compiler.service';
import { SegmentNode } from './segment-ast';
import {
  openIntDb, closeIntDb, resetFixtures, seedPerson, seedEvent, INT_PROJECT_ID,
} from '../../test-support/int-db';

const BUYER = 'dddddddd-0000-0000-0000-000000000001';
const OBJECTED_PHONE = 'dddddddd-0000-0000-0000-000000000002';
const OBJECTED_LAPTOP = 'dddddddd-0000-0000-0000-000000000003';
const VICTIM_PHONE = 'dddddddd-0000-0000-0000-000000000004';
const ATTACKER = 'dddddddd-0000-0000-0000-000000000005';
const DNT_DEVICE = 'dddddddd-0000-0000-0000-000000000006';
const MIXED_PHONE = 'dddddddd-0000-0000-0000-000000000007';
const MIXED_LAPTOP = 'dddddddd-0000-0000-0000-000000000008';

/**
 * Do-not-track inside segment SQL, against Postgres: the claim is about
 * three-valued logic (NULL through NOT, AND and OR) and a window function,
 * which only a real database can prove.
 */
describe('Segments and do-not-track (integration)', () => {
  let ds: DataSource;
  const compiler = new SegmentCompilerService();

  const run = async (ast: SegmentNode): Promise<string[]> => {
    const { sql, params } = compiler.compile(ast, INT_PROJECT_ID);
    const rows: { person_key: string }[] = await ds.query(sql, params);
    return rows.map((r) => r.person_key).sort();
  };

  const bought = (occurrence: string, count = 1) =>
    ({ type: 'behaviour', eventName: 'purchase', occurrence, count, withinDays: 30 }) as SegmentNode;
  const inUs = { type: 'attribute', field: 'country', op: 'eq', value: 'US' } as SegmentNode;

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query('TRUNCATE tracking_objections');
    await seedPerson(ds, { id: BUYER, externalUserId: 'buyer', country: 'US', totalRevenue: 500 });
    // The dashboard objected for this person: every device, whatever it says.
    await seedPerson(ds, { id: OBJECTED_PHONE, externalUserId: 'objected', country: 'US', totalRevenue: 500 });
    await seedPerson(ds, { id: OBJECTED_LAPTOP, externalUserId: 'objected', country: 'US' });
    await ds.query(
      `INSERT INTO tracking_objections (project_id, external_user_id) VALUES ($1, 'objected')`,
      [INT_PROJECT_ID],
    );
    // Someone else's device claims the victim's external id and turns
    // do-not-track on: only that device is affected.
    await seedPerson(ds, { id: VICTIM_PHONE, externalUserId: 'victim', country: 'US' });
    await seedPerson(ds, { id: ATTACKER, externalUserId: 'victim', country: 'US' });
    // An anonymous device that turned it on itself.
    await seedPerson(ds, { id: DNT_DEVICE, country: 'US', totalRevenue: 500 });
    // One person, two devices: the phone (do-not-track) bought, the laptop did not.
    await seedPerson(ds, { id: MIXED_PHONE, externalUserId: 'mixed', country: 'US' });
    await seedPerson(ds, { id: MIXED_LAPTOP, externalUserId: 'mixed', country: 'US' });
    await ds.query(
      `UPDATE device_identities SET do_not_track = true WHERE id = ANY($1::uuid[])`,
      [[ATTACKER, DNT_DEVICE, MIXED_PHONE]],
    );
    for (const id of [BUYER, OBJECTED_PHONE, VICTIM_PHONE, DNT_DEVICE, MIXED_PHONE]) {
      await seedEvent(ds, { deviceIdentityId: id, eventName: 'purchase', daysAgo: 1 });
    }
  });

  const everyone = ['buyer', `device:${DNT_DEVICE}`, 'mixed', 'objected', 'victim'];

  it('picks nobody for what was done on a do-not-track device or by an objected person', async () => {
    // The victim is still picked: the attacker's flag stays on the attacker's row.
    expect(await run(bought('at_least'))).toEqual(['buyer', 'victim']);
  });

  it('does not pick them for what they did not do either', async () => {
    // Only the mixed person's tracked laptop says "has not bought": the
    // phone's purchase is not counted, and the phone itself is unknown.
    expect(await run(bought('none'))).toEqual(['mixed']);
  });

  it('keeps the behaviour rule unknown under NOT', async () => {
    const notBought = { type: 'group', operator: 'and', negate: true, children: [bought('at_least')] } as SegmentNode;
    expect(await run(notBought)).toEqual(['mixed']);
  });

  it('still lets a rule that is not about behaviour decide an OR', async () => {
    const either = { type: 'group', operator: 'or', children: [bought('at_least'), inUs] } as SegmentNode;
    expect(await run(either)).toEqual(everyone);
  });

  it('cannot reach them through an AND with a behaviour rule', async () => {
    const both = { type: 'group', operator: 'and', children: [inUs, bought('at_least')] } as SegmentNode;
    expect(await run(both)).toEqual(['buyer', 'victim']);
  });

  it('applies to attributes counted from behaviour, such as revenue', async () => {
    const bigSpender = { type: 'attribute', field: 'totalRevenue', op: 'gte', value: 100 } as SegmentNode;
    expect(await run(bigSpender)).toEqual(['buyer']);
  });

  it('leaves attributes the person told us about alone', async () => {
    expect(await run(inUs)).toEqual(everyone);
  });

  it('selects do-not-track rows by their own flag or their person’s objection', async () => {
    const flagged = { type: 'attribute', field: 'doNotTrack', op: 'eq', value: true } as SegmentNode;
    expect(await run(flagged)).toEqual([`device:${DNT_DEVICE}`, 'mixed', 'objected', 'victim']);
  });
});
