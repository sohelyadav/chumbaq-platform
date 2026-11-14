import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb, resetFixtures, INT_PROJECT_ID } from '../../test-support/int-db';
import { DeviceIdentityEntity } from './entities/device-identity.entity';
import { IdentityAliasEntity } from './entities/identity-alias.entity';
import { IdentityService } from './identity.service';
import { ConsentEventsService } from '../consent/consent-events.service';
import { ConsentEventEntity } from '../consent/entities/consent-event.entity';
import { TrackingConsentService } from '../consent/tracking-consent.service';

/**
 * A device row is found by fingerprint, which survives sign-out in every SDK, so the
 * next person to sign in on a shared device gets the same row. It must not keep the
 * previous person's addresses, names, traits, revenue or channel consent.
 */
describe('A different user signing in on a device (integration)', () => {
  let ds: DataSource;
  let identity: IdentityService;

  beforeAll(async () => {
    ds = await openIntDb();
    const tracking = new TrackingConsentService(ds.getRepository(DeviceIdentityEntity));
    identity = new IdentityService(
      ds.getRepository(DeviceIdentityEntity),
      ds.getRepository(IdentityAliasEntity),
      { restore: async () => 0 } as never,
      new ConsentEventsService(ds.getRepository(ConsentEventEntity)),
      tracking,
      { record: async () => undefined } as never,
    );
    await resetFixtures(ds);
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  const fingerprint = () => `fp-handover-${randomUUID()}`;

  const signInAlice = (deviceFingerprint: string) =>
    identity.identify({
      projectId: INT_PROJECT_ID,
      deviceFingerprint,
      platform: 'ios',
      externalUserId: 'alice',
      email: 'alice@example.com',
      phone: '+919800000001',
      firstName: 'Alice',
      traits: { plan: 'gold' },
      emailOptIn: true,
      smsOptIn: true,
      whatsappOptIn: true,
      pushOptIn: true,
    });

  it('gives the next user a row with none of the previous user\'s profile or consent', async () => {
    const fp = fingerprint();
    await signInAlice(fp);

    const bob = await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: fp, platform: 'ios', externalUserId: 'bob' });

    expect(bob).toMatchObject({
      externalUserId: 'bob',
      email: null,
      phoneE164: null,
      phone: null,
      firstName: null,
      emailOptIn: null,
      smsOptIn: null,
      whatsappOptIn: null,
      // The device's own facts stay.
      pushOptIn: true,
    });
    expect(bob.traits ?? {}).not.toHaveProperty('plan');
    expect(JSON.stringify(bob)).not.toMatch(/alice@example\.com|Alice|9800000001|gold/);
  });

  it('records the previous user\'s channel consent as ended on the row', async () => {
    const fp = fingerprint();
    const alice = await signInAlice(fp);

    await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: fp, platform: 'ios', externalUserId: 'bob' });

    const rows = await ds.query(
      `SELECT channel, granted FROM consent_events WHERE device_identity_id = $1 AND source = 'device_handover' ORDER BY channel`,
      [alice.id],
    );
    expect(rows).toEqual([
      { channel: 'email', granted: false },
      { channel: 'sms', granted: false },
      { channel: 'whatsapp', granted: false },
    ]);
  });

  it('keeps what the next user does send', async () => {
    const fp = fingerprint();
    await signInAlice(fp);

    const bob = await identity.identify({
      projectId: INT_PROJECT_ID,
      deviceFingerprint: fp,
      platform: 'ios',
      externalUserId: 'bob',
      email: 'bob@example.com',
      emailOptIn: true,
    });

    expect(bob).toMatchObject({ email: 'bob@example.com', emailOptIn: true, smsOptIn: null });
  });

  it('leaves the profile alone when the same user signs in again, or an anonymous device signs in', async () => {
    const fp = fingerprint();
    await signInAlice(fp);
    const again = await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: fp, platform: 'ios', externalUserId: 'alice' });
    expect(again).toMatchObject({ email: 'alice@example.com', emailOptIn: true, firstName: 'Alice' });

    const anon = fingerprint();
    await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: anon, platform: 'ios', email: 'carol@example.com', emailOptIn: true });
    const carol = await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: anon, platform: 'ios', externalUserId: 'carol' });
    expect(carol).toMatchObject({ email: 'carol@example.com', emailOptIn: true });
  });
});
