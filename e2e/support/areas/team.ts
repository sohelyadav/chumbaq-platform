import { randomUUID } from 'crypto';
import { Client } from 'pg';
import type { Locator, Page } from '@playwright/test';
import { apiUrl, createAccount, createProject, newClientIp, uniqueEmail, type Account, type Project } from '../api';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the team specs (members, roles, removing, leaving). People each get a
 * client address of their own, so the per-address limits on sign-in and the global
 * throttle count every person as a separate client.
 */

export type Role = 'owner' | 'admin' | 'member';

export interface Person extends Account {
  /** The X-Forwarded-For this person's API calls use. */
  ip: string;
}

export const ROLE_REFUSAL = 'Your role in this project does not allow this.';
export const PROJECT_NOT_FOUND = 'Project not found';
export const MOVE_BILLING_FIRST = 'Move billing ownership to another owner first.';
export const REAUTH_REQUIRED = 'Confirm it is you to continue.';
export const INVITE_GONE = 'This invite has expired or was already used.';

export const MEMBER_PERMISSIONS = ['project.read', 'messaging.write', 'people.read'];
export const ADMIN_PERMISSIONS = [...MEMBER_PERMISSIONS, 'channels.manage', 'keys.manage', 'members.manage', 'activity.view'];
export const OWNER_PERMISSIONS = [...ADMIN_PERMISSIONS, 'privacy', 'project.admin'];

/** The e2e database (the name is checked as in reset.ts), for seeding and reading back. */
export async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const env = stackEnv();
  const client = new Client({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT || 5432),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: assertE2eDatabase(env),
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A new account with its own client address. */
export async function newPerson(label: string, name: string): Promise<Person> {
  const ip = newClientIp();
  const account = await createAccount(ip, label, name);
  return { ...account, ip };
}

export interface CallResult<T = any> {
  status: number;
  /** The parsed body (the whole envelope, `{ data, meta }`, on success). */
  body: T;
}

/** A JSON request that answers the status and body whatever the status. */
export async function call<T = any>(
  method: string,
  path: string,
  { as, ip, body }: { as?: Pick<Person, 'accessToken' | 'ip'> | null; ip?: string; body?: unknown } = {},
): Promise<CallResult<T>> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': as?.ip ?? ip ?? newClientIp(),
      ...(as ? { Authorization: `Bearer ${as.accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body: parsed as T };
}

/** The `message` of an error body. */
export function messageOf(result: CallResult): unknown {
  return (result.body as { message?: unknown } | undefined)?.message;
}

/** Adds someone to a project with a role, as an accepted invite leaves it, in order of the calls. */
export async function addMember(projectId: string, person: Pick<Person, 'userId'>, role: Role, addedBy: Pick<Person, 'userId'>): Promise<void> {
  await withDb((db) =>
    db.query(
      `INSERT INTO project_members (project_id, user_id, role, added_by, created_at)
       VALUES ($1, $2, $3, $4, clock_timestamp())`,
      [projectId, person.userId, role, addedBy.userId],
    ),
  );
}

export interface Team {
  owner: Person;
  project: Project;
  /** Everyone else, by the key the caller chose, added in the order given. */
  people: Record<string, Person>;
}

/**
 * A project of a new owner (its billing owner) and the people given, each added with
 * their role in the order listed: `{ coOwner: ['owner', 'Cara Coowner'], member: ['member', 'Mia Member'] }`.
 */
export async function makeTeam(
  ownerName: string,
  people: Record<string, [Role, string]>,
  projectName?: string,
): Promise<Team> {
  const owner = await newPerson('team-owner', ownerName);
  const project = await createProject(owner, owner.ip, projectName ?? `Team ${randomUUID().slice(0, 6)}`);
  const made: Record<string, Person> = {};
  const entries = Object.entries(people);
  const accounts = await Promise.all(entries.map(([key, [, name]]) => newPerson(`team-${key.toLowerCase()}`, name)));
  for (const [index, [key, [role]]] of entries.entries()) {
    await addMember(project.id, accounts[index], role, owner);
    made[key] = accounts[index];
  }
  return { owner, project, people: made };
}

/** Moves every one of the user's sign-ins back 20 minutes, past the 15-minute recent sign-in window. */
export async function ageSignIn(person: Pick<Person, 'userId'>): Promise<void> {
  await withDb((db) =>
    db.query(`UPDATE auth_sessions SET authenticated_at = now() - interval '20 minutes' WHERE user_id = $1`, [person.userId]),
  );
}

export interface SentInvite {
  id: string;
  email: string;
  token: string;
  inviteUrl: string;
}

/** An invitation sent through the API by `inviter`. */
export async function sendInvite(projectId: string, inviter: Person, email: string, role: Role): Promise<SentInvite> {
  const result = await call('POST', `/api/projects/${projectId}/invitations`, { as: inviter, body: { email, role } });
  if (result.status !== 201) throw new Error(`Invite answered ${result.status}: ${JSON.stringify(result.body)}`);
  const created = result.body.data as { invitation: { id: string; email: string }; inviteUrl: string };
  const token = new URL(created.inviteUrl).hash.slice('#token='.length);
  return { id: created.invitation.id, email: created.invitation.email, token, inviteUrl: created.inviteUrl };
}

/** An address nobody has registered. */
export function inviteeEmail(label: string): string {
  return uniqueEmail(label);
}

export interface ActivityEntry {
  action: string;
  actorUserId: string | null;
  actorLabel: string;
  targetId: string | null;
  targetLabel: string | null;
  details: Record<string, unknown> | null;
}

/** The project's team activity, newest first, read as `reader` (an owner or admin). */
export async function teamActivity(projectId: string, reader: Person): Promise<ActivityEntry[]> {
  const result = await call('GET', `/api/projects/${projectId}/activity?group=team`, { as: reader });
  if (result.status !== 200) throw new Error(`Activity answered ${result.status}: ${JSON.stringify(result.body)}`);
  return (result.body.data as { entries: ActivityEntry[] }).entries;
}

/** "Name (email)", as the activity log labels people. */
export function personLabel(person: Pick<Person, 'name' | 'email'>): string {
  return `${person.name} (${person.email})`;
}

export interface ListedProject {
  id: string;
  role: Role;
  permissions: string[];
  isBillingOwner: boolean;
}

/** The person's `GET /api/projects`. */
export async function projectsOf(person: Person): Promise<ListedProject[]> {
  const result = await call('GET', '/api/projects', { as: person });
  if (result.status !== 200) throw new Error(`Projects answered ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body.data as ListedProject[];
}

/** A project's member list as `reader` sees it. */
export async function membersOf(projectId: string, reader: Person): Promise<{ members: any[]; billingOffer: unknown }> {
  const result = await call('GET', `/api/projects/${projectId}/members`, { as: reader });
  if (result.status !== 200) throw new Error(`Members answered ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body.data;
}

/** Pending invitations as `reader` (members.manage) sees them. */
export async function invitationsOf(projectId: string, reader: Person): Promise<Array<{ id: string; email: string; role: Role }>> {
  const result = await call('GET', `/api/projects/${projectId}/invitations`, { as: reader });
  if (result.status !== 200) throw new Error(`Invitations answered ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body.data;
}

/** Opens the project's Members page and waits for the member table. */
export async function openMembers(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/team`);
  await page.getByRole('heading', { name: 'Members', exact: true }).waitFor();
  await membersTable(page).locator('tbody tr').first().waitFor();
}

/** The Members card's table (the first table on the page). */
export function membersTable(page: Page): Locator {
  return page.getByRole('table').first();
}

/** A person's row in the members table. */
export function memberRow(page: Page, email: string): Locator {
  return membersTable(page).getByRole('row').filter({ hasText: email });
}

/** Chooses a role in a member row's role picker (a Radix Select, which has no label). */
export async function chooseRole(page: Page, email: string, label: 'Owner' | 'Admin' | 'Member'): Promise<void> {
  await memberRow(page, email).getByRole('combobox').click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

/** The card on a page whose title is `title` (shadcn cards carry data-slot). */
export function cardTitled(page: Page, title: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^\\s*${title}`) }) });
}

/** Date the way the members table shows it (date-fns `MMM d, yyyy`), in this machine's zone. */
export function joinedLabel(at: Date): string {
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
