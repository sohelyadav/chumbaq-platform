import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';

/**
 * For the API's own responses, which are JSON: nothing in them should ever load. A
 * route that really serves a page overrides this with one of the two policies below.
 * The dashboard's policy is separate, because nginx serves the dashboard, not this.
 */
const API_POLICY = {
  defaultSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
};

export function applySecurityHeaders(app: INestApplication): void {
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: API_POLICY },
      // SDKs and pixels load from this API on tenants' own sites.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // A short link's redirect would otherwise strip the referrer from the tenant's
      // destination, changing what their analytics report.
      referrerPolicy: false,
      // The short-link domain can sit beside subdomains this deployment knows nothing of.
      strictTransportSecurity: { maxAge: 15_552_000, includeSubDomains: false },
    }),
  );
}

/** A page with inline styles and nothing else, such as "this link is unavailable". */
export const STATIC_PAGE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** A page whose only action is posting a form back to itself. */
export const FORM_PAGE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * The short-link interstitial, whose one script carries this response's nonce. A tenant's
 * link fields are written into this page, so anything that escaped the escaping still
 * would not run. Navigating to the app's custom scheme is not something CSP limits.
 */
export const interstitialPolicy = (nonce: string): string =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
