import { requestId, requestIdOf } from './request-id';

describe('requestId middleware', () => {
  const run = (header?: string) => {
    const req = { headers: header === undefined ? {} : { 'x-request-id': header } } as never;
    const set = jest.fn();
    const next = jest.fn();
    requestId(req, { setHeader: set } as never, next);
    return { req, set, next };
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("keeps nginx's id and echoes it", () => {
    const { req, set, next } = run('8f1c2b3a4d5e6f708192a3b4c5d6e7f8');
    expect(requestIdOf(req)).toBe('8f1c2b3a4d5e6f708192a3b4c5d6e7f8');
    expect(set).toHaveBeenCalledWith('X-Request-Id', '8f1c2b3a4d5e6f708192a3b4c5d6e7f8');
    expect(next).toHaveBeenCalled();
  });

  it('makes one when the header is missing', () => {
    expect(requestIdOf(run().req)).toMatch(UUID);
  });

  it('replaces a header that could forge a log line', () => {
    expect(requestIdOf(run('bad id!\nINFO forged').req)).toMatch(UUID);
    expect(requestIdOf(run('x'.repeat(65)).req)).toMatch(UUID);
  });
});
