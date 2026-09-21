import { describe, expect, it } from 'vitest';
import { analyzePosts, createJevPresets, resolveCredentials, TwitterClient, validateJevSpec } from '../src/index.js';

describe('library exports', () => {
  it('exposes primary library surface', () => {
    expect(typeof TwitterClient).toBe('function');
    expect(typeof resolveCredentials).toBe('function');
    expect(typeof analyzePosts).toBe('function');
    expect(typeof validateJevSpec).toBe('function');
    expect(typeof createJevPresets).toBe('function');
  });
});
