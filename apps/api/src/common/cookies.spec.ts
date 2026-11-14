import type { Response } from 'express';
import { readCookie, SessionCookie } from './cookies';

/** A response that records what `cookie` and `clearCookie` were asked to do. */
function recorder() {
  const calls: Array<{ op: 'set' | 'clear'; name: string; value?: string; options: Record<string, unknown> }> = [];
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => calls.push({ op: 'set', name, value, options }),
    clearCookie: (name: string, options: Record<string, unknown>) => calls.push({ op: 'clear', name, options }),
  } as unknown as Response;
  return { res, calls };
}

const req = (cookie: string) => ({ headers: { cookie } });

describe('SessionCookie', () => {
  const secure = new SessionCookie('chumbaq_refresh', '/api/auth', true);
  const local = new SessionCookie('chumbaq_refresh', '/api/auth', false);

  it('is set as a __Host- cookie on Path=/ when Secure, and replaces the bare one', () => {
    const { res, calls } = recorder();
    secure.set(res, 'token', 1000);

    expect(calls[0]).toMatchObject({
      op: 'set',
      name: '__Host-chumbaq_refresh',
      value: 'token',
      options: { path: '/', secure: true, httpOnly: true, sameSite: 'strict', maxAge: 1000 },
    });
    expect(calls[0].options).not.toHaveProperty('domain');
    expect(calls[1]).toMatchObject({ op: 'clear', name: 'chumbaq_refresh', options: { path: '/api/auth' } });
  });

  it('keeps the bare name on its path when Secure is off, since browsers refuse __Host- then', () => {
    const { res, calls } = recorder();
    local.set(res, 'token', 1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'chumbaq_refresh', options: { path: '/api/auth', secure: false } });
  });

  it('reads the __Host- cookie, whatever bare cookies another host planted beside it', () => {
    expect(secure.read(req('chumbaq_refresh=PLANTED; __Host-chumbaq_refresh=REAL'))).toBe('REAL');
  });

  it('never takes a bare cookie when Secure, since any host under the site can set one', () => {
    expect(secure.read(req('chumbaq_refresh=PLANTED'))).toBeUndefined();
  });

  it('takes the bare name with Secure off only when it is sent once', () => {
    expect(local.read(req('chumbaq_refresh=PLANTED; chumbaq_refresh=REAL'))).toBeUndefined();
    expect(local.read(req('chumbaq_refresh=REAL'))).toBe('REAL');
  });

  it('ignores the __Host- name when Secure is off', () => {
    expect(local.read(req('__Host-chumbaq_refresh=X'))).toBeUndefined();
  });

  it('clears both names when Secure', () => {
    const { res, calls } = recorder();
    secure.clear(res);
    expect(calls.map((c) => [c.op, c.name, c.options.path])).toEqual([
      ['clear', '__Host-chumbaq_refresh', '/'],
      ['clear', 'chumbaq_refresh', '/api/auth'],
    ]);
  });
});

describe('readCookie', () => {
  it('returns the first value of the name', () => {
    expect(readCookie(req('a=1; chumbaq_did=x; chumbaq_did=y'), 'chumbaq_did')).toBe('x');
  });
});
