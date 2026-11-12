import type { CertInIncidentType } from '@chumbaq/shared';
import { ANNEXURE_I, isAnnexureId } from './annexure-i';
import { buildReportDraft, dueReminders, deadlineOf, logCommand } from './incident-report';

const HOUR = 3600_000;

describe('Annexure I', () => {
  it('has the 20 types in order, i to xx, verbatim', () => {
    expect(ANNEXURE_I.map((t) => t.id)).toEqual([
      'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
      'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx',
    ]);
    expect(ANNEXURE_I[0].label).toBe('Targeted scanning/probing of critical networks/systems');
    expect(ANNEXURE_I[10].label).toBe('Data Breach');
    expect(ANNEXURE_I[11].label).toBe('Data Leak');
    expect(isAnnexureId('xii')).toBe(true);
    expect(isAnnexureId('xxi')).toBe(false);
  });
});

describe('deadline and reminders', () => {
  const noticed = new Date('2026-11-11T08:00:00Z');

  it('the deadline is 6 hours after noticing', () => {
    expect(deadlineOf(noticed).toISOString()).toBe('2026-11-11T14:00:00.000Z');
  });

  it('a reminder is due at 4 and at 5 hours, once each, only while not reported', () => {
    const at = (h: number) => new Date(noticed.getTime() + h * HOUR);
    const open = { status: 'open' as const, noticedAt: noticed, reminder4hAt: null, reminder5hAt: null };
    expect(dueReminders(open, at(3.9))).toEqual([]);
    expect(dueReminders(open, at(4))).toEqual(['4h']);
    expect(dueReminders(open, at(5.5))).toEqual(['4h', '5h']);
    expect(dueReminders({ ...open, reminder4hAt: at(4) }, at(5.5))).toEqual(['5h']);
    expect(dueReminders({ ...open, status: 'reported' }, at(5.5))).toEqual([]);
    expect(dueReminders({ ...open, status: 'closed' }, at(5.5))).toEqual([]);
  });

  it('sends no reminder for an incident recorded after its hour had passed', () => {
    // Recorded 7 hours after noticing: the overdue state shows on the page; no late 4h email.
    const at = new Date(noticed.getTime() + 7 * HOUR);
    expect(dueReminders({ status: 'open', noticedAt: noticed, reminder4hAt: null, reminder5hAt: null }, at, at)).toEqual([]);
  });
});

describe('the log bundle command', () => {
  it('covers 24 hours before noticing until now', () => {
    expect(logCommand(new Date('2026-11-11T08:00:00Z'), new Date('2026-11-11T10:30:00Z'))).toBe(
      'sudo /usr/local/sbin/chumbaq-collect-logs --from 2026-11-10T08:00:00Z --to 2026-11-11T10:30:00Z',
    );
  });
});

describe('buildReportDraft', () => {
  const incident = {
    title: 'Leaked API key used',
    types: ['iii', 'xii'] as CertInIncidentType[],
    noticedAt: new Date('2026-11-11T08:35:00Z'),
    howNoticed: 'Trap API key alarm',
    summary: 'A trap key was used from 203.0.113.9.',
    systems: 'Customer API',
    tenantCount: 2,
    notes: [{ at: new Date('2026-11-11T09:00:00Z'), note: 'Rotated keys' }],
  };
  const contact = {
    orgName: 'Qleverlabs',
    orgAddress: null,
    sector: 'IT services',
    pocName: 'A Founder',
    pocRole: 'Director',
    pocEmail: 'security@chumbaq.com',
    pocPhone: null,
  };

  it('names the types by their Annexure I wording and the times in IST', () => {
    const { subject, body } = buildReportDraft(incident, contact);
    expect(subject).toBe('Cyber security incident report: Leaked API key used');
    expect(body).toContain('(iii) Unauthorised access of IT systems/data');
    expect(body).toContain('(xii) Data Leak');
    expect(body).toContain('11 Nov 2026, 14:05 IST (08:35 UTC)');
    expect(body).toContain('Rotated keys');
    expect(body).toContain('Customer accounts affected: 2');
  });

  it('leaves what is missing as [to fill]', () => {
    const { body } = buildReportDraft({ ...incident, summary: '', systems: '' }, { ...contact, orgAddress: null, pocPhone: null });
    expect(body).toMatch(/Address: \[to fill\]/);
    expect(body).toMatch(/Phone: \[to fill\]/);
    expect(body).toMatch(/Systems affected: \[to fill\]/);
  });

  it("carries every field of CERT-In's incident reporting form", () => {
    const { body } = buildReportDraft(incident, contact);
    expect(body).toContain('I am: the affected entity');
    expect(body).toContain("Is the affected system critical to the organisation's mission? (Yes/No, brief details): [to fill]");
    for (const field of [
      'Domain/URL',
      'IP address',
      'Operating system',
      'Make/Model/Cloud details',
      'Location of affected system (city, region, country)',
      'Network and name of ISP',
      'Occurrence date & time (dd/mm/yyyy hh:mm)',
    ]) {
      expect(body).toContain(`${field}: [to fill]`);
    }
    expect(body).toContain('Affected application details: Customer API');
    // The form's format, in IST (08:35 UTC is 14:05 IST).
    expect(body).toContain('Detection date & time (dd/mm/yyyy hh:mm): 11/11/2026 14:05 IST');
  });

  it('writes the detection time in IST across a date change', () => {
    const { body } = buildReportDraft({ ...incident, noticedAt: new Date('2026-12-31T19:00:00Z') }, contact);
    expect(body).toContain('Detection date & time (dd/mm/yyyy hh:mm): 01/01/2027 00:30 IST');
  });

  it('works with no contact saved yet', () => {
    const { body } = buildReportDraft(incident, null);
    expect(body).toMatch(/Organisation: \[to fill\]/);
  });
});

describe("the shared package's copy", () => {
  it('matches the API list exactly', async () => {
    // A test may value-import the shared package (jest maps it); production code may not.
    const { CERT_IN_ANNEXURE_I } = await import('@chumbaq/shared');
    expect(CERT_IN_ANNEXURE_I).toEqual(ANNEXURE_I.map((t) => ({ id: t.id, label: t.label })));
  });
});
