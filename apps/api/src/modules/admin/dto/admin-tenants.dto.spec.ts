import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import {
  AdminFactorResetRequestDto,
  AdminTenantReasonDto,
  AdminTenantsFilterDto,
  ListAdminTenantsDto,
} from './admin-tenants.dto';

describe('admin tenant DTOs, through the real validation pipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

  const reasonBody = (value: unknown) =>
    pipe.transform(value, { type: 'body', metatype: AdminTenantReasonDto });
  const listQuery = (value: unknown) =>
    pipe.transform(value, { type: 'query', metatype: ListAdminTenantsDto });

  describe('AdminTenantReasonDto', () => {
    it('trims the reason', async () => {
      const dto = await reasonBody({ reason: '  repeated abuse reports  ' });
      expect(dto.reason).toBe('repeated abuse reports');
    });

    it('accepts exactly 10 and exactly 500 characters', async () => {
      await expect(reasonBody({ reason: 'x'.repeat(10) })).resolves.toBeDefined();
      await expect(reasonBody({ reason: 'x'.repeat(500) })).resolves.toBeDefined();
    });

    it('refuses 9 and 501 characters', async () => {
      await expect(reasonBody({ reason: 'x'.repeat(9) })).rejects.toThrow(BadRequestException);
      await expect(reasonBody({ reason: 'x'.repeat(501) })).rejects.toThrow(BadRequestException);
    });

    it('measures after trimming, so padding cannot reach the minimum', async () => {
      await expect(reasonBody({ reason: `   ${'x'.repeat(9)}      ` })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a missing reason', async () => {
      await expect(reasonBody({})).rejects.toThrow(BadRequestException);
    });

    // Implicit conversion would otherwise make these valid strings of 15 and 10
    // characters, and write "[object Object]" into the audit log as the reason.
    it.each([[{ a: 1 }], [1234567890], [['a reason long enough']]])(
      'refuses the non-string reason %j',
      async (reason) => {
        await expect(reasonBody({ reason })).rejects.toThrow(BadRequestException);
      },
    );

    it('refuses unknown properties', async () => {
      await expect(
        reasonBody({ reason: 'x'.repeat(10), suspendedAt: null }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('AdminFactorResetRequestDto', () => {
    const resetBody = (value: unknown) =>
      pipe.transform(value, { type: 'body', metatype: AdminFactorResetRequestDto });
    const valid = {
      reason: 'Lost phone and recovery codes',
      verificationMethod: 'video_call',
      verificationNotes: '  Matched passport on a video call  ',
    };

    it('accepts every listed method and trims the notes', async () => {
      for (const verificationMethod of ['video_call', 'government_id', 'phone_call_known_number', 'billing_record', 'other']) {
        const dto = await resetBody({ ...valid, verificationMethod });
        expect(dto.verificationMethod).toBe(verificationMethod);
        expect(dto.verificationNotes).toBe('Matched passport on a video call');
      }
    });

    it.each([
      ['no method', { verificationMethod: undefined }],
      ['email as the method', { verificationMethod: 'email' }],
      ['no notes', { verificationNotes: undefined }],
      ['notes under 10 characters once trimmed', { verificationNotes: `   ${'x'.repeat(9)}   ` }],
      ['notes over 1000 characters', { verificationNotes: 'x'.repeat(1001) }],
      ['notes that are not a string', { verificationNotes: { a: 'long enough object' } }],
    ])('refuses %s', async (_, change) => {
      await expect(resetBody({ ...valid, ...change })).rejects.toThrow(BadRequestException);
    });
  });

  describe('ListAdminTenantsDto', () => {
    it('applies the shared pagination defaults and converts query strings', async () => {
      expect(await listQuery({})).toMatchObject({ page: 1, limit: 20 });
      const dto = await listQuery({ page: '3', limit: '50' });
      expect(dto).toMatchObject({ page: 3, limit: 50, skip: 100 });
    });

    it('refuses a limit over the shared maximum', async () => {
      await expect(listQuery({ limit: '101' })).rejects.toThrow(BadRequestException);
    });

    it('accepts both statuses and refuses anything else', async () => {
      expect((await listQuery({ status: 'active' })).status).toBe('active');
      expect((await listQuery({ status: 'suspended' })).status).toBe('suspended');
      await expect(listQuery({ status: 'deleted' })).rejects.toThrow(BadRequestException);
    });

    it('trims search and bounds its length', async () => {
      expect((await listQuery({ search: '  priya  ' })).search).toBe('priya');
      await expect(listQuery({ search: 'x'.repeat(255) })).resolves.toBeDefined();
      await expect(listQuery({ search: 'x'.repeat(256) })).rejects.toThrow(BadRequestException);
    });

    it('refuses a repeated search parameter, which Express parses to an array', async () => {
      await expect(listQuery({ search: ['a', 'b'] })).rejects.toThrow(BadRequestException);
    });

    it('sorts newest sign-ups first by default, with no activity filter', async () => {
      const dto = await listQuery({});
      expect(dto.sort).toBe('created_at');
      expect(dto.order).toBe('desc');
      expect(dto.activity).toBeUndefined();
    });

    it('accepts every sort, order and activity filter', async () => {
      for (const sort of ['created_at', 'mau_this_month', 'messages_sent_30d', 'last_usage_day']) {
        expect((await listQuery({ sort })).sort).toBe(sort);
      }
      expect((await listQuery({ order: 'asc' })).order).toBe('asc');
      for (const activity of ['new', 'quiet', 'never_used']) {
        expect((await listQuery({ activity })).activity).toBe(activity);
      }
    });

    it.each([
      ['a column that is not a sort', { sort: 'email' }],
      ['raw SQL as the sort', { sort: 'created_at; DROP TABLE users' }],
      ['an unknown order', { order: 'up' }],
      ['an unknown activity', { activity: 'dormant' }],
      ['a repeated sort', { sort: ['created_at', 'mau_this_month'] }],
    ])('refuses %s', async (_, query) => {
      await expect(listQuery(query)).rejects.toThrow(BadRequestException);
    });
  });

  describe('AdminTenantsFilterDto (the export)', () => {
    const exportQuery = (value: unknown) =>
      pipe.transform(value, { type: 'query', metatype: AdminTenantsFilterDto });

    it('takes the list filters and sort', async () => {
      const dto = await exportQuery({ search: ' a ', status: 'suspended', activity: 'quiet', sort: 'last_usage_day', order: 'asc' });
      expect(dto).toMatchObject({ search: 'a', status: 'suspended', activity: 'quiet', sort: 'last_usage_day', order: 'asc' });
    });

    it('refuses pagination, since an export is not paged', async () => {
      await expect(exportQuery({ page: '2' })).rejects.toThrow(BadRequestException);
      await expect(exportQuery({ limit: '10' })).rejects.toThrow(BadRequestException);
    });
  });
});
