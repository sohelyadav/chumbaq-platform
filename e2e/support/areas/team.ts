import { createHash, randomBytes, randomUUID } from 'crypto';
import { Client } from 'pg';
import type { Browser, Locator, Page } from '@playwright/test';
import { enrolAndSignInStaff } from '../admin';
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

// ---- Invitations (chunk 2)

export const SEAT_LIMIT_MESSAGE = 'Your plan has no free seats. Upgrade to invite teammates.';
export const INVITES_SUSPENDED = "This project's account is suspended.";
export const ALREADY_MEMBER = 'They are already a member of this project.';

/** The keys a pending invite has in `GET .../invitations`: no token, no link. */
export const INVITATION_VIEW_KEYS = ['createdAt', 'email', 'expired', 'expiresAt', 'id', 'invitedBy', 'role'];

/** sha256 hex, as the API stores invite tokens. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 43 random base64url characters: shaped like an invite token, naming no invite. */
export function unknownInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** `POST /api/invitations/preview` as `person` (optionally from another address, for the 10/min throttle). */
export function previewInvite(person: Pick<Person, 'accessToken' | 'ip'>, token: string, ip?: string): Promise<CallResult> {
  return call('POST', '/api/invitations/preview', { as: { accessToken: person.accessToken, ip: ip ?? person.ip }, body: { token } });
}

/** `POST /api/invitations/accept` as `person`. */
export function acceptInvite(person: Pick<Person, 'accessToken' | 'ip'>, token: string, ip?: string): Promise<CallResult> {
  return call('POST', '/api/invitations/accept', { as: { accessToken: person.accessToken, ip: ip ?? person.ip }, body: { token } });
}

/** An invitation's resend through the API by `person`; answers the new link and token. */
export async function resendInvite(projectId: string, person: Person, invitationId: string): Promise<SentInvite> {
  const result = await call('POST', `/api/projects/${projectId}/invitations/${invitationId}/resend`, { as: person });
  if (result.status !== 201) throw new Error(`Resend answered ${result.status}: ${JSON.stringify(result.body)}`);
  const created = result.body.data as { invitation: { id: string; email: string }; inviteUrl: string };
  const token = new URL(created.inviteUrl).hash.slice('#token='.length);
  return { id: created.invitation.id, email: created.invitation.email, token, inviteUrl: created.inviteUrl };
}

export interface InvitationRecord {
  id: string;
  email: string;
  role: Role;
  token_hash: string;
  invited_by: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by: string | null;
  revoked_at: Date | null;
}

/** The invitation row as stored. */
export async function invitationRecord(id: string): Promise<InvitationRecord> {
  return withDb(async (db) => {
    const { rows } = await db.query<InvitationRecord>(
      `SELECT id, email, role, token_hash, invited_by, expires_at, accepted_at, accepted_by, revoked_at
         FROM project_invitations WHERE id = $1`,
      [id],
    );
    if (rows.length !== 1) throw new Error(`No invitation ${id}`);
    return rows[0];
  });
}

/** Every invitation row of a project, as text (each row's JSON), for looking for a value anywhere in it. */
export async function invitationRowsAsText(projectId: string): Promise<string[]> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ row: string }>(
      `SELECT row_to_json(i)::text AS row FROM project_invitations i WHERE project_id = $1`,
      [projectId],
    );
    return rows.map((r) => r.row);
  });
}

/** Moves an invitation's expiry to `interval` from now (`'-1 minute'`, `'2 days'`). */
export async function setInviteExpiry(id: string, interval: string): Promise<void> {
  await withDb((db) => db.query(`UPDATE project_invitations SET expires_at = now() + $2::interval WHERE id = $1`, [id, interval]));
}

/** A staff override of the account's seat limit (null clears it). */
export async function setSeatLimit(person: Pick<Person, 'userId'>, limit: number | null): Promise<void> {
  await withDb((db) => db.query('UPDATE users SET seat_limit = $2 WHERE id = $1', [person.userId, limit]));
}

/** Suspends an account as staff would (and `reactivate` undoes it). */
export async function suspendAccount(person: Pick<Person, 'userId'>): Promise<void> {
  await withDb((db) =>
    db.query(`UPDATE users SET suspended_at = now(), suspended_reason = 'e2e' WHERE id = $1`, [person.userId]),
  );
}

export async function reactivateAccount(person: Pick<Person, 'userId'>): Promise<void> {
  await withDb((db) =>
    db.query(`UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1`, [person.userId]),
  );
}

/** Whether `person` has a member row in the project, and its role. */
export async function memberRoleIn(projectId: string, person: Pick<Person, 'userId'>): Promise<Role | null> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ role: Role }>(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, person.userId],
    );
    return rows[0]?.role ?? null;
  });
}

/** A toast, found by its title, in the notifications region. */
export function toastTitled(page: Page, title: string): Locator {
  return page.getByRole('region', { name: /Notifications/ }).locator('li').filter({ hasText: title });
}

/** The Pending invites card's row for an address. */
export function pendingInviteRow(page: Page, email: string): Locator {
  return cardTitled(page, 'Pending invites').getByRole('row').filter({ hasText: email });
}

/** Opens the project's team activity and waits for a row with `sentence`. */
export async function expectTeamActivitySentence(page: Page, projectId: string, sentence: string): Promise<void> {
  await page.goto(`/projects/${projectId}/activity?group=team`);
  await page.getByRole('cell', { name: sentence, exact: true }).first().waitFor();
}

// ---- Billing transfer, activity log, role matrix, view-as (chunk 3)

export const BILLING_TARGET_NOT_OWNER = 'Billing ownership can only move to another owner of this project.';
export const BILLING_OFFER_GONE = 'This billing transfer has expired or was cancelled.';
export const BILLING_SUSPENDED = "Billing can't move while either account is suspended.";
export const MEMBER_NOT_FOUND = 'Member not found';
export const READ_ONLY = 'Impersonation sessions are read-only';
export const STAFF_SENTENCE = 'Chumbaq support viewed this project (read-only)';
export const INVALID_ACTIVITY_FILTER = 'Invalid activity filter.';
export const ACTIVITY_CSV_HEADER =
  'occurred_at,actor,action,target_type,target_id,target_label,ip_address,country,user_agent,details,id';

/** The validation messages of a 400, as a list (Nest sends one string or an array). */
export function messagesOf(result: CallResult): string[] {
  const message = messageOf(result);
  return Array.isArray(message) ? message.map(String) : message === undefined ? [] : [String(message)];
}

/** `call` with extra request headers (a User-Agent, say). */
export async function callWithHeaders<T = any>(
  method: string,
  path: string,
  as: Pick<Person, 'accessToken' | 'ip'>,
  headers: Record<string, string>,
  body?: unknown,
): Promise<CallResult<T>> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': as.ip,
      Authorization: `Bearer ${as.accessToken}`,
      ...headers,
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

export interface RawResult {
  status: number;
  headers: Headers;
  /** Decoded by hand, so a leading byte order mark stays. */
  text: string;
  message: unknown;
}

/** A GET answered as bytes (for the CSV export), with a bearer token or none. */
export async function rawGet(path: string, token: string | null, ip: string): Promise<RawResult> {
  const response = await fetch(apiUrl(path), {
    headers: { 'X-Chumbaq-Client': 'web', 'X-Forwarded-For': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let message: unknown;
  try {
    message = (JSON.parse(text) as { message?: unknown }).message;
  } catch {
    message = undefined;
  }
  return { status: response.status, headers: response.headers, text, message };
}

export interface FullActivityEntry extends ActivityEntry {
  id: string;
  occurredAt: string;
  actorKind: string;
  group: string;
  targetType: string | null;
  ipAddress: string | null;
  country: string | null;
  userAgent: string | null;
}

export interface ActivityPage {
  entries: FullActivityEntry[];
  nextCursor: string | null;
  actors: Array<{ userId: string; label: string }>;
}

/** `GET .../activity` with a query string (`group=team`, `cursor=...`), as `reader`. */
export async function activityPage(projectId: string, reader: Pick<Person, 'accessToken' | 'ip'>, query = ''): Promise<ActivityPage> {
  const result = await call('GET', `/api/projects/${projectId}/activity${query ? `?${query}` : ''}`, { as: reader });
  if (result.status !== 200) throw new Error(`Activity answered ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body.data as ActivityPage;
}

export interface SeedActivity {
  action: string;
  actorUserId?: string | null;
  actorKind?: string;
  actorLabel: string;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  details?: Record<string, unknown> | null;
  /** How long before now it happened (`'2 hours'`); now when left out. */
  ago?: string;
}

/** Writes activity rows directly (inserts are allowed by the append-only triggers). Answers their ids in order. */
export async function insertActivity(projectId: string, rows: SeedActivity[]): Promise<string[]> {
  return withDb(async (db) => {
    const ids: string[] = [];
    for (const row of rows) {
      const { rows: inserted } = await db.query<{ id: string }>(
        `INSERT INTO project_activity
           (project_id, occurred_at, actor_kind, actor_user_id, actor_label, action, target_type, target_id, target_label, details)
         VALUES ($1, clock_timestamp() - $2::interval, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          projectId,
          row.ago ?? '0 seconds',
          row.actorKind ?? 'user',
          row.actorUserId ?? null,
          row.actorLabel,
          row.action,
          row.targetType ?? null,
          row.targetId ?? null,
          row.targetLabel ?? null,
          row.details === undefined || row.details === null ? null : JSON.stringify(row.details),
        ],
      );
      ids.push(inserted[0].id);
    }
    return ids;
  });
}

/** The project's activity rows as stored, newest first. */
export async function activityRows(projectId: string): Promise<
  Array<{ action: string; actor_kind: string; actor_user_id: string | null; ip_address: string | null; user_agent: string | null; details: unknown }>
> {
  return withDb(async (db) => {
    const { rows } = await db.query(
      `SELECT action, actor_kind, actor_user_id, ip_address, user_agent, details
         FROM project_activity WHERE project_id = $1 ORDER BY occurred_at DESC, id DESC`,
      [projectId],
    );
    return rows;
  });
}

/** Offers billing for the project to `to` as `from`; answers the call. */
export function offerBilling(projectId: string, from: Pick<Person, 'accessToken' | 'ip'>, to: Pick<Person, 'userId'>): Promise<CallResult> {
  return call('POST', `/api/projects/${projectId}/billing-transfer`, { as: from, body: { toUserId: to.userId } });
}

/** Moves the project's billing offer `interval` into the past (`'7 days 1 minute'`). */
export async function ageBillingOffer(projectId: string, interval: string): Promise<void> {
  await withDb((db) =>
    db.query(`UPDATE projects SET pending_billing_offered_at = now() - $2::interval WHERE id = $1`, [projectId, interval]),
  );
}

/** The project's stored billing owner and pending offer. */
export async function billingState(projectId: string): Promise<{ ownerId: string; pendingTo: string | null }> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ owner_id: string; pending_billing_owner_id: string | null }>(
      'SELECT owner_id, pending_billing_owner_id FROM projects WHERE id = $1',
      [projectId],
    );
    return { ownerId: rows[0].owner_id, pendingTo: rows[0].pending_billing_owner_id };
  });
}

/** A staff override of the account's project limit (null clears it). */
export async function setProjectLimit(person: Pick<Person, 'userId'>, limit: number | null): Promise<void> {
  await withDb((db) => db.query('UPDATE users SET project_limit = $2 WHERE id = $1', [person.userId, limit]));
}

/** Renames an account directly (for names the sign-up form would not be the place to test). */
export async function renameAccount(person: Person, name: string): Promise<Person> {
  await withDb((db) => db.query('UPDATE users SET name = $2 WHERE id = $1', [person.userId, name]));
  return { ...person, name };
}

/** The person's `GET /api/projects` meta (billed projects, seats). */
export async function projectsMetaOf(person: Person): Promise<{ billedProjects: number; seats: { used: number; limit: number | null } }> {
  const result = await call('GET', '/api/projects', { as: person });
  if (result.status !== 200) throw new Error(`Projects answered ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body.meta;
}

/** Opens the project's Settings page and waits for its Leave project card. */
export async function openSettings(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/settings`);
  await cardTitled(page, 'Leave project').waitFor();
}

/** Opens the project's Activity page (with an optional query) and waits for its heading. */
export async function openActivity(page: Page, projectId: string, query = ''): Promise<void> {
  await page.goto(`/projects/${projectId}/activity${query ? `?${query}` : ''}`);
  await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
}

/** RFC 4180 rows (quoted cells, doubled quotes, CRLF), without a BOM. */
export function parseCsv(text: string): string[][] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// View-as

export interface StaffMember {
  token: string;
  ip: string;
}

/**
 * A super admin with a fresh passkey sign-in to the admin app (the flag set directly,
 * which is all the guards read; the CLI path is the admin specs'), signed in in a
 * context of its own that is closed afterwards. The token is what view-as needs.
 */
export async function newStaffMember(browser: Browser): Promise<StaffMember> {
  const staff = await newPerson('team-staff', 'Sam Staff');
  await withDb((db) => db.query('UPDATE users SET is_super_admin = true WHERE id = $1', [staff.userId]));
  const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Forwarded-For': staff.ip } });
  try {
    const token = await enrolAndSignInStaff(await context.newPage(), staff);
    return { token, ip: staff.ip };
  } finally {
    await context.close();
  }
}

/** Starts view-as of `tenant` through the admin API; answers the one-time handoff link. */
export async function viewAsLink(staff: StaffMember, tenant: Pick<Person, 'userId'>): Promise<string> {
  const base = process.env.E2E_ADMIN_API_URL;
  if (!base) throw new Error('E2E_ADMIN_API_URL is not set: run the specs through playwright.config.ts');
  const response = await fetch(`${base}/api/admin/tenants/${tenant.userId}/impersonate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'admin',
      'X-Forwarded-For': staff.ip,
      Authorization: `Bearer ${staff.token}`,
    },
    body: JSON.stringify({ reason: 'E2E: checking the team pages' }),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`impersonate answered ${response.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { data: { url: string } }).data.url;
}

/** Spends a handoff link on the customer API, as the /impersonate page does; answers the view-as token. */
export async function viewAsToken(link: string): Promise<{ accessToken: string; ip: string }> {
  const ip = newClientIp();
  const code = new URL(link).hash.replace(/^#code=/, '');
  const result = await call('POST', '/api/auth/impersonation/exchange', { ip, body: { code } });
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`exchange answered ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return { accessToken: (result.body.data as { accessToken: string }).accessToken, ip };
}

/** Opens a handoff link in a browser of its own; answers the read-only tab, on /projects. */
export async function openViewAsLink(browser: Browser, baseURL: string | undefined, link: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'X-Forwarded-For': newClientIp() },
  });
  const page = await context.newPage();
  await page.goto(link);
  await page.waitForURL(/\/projects$/);
  await page.getByRole('region', { name: 'Impersonation session' }).waitFor();
  return page;
}
