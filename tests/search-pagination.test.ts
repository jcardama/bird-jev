import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { extractCursorFromInstructions } from '../src/lib/twitter-client-utils.js';
import { validCookies } from './twitter-client-fixtures.js';

function page(ids: string[], cursor?: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        search_by_raw_query: {
          search_timeline: {
            timeline: {
              instructions: [
                {
                  type: 'TimelineAddEntries',
                  entries: ids.map((id) => ({
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            rest_id: id,
                            legacy: { full_text: `post ${id}` },
                            core: { user_results: { result: { legacy: { screen_name: 'reader', name: 'Reader' } } } },
                          },
                        },
                      },
                    },
                  })),
                },
                ...(cursor
                  ? [{ type: 'TimelineReplaceEntry', entry: { content: { cursorType: 'Bottom', value: cursor } } }]
                  : []),
              ],
            },
          },
        },
      },
    }),
  };
}

describe('search cursor recovery', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: TwitterClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new TwitterClient({ cookies: validCookies });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('honors replacement cursors after add entries', () => {
    expect(
      extractCursorFromInstructions([
        { entries: [{ content: { cursorType: 'Bottom', value: 'old' } }] },
        { entry: { content: { cursorType: 'Top', value: 'top' } } },
        { entry: { content: { cursorType: 'Bottom', value: 'new' } } },
      ]),
    ).toBe('new');
    expect(
      extractCursorFromInstructions([{ entry: { content: { cursorType: 'Bottom', value: '' } } }]),
    ).toBeUndefined();
  });

  it('collects 100 distinct posts through five replacement-cursor pages', async () => {
    for (let p = 0; p < 5; p++) {
      fetchMock.mockResolvedValueOnce(
        page(
          Array.from({ length: 20 }, (_, n) => String(p * 20 + n)),
          `c${p}`,
        ),
      );
    }
    const result = await client.search('same query', 100);
    expect(result.success).toBe(true);
    expect(result.tweets).toHaveLength(100);
    expect(new Set(result.tweets?.map((tweet) => tweet.id)).size).toBe(100);
    expect(result.nextCursor).toBe('c4');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const [url] of fetchMock.mock.calls) {
      expect(JSON.parse(new URL(url).searchParams.get('variables') ?? '{}')).toMatchObject({
        rawQuery: 'same query',
        product: 'Latest',
      });
    }
  });

  it.each([false, true])('keeps Top ranking across pages (all=%s)', async (all) => {
    fetchMock.mockResolvedValueOnce(page(['1'], 'next')).mockResolvedValueOnce(page(['2']));
    const result = all
      ? await client.getAllSearchResults('q', { mode: 'Top', cursor: 'start' })
      : await client.search('q', 2, { mode: 'Top', cursor: 'start' });
    expect(result.success).toBe(true);
    expect(result.tweets?.map((tweet) => tweet.id)).toEqual(['1', '2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [i, [url]] of fetchMock.mock.calls.entries()) {
      expect(JSON.parse(new URL(url).searchParams.get('variables') ?? '{}')).toMatchObject({
        rawQuery: 'q',
        product: 'Top',
        cursor: i === 0 ? 'start' : 'next',
      });
    }
  });

  it.each(['popular', 'top', '', null, 1])('rejects invalid modes from JavaScript callers: %s', async (mode) => {
    for (const [method, args] of [
      [client.search, ['q', 1, { mode }]],
      [client.getAllSearchResults, ['q', { mode }]],
    ] as const) {
      await expect(Reflect.apply(method, client, args)).resolves.toEqual({
        success: false,
        error: 'Invalid search mode. Expected "Top" or "Latest".',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('crosses duplicate-only and empty intermediary pages with advancing cursors', async () => {
    fetchMock
      .mockResolvedValueOnce(page(['1'], 'a'))
      .mockResolvedValueOnce(page(['1'], 'b'))
      .mockResolvedValueOnce(page([], 'c'))
      .mockResolvedValueOnce(page(['2']));
    const result = await client.getAllSearchResults('q');
    expect(result.tweets?.map((tweet) => tweet.id)).toEqual(['1', '2']);
    expect(result.nextCursor).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('preserves a resume point when max-pages lands on duplicates', async () => {
    fetchMock.mockResolvedValueOnce(page(['1'], 'a')).mockResolvedValueOnce(page(['1'], 'b'));
    const result = await client.getAllSearchResults('q', { maxPages: 2 });
    expect(result.tweets?.map((tweet) => tweet.id)).toEqual(['1']);
    expect(result.nextCursor).toBe('b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops cursor cycles, including the initial resume cursor', async () => {
    fetchMock.mockResolvedValueOnce(page(['1'], 'b')).mockResolvedValueOnce(page(['2'], 'a'));
    const result = await client.getAllSearchResults('q', { cursor: 'a' });
    expect(result.success).toBe(true);
    expect(result.nextCursor).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds no-progress traversal while retaining the next cursor', async () => {
    for (const cursor of ['a', 'b', 'c']) {
      fetchMock.mockResolvedValueOnce(page([], cursor));
    }
    const result = await client.getAllSearchResults('q');
    expect(result.success).toBe(true);
    expect(result.tweets).toEqual([]);
    expect(result.nextCursor).toBe('c');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects an oversized response rather than silently skipping unseen posts on resume', async () => {
    fetchMock.mockResolvedValueOnce(page(['1', '2', '3'], 'next'));
    const result = await client.search('q', 2, { cursor: 'start' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Use --all with --max-pages');
    expect(result.nextCursor).toBeUndefined();
  });

  it('honors a finite count and starting cursor without consuming an extra page', async () => {
    fetchMock.mockResolvedValueOnce(page(['21', '22'], 'next'));
    const result = await client.search('q', 2, { cursor: 'start' });
    expect(result.tweets?.map((tweet) => tweet.id)).toEqual(['21', '22']);
    expect(result.nextCursor).toBe('next');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const variables = JSON.parse(new URL(fetchMock.mock.calls[0][0]).searchParams.get('variables') ?? '{}');
    expect(variables).toMatchObject({ count: 2, cursor: 'start' });
  });
});
