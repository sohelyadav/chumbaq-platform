import { createHash, createHmac } from 'crypto';

/**
 * AWS Signature Version 4, for the handful of SES calls Chumbaq makes.
 *
 * Written out rather than pulled in with the AWS SDK: two endpoints do not
 * justify a dependency tree that size in a self-hosted product, and the
 * algorithm is fixed and published. It is pinned against AWS's own test
 * vector in `sigv4.spec.ts`.
 */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  host: string;
  path: string;
  /** Already-encoded query string without the `?`, or empty. */
  query?: string;
  body?: string;
  headers?: Record<string, string>;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) =>
  createHmac('sha256', key).update(value, 'utf8').digest();

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Returns the headers to send, `Authorization` included. */
export function signRequest(
  request: SignableRequest,
  credentials: AwsCredentials,
  region: string,
  service: string,
  now: Date = new Date(),
): Record<string, string> {
  const { amzDate, dateStamp } = amzDates(now);
  const body = request.body ?? '';

  const headers: Record<string, string> = {
    ...(request.headers ?? {}),
    host: request.host,
    'x-amz-date': amzDate,
  };
  if (credentials.sessionToken) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value.trim().replace(/\s+/g, ' '),
    ]),
  );
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    request.method.toUpperCase(),
    request.path,
    request.query ?? '',
    canonicalHeaders,
    signedHeaders,
    sha256(body),
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
