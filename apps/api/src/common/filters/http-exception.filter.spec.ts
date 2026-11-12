import { ArgumentsHost, ConflictException, Logger } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  const run = (exception: unknown) => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: '/api/x', path: '/api/x', method: 'POST', requestId: 'req-123' }),
      }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(exception, host);
    return { code: status.mock.calls[0][0], body: json.mock.calls[0][0] };
  };

  let logged: jest.SpyInstance;
  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps a driver message out of the response and in the log', () => {
    const { code, body } = run(
      new Error('password authentication failed for user "chumbaq" at 10.0.0.5'),
    );

    expect(code).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/10\.0\.0\.5|password authentication/);
    expect(body.message).toBe('Internal server error');
    expect(body.error).toBe('Internal Server Error');
    expect(logged.mock.calls[0][0]).toContain('10.0.0.5');
  });

  it('puts the request id in the log line, so it can be matched with nginx', () => {
    run(new Error('boom'));
    expect(logged.mock.calls[0][0]).toContain('[req-123]');
  });

  it('still answers a deliberate HTTP error with its own message', () => {
    const { code, body } = run(new ConflictException('Tenant is already suspended'));

    expect(code).toBe(409);
    expect(body.message).toBe('Tenant is already suspended');
    expect(logged).not.toHaveBeenCalled();
  });
});
