import { Test, TestingModule } from '@nestjs/testing';
import { MixpanelApiService } from './mixpanel-api.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('MixpanelApiService', () => {
  let service: MixpanelApiService;

  const mockGet = jest.fn();
  const mockPost = jest.fn();
  const mockAxiosInstance = { get: mockGet, post: mockPost } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [MixpanelApiService],
    }).compile();

    service = module.get<MixpanelApiService>(MixpanelApiService);
  });

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------
  describe('testConnection', () => {
    it('returns true when axios GET succeeds', async () => {
      mockGet.mockResolvedValueOnce({ data: [] });

      const result = await service.testConnection('user', 'pass', 'proj-123');

      expect(result).toBe(true);
    });

    it('calls /cohorts/list with the correct project_id param', async () => {
      mockGet.mockResolvedValueOnce({ data: [] });

      await service.testConnection('user', 'pass', 'proj-123');

      expect(mockGet).toHaveBeenCalledWith('/cohorts/list', {
        params: { project_id: 'proj-123' },
      });
    });

    it('returns false when axios throws an error', async () => {
      mockGet.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.testConnection('user', 'pass', 'proj-123');

      expect(result).toBe(false);
    });

    it('logs a warning when axios throws an error', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      mockGet.mockRejectedValueOnce(new Error('Unauthorized'));

      await service.testConnection('user', 'pass', 'proj-123');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Mixpanel connection test failed'),
      );
    });

    it('returns false for non-Error thrown values', async () => {
      mockGet.mockRejectedValueOnce('string error');

      const result = await service.testConnection('user', 'pass', 'proj-123');

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // listCohorts
  // ---------------------------------------------------------------------------
  describe('listCohorts', () => {
    const config = { username: 'user', password: 'pass', mixpanelProjectId: 'proj-123' };

    it('returns a mapped array when the response data is an array', async () => {
      const raw = [
        { id: 1, name: 'Cohort A', count: 50, description: 'desc', created: '2024-01-01' },
        { id: 2, name: 'Cohort B', count: 0, created: '2024-02-01' },
      ];
      mockGet.mockResolvedValueOnce({ data: raw });

      const result = await service.listCohorts(config);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 1,
        name: 'Cohort A',
        count: 50,
        description: 'desc',
        created: '2024-01-01',
      });
    });

    it('defaults description to null when not present in raw data', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 3, name: 'C', count: 10, created: '2024-03-01' }] });

      const result = await service.listCohorts(config);

      expect(result[0].description).toBeNull();
    });

    it('defaults count to 0 when count is missing in raw data', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 4, name: 'D', created: '2024-03-01' }] });

      const result = await service.listCohorts(config);

      expect(result[0].count).toBe(0);
    });

    it('uses alternate count fields and parses string values', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 5, name: 'E', num_users: '17', created: '2024-03-01' }] });

      const result = await service.listCohorts(config);

      expect(result[0].count).toBe(17);
    });

    it('throws an error when the response data is not an array', async () => {
      mockGet.mockResolvedValueOnce({ data: { error: 'bad request' } });

      await expect(service.listCohorts(config)).rejects.toThrow('Unexpected Mixpanel response');
    });

    it('calls /cohorts/list with the correct project_id param', async () => {
      mockGet.mockResolvedValueOnce({ data: [] });

      await service.listCohorts(config);

      expect(mockGet).toHaveBeenCalledWith('/cohorts/list', {
        params: { project_id: 'proj-123' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getCohortMembers
  // ---------------------------------------------------------------------------
  describe('getCohortMembers', () => {
    const config = { username: 'user', password: 'pass', mixpanelProjectId: 'proj-123' };

    it('returns all profiles for a single page when count equals total', async () => {
      const profiles = [
        { $distinct_id: 'u1', $properties: { $email: 'u1@example.com' } },
        { $distinct_id: 'u2', $properties: {} },
      ];
      mockPost.mockResolvedValueOnce({
        data: { status: 'ok', results: profiles, total: 2, session_id: 'sess-1' },
      });

      const result = await service.getCohortMembers(config, 42);

      expect(result).toHaveLength(2);
      expect(result[0].$distinct_id).toBe('u1');
    });

    it('stops pagination when allResults.length >= total', async () => {
      const page0Profiles = [
        { $distinct_id: 'u1', $properties: {} },
        { $distinct_id: 'u2', $properties: {} },
      ];
      const page1Profiles = [{ $distinct_id: 'u3', $properties: {} }];

      // Page 0: 2 results, total = 3
      mockPost.mockResolvedValueOnce({
        data: { status: 'ok', results: page0Profiles, total: 3, session_id: 'sess-abc' },
      });
      // Page 1: 1 result, total = 3 — after adding this allResults.length = 3 >= 3
      mockPost.mockResolvedValueOnce({
        data: { status: 'ok', results: page1Profiles, total: 3, session_id: 'sess-abc' },
      });

      const result = await service.getCohortMembers(config, 42);

      expect(result).toHaveLength(3);
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('stops pagination when results array is empty', async () => {
      mockPost.mockResolvedValueOnce({
        data: { status: 'ok', results: [], total: 10, session_id: 'sess-1' },
      });

      const result = await service.getCohortMembers(config, 42);

      expect(result).toHaveLength(0);
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('passes session_id on subsequent pages', async () => {
      const page0 = [{ $distinct_id: 'u1', $properties: {} }];
      const page1 = [{ $distinct_id: 'u2', $properties: {} }];

      mockPost.mockResolvedValueOnce({
        data: { status: 'ok', results: page0, total: 2, session_id: 'my-session' },
      });
      mockPost.mockResolvedValueOnce({
        data: { status: 'ok', results: page1, total: 2, session_id: 'my-session' },
      });

      await service.getCohortMembers(config, 42);

      // Second call should include session_id in the posted params string
      const secondCallBody: string = mockPost.mock.calls[1][1];
      expect(secondCallBody).toContain('session_id=my-session');
    });

    it('throws when the engage API returns a non-ok status', async () => {
      mockPost.mockResolvedValueOnce({
        data: { status: 'error', error: 'Invalid project' },
      });

      await expect(service.getCohortMembers(config, 42)).rejects.toThrow(
        'Mixpanel engage API error',
      );
    });

    it('uses axios.create with Basic auth header', async () => {
      mockPost.mockResolvedValueOnce({
        data: { status: 'ok', results: [], total: 0, session_id: 's1' },
      });

      await service.getCohortMembers(config, 42);

      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: expect.stringContaining('Basic ') }),
        }),
      );
    });
  });
});
