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
  WHATSAPP_PROVIDERS,
  WhatsAppProviderName,
  PROVIDER_LABELS,
} from '../push-notifications/message-channel';
import { reachProvider } from '../push-notifications/services/per-recipient-provider';
import { WhatsAppSettingsEntity } from './entities/whatsapp-settings.entity';
import { WhatsAppProviderRegistry } from './whatsapp-provider.registry';
import { ConnectWhatsAppProviderDto, UpdateWhatsAppSettingsDto } from './dto/whatsapp.dto';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { changedFields } from '../project-activity/changed-fields';
import { channelTarget, recordProviderConnect } from '../project-activity/channel-targets';

/** Credential fields that are identifiers rather than secrets, shown so the right account is recognised. */
const PUBLIC_FIELDS: Record<WhatsAppProviderName, string[]> = {
  meta: ['phoneNumberId', 'businessAccountId'],
  twilio_whatsapp: ['accountSid', 'sender'],
  gupshup: ['appName', 'appId', 'sourceNumber'],
  interakt: [],
};

/** The field whose last four characters identify the stored secret. */
const SECRET_FIELD: Record<WhatsAppProviderName, string> = {
  meta: 'accessToken',
  twilio_whatsapp: 'authToken',
  gupshup: 'apiKey',
  interakt: 'apiKey',
};

export interface WhatsAppCredentialSummary {
  provider: WhatsAppProviderName;
  identifiers: Record<string, string>;
  keyHint: string | null;
  /** Whether webhooks from this provider can be verified with what is stored. */
  webhooksSigned: boolean;
}

export interface WhatsAppSettingsStatus {
  configured: boolean;
  settings: Omit<WhatsAppSettingsEntity, 'project' | 'webhookToken'> | null;
  providers: WhatsAppCredentialSummary[];
  /** Where to point each provider's webhook. Meta also needs `verifyToken`. */
  webhookUrls: Record<WhatsAppProviderName, string> | null;
  /** What to paste as Meta's webhook "Verify token". */
  verifyToken: string | null;
  webhooksReachable: boolean;
  readyToSend: boolean;
}

@Injectable()
export class WhatsAppSettingsService {
  constructor(
    @InjectRepository(WhatsAppSettingsEntity)
    private readonly settingsRepository: Repository<WhatsAppSettingsEntity>,
    private readonly credentials: ChannelCredentialsService,
    private readonly registry: WhatsAppProviderRegistry,
    private readonly config: ConfigService,
    private readonly activity: ProjectActivityService,
  ) {}

  find(projectId: string): Promise<WhatsAppSettingsEntity | null> {
    return this.settingsRepository.findOne({ where: { projectId } });
  }

  findByWebhookToken(token: string): Promise<WhatsAppSettingsEntity | null> {
    if (!/^[0-9a-f]{48}$/.test(token)) return Promise.resolve(null);
    return this.settingsRepository.findOne({ where: { webhookToken: token } });
  }

  /** Creates the settings row on first use, so webhook URLs exist before connecting. */
  async ensure(projectId: string): Promise<WhatsAppSettingsEntity> {
    const existing = await this.find(projectId);
    if (existing) return existing;
    // ON CONFLICT DO NOTHING: two first uses at once (the settings page and a
    // connect) would otherwise trip the unique project index and fail one.
    await this.settingsRepository
      .createQueryBuilder()
      .insert()
      .into(WhatsAppSettingsEntity)
      .values({
        projectId,
        provider: null,
        requireOptIn: true,
        webhookToken: randomBytes(24).toString('hex'),
      })
      .orIgnore()
      .execute();
    return this.settingsRepository.findOneOrFail({ where: { projectId } });
  }

  /**
   * Writes only the columns given, never the whole row: a row read before
   * a slow step and saved after it would put back whatever another request
   * changed in between (a provider connected, an opt-in setting).
   */
  async update(dto: UpdateWhatsAppSettingsDto, actorId: string, ctx: ActivityContext): Promise<WhatsAppSettingsStatus> {
    await this.ensure(dto.projectId);
    if (dto.requireOptIn !== undefined) {
      const next = { requireOptIn: dto.requireOptIn };
      // Compared with the row under a lock, and logged with the field's name in the
      // same transaction; setting it to what it already is logs nothing.
      await this.settingsRepository.manager.transaction(async (manager) => {
        const repo = manager.getRepository(WhatsAppSettingsEntity);
        const current = await repo.findOne({
          where: { projectId: dto.projectId },
          lock: { mode: 'pessimistic_write' },
        });
        const fields = changedFields(current, next);
        if (!current || fields.length === 0) return;
        await repo.update({ projectId: dto.projectId }, next);
        await this.activity.record(
          {
            projectId: dto.projectId,
            actor: { kind: 'user', userId: actorId },
            action: 'channel.settings_changed',
            target: channelTarget('whatsapp'),
            details: { channel: 'whatsapp', fields },
          },
          ctx,
          manager,
        );
      });
    }
    return this.status(dto.projectId);
  }

  /**
   * Validates the credentials against the provider, then stores them and makes it
   * active. Logged in the same transaction (`recordProviderConnect`); a reconnect
   * that changes nothing logs nothing.
   */
  async connect(dto: ConnectWhatsAppProviderDto, actorId: string, ctx: ActivityContext): Promise<WhatsAppSettingsStatus> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dto.credentials);
    } catch {
      throw new BadRequestException('Credentials must be valid JSON.');
    }

    const provider = this.registry.get(dto.provider);
    await reachProvider(PROVIDER_LABELS[dto.provider], () => provider.validateCredentials(parsed));
    await this.ensure(dto.projectId);

    await this.settingsRepository.manager.transaction(async (manager) => {
      // The projects row first, as every project transaction takes it (lock order).
      await manager.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [dto.projectId]);
      const repo = manager.getRepository(WhatsAppSettingsEntity);
      const current = await repo.findOneOrFail({
        where: { projectId: dto.projectId },
        lock: { mode: 'pessimistic_write' },
      });
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
          channel: 'whatsapp',
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
    provider: WhatsAppProviderName,
  ): Promise<Record<string, unknown> | null> {
    const plaintext = await this.credentials.getPlaintext(projectId, provider);
    if (plaintext === null) return null;
    try {
      return JSON.parse(plaintext) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  baseUrl(): string {
    return String(this.config.get('app.baseUrl') ?? '').replace(/\/+$/, '');
  }

  webhookUrl(token: string, provider: WhatsAppProviderName): string {
    return `${this.baseUrl()}/api/whatsapp/webhooks/${provider}/${token}`;
  }

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

  async status(projectId: string): Promise<WhatsAppSettingsStatus> {
    const row = await this.find(projectId);
    if (!row) {
      return {
        configured: false,
        settings: null,
        providers: [],
        webhookUrls: null,
        verifyToken: null,
        webhooksReachable: this.webhooksReachable(),
        readyToSend: false,
      };
    }

    const providers: WhatsAppCredentialSummary[] = [];
    for (const provider of WHATSAPP_PROVIDERS) {
      const stored = await this.credentialsFor(projectId, provider);
      if (!stored) continue;
      const identifiers: Record<string, string> = {};
      for (const field of PUBLIC_FIELDS[provider]) {
        if (typeof stored[field] === 'string') identifiers[field] = stored[field] as string;
      }
      const secret = stored[SECRET_FIELD[provider]];
      providers.push({
        provider,
        identifiers,
        keyHint: typeof secret === 'string' && secret.length > 4 ? secret.slice(-4) : null,
        webhooksSigned: this.webhooksSigned(provider, stored),
      });
    }

    const { project: _project, webhookToken, ...settings } = row;
    const webhookUrls = Object.fromEntries(
      WHATSAPP_PROVIDERS.map((provider) => [provider, this.webhookUrl(webhookToken, provider)]),
    ) as Record<WhatsAppProviderName, string>;

    return {
      configured: true,
      settings,
      providers,
      webhookUrls,
      verifyToken: webhookToken,
      webhooksReachable: this.webhooksReachable(),
      readyToSend:
        !!row.provider && providers.some((summary) => summary.provider === row.provider),
    };
  }

  /**
   * Meta and Interakt sign with a secret the customer adds separately (the
   * app secret, the webhook secret); Twilio signs with the auth token every
   * connection has; Gupshup does not sign at all.
   */
  private webhooksSigned(provider: WhatsAppProviderName, stored: Record<string, unknown>): boolean {
    if (provider === 'meta') return typeof stored.appSecret === 'string' && !!stored.appSecret;
    if (provider === 'interakt') return typeof stored.webhookSecret === 'string' && !!stored.webhookSecret;
    if (provider === 'twilio_whatsapp') return true;
    return false;
  }

  async requireSendable(projectId: string): Promise<{
    settings: WhatsAppSettingsEntity & { provider: WhatsAppProviderName };
    credentials: Record<string, unknown>;
  }> {
    const settings = await this.find(projectId);
    if (!settings) {
      throw new NotFoundException('WhatsApp is not set up for this project. Connect a provider in WhatsApp settings.');
    }
    if (!settings.provider) {
      throw new BadRequestException('Connect a WhatsApp provider in WhatsApp settings before sending.');
    }
    const credentials = await this.credentialsFor(projectId, settings.provider);
    if (!credentials) {
      throw new BadRequestException(
        `The ${settings.provider} credentials for this project are missing or unreadable. Reconnect the provider.`,
      );
    }
    return {
      settings: settings as WhatsAppSettingsEntity & { provider: WhatsAppProviderName },
      credentials,
    };
  }
}
