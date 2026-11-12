import { EntityManager, Repository } from 'typeorm';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';

const fakeRepository = () =>
  ({
    create: jest.fn((row) => row),
    save: jest.fn(async (row) => row),
  }) as unknown as jest.Mocked<Repository<AdminAuditLogEntity>>;

describe('AdminAuditService', () => {
  const entry = {
    actorId: 'admin-1',
    actorEmail: 'admin@x.com',
    action: 'tenant.suspended' as const,
    targetType: 'user',
  };

  it('writes through the passed manager, so it joins the caller’s transaction', async () => {
    const own = fakeRepository();
    const transactional = fakeRepository();
    const manager = {
      getRepository: jest.fn(() => transactional),
    } as unknown as EntityManager;

    await new AdminAuditService(own).record(entry, manager);

    expect(transactional.save).toHaveBeenCalledTimes(1);
    expect(own.save).not.toHaveBeenCalled();
  });

  it('writes through its own repository without a manager, nulling omitted fields', async () => {
    const own = fakeRepository();

    const row = await new AdminAuditService(own).record(entry);

    expect(own.save).toHaveBeenCalledTimes(1);
    expect(row).toEqual({
      ...entry,
      targetId: null,
      targetLabel: null,
      reason: null,
      metadata: null,
      ipAddress: null,
    });
  });

  it('exposes no way to change or remove a row', () => {
    const methods = Object.getOwnPropertyNames(AdminAuditService.prototype);
    expect(methods.sort()).toEqual(['constructor', 'record', 'recordRead']);
  });
});
