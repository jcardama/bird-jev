import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';
import type { TweetData } from '../src/lib/twitter-client-types.js';

const cookies = { authToken: 'test-auth', ct0: 'test-ct0' };
const post: TweetData = { id: '123', text: 'A transit observation', author: { username: 'reader', name: 'Reader' } };

function timeline(names: string[]): Response {
  return Response.json({
    data: {
      timeline: {
        timeline: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: names.map((name, index) => ({
                entryId: `item-${index}`,
                content: { itemContent: { is_ai_trend: true, name } },
              })),
            },
          ],
        },
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('strict news collection', () => {
  it('keeps partial items and stops when a later tab fails', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(timeline(['First']))
      .mockResolvedValueOnce(new Response('secret', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const client = new TwitterClient({ cookies });
    const result = await client.getNews(3, { tabs: ['news', 'sports', 'entertainment'], strictCollection: true });

    expect(result.success).toBe(false);
    expect(result.items?.map((item) => item.headline)).toEqual(['First']);
    expect(result).toMatchObject({ error: 'Failed to fetch news tab: sports' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves default best-effort collection across tab failures', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 500 }))
      .mockResolvedValueOnce(timeline(['Second']));
    vi.stubGlobal('fetch', fetch);
    const result = await new TwitterClient({ cookies }).getNews(1, { tabs: ['news', 'sports'] });

    expect(result.success).toBe(true);
    expect(result.items?.map((item) => item.headline)).toEqual(['Second']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a failed first tab from an empty selected collection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private error body')));
    const result = await new TwitterClient({ cookies }).getNews(1, { strictCollection: true });

    expect(result).toEqual({ success: false, error: 'Failed to fetch news tab: forYou', items: [] });
  });

  it('does not treat a malformed tab response as an empty success', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: {} }))
      .mockResolvedValueOnce(timeline(['Later']));
    vi.stubGlobal('fetch', fetch);
    const result = await new TwitterClient({ cookies }).getNews(1, {
      tabs: ['news', 'sports'],
      strictCollection: true,
    });

    expect(result).toEqual({ success: false, error: 'Failed to fetch news tab: news', items: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains partial related posts but stops on a failed related-post search', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(timeline(['First', 'Second'])));
    const client = new TwitterClient({ cookies });
    const search = vi
      .spyOn(client, 'search')
      .mockResolvedValue({ success: false, error: 'secret response', tweets: [post] });
    const result = await client.getNews(2, { withTweets: true, strictCollection: true });

    expect(result.success).toBe(false);
    expect(result.items?.[0].tweets).toEqual([post]);
    expect(result.items?.[1].tweets).toBeUndefined();
    expect(result).toMatchObject({ error: 'Failed to fetch related posts for a news item' });
    expect(JSON.stringify(result)).not.toContain('secret response');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('reports a thrown related-post failure without its exception text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(timeline(['First'])));
    const client = new TwitterClient({ cookies });
    vi.spyOn(client, 'search').mockRejectedValue(new Error('sensitive exception'));
    const result = await client.getNews(1, { withTweets: true, strictCollection: true });

    expect(result.success).toBe(false);
    expect(result.items?.[0].headline).toBe('First');
    expect(JSON.stringify(result)).not.toContain('sensitive exception');
  });

  it('does not reinterpret a successful empty related-post search as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(timeline(['First'])));
    const client = new TwitterClient({ cookies });
    vi.spyOn(client, 'search').mockResolvedValue({ success: true, tweets: [] });
    const result = await client.getNews(1, { withTweets: true, strictCollection: true });

    expect(result.success).toBe(true);
    expect(result.items?.[0].tweets).toEqual([]);
  });

  it('preserves default best-effort behavior on related-post failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(timeline(['First'])));
    const client = new TwitterClient({ cookies });
    vi.spyOn(client, 'search').mockResolvedValue({ success: false, error: 'unavailable', tweets: [post] });
    const result = await client.getNews(1, { withTweets: true });

    expect(result.success).toBe(true);
    expect(result.items?.[0].tweets).toBeUndefined();
  });
});
