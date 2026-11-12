import { AUDIT_CSV_HEADER, csvCell, toAuditCsv } from './audit-csv';
import type { AdminAuditLog } from '@chumbaq/shared';

const ROW: AdminAuditLog = {
  id: '9a4c1f7e-0d2b-4e4b-9a55-0f7c2b0f1a11',
  actorId: null,
  actorEmail: 'cli',
  action: 'super_admin.granted',
  targetType: 'user',
  targetId: null,
  targetLabel: 'ops@chumbaq.com',
  reason: null,
  metadata: null,
  ipAddress: null,
  createdAt: '2026-11-06T10:00:00.000Z',
};

describe('csvCell', () => {
  it.each([
    ['=HYPERLINK("http://x.test")', `"'=HYPERLINK(""http://x.test"")"`],
    ['+1', "'+1"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
  ])('neutralises a cell that a spreadsheet would run: %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it.each([
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['plain', 'plain'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('quotes only what needs it: %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('leaves a formula character that is not first alone', () => {
    expect(csvCell('a=b')).toBe('a=b');
  });
});

describe('toAuditCsv', () => {
  it('writes a header and one CRLF-ended line per row, metadata as JSON', () => {
    const csv = toAuditCsv([{ ...ROW, metadata: { expiresAt: 'x', n: 1 } }]);

    expect(csv).toBe(
      `${AUDIT_CSV_HEADER.join(',')}\r\n` +
        `2026-11-06T10:00:00.000Z,cli,,super_admin.granted,user,,ops@chumbaq.com,,,` +
        `"{""expiresAt"":""x"",""n"":1}",${ROW.id}\r\n`,
    );
  });

  it('is only the header when there are no rows', () => {
    expect(toAuditCsv([])).toBe(`${AUDIT_CSV_HEADER.join(',')}\r\n`);
  });
});
