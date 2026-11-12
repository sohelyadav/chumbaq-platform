import { ForbiddenException } from '@nestjs/common';
import { HIDDEN_DURING_IMPERSONATION, redactForImpersonator } from '../../common/impersonation-redaction';
import type { ProjectAccess } from './project-access.service';
import { roleCan, type ProjectRole } from './project-permissions';
import { redactSecrets } from './redact-secrets';
import { IMPERSONATION_READ_ONLY, VIEW_AS_NOT_AVAILABLE, refuseViewAs } from './view-as';
import { IMPERSONATION_READ_ONLY as FROM_PRIVACY } from '../privacy/person-privacy.controller';

const access = (role: ProjectRole, impersonated = false): ProjectAccess => ({
  project: {} as never,
  role,
  isBillingOwner: role === 'owner',
  impersonated,
  can: (p) => roleCan(role, p),
});

// Shaped like the push settings GET.
const settings = () => ({
  projectId: '9b0c3c4e-5f1a-4f55-9a43-3d2f0d7e8a11',
  fcmConfigured: true,
  webhookUrls: { slack: 'https://hooks.slack.com/services/T0/B0/secret', zapier: 'https://hooks.zapier.com/x/y' },
  serverKey: 'AAAA-secret',
  quietHours: null,
});

describe('redactSecrets', () => {
  it('hides the fields from a member, as view-as hides them', () => {
    const hidden = redactSecrets(settings(), access('member'), ['webhookUrls', 'serverKey', 'quietHours']);
    expect(hidden).toEqual(redactForImpersonator(settings(), 'staff', ['webhookUrls', 'serverKey', 'quietHours']));
    expect(hidden.webhookUrls).toEqual({ slack: HIDDEN_DURING_IMPERSONATION, zapier: HIDDEN_DURING_IMPERSONATION });
    expect(hidden.serverKey).toBe(HIDDEN_DURING_IMPERSONATION);
    expect(hidden.fcmConfigured).toBe(true);
  });

  it('shows them to owners and admins', () => {
    expect(redactSecrets(settings(), access('owner'), ['serverKey'])).toEqual(settings());
    expect(redactSecrets(settings(), access('admin'), ['serverKey'])).toEqual(settings());
  });

  it('hides them from view-as even of an owner', () => {
    expect(redactSecrets(settings(), access('owner', true), ['serverKey']).serverKey).toBe(
      HIDDEN_DURING_IMPERSONATION,
    );
  });

  it('leaves the original body as it was', () => {
    const body = settings();
    redactSecrets(body, access('member'), ['serverKey']);
    expect(body.serverKey).toBe('AAAA-secret');
  });
});

describe('refuseViewAs', () => {
  it('refuses staff viewing as a tenant with the read-only text, and lets the tenant through', () => {
    const user = { userId: 'u', email: 'u@acme.example', isSuperAdmin: false };
    expect(() => refuseViewAs({ ...user, impersonatedBy: 'staff' })).toThrow(ForbiddenException);
    expect(() => refuseViewAs({ ...user, impersonatedBy: 'staff' })).toThrow(IMPERSONATION_READ_ONLY);
    expect(() => refuseViewAs(user)).not.toThrow();
  });

  it('keeps a route\'s own text when given one, such as identity\'s', () => {
    const user = { userId: 'u', email: 'u@acme.example', isSuperAdmin: false, impersonatedBy: 'staff' };
    expect(VIEW_AS_NOT_AVAILABLE).toBe('Not available while viewing as another account');
    expect(() => refuseViewAs(user, VIEW_AS_NOT_AVAILABLE)).toThrow(VIEW_AS_NOT_AVAILABLE);
    expect(() => refuseViewAs({ ...user, impersonatedBy: undefined }, VIEW_AS_NOT_AVAILABLE)).not.toThrow();
  });

  it('is the same constant the privacy controller exported', () => {
    expect(FROM_PRIVACY).toBe(IMPERSONATION_READ_ONLY);
    expect(IMPERSONATION_READ_ONLY).toBe('Impersonation sessions are read-only');
  });
});
