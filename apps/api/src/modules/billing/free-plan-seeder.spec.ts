import { DataSource } from 'typeorm';
import { FREE_PLAN_INSERT_SQL, FreePlanSeeder } from './free-plan-seeder';

describe('FreePlanSeeder', () => {
  const dataSource = (synchronize: boolean) => {
    const query = jest.fn().mockResolvedValue([]);
    return { ds: { options: { synchronize }, query } as unknown as DataSource, query };
  };

  it('adds the free row, leaving one already there alone, where synchronize built the schema', async () => {
    const { ds, query } = dataSource(true);
    await new FreePlanSeeder(ds).onModuleInit();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(FREE_PLAN_INSERT_SQL);
    expect(FREE_PLAN_INSERT_SQL).toMatch(/ON CONFLICT \("code"\) DO NOTHING/);
  });

  it('does nothing where migrations own the schema (they seed it)', async () => {
    const { ds, query } = dataSource(false);
    await new FreePlanSeeder(ds).onModuleInit();
    expect(query).not.toHaveBeenCalled();
  });
});
