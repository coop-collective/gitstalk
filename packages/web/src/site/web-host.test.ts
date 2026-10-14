import { describe, expect, it } from 'vitest';

import { webHost } from './web-host';

describe('webHost', () => {
  it('is the host of the deployment origin', () => {
    expect(webHost('https://gitstalk.dev')).toBe('gitstalk.dev');
    expect(webHost('https://gitstalk.io/')).toBe('gitstalk.io');
    expect(webHost('http://localhost:5173')).toBe('localhost:5173');
  });

  it('falls back to the product name when the origin is missing or invalid', () => {
    expect(webHost(undefined)).toBe('gitstalk');
    expect(webHost('not a url')).toBe('gitstalk');
  });
});
