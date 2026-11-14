import { TENANT_CSV_HEADER, TenantCsvRow, toTenantsCsv } from './tenants-csv';

const row = (over: Partial<TenantCsvRow> = {}): TenantCsvRow => ({
  id: '0d7f3c1e-0000-4000-8000-000000000001',
  email: 'owner@example.com',
  name: 'Owner',
  status: 'active',
  plan: 'free',
  isSuperAdmin: false,
  createdAt: '2026-10-01T09:30:00.000Z',
  projectCount: 2,
  mauThisMonth: 12480,
  messagesSent30d: 310,
  lastUsageDay: '2026-11-12',
  ...over,
});

const lines = (csv: string) => csv.split('\r\n').filter((line) => line.length > 0);

describe('toTenantsCsv', () => {
  it('starts with the header and writes one CRLF line per tenant', () => {
    const csv = toTenantsCsv([row(), row({ email: 'b@example.com' })], '2026-11-13');

    expect(lines(csv)[0]).toBe(TENANT_CSV_HEADER.join(','));
    expect(lines(csv)).toHaveLength(3);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines(csv)[1]).toBe(
      '0d7f3c1e-0000-4000-8000-000000000001,owner@example.com,Owner,active,free,false,' +
        '2026-10-01T09:30:00.000Z,2,12480,310,2026-11-12,2026-11-13',
    );
  });

  it('makes a formula in a name inert', () => {
    const csv = toTenantsCsv([row({ name: '=HYPERLINK("x")' })], '2026-11-13');
    expect(lines(csv)[1].split(',')[2]).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('makes a formula in an email inert', () => {
    const csv = toTenantsCsv([row({ email: '+1@example.com' })], '2026-11-13');
    expect(lines(csv)[1].split(',')[1]).toBe(`'+1@example.com`);
  });

  it('writes the effective plan after the status', () => {
    const csv = toTenantsCsv([row({ plan: 'plan_scratch_a' })], '2026-11-13');
    const header = lines(csv)[0].split(',');
    expect(lines(csv)[1].split(',')[header.indexOf('plan')]).toBe('plan_scratch_a');
    expect(header.indexOf('plan')).toBe(header.indexOf('status') + 1);
  });

  it('quotes a name with a comma', () => {
    const csv = toTenantsCsv([row({ name: 'Acme, Inc' })], '2026-11-13');
    expect(lines(csv)[1]).toContain(',"Acme, Inc",');
  });

  it('leaves the last usage and counted-through cells empty when nothing is counted', () => {
    const csv = toTenantsCsv([row({ lastUsageDay: null })], null);
    expect(lines(csv)[1].endsWith(',310,,')).toBe(true);
  });

  it('has a cell for every header and nothing more', () => {
    const csv = toTenantsCsv([row()], '2026-11-13');
    expect(lines(csv)[1].split(',')).toHaveLength(TENANT_CSV_HEADER.length);
  });
});
