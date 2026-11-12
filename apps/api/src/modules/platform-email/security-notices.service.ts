import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  accountLink,
  factorResetCancelledEmail,
  factorResetRequestedEmail,
  factorsResetEmail,
  newDeviceEmail,
  passkeyChangedEmail,
  passwordChangedByOwnerEmail,
  privacyKeyCreatedEmail,
  recoveryCodesReplacedEmail,
  recoveryCodeUsedEmail,
  sessionReplayedEmail,
  staffEnrolmentStartedEmail,
  STAFF_LINK_CANCEL_PATH,
  StaffLinkCancelledBy,
  staffResetLinkCancelledEmail,
  staffResetLinkIssuedEmail,
  totpChangedEmail,
} from './account-emails';
import { PlatformEmail, PlatformEmailService } from './platform-email.service';

interface Recipient {
  id: string;
  email: string;
  name: string;
}

/**
 * Tells someone at once when something happens to how their account is protected, always
 * at the stored address. None of this is waited for and none of it can fail what caused
 * it, because a slow or broken email provider must not hold up or undo a sign-in.
 */
@Injectable()
export class SecurityNoticesService {
  private readonly logger = new Logger(SecurityNoticesService.name);
  private readonly background = new Set<Promise<void>>();

  constructor(
    private readonly email: PlatformEmailService,
    private readonly config: ConfigService,
  ) {}

  /** Never rejects. For work that decides whether to notify, as well as the sending. */
  inBackground(work: () => Promise<void>): void {
    const task: Promise<void> = Promise.resolve()
      .then(work)
      .catch((error: Error) => this.logger.error(`Security notice failed: ${error.message}`))
      .finally(() => this.background.delete(task));
    this.background.add(task);
  }

  /** Resolves once work started so far has finished. */
  async settled(): Promise<void> {
    await Promise.all(this.background);
  }

  private link(path: string): string {
    return accountLink(this.config.getOrThrow<string>('app.appUrl'), path);
  }

  private async send(user: Recipient, compose: () => PlatformEmail): Promise<void> {
    const result = await this.email.send(compose());
    if (!result.sent) {
      this.logger.warn(`Security notice not sent for user ${user.id}: ${result.reason}`);
    }
  }

  newDevice(user: Recipient, device: string, ipAddress: string | null | undefined): Promise<void> {
    return this.send(user, () =>
      newDeviceEmail(user, device, ipAddress ?? null, this.link('/forgot-password')),
    );
  }

  sessionReplayed(user: Recipient): void {
    this.inBackground(() =>
      this.send(user, () => sessionReplayedEmail(user, this.link('/forgot-password'))),
    );
  }

  passwordChangedByOwner(user: Recipient): void {
    this.inBackground(() =>
      this.send(user, () => passwordChangedByOwnerEmail(user, this.link('/forgot-password'))),
    );
  }

  passkeyChanged(user: Recipient, change: 'added' | 'removed', name: string): void {
    this.inBackground(() =>
      this.send(user, () => passkeyChangedEmail(user, change, name, this.link('/settings'))),
    );
  }

  /** Awaitable, for a caller already running in `inBackground`. */
  privacyKeyCreated(
    user: Recipient,
    key: { name: string },
    project: { id: string; name: string },
  ): Promise<void> {
    return this.send(user, () =>
      privacyKeyCreatedEmail(user, key.name, project.name, this.link(`/projects/${project.id}/api-keys`)),
    );
  }

  totpChanged(user: Recipient, change: 'added' | 'removed'): void {
    this.inBackground(() =>
      this.send(user, () => totpChangedEmail(user, change, this.link('/settings'))),
    );
  }

  staffEnrolmentStarted(user: Recipient, ipAddress: string | null | undefined): void {
    this.inBackground(() => this.send(user, () => staffEnrolmentStartedEmail(user, ipAddress ?? null)));
  }

  recoveryCodeUsed(user: Recipient, remaining: number): void {
    this.inBackground(() =>
      this.send(user, () => recoveryCodeUsedEmail(user, remaining, this.link('/settings'))),
    );
  }

  recoveryCodesReplaced(user: Recipient): void {
    this.inBackground(() =>
      this.send(user, () => recoveryCodesReplacedEmail(user, this.link('/settings'))),
    );
  }

  /** Whether account email is set up at all, so a warning could be sent. */
  canSend(): boolean {
    return this.email.isConfigured;
  }

  /**
   * Unlike the rest, waited for and reported: the factor reset's wait only starts once
   * the owner's warning is known to have gone, so the caller needs to know. Never throws.
   */
  async sendFactorResetRequested(user: Recipient, executeAfter: Date): Promise<boolean> {
    try {
      const result = await this.email.send(
        factorResetRequestedEmail(user, executeAfter, this.link('/settings')),
      );
      if (!result.sent) {
        this.logger.warn(`Factor reset warning not sent for user ${user.id}: ${result.reason}`);
      }
      return result.sent;
    } catch (error) {
      this.logger.error(`Factor reset warning failed for user ${user.id}: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Waited for and reported, as the factor reset warning is: `admin:password-reset-link`
   * issues nothing unless the owner has been told. Never throws.
   */
  async sendStaffResetLinkIssued(user: Recipient, usableAt: Date): Promise<boolean> {
    try {
      const result = await this.email.send(
        staffResetLinkIssuedEmail(user, usableAt, this.link(STAFF_LINK_CANCEL_PATH)),
      );
      if (!result.sent) {
        this.logger.warn(`Staff reset link notice not sent for user ${user.id}: ${result.reason}`);
      }
      return result.sent;
    } catch (error) {
      this.logger.error(`Staff reset link notice failed for user ${user.id}: ${(error as Error).message}`);
      return false;
    }
  }

  staffResetLinkCancelled(user: Recipient, why: StaffLinkCancelledBy = 'signed_in'): void {
    this.inBackground(() =>
      this.send(user, () => staffResetLinkCancelledEmail(user, this.link('/settings'), why)),
    );
  }

  factorResetCancelled(user: Recipient): void {
    this.inBackground(() =>
      this.send(user, () => factorResetCancelledEmail(user, this.link('/settings'))),
    );
  }

  factorsReset(user: Recipient): void {
    this.inBackground(() => this.send(user, () => factorsResetEmail(user, this.link('/settings'))));
  }
}
