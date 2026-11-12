import { randomUUID } from 'crypto';
import type { ProjectRole } from '../modules/project-access/project-permissions';

/**
 * In-memory tables for `ProjectAccessService` unit tests, behaving like TypeORM over
 * Postgres rather than like the code under test: `findOne` matches every column named
 * in `where`, and (as TypeORM does) a key whose value is `undefined` is no condition at
 * all, so a lookup that forgets the user id matches every member of the project.
 */
type Row = Record<string, unknown>;

interface FindOne {
  where: Row;
  relations?: Record<string, boolean>;
  select?: unknown;
}

export class FakeTable<T extends Row> {
  readonly rows: T[] = [];
  /** Every `findOne` made, so a test can prove a lookup never happened. */
  readonly calls: FindOne[] = [];

  constructor(private readonly join: (row: T, relation: string) => unknown = () => undefined) {}

  async findOne(options: FindOne): Promise<T | null> {
    this.calls.push(options);
    const found = this.rows.find((row) =>
      Object.entries(options.where).every(([key, value]) => value === undefined || row[key] === value),
    );
    if (!found) return null;
    const copy: Row = { ...found };
    for (const [relation, wanted] of Object.entries(options.relations ?? {})) {
      if (wanted) copy[relation] = this.join(found, relation) ?? null;
    }
    return copy as T;
  }
}

export interface FakeProject extends Row {
  id: string;
  name: string;
  ownerId: string;
}

export class FakeProjectAccessDb {
  readonly projects = new FakeTable<FakeProject>();
  readonly members = new FakeTable<Row>((row, relation) =>
    relation === 'project' ? this.projects.rows.find((p) => p.id === row.projectId) : undefined,
  );
  readonly links = new FakeTable<Row>();
  readonly categories = new FakeTable<Row>();
  readonly banners = new FakeTable<Row>();

  /** A project as `ProjectsService.create` leaves it: the row, and its owner's member row. */
  project(ownerId: string, name = 'Acme app'): FakeProject {
    const project: FakeProject = {
      id: randomUUID(),
      name,
      domain: 'acme.example',
      ownerId,
      pendingBillingOwnerId: null,
      pendingBillingOfferedAt: null,
      createdAt: new Date('2026-11-01T10:00:00Z'),
      updatedAt: new Date('2026-11-01T10:00:00Z'),
    };
    this.projects.rows.push(project);
    this.member(project.id, ownerId, 'owner');
    return project;
  }

  member(projectId: string, userId: string, role: ProjectRole): void {
    this.members.rows.push({
      id: randomUUID(),
      projectId,
      userId,
      role,
      addedBy: null,
      createdAt: new Date('2026-11-02T10:00:00Z'),
    });
  }

  link(projectId: string): string {
    const id = randomUUID();
    this.links.rows.push({ id, projectId, shortCode: 'abc123', longUrl: 'https://acme.example/x' });
    return id;
  }

  category(projectId: string): string {
    const id = randomUUID();
    this.categories.rows.push({ id, projectId, name: 'Home', type: 'carousel' });
    return id;
  }

  banner(categoryId: string): string {
    const id = randomUUID();
    this.banners.rows.push({ id, categoryId, title: 'Sale' });
    return id;
  }
}
