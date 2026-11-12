import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Names the person: the exact external id the objection covers. */
export class PersonObjectionTargetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalUserId: string;
}

export class CreatePersonObjectionDto extends PersonObjectionTargetDto {
  /** The person-page row the team member acted from, kept as provenance. */
  @IsUUID()
  @IsOptional()
  sourceIdentityId?: string;
}
