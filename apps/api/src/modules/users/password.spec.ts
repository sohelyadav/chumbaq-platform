import * as fs from 'fs';
import * as path from 'path';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { LoginDto } from '../auth/dto/login.dto';
import { ReauthDto } from '../auth/dto/reauth.dto';
import { StaffLoginDto } from '../staff-auth/dto/staff-auth.dto';
import { RegisterDto } from '../auth/dto/register.dto';
import { ResetPasswordDto } from '../auth/dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_LONG, PASSWORD_TOO_SHORT,
} from './password';

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const body = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
  data: '',
});

async function messagesFor(metatype: ArgumentMetadata['metatype'], value: unknown) {
  try {
    await pipe.transform(value, body(metatype));
    return [];
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    return (error.getResponse() as { message: string[] }).message;
  }
}

// Each DTO that sets a password, with the rest of a body it would accept.
const SETTERS = [
  ['RegisterDto', RegisterDto, 'password', { email: 'a@b.co', name: 'A' }],
  ['ResetPasswordDto', ResetPasswordDto, 'newPassword', { token: 't' }],
  ['ChangePasswordDto', ChangePasswordDto, 'newPassword', { currentPassword: 'old-password' }],
] as const;

// 'é' is two bytes of UTF-8 and '😀' four, so these are short in characters and long in bytes.
const AT_LIMIT = 'a'.repeat(PASSWORD_MAX_BYTES);
const ONE_BYTE_OVER = 'a'.repeat(PASSWORD_MAX_BYTES + 1);
const FEW_CHARACTERS_MANY_BYTES = 'é'.repeat(37);
const EMOJI = '😀'.repeat(19);

describe('the one rule for a new password', () => {
  describe.each(SETTERS)('%s', (_name, dto, field, rest) => {
    const withPassword = (password: string) => ({ ...rest, [field]: password });

    it('accepts 8 characters and exactly 72 bytes', async () => {
      expect(await messagesFor(dto, withPassword('12345678'))).toEqual([]);
      expect(await messagesFor(dto, withPassword(AT_LIMIT))).toEqual([]);
    });

    it('refuses fewer than 8 characters', async () => {
      expect(await messagesFor(dto, withPassword('1234567'))).toEqual([PASSWORD_TOO_SHORT]);
    });

    it('refuses more than 72 bytes, counting bytes and not characters', async () => {
      expect(await messagesFor(dto, withPassword(ONE_BYTE_OVER))).toEqual([PASSWORD_TOO_LONG]);
      expect(FEW_CHARACTERS_MANY_BYTES.length).toBeLessThan(PASSWORD_MAX_BYTES);
      expect(await messagesFor(dto, withPassword(FEW_CHARACTERS_MANY_BYTES))).toEqual([
        PASSWORD_TOO_LONG,
      ]);
      expect(await messagesFor(dto, withPassword(EMOJI))).toEqual([PASSWORD_TOO_LONG]);
    });
  });

  it('is the limit bcrypt really has: two passwords alike to byte 72 hash the same', async () => {
    const hash = await bcrypt.hash(`${AT_LIMIT}first`, 4);
    await expect(bcrypt.compare(`${AT_LIMIT}second`, hash)).resolves.toBe(true);
  });

  // Someone who set a long password before this rule must still be able to sign in and change it.
  it.each([
    ['LoginDto', LoginDto, { email: 'a@b.co' }],
    ['ReauthDto', ReauthDto, {}],
    ['StaffLoginDto', StaffLoginDto, { email: 'a@b.co' }],
  ] as const)('is not applied by %s, which checks an existing password', async (_name, dto, rest) => {
    expect(await messagesFor(dto, { ...rest, password: 'x'.repeat(200) })).toEqual([]);
  });

  it('nor to the current password when changing it', async () => {
    expect(
      await messagesFor(ChangePasswordDto, {
        currentPassword: 'x'.repeat(200),
        newPassword: '12345678',
      }),
    ).toEqual([]);
  });
});

// The dashboard checks the same rule before sending, from its own copy of the numbers.
it('matches the dashboard copy in apps/web/src/lib/password.ts', () => {
  const web = fs.readFileSync(
    path.join(__dirname, '../../../../web/src/lib/password.ts'),
    'utf8',
  );
  expect(web).toContain(`PASSWORD_MAX_BYTES = ${PASSWORD_MAX_BYTES};`);
  expect(web).toContain(`PASSWORD_MIN_LENGTH = ${PASSWORD_MIN_LENGTH};`);
});

/**
 * Source-level, like `dto-enum-messages.spec.ts`: the next DTO with a password field must
 * either take the shared rule or be named here as one that checks an existing password.
 *
 * It finds fields by name only, so it sees `password` and `passphrase` but not a credential
 * called something else, such as `secret` (which many DTOs use for webhook keys). It is a
 * tripwire, not a proof that every way to set a sign-in credential takes the rule.
 */
const CREDENTIAL_FIELD =
  /((?:^[ \t]*@.*\n|^[ \t]*\/\/.*\n|^[ \t]*\/?\*.*\n)*)^[ \t]*(\w*pass(?:word|phrase)\w*)\??:/gim;

/** Credential fields in a DTO's source that lack `@IsNewPassword()`, by name. */
const fieldsWithoutTheRule = (source: string) =>
  [...source.matchAll(CREDENTIAL_FIELD)]
    .filter(([, decorators]) => !/@IsNewPassword\(/.test(decorators))
    .map(([, , name]) => name);

describe('the DTO field scan', () => {
  it('catches password and passphrase fields without the rule, and passes those with it', () => {
    const source = [
      'export class X {',
      '  @IsString()',
      '  password: string;',
      '',
      '  @IsOptional()',
      '  newPassphrase?: string;',
      '',
      '  // why',
      '  @IsNewPassword()',
      '  confirmedPassword: string;',
      '}',
    ].join('\n');
    expect(fieldsWithoutTheRule(source)).toEqual(['password', 'newPassphrase']);
  });
});

describe('DTO password fields', () => {
  const CHECKS_AN_EXISTING_PASSWORD = new Set([
    'auth/dto/login.dto.ts:password',
    'auth/dto/reauth.dto.ts:password',
    'staff-auth/dto/staff-auth.dto.ts:password',
    'users/dto/change-password.dto.ts:currentPassword',
    // A third party's credential, not one of ours.
    'mixpanel-cohorts/dto/configure-mixpanel.dto.ts:serviceAccountPassword',
  ]);
  const modules = path.join(__dirname, '..');

  const dtoFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return dtoFiles(full);
      return /\.dto\.ts$/.test(entry.name) ? [full] : [];
    });

  it('all use @IsNewPassword unless they check an existing password', () => {
    const offenders: string[] = [];
    for (const file of dtoFiles(modules)) {
      const relative = path.relative(modules, file).split(path.sep).join('/');
      for (const name of fieldsWithoutTheRule(fs.readFileSync(file, 'utf8'))) {
        const key = `${relative}:${name}`;
        if (!CHECKS_AN_EXISTING_PASSWORD.has(key)) offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
  });
});
