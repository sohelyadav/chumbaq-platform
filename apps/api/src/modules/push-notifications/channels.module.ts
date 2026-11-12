import { Module } from '@nestjs/common';
import { FcmProvider } from './services/fcm.provider';
import { ApnsProvider } from './services/apns.provider';
import { MiPushProvider } from './services/mipush.provider';
import { ChannelProviderRegistry } from './services/channel-provider.registry';

/**
 * The delivery channels this build can send on.
 *
 * Its own module because both the sender and token registration need it, and
 * they sit on opposite sides of an existing import: push-notifications already
 * imports push-tokens, so pointing push-tokens back would be a cycle.
 * Registration needs it to refuse a token for a channel nothing can deliver
 * on — a check that only means anything if it asks the same registry the
 * sender will later consult.
 *
 * A new channel is registered here and nowhere else.
 */
@Module({
  providers: [FcmProvider, ApnsProvider, MiPushProvider, ChannelProviderRegistry],
  exports: [FcmProvider, ApnsProvider, MiPushProvider, ChannelProviderRegistry],
})
export class ChannelsModule {}
