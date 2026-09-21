import { describe, expect, it } from 'vitest';
import { looksLikeTweetInput, resolveCliInvocation } from '../src/lib/cli-args.js';

describe('cli-args', () => {
  const known = new Set([
    'tweet',
    'reply',
    'query-ids',
    'read',
    'replies',
    'thread',
    'search',
    'mentions',
    'bookmarks',
    'following',
    'followers',
    'likes',
    'help',
    'whoami',
    'check',
  ]);

  it('detects tweet URLs', () => {
    expect(looksLikeTweetInput('https://x.com/user/status/1234567890')).toBe(true);
    expect(looksLikeTweetInput('http://twitter.com/user/status/1234567890')).toBe(true);
    expect(looksLikeTweetInput('x.com/user/status/1234567890')).toBe(true);
  });

  it('detects numeric tweet ids', () => {
    expect(looksLikeTweetInput('1234567890')).toBe(true);
    expect(looksLikeTweetInput('123')).toBe(false);
  });

  it('returns help for empty args', () => {
    const result = resolveCliInvocation([], known);
    expect(result.showHelp).toBe(true);
    expect(result.argv).toBeNull();
  });

  it('rewrites bare tweet url to read command', () => {
    const result = resolveCliInvocation(['https://x.com/user/status/1234567890'], known);
    expect(result.showHelp).toBe(false);
    expect(result.argv).toEqual(['node', 'bird', 'read', 'https://x.com/user/status/1234567890']);
  });

  it('rewrites bare tweet id to read command', () => {
    const result = resolveCliInvocation(['1234567890123456789'], known);
    expect(result.argv).toEqual(['node', 'bird', 'read', '1234567890123456789']);
  });

  it('preserves leading options before inferred read command', () => {
    const result = resolveCliInvocation(['--plain', 'https://x.com/user/status/1234567890'], known);
    expect(result.argv).toEqual(['node', 'bird', '--plain', 'read', 'https://x.com/user/status/1234567890']);
  });

  it.each(['search', 'likes', 'read'])('keeps command-like JEV subjects as option values (%s)', (subject) => {
    const args = ['1234567890123456789', '--jev', '--sentiment', subject];
    expect(resolveCliInvocation(args, known).argv).toEqual(['node', 'bird', 'read', ...args]);
  });

  it('skips declared option values before resolving the first operand', () => {
    const args = ['--chrome-profile', 'search', '--jev', '--sentiment', 'likes', '1234567890123456789'];
    const valueOptions = new Set(['--chrome-profile', '--sentiment']);
    expect(resolveCliInvocation(args, known, valueOptions).argv).toEqual([
      'node',
      'bird',
      '--chrome-profile',
      'search',
      '--jev',
      '--sentiment',
      'likes',
      'read',
      '1234567890123456789',
    ]);
    expect(
      resolveCliInvocation(['--auth-token', '1234567890123456789'], known, new Set(['--auth-token'])).argv,
    ).toBeNull();
  });

  it('handles an option terminator without inspecting later option-like operands', () => {
    expect(resolveCliInvocation(['--plain', '--', '1234567890123456789'], known).argv).toEqual([
      'node',
      'bird',
      '--plain',
      'read',
      '--',
      '1234567890123456789',
    ]);
  });

  it('does not infer a read from a later operand of another command', () => {
    expect(resolveCliInvocation(['search', '1234567890123456789', '--sentiment', 'likes'], known).argv).toBeNull();
    expect(resolveCliInvocation(['unknown', '1234567890123456789'], known).argv).toBeNull();
  });

  it('does not rewrite when a known command is provided', () => {
    const result = resolveCliInvocation(['read', 'https://x.com/user/status/1234567890'], known);
    expect(result.argv).toBeNull();
  });

  it('does not rewrite unknown commands', () => {
    const result = resolveCliInvocation(['https://example.com'], known);
    expect(result.argv).toBeNull();
    expect(result.showHelp).toBe(false);
  });
});
