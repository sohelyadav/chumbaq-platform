import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { BillingDetailsDto, ChoosePlanDto } from './billing.dto';

describe('billing DTOs, through the real validation pipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const details = (value: unknown) => pipe.transform(value, { type: 'body', metatype: BillingDetailsDto });
  const choose = (value: unknown) => pipe.transform(value, { type: 'body', metatype: ChoosePlanDto });

  const VALID = {
    legalName: '  Acme Software Private Limited ',
    gstin: ' 27aapfu0939f1zv ',
    address: { line1: '1 Main Road', city: 'Pune', postalCode: '411001', country: 'IN' },
    stateCode: '27',
  };

  describe('ChoosePlanDto', () => {
    it('takes a plan code and an interval', async () => {
      await expect(choose({ plan: 'team_2', interval: 'yearly' })).resolves.toEqual({ plan: 'team_2', interval: 'yearly' });
    });

    it('refuses a price, an amount or any other field: amounts come from the server', async () => {
      await expect(choose({ plan: 'team', interval: 'monthly', amountPaise: 1 })).rejects.toThrow(BadRequestException);
      await expect(choose({ plan: 'team', interval: 'monthly', price: 1 })).rejects.toThrow(BadRequestException);
    });

    it('refuses an interval or plan code outside the rules', async () => {
      await expect(choose({ plan: 'team', interval: 'weekly' })).rejects.toThrow(BadRequestException);
      await expect(choose({ plan: 'Team', interval: 'monthly' })).rejects.toThrow(BadRequestException);
      await expect(choose({ plan: { $ne: 1 }, interval: 'monthly' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('BillingDetailsDto', () => {
    it('trims the name and upper-cases the GSTIN', async () => {
      const dto = await details(VALID);
      expect(dto.legalName).toBe('Acme Software Private Limited');
      expect(dto.gstin).toBe('27AAPFU0939F1ZV');
    });

    it('takes no GSTIN, or an empty one, as none', async () => {
      const { gstin: _gstin, ...withoutGstin } = VALID;
      expect((await details(withoutGstin)).gstin).toBeUndefined();
      expect((await details({ ...VALID, gstin: '  ' })).gstin).toBeUndefined();
    });

    it.each([
      ['a malformed GSTIN', { ...VALID, gstin: '27AAPFU0939F1Z' }],
      ['a five-digit PIN code', { ...VALID, address: { ...VALID.address, postalCode: '41100' } }],
      ['a PIN code starting with 0', { ...VALID, address: { ...VALID.address, postalCode: '011001' } }],
      ['a country other than India', { ...VALID, address: { ...VALID.address, country: 'US' } }],
      ['an unknown state code', { ...VALID, stateCode: '00' }],
      ['a one-character name', { ...VALID, legalName: ' A ' }],
      ['an extra field', { ...VALID, amountPaise: 1 }],
      ['an extra address field', { ...VALID, address: { ...VALID.address, state: 'MH' } }],
      ['a control character in the name', { ...VALID, legalName: 'Acme\nInc' }],
    ])('refuses %s', async (_name, body) => {
      await expect(details(body)).rejects.toThrow(BadRequestException);
    });
  });
});
