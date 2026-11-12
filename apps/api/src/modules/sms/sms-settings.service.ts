import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { ChannelCredentialsService } from '../push-notifications/channel-credentials.service';
import {
  SMS_PROVIDERS,
  SmsProviderName,
  PROVIDER_LABELS,
} from '../push-notifications/message-channel';
import { reachProvider } from '../push-notifications/services/per-recipient-provider';
import { SmsSettingsEntity } from './entities/sms-settings.entity';
import { SmsProviderRegistry } from './sms-provider.registry';
import { ConnectSmsProviderDto, UpdateSmsSettingsDto } from './dto/sms.dto';
import { DEFAULT_OPT_OUT_TEXT } from './sms-rendering';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { changedFields } from '../project-activity/changed-fields';
import { channelTarget, recordProviderConnect } from '../project-activity/channel-targets';

/** What the dashboard is told about a stored credential. Never a secret. */
export interface SmsCredentialSummary {
  provider: SmsProviderName;
  /** The Account SID is not secret; shown so the right account is recognised. */
  accountSid: string | null;
  /** Last four characters of the Auth Token. */
  keyHint: string | null;
}

export interface SmsSettingsStatus {
  configured: boolean;
  settings: Omit<SmsSettingsEntity, 'project' | 'webhookToken'> | null;
  providers: SmsCredentialSummary[];
  /**
   * Where to point the number's incoming-message webhook, so STOP and START
   * replies reach the suppression list. Delivery reports need no setup: each
   * message names its own callback.
   */
  inboundWebhookUrl: string | null;
  /**
   * False when the API's public URL is a local address Twilio cannot reach;
   * texts still send, but delivery reports and STOP replies never arrive.
   */
  webhooksReachable: boolean;
  readyToSend: boolean;
}

const SENDER_FIRST = 'Set the sender before connecting a provider.';

@Injectable()
export class SmsSettingsService {
  constructor(
    @InjectRepository(SmsSettingsEntity)
    private readonly settingsRepository: Repository<SmsSettingsEntity>,
    private readonly credentials: ChannelCredentialsService,
    private readonly registry: SmsProviderRegistry,
    private readonly config: ConfigService,
    private readonly activity: ProjectActivityService,
  ) {}

  find(projectId: string): Promise<SmsSettingsEntity | null> {
    return this.settingsRepository.findOne({ where: { projectId } });
  }

  findByWebhookToken(token: string): Promise<SmsSettingsEntity | null> {
    if (!/^[0-9a-f]{48}$/.test(token)) return Promise.resolve(null);
    return this.settingsRepository.findOne({ where: { webhookToken: token } });
  }

  /**
   * Saves the sender settings. Writes only the columns this form owns, so a
   * provider being connected at the same moment is not undone, nor is this
   * undone by it (see `connect`). Of those, only the ones whose value changes,
   * compared with the row under a lock; `channel.settings_changed` names them in
   * the same transaction, and a save that changes nothing logs nothing.
   */
  async update(dto: UpdateSmsSettingsDto, actorId: string, ctx: ActivityContext): Promise<SmsSettingsStatus> {
    const fields: Partial<Pick<SmsSettingsEntity, 'sender' | 'requireOptIn' | 'optOutText'>> = {
      sender: dto.sender.trim(),
    };
    if (dto.requireOptIn !== undefined) fields.requireOptIn = dto.requireOptIn;
    if (dto.optOutText !== undefined) fields.optOutText = dto.optOutText.trim() || null;

    await this.settingsRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(SmsSettingsEntity);
      const current = await repo.findOne({
        where: { projectId: dto.projectId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) {
        // The first save creates the row; ON CONFLICT DO NOTHING so two first
        // saves at once do not trip the unique project index.
        await repo
          .createQueryBuilder()
          .insert()
          .into(SmsSettingsEntity)
          .values({
            optOutText: DEFAULT_OPT_OUT_TEXT,
            ...fields,
            projectId: dto.projectId,
            provider: null,
            webhookToken: randomBytes(24).toString('hex'),
          })
          .orIgnore()
          .execute();
      }
      const changed = changedFields(current, fields);
      if (changed.length === 0) return;
      await repo.update(
        { projectId: dto.projectId },
        Object.fromEntries(changed.map((field) => [field, fields[field]])),
      );
      await this.activity.record(
        {
          projectId: dto.projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'channel.settings_changed',
          target: channelTarget('sms'),
          details: { channel: 'sms', fields: changed },
        },
        ctx,
        manager,
      );
    });
    return this.status(dto.projectId);
  }

  /**
   * Validates the credentials against the provider, then stores them. The
   * check can take seconds, so afterwards only the provider column is
   * written: saving the row as read before it would put back an opt-in or
   * sender changed in the meantime. Logged in the same transaction
   * (`recordProviderConnect`); a reconnect that changes nothing logs nothing.
   */
  async connect(dto: ConnectSmsProviderDto, actorId: string, ctx: ActivityContext): Promise<SmsSettingsStatus> {
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
      const repo = manager.getRepository(SmsSettingsEntity);
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
          channel: 'sms',
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

  async credentialsFor(
    projectId: string,
    provider: SmsProviderName,
  ): Promise<Record<string, unknown> | null> {
    const plaintext = await this.credentials.getPlaintext(projectId, provider);
    if (plaintext === null) return null;
    try {
      return JSON.parse(plaintext) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** The public base URL webhooks are built on, without a trailing slash. */
  baseUrl(): string {
    return String(this.config.get('app.baseUrl') ?? '').replace(/\/+$/, '');
  }

  /**
   * Whether a provider on the internet could call the base URL. A local
   * address would only fill the provider's error log with failed callbacks.
   */
  webhooksReachable(): boolean {
    try {
      const host = new URL(this.baseUrl()).hostname;
      return !(
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        /^127\./.test(host) ||
        host === '0.0.0.0' ||
        host === '[::1]'
      );
    } catch {
      return false;
    }
  }

  /** Where one message's delivery report goes, or undefined when unreachable. */
  statusCallbackUrl(
    settings: Pick<SmsSettingsEntity, 'webhookToken'>,
    campaignId: string | null,
    identityId: string | null,
  ): string | undefined {
    if (!this.webhooksReachable()) return undefined;
    const query = new URLSearchParams();
    if (campaignId) query.set('c', campaignId);
    if (identityId) query.set('i', identityId);
    const suffix = query.toString() ? `?${query}` : '';
    return `${this.baseUrl()}/api/sms/webhooks/twilio/${settings.webhookToken}/status${suffix}`;
  }

  async status(projectId: string): Promise<SmsSettingsStatus> {
    const row = await this.find(projectId);
    if (!row) {
      return {
        configured: false,
        settings: null,
        providers: [],
        inboundWebhookUrl: null,
        webhooksReachable: this.webhooksReachable(),
        readyToSend: false,
      };
    }

    const providers: SmsCredentialSummary[] = [];
    for (const provider of SMS_PROVIDERS) {
      const stored = await this.credentialsFor(projectId, provider);
      if (!stored) continue;
      providers.push({
        provider,
        accountSid: typeof stored.accountSid === 'string' ? stored.accountSid : null,
        keyHint:
          typeof stored.authToken === 'string' && stored.authToken.length > 4
            ? stored.authToken.slice(-4)
            : null,
      });
    }

    const { project: _project, webhookToken, ...settings } = row;
    return {
      configured: true,
      settings,
      providers,
      inboundWebhookUrl: `${this.baseUrl()}/api/sms/webhooks/twilio/${webhookToken}/inbound`,
      webhooksReachable: this.webhooksReachable(),
      readyToSend:
        !!row.provider && providers.some((summary) => summary.provider === row.provider),
    };
  }

  /** Settings that can send, or a precise reason they cannot. */
  async requireSendable(projectId: string): Promise<{
    settings: SmsSettingsEntity & { provider: SmsProviderName };
    credentials: Record<string, unknown>;
  }> {
    const settings = await this.find(projectId);
    if (!settings) {
      throw new NotFoundException('SMS is not set up for this project. Add a sender in SMS settings.');
    }
    if (!settings.provider) {
      throw new BadRequestException('Connect Twilio in SMS settings before sending.');
    }
    const credentials = await this.credentialsFor(projectId, settings.provider);
    if (!credentials) {
      throw new BadRequestException(
        `The ${settings.provider} credentials for this project are missing or unreadable. Reconnect the provider.`,
      );
    }
    return {
      settings: settings as SmsSettingsEntity & { provider: SmsProviderName },
      credentials,
    };
  }
}
