import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { IncidentDetail, IncidentSummary, SecurityAlertView, SecurityContact } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { AdminAuditService } from '../admin/admin-audit.service';
import { SuperAdminGuard } from '../admin/guards/super-admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SecurityAlertsService } from '../security-alerts/security-alerts.service';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { CreateIncidentDto, IncidentNoteDto, ReportIncidentDto, SecurityContactDto } from './incident.dto';
import { IncidentsService } from './incidents.service';

type Staff = { userId: string; email: string };
type IncidentAuditAction =
  | 'incident.recorded'
  | 'incident.reported'
  | 'incident.note_added'
  | 'incident.closed'
  | 'security_contact.updated';

/**
 * The Incidents page: the CERT-In 6-hour register, the report draft, the security
 * contact it is filled from, and recent alarms. No re-authentication step: recording an
 * incident at 2 a.m. must take under a minute. Every write is audited.
 */
@Controller('admin')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class IncidentsController {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly alerts: SecurityAlertsService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get('incidents')
  list(): Promise<IncidentSummary[]> {
    return this.incidents.list();
  }

  @Post('incidents')
  async record(@Body() dto: CreateIncidentDto, @CurrentUser() staff: Staff, @Req() req: Request): Promise<IncidentDetail> {
    const incident = await this.incidents.record(dto, staff.userId);
    await this.recordAudit('incident.recorded', incident, staff, req, { types: incident.types });
    return incident;
  }

  @Get('incidents/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentDetail> {
    return this.incidents.get(id);
  }

  @Get('incidents/:id/report-draft')
  draft(@Param('id', ParseUUIDPipe) id: string): Promise<{ subject: string; body: string }> {
    return this.incidents.reportDraft(id);
  }

  @Post('incidents/:id/report')
  async report(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportIncidentDto,
    @CurrentUser() staff: Staff,
    @Req() req: Request,
  ): Promise<IncidentDetail> {
    const incident = await this.incidents.report(id, dto, staff.userId);
    await this.recordAudit('incident.reported', incident, staff, req, { method: dto.method });
    return incident;
  }

  @Post('incidents/:id/notes')
  async note(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IncidentNoteDto,
    @CurrentUser() staff: Staff,
    @Req() req: Request,
  ): Promise<IncidentDetail> {
    const incident = await this.incidents.addNote(id, dto.note, staff.userId);
    await this.recordAudit('incident.note_added', incident, staff, req);
    return incident;
  }

  @Post('incidents/:id/close')
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IncidentNoteDto,
    @CurrentUser() staff: Staff,
    @Req() req: Request,
  ): Promise<IncidentDetail> {
    const incident = await this.incidents.close(id, dto.note, staff.userId);
    await this.recordAudit('incident.closed', incident, staff, req, { wasReported: Boolean(incident.reportedAt) });
    return incident;
  }

  @Get('security-contact')
  contact(): Promise<SecurityContact> {
    return this.incidents.contact();
  }

  @Put('security-contact')
  async saveContact(@Body() dto: SecurityContactDto, @CurrentUser() staff: Staff, @Req() req: Request): Promise<SecurityContact> {
    const saved = await this.incidents.saveContact(dto, staff.userId);
    await this.audit.record({
      actorId: staff.userId,
      actorEmail: staff.email,
      action: 'security_contact.updated',
      targetType: 'security_contact',
      targetId: null,
      targetLabel: saved.orgName,
      ipAddress: getClientIp(req),
    });
    return saved;
  }

  @Get('security-alerts')
  alarms(@Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number): Promise<SecurityAlertView[]> {
    return this.alerts.list(limit);
  }

  private async recordAudit(
    action: IncidentAuditAction,
    incident: IncidentDetail,
    staff: Staff,
    req: Request,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorId: staff.userId,
      actorEmail: staff.email,
      action,
      targetType: 'incident',
      targetId: incident.id,
      targetLabel: incident.title,
      metadata,
      ipAddress: getClientIp(req),
    });
  }
}
