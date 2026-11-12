import { SetMetadata } from '@nestjs/common';

export const ALLOW_ENROLMENT_SESSION = 'staff:allow-enrolment';

/**
 * The few routes an enrolment-only session may use: those that enrol its first factor,
 * say who it is, and sign it out. Every other staff route refuses it by default, so a
 * route added later is safe without anyone remembering this exists.
 */
export const AllowEnrolmentSession = () => SetMetadata(ALLOW_ENROLMENT_SESSION, true);
