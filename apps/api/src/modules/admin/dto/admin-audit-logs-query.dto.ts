import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import type { AdminAuditAction } from '@chumbaq/shared';
import { PaginationDto } from '../../../common/dto/pagination.dto';

// A Record rather than an array: shared exports only the type, and this way a new
// action added there fails compilation here instead of being refused with a 400.
const AUDIT_ACTIONS: Record<AdminAuditAction, true> = {
  'tripwire.created': true,
  'tripwire.revoked': true,
  'incident.recorded': true,
  'incident.reported': true,
  'incident.note_added': true,
  'incident.closed': true,
  'security_contact.updated': true,
  'tenant.suspended': true,
  'tenant.reactivated': true,
  'tenant.impersonated': true,
  'tenant.viewed': true,
  'super_admin.granted': true,
  'super_admin.revoked': true,
  'super_admin.passkeys_reset': true,
  'account.factors_reset': true,
  'audit_log.exported': true,
  'tenants.exported': true,
  'account.factors_reset_requested': true,
  'account.factors_reset_cancelled': true,
  'account.password_reset_refused': true,
  'account.password_reset_link_issued': true,
  'account.password_reset_link_cancelled': true,
  'account.password_reset_link_void_failed': true,
  'account.project_limit_changed': true,
  'account.seat_limit_changed': true,
  'staff.signed_in': true,
  'staff.sign_in_failed': true,
  'staff.signed_out': true,
  'staff.session_revoked': true,
  'staff.enrolment_started': true,
  'staff.enrolment_allowed': true,
  'staff.factor_added': true,
  'staff.factor_removed': true,
  'tenant.impersonation_exchanged': true,
  'tenant.impersonation_refused': true,
  'billing.plan_created': true,
  'billing.plan_updated': true,
  'billing.price_added': true,
  'billing.price_retired': true,
  'billing.comp_granted': true,
  'billing.comp_ended': true,
  'billing.subscription_cancelled': true,
  'billing.invoice_resent': true,
};
export const AUDIT_ACTION_VALUES = Object.keys(AUDIT_ACTIONS) as AdminAuditAction[];

/**
 * `?action=a&action=b` and `?action=a,b` both arrive as a list. Reads the raw
 * input, because implicit conversion has already reshaped `value` by now. Empty
 * entries are kept so `action=` is refused rather than read as no filter.
 */
function actionList({ key, obj }: TransformFnParams): unknown {
  const raw = obj[key];
  const parts = Array.isArray(raw) ? raw : [raw];
  if (!parts.every((part) => typeof part === 'string')) return raw;
  return (parts as string[]).flatMap((part) => part.split(',').map((item) => item.trim()));
}

/** Stored addresses are lower-cased, and `cli` names the command-line tools. */
function lowerCaseTrimmed({ key, obj }: TransformFnParams): unknown {
  const raw = obj[key];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
}

// The constructor signature TypeScript requires of a mixin's base.
type Constructor = new (...args: any[]) => object;

/** The filters, shared by the paged list and the export so the two cannot drift. */
function withAuditLogFilters<TBase extends Constructor>(Base: TBase) {
  class AuditLogFilters extends Base {
    @IsOptional()
    @IsUUID()
    actorId?: string;

    @IsOptional()
    @Transform(lowerCaseTrimmed)
    @IsString()
    @MaxLength(255)
    @Matches(/^[^\0]+$/, { message: '$property must not be empty or contain null characters' })
    actorEmail?: string;

    @IsOptional()
    // The elements are strings: a union of literals, which dto-object-arrays.spec
    // cannot tell from an object type.
    @Type(() => String)
    @Transform(actionList)
    @IsArray()
    @ArrayMaxSize(AUDIT_ACTION_VALUES.length)
    @IsIn(AUDIT_ACTION_VALUES, { each: true })
    action?: AdminAuditAction[];

    @IsOptional()
    @IsUUID()
    targetId?: string;

    /** Inclusive. An instant, so the caller says which timezone its day is in. */
    @IsOptional()
    @IsISO8601({ strict: true })
    from?: string;

    /** Exclusive, so consecutive ranges neither overlap nor leave a gap. */
    @IsOptional()
    @IsISO8601({ strict: true })
    to?: string;
  }
  return AuditLogFilters;
}

export class AdminAuditLogsExportDto extends withAuditLogFilters(class {}) {}

export class AdminAuditLogsQueryDto extends withAuditLogFilters(PaginationDto) {}
