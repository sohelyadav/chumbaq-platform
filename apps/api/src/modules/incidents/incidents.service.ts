import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type {
  CertInIncidentType,
  IncidentDetail,
  IncidentReportMethod,
  IncidentStatus,
  IncidentSummary,
  SecurityContact,
} from '@chumbaq/shared';
import { PlatformEmailService } from '../platform-email/platform-email.service';
import { emailAllStaff } from '../security-alerts/staff-mail';
import type { CreateIncidentDto, ReportIncidentDto, SecurityContactDto } from './incident.dto';
import { recordedEmail } from './incident-emails';
import { buildReportDraft, deadlineOf, logCommand } from './incident-report';

/** Clocks differ a little between a browser and the server; more than this is the future. */
const FUTURE_SLACK_MS = 60_000;

interface IncidentRow {
  id: string;
  noticed_at: Date;
  recorded_at: Date;
  recorded_by: string | null;
  how_noticed: string;
  types: CertInIncidentType[];
  title: string;
  summary: string;
  systems: string;
  tenant_ids: string[];
  alert_id: string | null;
  status: IncidentStatus;
  reported_at: Date | null;
  reported_by: string | null;
  report_method: IncidentReportMethod | null;
  certin_reference: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  reminder_email_failed: boolean;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function summaryOf(r: IncidentRow): IncidentSummary {
  return {
    id: r.id,
    title: r.title,
    types: r.types,
    status: r.status,
    noticedAt: r.noticed_at.toISOString(),
    deadline: deadlineOf(r.noticed_at).toISOString(),
    reportedAt: iso(r.reported_at),
    closedAt: iso(r.closed_at),
  };
}

/** The incident register behind the admin Incidents page. Staff only (the controller). */
@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly email: PlatformEmailService,
    private readonly config: ConfigService,
  ) {}

  /** Open ones first, then newest noticed first. */
  async list(): Promise<IncidentSummary[]> {
    const rows: IncidentRow[] = await this.dataSource.query(
      `SELECT * FROM security_incidents ORDER BY (status = 'open') DESC, noticed_at DESC LIMIT 500`,
    );
    return rows.map(summaryOf);
  }

  async get(id: string): Promise<IncidentDetail> {
    const [row]: IncidentRow[] = await this.dataSource.query(`SELECT * FROM security_incidents WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('Incident not found');
    const notes: { id: string; created_at: Date; created_by: string | null; note: string }[] = await this.dataSource.query(
      `SELECT id, created_at, created_by, note FROM security_incident_notes WHERE incident_id = $1 ORDER BY created_at, id`,
      [id],
    );
    return {
      ...summaryOf(row),
      recordedAt: row.recorded_at.toISOString(),
      recordedBy: row.recorded_by,
      howNoticed: row.how_noticed,
      summary: row.summary,
      systems: row.systems,
      tenantIds: row.tenant_ids,
      alertId: row.alert_id,
      reportedBy: row.reported_by,
      reportMethod: row.report_method,
      certinReference: row.certin_reference,
      closedBy: row.closed_by,
      reminderEmailFailed: row.reminder_email_failed,
      notes: notes.map((n) => ({ id: n.id, createdAt: n.created_at.toISOString(), createdBy: n.created_by, note: n.note })),
      logCommand: logCommand(row.noticed_at, new Date()),
    };
  }

  async record(dto: CreateIncidentDto, staffId: string): Promise<IncidentDetail> {
    const noticedAt = dto.noticedAt ? new Date(dto.noticedAt) : new Date();
    if (noticedAt.getTime() > Date.now() + FUTURE_SLACK_MS) {
      throw new BadRequestException('When it was noticed cannot be in the future');
    }
    const [row] = await this.dataSource.query(
      `INSERT INTO security_incidents (noticed_at, recorded_by, how_noticed, types, title, summary, systems, tenant_ids, alert_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        noticedAt,
        staffId,
        dto.howNoticed ?? '',
        [...new Set(dto.types)],
        dto.title.trim(),
        dto.summary ?? '',
        dto.systems ?? '',
        [...new Set(dto.tenantIds ?? [])],
        dto.alertId ?? null,
      ],
    );
    const { anyFailed } = await emailAllStaff(
      this.dataSource,
      this.email,
      recordedEmail({ id: row.id, title: dto.title.trim(), noticedAt }, this.config.get<string>('ADMIN_APP_URL') || null),
    ).catch((error: Error) => {
      this.logger.error(`Incident ${row.id}: staff email failed: ${error.message}`);
      return { anyFailed: true };
    });
    if (anyFailed) {
      await this.dataSource.query(`UPDATE security_incidents SET reminder_email_failed = true WHERE id = $1`, [row.id]);
    }
    return this.get(row.id);
  }

  async report(id: string, dto: ReportIncidentDto, staffId: string): Promise<IncidentDetail> {
    const reportedAt = dto.reportedAt ? new Date(dto.reportedAt) : new Date();
    if (reportedAt.getTime() > Date.now() + FUTURE_SLACK_MS) {
      throw new BadRequestException('When it was reported cannot be in the future');
    }
    const [rows] = await this.dataSource.query(
      `UPDATE security_incidents
          SET status = 'reported', reported_at = $2, reported_by = $3, report_method = $4, certin_reference = $5
        WHERE id = $1 AND status = 'open' RETURNING id`,
      [id, reportedAt, staffId, dto.method, dto.certinReference?.trim() || null],
    );
    if (!rows.length) await this.refuseMove(id, 'Only an open incident can be marked reported');
    return this.get(id);
  }

  async addNote(id: string, note: string, staffId: string): Promise<IncidentDetail> {
    await this.get(id);
    await this.dataSource.query(
      `INSERT INTO security_incident_notes (incident_id, created_by, note) VALUES ($1, $2, $3)`,
      [id, staffId, note.trim()],
    );
    return this.get(id);
  }

  async close(id: string, note: string, staffId: string): Promise<IncidentDetail> {
    await this.dataSource.transaction(async (manager) => {
      const [rows] = await manager.query(
        `UPDATE security_incidents SET status = 'closed', closed_at = now(), closed_by = $2
          WHERE id = $1 AND status <> 'closed' RETURNING id`,
        [id, staffId],
      );
      if (!rows.length) await this.refuseMove(id, 'This incident is already closed');
      await manager.query(`INSERT INTO security_incident_notes (incident_id, created_by, note) VALUES ($1, $2, $3)`, [
        id,
        staffId,
        note.trim(),
      ]);
    });
    return this.get(id);
  }

  /** 404 when there is no such incident, else 409 with `message`. */
  private async refuseMove(id: string, message: string): Promise<never> {
    const [exists] = await this.dataSource.query(`SELECT 1 FROM security_incidents WHERE id = $1`, [id]);
    if (!exists) throw new NotFoundException('Incident not found');
    throw new ConflictException(message);
  }

  async reportDraft(id: string): Promise<{ subject: string; body: string }> {
    const incident = await this.get(id);
    const contact = await this.contact();
    return buildReportDraft(
      {
        title: incident.title,
        types: incident.types,
        noticedAt: new Date(incident.noticedAt),
        howNoticed: incident.howNoticed,
        summary: incident.summary,
        systems: incident.systems,
        tenantCount: incident.tenantIds.length,
        notes: incident.notes.map((n) => ({ at: new Date(n.createdAt), note: n.note })),
      },
      contact.updatedAt ? contact : null,
    );
  }

  async contact(): Promise<SecurityContact> {
    const [row] = await this.dataSource.query(`SELECT * FROM security_contact WHERE id = 1`);
    return {
      orgName: row?.org_name ?? null,
      orgAddress: row?.org_address ?? null,
      sector: row?.sector ?? null,
      pocName: row?.poc_name ?? null,
      pocRole: row?.poc_role ?? null,
      pocEmail: row?.poc_email ?? null,
      pocPhone: row?.poc_phone ?? null,
      updatedAt: row ? row.updated_at.toISOString() : null,
    };
  }

  async saveContact(dto: SecurityContactDto, staffId: string): Promise<SecurityContact> {
    await this.dataSource.query(
      `INSERT INTO security_contact (id, org_name, org_address, sector, poc_name, poc_role, poc_email, poc_phone, updated_at, updated_by)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, now(), $8)
       ON CONFLICT (id) DO UPDATE SET org_name = $1, org_address = $2, sector = $3, poc_name = $4, poc_role = $5,
         poc_email = $6, poc_phone = $7, updated_at = now(), updated_by = $8`,
      [dto.orgName ?? null, dto.orgAddress ?? null, dto.sector ?? null, dto.pocName ?? null, dto.pocRole ?? null, dto.pocEmail ?? null, dto.pocPhone ?? null, staffId],
    );
    return this.contact();
  }
}
