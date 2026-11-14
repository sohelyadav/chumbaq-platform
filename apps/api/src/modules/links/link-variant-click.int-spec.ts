import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { openIntDb, closeIntDb } from '../../test-support/int-db';
import { LinkVariantEntity } from './entities/link-variant.entity';
import { LinkVariantsService } from './link-variants.service';

/**
 * A click reads the variants, then counts itself. A tenant's edit or delete landing in
 * between must survive the click.
 */
describe('A click counted on an A/B variant (integration)', () => {
  let ds: DataSource;
  const owner = randomUUID();
  let linkId: string;

  beforeAll(async () => {
    ds = await openIntDb();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'v')`, [
      owner,
      `${owner}@variant-click-int.test`,
    ]);
    const [{ id: projectId }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('v', $1) RETURNING id`, [owner]);
    [{ id: linkId }] = await ds.query(
      `INSERT INTO links (short_code, long_url, project_id) VALUES ($1, 'https://example.test/', $2) RETURNING id`,
      [`var-${randomUUID().slice(0, 8)}`, projectId],
    );
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
    await closeIntDb(ds);
  });

  /** The variants as the click read them, with `meanwhile` run before it counts. */
  const clickWith = async (meanwhile: (variantId: string) => Promise<unknown>) => {
    const [{ id }] = await ds.query(
      `INSERT INTO link_variants (link_id, name, long_url, weight) VALUES ($1, 'A', 'https://old.example.test/', 100) RETURNING id`,
      [linkId],
    );
    const real = ds.getRepository(LinkVariantEntity);
    const repo = Object.create(real) as Repository<LinkVariantEntity>;
    repo.find = (async (options: never) => {
      const rows = await real.find(options);
      await meanwhile(id);
      return rows;
    }) as never;
    await new LinksVariantsUnderTest(repo).selectVariant(linkId);
    return id;
  };

  class LinksVariantsUnderTest extends LinkVariantsService {
    constructor(repo: Repository<LinkVariantEntity>) {
      super(repo, null as never);
    }
  }

  it('keeps the destination a tenant set while the click was in flight', async () => {
    const id = await clickWith((variantId) =>
      ds.query(`UPDATE link_variants SET long_url = 'https://new.example.test/' WHERE id = $1`, [variantId]),
    );
    const [row] = await ds.query(`SELECT long_url, clicks FROM link_variants WHERE id = $1`, [id]);
    expect(row).toEqual({ long_url: 'https://new.example.test/', clicks: 1 });
  });

  it('does not bring back a variant deleted while the click was in flight', async () => {
    const id = await clickWith((variantId) => ds.query(`DELETE FROM link_variants WHERE id = $1`, [variantId]));
    expect(await ds.query(`SELECT 1 FROM link_variants WHERE id = $1`, [id])).toEqual([]);
  });
});
