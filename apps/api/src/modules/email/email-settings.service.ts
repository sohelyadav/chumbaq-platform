import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { IsNull, Not, Repository } from 'typeorm';
import { ChannelCredentialsService } from '../push-notifications/channel-credentials.service';
import {
  EMAIL_PROVIDERS,
  EmailProviderName,
  normaliseEmail,
  PROVIDER_LABELS,
} from '../push-notifications/message-channel';
import { reachProvider } from '../push-notifications/services/per-recipient-provider';
import { EmailSettingsEntity } from './entities/email-settings.entity';
import { EmailProviderRegistry } from './email-provider.registry';
import { ConnectEmailProviderDto, UpdateEmailSettingsDto } from './dto/email.dto';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { changedFields } from '../project-activity/changed-fields';
import { channelTarget, recordProviderConnect } from '../project-activity/channel-targets';

/** What the dashboard is told about a stored credential. Never a secret. */
export interface CredentialSummary {
  provider: EmailProviderName;
  /** Last four characters of the key, so the right one can be recognised. */
  keyHint: string | null;
  region?: string;
  configurationSetName?: string | null;
  /** Resend: whether delivery events can be verified, and so recorded. */
  hasWebhookSecret?: boolean;
}

export interface EmailSettingsStatus {
  configured: boolean;
  settings: Omit<EmailSettingsEntity, 'project' | 'webhookToken'> | null;
  providers: CredentialSummary[];
  /** Where to point each provider's delivery events. */
  webhookUrls: Record<EmailProviderName, string> | null;
  /** True once a provider is connected and the sender is filled in. */
  readyToSend: boolean;
}

const SENDER_FIRST =
  'Set the sender (from address and postal address) before connecting a provider.';

@Injectable()
export class EmailSettingsService {
  constructor(
    @InjectRepository(EmailSettingsEntity)
    private readonly settingsRepository: Repository<EmailSettingsEntity>,
    private readonly credentials: ChannelCredentialsService,
    private readonly registry: EmailProviderRegistry,
    private readonly config: ConfigService,
    private readonly activity: ProjectActivityService,
  ) {}

  find(projectId: string): Promise<EmailSettingsEntity | null> {
    return this.settingsRepository.findOne({ where: { projectId } });
  }

  findByWebhookToken(token: string): Promise<EmailSettingsEntity | null> {
    if (!/^[0-9a-f]{48}$/.test(token)) return Promise.resolve(null);
    // With the project, for its owner: the SES webhook counts certificate fetches
    // per account, and one join here saves a second lookup on every request.
    return this.settingsRepository.findOne({
      where: { webhookToken: token },
      relations: { project: true },
    });
  }

  /**
   * Saves the sender. Writes only the columns this form owns: the row also
   * holds the webhook token and the pinned SNS topic, which other requests
   * change, and writing back a copy read earlier would undo a rotation (the
   * old webhook URL would work again) or a topic switch.
   *
   * Of those, only the ones whose value changes are written, compared with the row
   * under a lock, and `channel.settings_changed` names them in the same transaction.
   * A save that changes nothing writes and logs nothing.
   */
  async update(dto: UpdateEmailSettingsDto, actorId: string, ctx: ActivityContext): Promise<EmailSettingsStatus> {
    const fromEmail = normaliseEmail(dto.fromEmail);
    if (!fromEmail) throw new BadRequestException('The from address is not valid.');
    const replyTo = dto.replyTo ? normaliseEmail(dto.replyTo) : null;

    const sender: Partial<
      Pick<EmailSettingsEntity, 'fromEmail' | 'fromName' | 'replyTo' | 'postalAddress' | 'requireOptIn'>
    > = {
      fromEmail,
      fromName: dto.fromName?.trim() || null,
      replyTo,
      postalAddress: dto.postalAddress.trim(),
    };
    if (dto.requireOptIn !== undefined) sender.requireOptIn = dto.requireOptIn;

    await this.settingsRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(EmailSettingsEntity);
      const current = await repo.findOne({
        where: { projectId: dto.projectId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) {
        // The first save creates the row. ON CONFLICT DO NOTHING, so two first
        // saves at once do not trip the unique project index; the update below
        // then writes the sender whichever of them inserted.
        await repo
          .createQueryBuilder()
          .insert()
          .into(EmailSettingsEntity)
          .values({
            ...sender,
            projectId: dto.projectId,
            provider: null,
            webhookToken: randomBytes(24).toString('hex'),
            sesTopicArn: null,
          })
          .orIgnore()
          .execute();
      }
      const fields = changedFields(current, sender);
      if (fields.length === 0) return;
      await repo.update(
        { projectId: dto.projectId },
        Object.fromEntries(fields.map((field) => [field, sender[field]])),
      );
      await this.activity.record(
        {
          projectId: dto.projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'channel.settings_changed',
          target: channelTarget('email'),
          details: { channel: 'email', fields },
        },
        ctx,
        manager,
      );
    });
    return this.status(dto.projectId);
  }

  /**
   * Stores a provider's credentials and makes it the one campaigns use.
   *
   * Validated against the provider before anything is stored: a key that
   * does not work is far easier to fix when pasted than when a campaign
   * reaches nobody. The check can take seconds, so afterwards only the
   * provider column is written, never the row as it was read before it.
   *
   * Logged in the same transaction as `channel.provider_changed` or
   * `channel.credentials_uploaded` (`recordProviderConnect`); reconnecting the
   * provider already in use with the credentials it already holds logs nothing.
   */
  async connect(dto: ConnectEmailProviderDto, actorId: string, ctx: ActivityContext): Promise<EmailSettingsStatus> {
    if (!(await this.find(dto.projectId))) throw new BadRequestException(SENDER_FIRST);

    let parsed: unknown;
    try {
      parsed = JSON.parse(dto.credentials);
    } catch {
      throw new BadRequestException('Credentials must be valid JSON.');
    }

    const provider = this.registry.get(dto.provider);
    await reachProvider(PROVIDER_LABELS[dto.provider], () => provider.validateCredentials(parsed));

    await this.settingsRepository.manager.transaction(async (manager) => {
      // The projects row first, as every project transaction takes it (lock order).
      await manager.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [dto.projectId]);
      const repo = manager.getRepository(EmailSettingsEntity);
      const current = await repo.findOne({
        where: { projectId: dto.projectId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new BadRequestException(SENDER_FIRST);
      const credentialsChanged = await this.credentials.replace(
        manager,
        dto.projectId,
        dto.provider,
        dto.credentials,
      );
      const providerChanged = current.provider !== dto.provider;
      if (providerChanged) await repo.update({ projectId: dto.projectId }, { provider: dto.provider });
      await recordProviderConnect(
        this.activity,
        manager,
        {
          projectId: dto.projectId,
          actorId,
          channel: 'email',
          provider: dto.provider,
          label: PROVIDER_LABELS[dto.provider],
          providerChanged,
          credentialsChanged,
        },
        ctx,
      );
    });
    return this.status(dto.projectId);
  }

  /**
   * Forgets the pinned SNS topic, so a new one can be subscribed. Logged as
   * `email.ses_topic_reset` only when a topic was pinned.
   */
  async resetSesTopic(projectId: string, actorId: string, ctx: ActivityContext): Promise<void> {
    await this.settingsRepository.manager.transaction(async (manager) => {
      const result = await manager
        .getRepository(EmailSettingsEntity)
        .update({ projectId, sesTopicArn: Not(IsNull()) }, { sesTopicArn: null });
      if (!result.affected) return;
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'email.ses_topic_reset',
          target: channelTarget('email'),
        },
        ctx,
        manager,
      );
    });
  }

  /**
   * Replaces the secret in every provider webhook URL, so a leaked one stops
   * working at once. There is no overlap: the old URL answers 404 from now on,
   * and the provider has to be given the new one. Logged as
   * `email.webhook_token_rotated`, never with either token.
   */
  async rotateWebhookToken(projectId: string, actorId: string, ctx: ActivityContext): Promise<EmailSettingsStatus> {
    await this.settingsRepository.manager.transaction(async (manager) => {
      const result = await manager
        .getRepository(EmailSettingsEntity)
        .update({ projectId }, { webhookToken: randomBytes(24).toString('hex') });
      if (!result.affected) {
        throw new NotFoundException('Email is not set up for this project. Add a sender in Email settings.');
      }
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'email.webhook_token_rotated',
          target: channelTarget('email'),
        },
        ctx,
        manager,
      );
    });
    return this.status(projectId);
  }

  async pinSesTopic(settingsId: string, topicArn: string): Promise<void> {
    await this.settingsRepository.update({ id: settingsId }, { sesTopicArn: topicArn });
  }

  /** Parsed credentials for a provider, or null when none are stored. */
  async credentialsFor(
    projectId: string,
    provider: EmailProviderName,
  ): Promise<Record<string, unknown> | null> {
    const plaintext = await this.credentials.getPlaintext(projectId, provider);
    if (plaintext === null) return null;
    try {
      return JSON.parse(plaintext) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async status(projectId: string): Promise<EmailSettingsStatus> {
    const row = await this.find(projectId);
    if (!row) {
      return {
        configured: false,
        settings: null,
        providers: [],
        webhookUrls: null,
        readyToSend: false,
      };
    }

    const providers: CredentialSummary[] = [];
    for (const provider of EMAIL_PROVIDERS) {
      const stored = await this.credentialsFor(projectId, provider);
      if (stored) providers.push(this.summarise(provider, stored));
    }

    const base = String(this.config.get('app.baseUrl') ?? '').replace(/\/+$/, '');
    const { project: _project, webhookToken, ...settings } = row;

    return {
      configured: true,
      settings,
      providers,
      webhookUrls: {
        ses: `${base}/api/email/webhooks/ses/${webhookToken}`,
        resend: `${base}/api/email/webhooks/resend/${webhookToken}`,
        brevo: `${base}/api/email/webhooks/brevo/${webhookToken}`,
      },
      readyToSend:
        !!row.provider && providers.some((summary) => summary.provider === row.provider),
    };
  }

  private summarise(
    provider: EmailProviderName,
    stored: Record<string, unknown>,
  ): CredentialSummary {
    const hint = (value: unknown) =>
      typeof value === 'string' && value.length > 4 ? value.slice(-4) : null;

    if (provider === 'ses') {
      return {
        provider,
        keyHint: hint(stored.accessKeyId),
        region: typeof stored.region === 'string' ? stored.region : undefined,
        configurationSetName:
          typeof stored.configurationSetName === 'string'
            ? stored.configurationSetName
            : null,
      };
    }
    if (provider === 'brevo') {
      return { provider, keyHint: hint(stored.apiKey) };
    }
    return {
      provider,
      keyHint: hint(stored.apiKey),
      hasWebhookSecret: typeof stored.webhookSecret === 'string',
    };
  }

  /** Settings that can send, or a precise reason they cannot. */
  async requireSendable(projectId: string): Promise<{
    settings: EmailSettingsEntity & { provider: EmailProviderName };
    credentials: Record<string, unknown>;
  }> {
    const settings = await this.find(projectId);
    if (!settings) {
      throw new NotFoundException('Email is not set up for this project. Add a sender in Email settings.');
    }
    if (!settings.provider) {
      throw new BadRequestException('Connect Amazon SES, Resend or Brevo in Email settings before sending.');
    }
    const credentials = await this.credentialsFor(projectId, settings.provider);
    if (!credentials) {
      throw new BadRequestException(
        `The ${settings.provider} credentials for this project are missing or unreadable. Reconnect the provider.`,
      );
    }
    return {
      settings: settings as EmailSettingsEntity & { provider: EmailProviderName },
      credentials,
    };
  }
}
