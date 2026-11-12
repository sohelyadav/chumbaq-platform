import { parseFactorsResetArgs, parsePasskeysResetArgs, parsePasswordResetLinkArgs } from './factors-reset-args';

const NOTES = 'Video call, matched passport photo';

describe('parseFactorsResetArgs', () => {
  it('accepts a known method and notes, in either order, trimming the notes', () => {
    expect(parseFactorsResetArgs(['--verified-by', 'video_call', '--notes', `  ${NOTES} `])).toEqual({
      verification: { method: 'video_call', notes: NOTES, recentResetJustification: null },
    });
    expect(parseFactorsResetArgs(['--notes', NOTES, '--verified-by', 'billing_record'])).toEqual({
      verification: { method: 'billing_record', notes: NOTES, recentResetJustification: null },
    });
  });

  it.each([
    ['nothing at all', []],
    ['no method', ['--notes', NOTES]],
    ['no notes', ['--verified-by', 'video_call']],
    ['email as the method', ['--verified-by', 'email', '--notes', NOTES]],
    ['notes too short once trimmed', ['--verified-by', 'video_call', '--notes', '  call      ']],
    ['a flag with no value', ['--verified-by', '--notes', NOTES]],
    ['an unknown flag', ['--verified-by', 'video_call', '--notes', NOTES, '--force', 'yes']],
    ['a flag given twice', ['--verified-by', 'video_call', '--verified-by', 'other', '--notes', NOTES]],
  ])('refuses %s', (_, args) => {
    expect(parseFactorsResetArgs(args)).toEqual({ error: expect.any(String) });
  });

  it('takes a justification for going ahead after a recent password reset, trimmed', () => {
    expect(
      parseFactorsResetArgs([
        '--verified-by',
        'video_call',
        '--notes',
        NOTES,
        '--recent-reset-justification',
        '  The owner reset it on the call with us ',
      ]),
    ).toEqual({
      verification: {
        method: 'video_call',
        notes: NOTES,
        recentResetJustification: 'The owner reset it on the call with us',
      },
    });
  });

  it('refuses a justification too short to say anything', () => {
    expect(
      parseFactorsResetArgs(['--verified-by', 'video_call', '--notes', NOTES, '--recent-reset-justification', ' fine ']),
    ).toEqual({ error: expect.stringContaining('--recent-reset-justification') });
  });
});

describe('parsePasskeysResetArgs', () => {
  it('needs nothing, and takes a justification for a recent password reset', () => {
    expect(parsePasskeysResetArgs([])).toEqual({ recentResetJustification: null });
    expect(parsePasskeysResetArgs(['--recent-reset-justification', 'Reset it myself after a new laptop'])).toEqual({
      recentResetJustification: 'Reset it myself after a new laptop',
    });
  });

  it.each([
    ['a justification too short', ['--recent-reset-justification', 'mine']],
    ['the flag with no value', ['--recent-reset-justification']],
    ['a factors-reset flag', ['--notes', NOTES]],
    ['a stray word', ['now']],
  ])('refuses %s', (_, args) => {
    expect(parsePasskeysResetArgs(args)).toEqual({ error: expect.any(String) });
  });
});

describe('parsePasswordResetLinkArgs', () => {
  it('accepts a known method and notes, trimming the notes', () => {
    expect(parsePasswordResetLinkArgs(['--verified-by', 'video_call', '--notes', ` ${NOTES} `])).toEqual({
      verification: {
        method: 'video_call',
        notes: NOTES,
        recentFactorResetJustification: null,
        confirmSuperAdmin: false,
      },
    });
  });

  it('takes a justification for a recent factor reset, trimmed, and the super admin confirmation', () => {
    expect(
      parsePasswordResetLinkArgs([
        '--confirm-super-admin',
        '--verified-by',
        'video_call',
        '--notes',
        NOTES,
        '--recent-factor-reset-justification',
        '  Lost the keys and the password manager ',
      ]),
    ).toEqual({
      verification: {
        method: 'video_call',
        notes: NOTES,
        recentFactorResetJustification: 'Lost the keys and the password manager',
        confirmSuperAdmin: true,
      },
    });
  });

  it.each([
    ['nothing at all', []],
    ['email as the method', ['--verified-by', 'email', '--notes', NOTES]],
    ['notes too short', ['--verified-by', 'video_call', '--notes', 'call']],
    [
      'a factor-reset justification under 10 characters',
      ['--verified-by', 'video_call', '--notes', NOTES, '--recent-factor-reset-justification', ' lost it '],
    ],
    ['the super admin confirmation given a value', ['--verified-by', 'video_call', '--notes', NOTES, '--confirm-super-admin', 'yes']],
    ['the super admin confirmation twice', ['--confirm-super-admin', '--confirm-super-admin', '--verified-by', 'video_call', '--notes', NOTES]],
    // Nothing to justify: getting past the window is what the link is for.
    [
      'a recent-reset justification',
      ['--verified-by', 'video_call', '--notes', NOTES, '--recent-reset-justification', 'The owner asked us to'],
    ],
  ])('refuses %s', (_, args) => {
    expect(parsePasswordResetLinkArgs(args)).toEqual({ error: expect.any(String) });
  });
});
