import { Injectable, BadRequestException } from '@nestjs/common';
import { PushProvider } from '../../push-tokens/entities/push-token.entity';
import { ChannelProvider } from './channel-provider';
import { FcmProvider } from './fcm.provider';
import { ApnsProvider } from './apns.provider';
import { MiPushProvider } from './mipush.provider';

/**
 * Resolves a channel to the thing that can deliver on it.
 *
 * Exists so the campaign worker asks for a provider by name instead of holding
 * an FcmProvider: adding a channel then means registering a class here, not
 * editing the send path. Which channel a recipient is on is already decided by
 * the token, so the worker's job is only to look it up.
 */
@Injectable()
export class ChannelProviderRegistry {
  private readonly providers = new Map<PushProvider, ChannelProvider>();

  constructor(
    fcmProvider: FcmProvider,
    apnsProvider: ApnsProvider,
    miPushProvider: MiPushProvider,
  ) {
    this.register(fcmProvider);
    // The other first-party channel, and the only one that reaches an iOS app
    // with no Firebase in it. Ordered next to FCM because the two never
    // compete for a device — it is iOS or it is Android.
    this.register(apnsProvider);
    // Registered without credentials existing anywhere yet. That is the point:
    // a project can now store Mi Push credentials and register a Mi Push token,
    // and a project that does neither is unaffected — the channel is only ever
    // chosen for a device that actually holds a token on it.
    this.register(miPushProvider);
  }

  private register(provider: ChannelProvider): void {
    this.providers.set(provider.provider, provider);
  }

  /** Whether anything can deliver on this channel in this build. */
  supports(provider: PushProvider): boolean {
    return this.providers.has(provider);
  }

  /** Every channel this build can deliver on. */
  supported(): PushProvider[] {
    return [...this.providers.keys()];
  }

  /**
   * The provider for a channel.
   *
   * Throws rather than returning null: a token exists for this channel, so
   * something registered it and a recipient is expecting the message. Silently
   * skipping them would drop recipients from a campaign with nothing to show
   * for it.
   */
  get(provider: PushProvider): ChannelProvider {
    const found = this.providers.get(provider);
    if (!found) {
      throw new BadRequestException(
        `No provider is registered for the "${provider}" channel. ` +
          `This build can deliver on: ${this.supported().join(', ')}.`,
      );
    }
    return found;
  }
}
