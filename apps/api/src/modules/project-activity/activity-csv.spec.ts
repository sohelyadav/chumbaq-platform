import type { ProjectActivityEntry } from '@chumbaq/shared';
import { ACTIVITY_CSV_HEADER, toActivityCsv } from './activity-csv';

const entry = (over: Partial<ProjectActivityEntry> = {}): ProjectActivityEntry => ({
  id: '0b0c4c4e-6a4f-4f7e-9a51-3f1d2a0c9e11',
  occurredAt: '2026-11-09T10:15:30.123Z',
  actorKind: 'user',
  actorUserId: '5e0d6d2a-1111-4c2b-8e1e-6f3a9b7c2d10',
  actorLabel: 'Priya (priya@acme.com)',
  action: 'campaign.sent',
  group: 'messaging',
  targetType: 'campaign',
  targetId: 'c-1',
  targetLabel: 'Diwali sale',
  details: { recipients: 12400 },
  ipAddress: '203.0.113.7',
  country: 'IN',
  userAgent: 'Mozilla/5.0',
  ...over,
});

const lines = (csv: string) => csv.split('\r\n').filter((l) => l !== '');

describe('toActivityCsv', () => {
  it('writes the header, then one line per entry in the order given', () => {
    const csv = toActivityCsv([entry(), entry({ id: 'second' })]);
    const [header, first, second] = lines(csv);
    expect(header).toBe(
      'occurred_at,actor,action,target_type,target_id,target_label,ip_address,country,user_agent,details,id',
    );
    expect(ACTIVITY_CSV_HEADER.join(',')).toBe(header);
    expect(first).toBe(
      '2026-11-09T10:15:30.123Z,Priya (priya@acme.com),campaign.sent,campaign,c-1,Diwali sale,203.0.113.7,IN,Mozilla/5.0,"{""recipients"":12400}",0b0c4c4e-6a4f-4f7e-9a51-3f1d2a0c9e11',
    );
    expect(second.endsWith(',second')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('writes only the header for no entries', () => {
    expect(toActivityCsv([])).toBe(`${ACTIVITY_CSV_HEADER.join(',')}\r\n`);
  });

  it('makes formula-looking labels inert', () => {
    const [, line] = lines(
      toActivityCsv([
        entry({
          targetLabel: '=HYPERLINK("https://evil.example","click")',
          actorLabel: '+cmd',
          userAgent: '@SUM(A1)',
          details: null,
        }),
      ]),
    );
    expect(line).toContain(`"'=HYPERLINK(""https://evil.example"",""click"")"`);
    expect(line).toContain(`,'+cmd,`);
    expect(line).toContain(`,'@SUM(A1),`);
    expect(line).not.toMatch(/(^|,)[=+@]/);
  });

  it('leaves nulls empty and quotes commas and line breaks', () => {
    const [, line] = lines(
      toActivityCsv([
        entry({ targetType: null, targetId: null, targetLabel: 'a, b\nc', ipAddress: null, country: null, userAgent: null, details: null }),
      ]),
    );
    expect(line).toBe(
      '2026-11-09T10:15:30.123Z,Priya (priya@acme.com),campaign.sent,,,"a, b\nc",,,,,0b0c4c4e-6a4f-4f7e-9a51-3f1d2a0c9e11',
    );
  });

  it('keeps emoji whole', () => {
    expect(toActivityCsv([entry({ targetLabel: 'Sale 🎉🎉' })])).toContain(',Sale 🎉🎉,');
  });
});
