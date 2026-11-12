import { IsEmail, IsIn, IsString, Length, MaxLength } from 'class-validator';
import { NormaliseEmail } from '../../users/email';
import { PROJECT_ROLES, type ProjectRole } from '../project-permissions';

/** `POST /projects/:projectId/invitations`. */
export class CreateInvitationDto {
  @NormaliseEmail()
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsIn(PROJECT_ROLES)
  role: ProjectRole;
}

/**
 * `POST /invitations/preview` and `/accept`: the token from the link's fragment, in the
 * body, never a URL. 43 characters (32 bytes base64url); the length bound keeps junk
 * from being hashed at any size.
 */
export class InvitationTokenDto {
  @IsString()
  @Length(1, 128)
  token: string;
}
