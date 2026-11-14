import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingEnabledGuard } from './billing-enabled.guard';

const guardWith = (billing: unknown) =>
  new BillingEnabledGuard({ get: (key: string) => (key === 'billing' ? billing : undefined) } as unknown as ConfigService);

describe('BillingEnabledGuard', () => {
  it('answers a plain 404 while billing is off, so the routes look absent', () => {
    expect(() => guardWith({ enabled: false }).canActivate()).toThrow(NotFoundException);
    expect(() => guardWith(undefined).canActivate()).toThrow(NotFoundException);
    try {
      guardWith({ enabled: false }).canActivate();
    } catch (error) {
      expect((error as NotFoundException).getResponse()).toEqual({ message: 'Not Found', statusCode: 404 });
    }
  });

  it('lets requests through while billing is on', () => {
    expect(guardWith({ enabled: true }).canActivate()).toBe(true);
  });
});
