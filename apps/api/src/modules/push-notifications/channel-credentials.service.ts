import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { PushChannelCredentialEntity } from './entities/push-channel-credential.entity';
import {
  PUSH_PROVIDERS,
  PushProvider,
} from '../push-tokens/entities/push-token.entity';
import { ChannelProviderName } from './message-channel';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { sameCredentials } from '../project-activity/changed-fields';

/** An encrypted credential blob, as stored. */
export interface StoredCredentials {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Per-project, per-channel credential storage.
 *
 * Callers name the channel they want. Nothing here knows what a credential
 * contains — FCM stores a service account JSON, a vendor channel will store
 * something else entirely — so the plaintext is handed back as a string and
 * parsed by whichever provider owns that format.
 */
@Injectable()
export class ChannelCredentialsService {
  private readonly logger = new Logger(ChannelCredentialsService.name);

  constructor(
    @InjectRepository(PushChannelCredentialEntity)
    private readonly credentialRepository: Repository<PushChannelCredentialEntity>,
    private readonly cryptoService: CredentialsCryptoService,
  ) {}

  /**
   * Stores credentials for a channel, replacing whatever was there.
   *
   * Upsert rather than insert: re-uploading a rotated key is the normal case,
   * and a project may only ever have one credential per channel — the unique
   * index says so, and two would leave which one sends undefined.
   */
  async upsert(
    projectId: string,
    provider: ChannelProviderName,
    plaintext: string,
  ): Promise<PushChannelCredentialEntity> {
    const encrypted = this.cryptoService.encrypt(plaintext);

    const existing = await this.credentialRepository.findOne({
      where: { projectId, provider },
    });

    const row =
      existing ??
      this.credentialRepository.create({ projectId, provider });

    row.credentialsEncrypted = encrypted.ciphertext;
    row.credentialsIv = encrypted.iv;
    row.credentialsTag = encrypted.tag;
    row.isActive = true;

    return this.credentialRepository.save(row);
  }

  /**
   * Stores credentials in `manager`'s transaction and says whether that changed
   * anything: false when the channel is already on with credentials saying the same
   * thing (compared decrypted, key order and spacing aside), and then nothing is
   * written. The activity log learns only that yes or no, never a value.
   *
   * The row is read FOR UPDATE, so two uploads at once compare in turn.
   */
  async replace(
    manager: EntityManager,
    projectId: string,
    provider: ChannelProviderName,
    plaintext: string,
  ): Promise<boolean> {
    const repo = manager.getRepository(PushChannelCredentialEntity);
    const existing = await repo.findOne({
      where: { projectId, provider },
      lock: { mode: 'pessimistic_write' },
    });
    if (existing?.isActive && this.holds(existing, plaintext)) return false;

    const encrypted = this.cryptoService.encrypt(plaintext);
    const row = existing ?? repo.create({ projectId, provider });
    row.credentialsEncrypted = encrypted.ciphertext;
    row.credentialsIv = encrypted.iv;
    row.credentialsTag = encrypted.tag;
    row.isActive = true;
    await repo.save(row);
    return true;
  }

  /** Whether a stored row already holds `plaintext`. One that will not decrypt does not. */
  private holds(row: PushChannelCredentialEntity, plaintext: string): boolean {
    let stored: string;
    try {
      stored = this.decrypt(row);
    } catch {
      return false;
    }
    return sameCredentials(stored, plaintext);
  }

  /** The stored ciphertext for a channel, or null if it has none. */
  async find(
    projectId: string,
    provider: ChannelProviderName,
  ): Promise<PushChannelCredentialEntity | null> {
    return this.credentialRepository.findOne({
      where: { projectId, provider },
    });
  }

  /**
   * Decrypted credentials for a channel, or null when the channel is not
   * configured or is switched off.
   *
   * Returns null rather than throwing for "not configured", because that is an
   * ordinary state — most projects will never configure most channels. A
   * credential that exists but will not decrypt is different, and throws.
   */
  async getPlaintext(
    projectId: string,
    provider: ChannelProviderName,
  ): Promise<string | null> {
    const row = await this.find(projectId, provider);
    if (!row || !row.isActive) return null;
    return this.decrypt(row);
  }

  /**
   * Decrypts a row that has already been loaded.
   *
   * Separate so the campaign worker can fetch the row alongside everything
   * else it needs and decrypt without a second query per batch.
   */
  decrypt(row: PushChannelCredentialEntity): string {
    return this.cryptoService.decrypt(
      row.credentialsEncrypted,
      row.credentialsIv,
      row.credentialsTag,
    );
  }

  /** Every provider this project holds active credentials for, any channel. */
  async configuredProviders(projectId: string): Promise<ChannelProviderName[]> {
    const rows = await this.credentialRepository.find({
      where: { projectId, isActive: true },
      select: ['provider'],
    });
    return rows.map((row) => row.provider);
  }

  /**
   * The push channels this project can currently send through.
   *
   * Narrowed rather than left to callers: the push worker selects tokens by
   * this list, and an email provider in it would be harmless today only by
   * the accident that no token names one.
   */
  async configuredPushProviders(projectId: string): Promise<PushProvider[]> {
    const all = await this.configuredProviders(projectId);
    return all.filter((provider): provider is PushProvider =>
      (PUSH_PROVIDERS as readonly string[]).includes(provider),
    );
  }
}
