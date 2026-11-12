import { BadRequestException } from '@nestjs/common';
import { ChannelProviderRegistry } from './channel-provider.registry';
import { FcmProvider } from './fcm.provider';
import { ApnsProvider } from './apns.provider';
import { MiPushProvider } from './mipush.provider';

describe('ChannelProviderRegistry', () => {
  const fcmProvider = new FcmProvider();
  const apnsProvider = new ApnsProvider();
  const miPushProvider = new MiPushProvider();
  const registry = new ChannelProviderRegistry(
    fcmProvider,
    apnsProvider,
    miPushProvider,
  );

  it('resolves a registered channel to its provider', () => {
    expect(registry.get('fcm')).toBe(fcmProvider);
    expect(registry.get('apns')).toBe(apnsProvider);
    expect(registry.get('mi_push')).toBe(miPushProvider);
  });

  it('reports what this build can deliver on', () => {
    expect(registry.supported()).toEqual(['fcm', 'apns', 'mi_push']);
    expect(registry.supports('fcm')).toBe(true);
    expect(registry.supports('apns')).toBe(true);
    expect(registry.supports('mi_push')).toBe(true);
  });

  it('refuses an unregistered channel instead of returning nothing', () => {
    // A token exists for that channel, so a recipient is waiting on it.
    // Returning null would let the worker skip them without a trace.
    expect(() => registry.get('oppo')).toThrow(BadRequestException);
  });

  it('names the channels it does support when it refuses', () => {
    // The message is what tells an operator their vendor build is missing,
    // rather than that their token registration is broken.
    expect(() => registry.get('huawei')).toThrow(/fcm/);
  });
});
