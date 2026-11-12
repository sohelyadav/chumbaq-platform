import { Controller, Get, INestApplication, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import {
  applySecurityHeaders,
  FORM_PAGE_POLICY,
  interstitialPolicy,
  STATIC_PAGE_POLICY,
} from './security-headers';

@Controller()
class ProbeController {
  @Get('json')
  json() {
    return { ok: true };
  }

  @Get('page')
  page(@Res() res: Response) {
    res.setHeader('Content-Security-Policy', STATIC_PAGE_POLICY);
    res.type('html').send('<h1>page</h1>');
  }

  @Get('away')
  away(@Res() res: Response) {
    res.redirect(302, 'https://tenant.example/landing');
  }
}

/** Real HTTP through real helmet, since the point is what actually leaves the server. */
describe('security headers', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    applySecurityHeaders(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(() => app.close());

  const get = (path: string) => fetch(`${base}/${path}`, { redirect: 'manual' });

  it('lets a JSON response load nothing and be framed by nothing', async () => {
    const csp = (await get('json')).headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('lets a route replace the policy for a page it really serves', async () => {
    expect((await get('page')).headers.get('content-security-policy')).toBe(STATIC_PAGE_POLICY);
  });

  it('stops content sniffing and hides the framework', async () => {
    const { headers } = await get('json');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-powered-by')).toBeNull();
  });

  it('leaves the referrer of a short-link redirect alone, for the tenant’s analytics', async () => {
    const response = await get('away');
    expect(response.status).toBe(302);
    expect(response.headers.get('referrer-policy')).toBeNull();
  });

  it('lets SDKs on tenants’ sites load from here', async () => {
    expect((await get('json')).headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('pins HTTPS for this host only, not subdomains it knows nothing of', async () => {
    expect((await get('json')).headers.get('strict-transport-security')).not.toContain('includeSubDomains');
  });

  it('runs only the interstitial’s own script', () => {
    const policy = interstitialPolicy('abc');
    expect(policy).toContain("script-src 'nonce-abc'");
    expect(policy).not.toContain("'unsafe-inline'; base-uri 'self'");
    expect(policy.match(/script-src [^;]+/)?.[0]).toBe("script-src 'nonce-abc'");
  });

  it('allows a form to post only where a form page needs it', () => {
    expect(FORM_PAGE_POLICY).toContain("form-action 'self'");
    expect(STATIC_PAGE_POLICY).toContain("form-action 'none'");
  });
});
