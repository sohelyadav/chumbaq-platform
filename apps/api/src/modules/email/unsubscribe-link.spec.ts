import { UnsubscribeLinks } from './unsubscribe-link';

describe('UnsubscribeLinks', () => {
  const links = new UnsubscribeLinks(Buffer.alloc(32, 7), 'https://api.example/');
  const PROJECT = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';

  const parts = (url: string) => {
    const params = new URL(url).searchParams;
    return { p: params.get('p'), e: params.get('e'), s: params.get('s') };
  };

  it('round-trips the address it was signed for', () => {
    const { p, e, s } = parts(links.url(PROJECT, 'priya@example.com'));
    expect(links.verify(p, e, s)).toBe('priya@example.com');
  });

  it('points at the API, without a doubled slash', () => {
    expect(links.url(PROJECT, 'a@b.co')).toMatch(/^https:\/\/api\.example\/api\/email\/unsubscribe\?/);
  });

  it('refuses a link edited to unsubscribe someone else', () => {
    const { p, s } = parts(links.url(PROJECT, 'priya@example.com'));
    const other = Buffer.from('victim@example.com').toString('base64url');
    expect(links.verify(p, other, s)).toBeNull();
  });

  it('refuses a link moved to another project', () => {
    const { e, s } = parts(links.url(PROJECT, 'priya@example.com'));
    expect(links.verify('11111111-2222-4333-8444-555555555555', e, s)).toBeNull();
  });

  it('refuses a link signed with a different key', () => {
    const forged = new UnsubscribeLinks(Buffer.alloc(32, 8), 'https://api.example');
    const { p, e, s } = parts(forged.url(PROJECT, 'priya@example.com'));
    expect(links.verify(p, e, s)).toBeNull();
  });

  it('refuses missing parts', () => {
    expect(links.verify(undefined, undefined, undefined)).toBeNull();
  });
});
