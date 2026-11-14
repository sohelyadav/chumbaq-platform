import { MAX_LIST_LIMIT, queryLimit } from './query-limit';

describe('queryLimit', () => {
  it.each([
    [undefined, 50],
    ['20', 20],
    ['10000000', MAX_LIST_LIMIT],
    ['0', 50],
    ['-5', 50],
    ['abc', 50],
    ['7.9', 7],
  ])('reads %p as %p', (raw, expected) => {
    expect(queryLimit(raw, 50)).toBe(expected);
  });
});
