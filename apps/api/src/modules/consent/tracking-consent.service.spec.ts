import { Logger } from '@nestjs/common';
import { TrackingConsentService } from './tracking-consent.service';

/** The lookups themselves are proved against Postgres in `consent.int-spec.ts`. */
describe('TrackingConsentService', () => {
  const repository = { query: jest.fn() };
  let service: TrackingConsentService;
  let log: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TrackingConsentService(repository as never);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    jest.useRealTimers();
  });

  it('asks the database nothing for a request that names nobody', async () => {
    expect(await service.isDoNotTrack({ projectId: 'p' })).toBe(false);
    expect(repository.query).not.toHaveBeenCalled();
  });

  it('asks nothing for an empty list either', async () => {
    expect(await service.withoutDoNotTrack('p', [])).toEqual([]);
    expect(repository.query).not.toHaveBeenCalled();
  });

  it('counts drops by kind', () => {
    service.recordDrop('event');
    service.recordDrop('event');
    service.recordDrop('touchpoint');
    expect(service.dropCounts()).toEqual(
      expect.objectContaining({ event: 2, touchpoint: 1, conversion: 0 }),
    );
  });

  it('logs the totals at most once a minute, naming no one', () => {
    jest.useFakeTimers({ now: new Date('2026-11-07T10:00:00Z') });
    service.recordDrop('event');
    service.recordDrop('event');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith('do_not_track: not stored since start: event=1');

    jest.setSystemTime(new Date('2026-11-07T10:01:00Z'));
    service.recordDrop('conversion');
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith('do_not_track: not stored since start: event=2 conversion=1');
  });
});
