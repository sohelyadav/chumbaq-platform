import { signRequest } from './sigv4';

describe('signRequest', () => {
  // AWS's published SigV4 test suite, case "get-vanilla". If this drifts,
  // every SES call is rejected with a signature mismatch.
  it('matches the AWS get-vanilla test vector', () => {
    const headers = signRequest(
      { method: 'GET', host: 'example.amazonaws.com', path: '/' },
      {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      },
      'us-east-1',
      'service',
      new Date('2015-08-30T12:36:00Z'),
    );

    expect(headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('signs a session token when one is given', () => {
    const headers = signRequest(
      { method: 'GET', host: 'example.amazonaws.com', path: '/' },
      { accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'T' },
      'us-east-1',
      'service',
    );
    expect(headers['x-amz-security-token']).toBe('T');
    expect(headers.Authorization).toContain('x-amz-security-token');
  });
});
