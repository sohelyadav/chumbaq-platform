import { IsIn, IsUUID } from 'class-validator';
import { PROJECT_ROLES, type ProjectRole } from '../project-permissions';

/** `PATCH /projects/:projectId/members/:memberId`. */
export class ChangeMemberRoleDto {
  @IsIn(PROJECT_ROLES)
  role: ProjectRole;
}

/** `POST /projects/:projectId/billing-transfer`: the owner offered billing ownership. */
export class OfferBillingDto {
  @IsUUID()
  toUserId: string;
}
