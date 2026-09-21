import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../src/cli/shared.js';
import { registerBookmarksCommand } from '../src/commands/bookmarks.js';
import { registerHomeCommand } from '../src/commands/home.js';
import { registerListsCommand } from '../src/commands/lists.js';
import { registerNewsCommand } from '../src/commands/news.js';
import { registerReadCommands } from '../src/commands/read.js';
import { registerSearchCommands } from '../src/commands/search.js';
import { registerUserTweetsCommand } from '../src/commands/user-tweets.js';
import { registerUserCommands } from '../src/commands/users.js';
import { analyzePosts as realAnalyzePosts } from '../src/lib/jev.js';
import { JEV_BASE_URL, JEV_MODEL } from '../src/lib/jev-spec.js';
import type { AnalyzePosts, JevOutcome, JevReport, JevSpec } from '../src/lib/jev-types.js';
import { TwitterClient } from '../src/lib/twitter-client.js';
import type { NewsItem } from '../src/lib/twitter-client-news.js';
import type { TweetData } from '../src/lib/twitter-client-types.js';

const FAKE_KEY = 'ts_test_fake_key';

const identity = (text: string): string => text;

function makeTweet(id: string, extra: Partial<TweetData> = {}): TweetData {
  return {
    id,
    text: `text-${id}`,
    author: { username: 'alice', name: 'Alice' },
    createdAt: '2020-01-01T00:00:00Z',
    ...extra,
  };
}

function fakeAnalyzePosts(): AnalyzePosts {
  return vi.fn(async (posts, spec: JevSpec, options) => {
    const status = options.collection?.status ?? 'ok';
    const postIds = [...new Set(posts.map((post) => post.id))];
    const source = options.collection?.source ?? 'unknown';
    const skippedReason = status === 'failed' ? 'collection_failed' : 'empty_selection';
    const report: JevReport = {
      schemaVersion: 1,
      requestedModel: 'jev-1.13.0',
      tasks: spec.tasks,
      selection: {
        source,
        status,
        occurrenceCount: posts.length,
        postCount: postIds.length,
        postIds,
        coverage: 'selected_posts_only',
        ...(options.collection?.nextCursor !== undefined ? { nextCursor: options.collection.nextCursor } : {}),
      },
      posts:
        status === 'ok' && postIds.length > 0
          ? postIds.map((postId) => ({
              postId,
              results: Object.fromEntries(
                spec.tasks
                  .filter((task) => task.scope === 'post')
                  .map((task) => [
                    task.id,
                    {
                      status: 'ok',
                      requestId: 'r1',
                      type: 'category',
                      value: 'relevant',
                      probabilities: { relevant: 0.9, irrelevant: 0.05, unclear: 0.05 },
                      confidence: 0.9,
                    },
                  ]),
              ),
            }))
          : postIds.map((postId) => ({
              postId,
              results: Object.fromEntries(
                spec.tasks
                  .filter((task) => task.scope === 'post')
                  .map((task) => [task.id, { status: 'skipped' as const, reason: skippedReason }]),
              ),
            })),
      collection: Object.fromEntries(
        spec.tasks
          .filter((task) => task.scope === 'collection')
          .map((task) => [
            task.id,
            status === 'ok' && postIds.length > 0
              ? {
                  status: 'ok' as const,
                  requestId: 'r0',
                  type: 'score' as const,
                  value: 2,
                  probabilities: { '0': 0.1, '1': 0.2, '2': 0.4, '3': 0.3 },
                  confidence: 0.4,
                }
              : { status: 'skipped' as const, reason: skippedReason },
          ]),
      ),
      requests: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        complete: status === 'ok',
      },
      ...(status === 'failed'
        ? { error: { code: 'collection_failed' as const, message: 'Collection failed; analysis was not attempted.' } }
        : {}),
    };
    return report;
  });
}

function createJevContext(analyzePosts: AnalyzePosts = fakeAnalyzePosts()) {
  const printTweets = vi.fn((tweets: TweetData[], opts?: { json?: boolean; emptyMessage?: string }) => {
    if (opts?.json) {
      console.log(JSON.stringify(tweets, null, 2));
      return;
    }
    if (tweets.length === 0) {
      console.log(opts?.emptyMessage ?? 'No tweets found.');
      return;
    }
    for (const tweet of tweets) {
      console.log(`${tweet.id}:${tweet.text}`);
    }
  });
  const printTweetsResult = vi.fn(
    (
      result: { tweets?: TweetData[]; nextCursor?: string },
      opts: { json: boolean; usePagination: boolean; emptyMessage: string },
    ) => {
      const tweets = result.tweets ?? [];
      if (opts.json && opts.usePagination) {
        console.log(JSON.stringify({ tweets, nextCursor: result.nextCursor ?? null }, null, 2));
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(tweets, null, 2));
        return;
      }
      if (tweets.length === 0) {
        console.log(opts.emptyMessage);
        return;
      }
      for (const tweet of tweets) {
        console.log(`${tweet.id}:${tweet.text}`);
      }
    },
  );

  const ctx = {
    resolveTimeoutFromOptions: () => undefined,
    resolveQuoteDepthFromOptions: () => 1,
    extractTweetId: (input: string) => input,
    resolveCredentialsFromOptions: vi.fn(async () => ({
      cookies: { authToken: 'auth', ct0: 'ct0', cookieHeader: 'auth=auth; ct0=ct0' },
      warnings: [],
    })),
    p: (kind: string) => `[${kind}] `,
    l: (kind: string) => `${kind}: `,
    colors: {
      banner: identity,
      subtitle: identity,
      section: identity,
      bullet: identity,
      command: identity,
      option: identity,
      argument: identity,
      description: identity,
      muted: identity,
      accent: identity,
    },
    getOutput: () => ({ plain: true, emoji: false, color: false, hyperlinks: false }),
    printTweets,
    printTweetsResult,
    analyzePosts,
  } as unknown as CliContext;

  return { ctx, analyzePosts, printTweets, printTweetsResult };
}

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
}

function firstJson(logSpy: ReturnType<typeof vi.spyOn>): unknown {
  const first = logSpy.mock.calls[0]?.[0];
  return JSON.parse(String(first));
}

function parseJevBody(init?: RequestInit): { questions: Record<string, unknown> } {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error('expected string request body');
  }
  return JSON.parse(body) as { questions: Record<string, unknown> };
}

function mockJevFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url !== `${JEV_BASE_URL}/v1/systemone`) {
      throw new Error(`unexpected fetch ${url}`);
    }
    const body = parseJevBody(init);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions ?? {})) {
      answers[id] = {
        type: 'choice',
        choice: 'relevant',
        probabilities: { relevant: 0.8, irrelevant: 0.1, unclear: 0.1 },
        confidence: 0.8,
      };
    }
    return new Response(
      JSON.stringify({
        model: JEV_MODEL,
        answers,
        usage: { input_tokens: 11, output_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { fetch: fetchImpl, calls };
}

function expectCategory(outcome: JevOutcome | undefined): void {
  expect(outcome).toMatchObject({
    status: 'ok',
    type: 'category',
    value: 'relevant',
  });
}

type RealEngineCase = {
  name: string;
  source: string;
  expected: unknown;
  register: (program: Command, ctx: CliContext) => void;
  argv: string[];
  mock: () => void;
};

const REAL_ENGINE_ARGV_TAIL = ['--jev', '--relevance', 'transit', '--jev-scope', 'both', '--json'] as const;

const REAL_ENGINE_CASES: RealEngineCase[] = [
  {
    name: 'read',
    source: 'read',
    expected: makeTweet('1'),
    register: registerReadCommands,
    argv: ['node', 'bird', 'read', '1', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'getTweet').mockResolvedValue({ success: true, tweet: makeTweet('1') });
    },
  },
  {
    name: 'replies',
    source: 'replies',
    expected: [makeTweet('1')],
    register: registerReadCommands,
    argv: ['node', 'bird', 'replies', '1', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'getReplies').mockResolvedValue({ success: true, tweets: [makeTweet('1')] });
    },
  },
  {
    name: 'thread',
    source: 'thread',
    expected: [makeTweet('1')],
    register: registerReadCommands,
    argv: ['node', 'bird', 'thread', '1', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'getThread').mockResolvedValue({ success: true, tweets: [makeTweet('1')] });
    },
  },
  {
    name: 'search',
    source: 'search',
    expected: [makeTweet('1')],
    register: registerSearchCommands,
    argv: ['node', 'bird', 'search', 'cats', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'search').mockResolvedValue({ success: true, tweets: [makeTweet('1')] });
    },
  },
  {
    name: 'mentions',
    source: 'mentions',
    expected: [makeTweet('1')],
    register: registerSearchCommands,
    argv: ['node', 'bird', 'mentions', '--user', 'alice', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'search').mockResolvedValue({ success: true, tweets: [makeTweet('1')] });
    },
  },
  {
    name: 'home',
    source: 'home',
    expected: [makeTweet('1')],
    register: registerHomeCommand,
    argv: ['node', 'bird', 'home', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'getHomeTimeline').mockResolvedValue({
        success: true,
        tweets: [makeTweet('1')],
      });
    },
  },
  {
    name: 'user-tweets',
    source: 'user-tweets',
    expected: [makeTweet('1')],
    register: registerUserTweetsCommand,
    argv: ['node', 'bird', 'user-tweets', 'alice', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'getUserIdByUsername').mockResolvedValue({
        success: true,
        userId: '42',
        username: 'alice',
        name: 'Alice',
      });
      vi.spyOn(TwitterClient.prototype, 'getUserTweetsPaged').mockResolvedValue({
        success: true,
        tweets: [makeTweet('1')],
      });
    },
  },
  {
    name: 'likes',
    source: 'likes',
    expected: [makeTweet('1')],
    register: registerUserCommands,
    argv: ['node', 'bird', 'likes', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'getLikes').mockResolvedValue({ success: true, tweets: [makeTweet('1')] });
    },
  },
  {
    name: 'list-timeline',
    source: 'list-timeline',
    expected: [makeTweet('1')],
    register: registerListsCommand,
    argv: ['node', 'bird', 'list-timeline', '12345', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'getListTimeline').mockResolvedValue({
        success: true,
        tweets: [makeTweet('1')],
      });
    },
  },
  {
    name: 'bookmarks',
    source: 'bookmarks',
    expected: [makeTweet('1')],
    register: registerBookmarksCommand,
    argv: ['node', 'bird', 'bookmarks', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'getBookmarks').mockResolvedValue({
        success: true,
        tweets: [makeTweet('1')],
      });
    },
  },
  {
    name: 'news',
    source: 'news',
    expected: [{ id: 'n1', headline: 'One', tweets: [makeTweet('1')] }],
    register: registerNewsCommand,
    argv: ['node', 'bird', 'news', '--with-tweets', ...REAL_ENGINE_ARGV_TAIL],
    mock: () => {
      vi.spyOn(TwitterClient.prototype, 'getNews').mockResolvedValue({
        success: true,
        items: [{ id: 'n1', headline: 'One', tweets: [makeTweet('1')] }],
      });
    },
  },
];

describe('command JEV adapters', () => {
  beforeEach(() => {
    vi.stubEnv('TYPESAFE_API_KEY', FAKE_KEY);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps ordinary JSON shapes when --jev is absent', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerReadCommands(program, ctx);
    registerSearchCommands(program, ctx);
    vi.spyOn(TwitterClient.prototype, 'getTweet').mockResolvedValue({ success: true, tweet: makeTweet('1') });
    vi.spyOn(TwitterClient.prototype, 'search').mockResolvedValue({ success: true, tweets: [makeTweet('2')] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockExit();

    await program.parseAsync(['node', 'bird', 'read', '1', '--json']);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(makeTweet('1'));
    logSpy.mockClear();

    await program.parseAsync(['node', 'bird', 'search', 'cats', '--json']);
    expect(ctx.printTweetsResult).toHaveBeenCalledWith(
      expect.objectContaining({ tweets: [makeTweet('2')] }),
      expect.objectContaining({ json: true, usePagination: false }),
    );
    expect(analyzePosts).not.toHaveBeenCalled();
  });

  it('wraps a bare read object and forwards _raw locally', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerReadCommands(program, ctx);
    const tweet = makeTweet('1', { _raw: { rest_id: '1' } });
    vi.spyOn(TwitterClient.prototype, 'getTweet').mockResolvedValue({ success: true, tweet });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockExit();

    await program.parseAsync(['node', 'bird', 'read', '1', '--jev', '--relevance', 'transit', '--json-full']);
    expect(analyzePosts).toHaveBeenCalledTimes(1);
    expect(analyzePosts).toHaveBeenCalledWith(
      [tweet],
      expect.anything(),
      expect.objectContaining({
        apiKey: FAKE_KEY,
        maxPosts: 100,
        collection: { source: 'read', status: 'ok' },
      }),
    );
    expect((analyzePosts as ReturnType<typeof vi.fn>).mock.calls[0]?.[0][0]._raw).toEqual({ rest_id: '1' });
    const payload = firstJson(logSpy) as { data: TweetData; jev: JevReport };
    expect(payload.data.id).toBe('1');
    expect(payload.data._raw).toEqual({ rest_id: '1' });
    expect(payload.jev.selection.source).toBe('read');
    expect(Array.isArray(payload)).toBe(false);
  });

  it('sends replies including a failed collection with partial tweets', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerReadCommands(program, ctx);
    const tweets = [makeTweet('2'), makeTweet('3')];
    vi.spyOn(TwitterClient.prototype, 'getReplies').mockResolvedValue({
      success: false,
      tweets,
      nextCursor: 'MORE',
      error: 'timeout',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = mockExit();

    await program.parseAsync(['node', 'bird', 'replies', '1', '--jev', '--relevance', 'transit', '--json']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(analyzePosts).toHaveBeenCalledWith(
      tweets,
      expect.anything(),
      expect.objectContaining({ collection: { source: 'replies', status: 'failed', nextCursor: 'MORE' } }),
    );
    const payload = firstJson(logSpy) as { data: TweetData[]; jev: JevReport };
    expect(payload.data).toEqual(tweets);
    expect(payload.jev.error?.code).toBe('collection_failed');
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('Failed to fetch replies');
  });

  it('analyzes the final filtered thread posts, not the full conversation', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerReadCommands(program, ctx);
    const root = makeTweet('1', { conversationId: '1', author: { username: 'alice', name: 'Alice' } });
    const authorReply = makeTweet('2', {
      conversationId: '1',
      inReplyToStatusId: '1',
      author: { username: 'alice', name: 'Alice' },
    });
    const other = makeTweet('3', {
      conversationId: '1',
      inReplyToStatusId: '1',
      author: { username: 'bob', name: 'Bob' },
    });
    vi.spyOn(TwitterClient.prototype, 'getThread').mockResolvedValue({
      success: true,
      tweets: [root, authorReply, other],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockExit();

    await program.parseAsync([
      'node',
      'bird',
      'thread',
      '1',
      '--author-chain',
      '--jev',
      '--relevance',
      'transit',
      '--json',
    ]);
    const selected = (analyzePosts as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as TweetData[];
    expect(selected.map((tweet) => tweet.id)).toEqual(['1', '2']);
    expect(selected.map((tweet) => tweet.id)).not.toContain('3');
    const payload = firstJson(logSpy) as { data: TweetData[]; jev: JevReport };
    expect(payload.data.map((tweet) => tweet.id)).toEqual(['1', '2']);
    expect(payload.jev.selection.source).toBe('thread');
  });

  it('wraps search pagination JSON and empty selections', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerSearchCommands(program, ctx);
    vi.spyOn(TwitterClient.prototype, 'getAllSearchResults').mockResolvedValue({
      success: true,
      tweets: [],
      nextCursor: undefined,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = mockExit();

    await program.parseAsync(['node', 'bird', 'search', 'cats', '--all', '--jev', '--relevance', 'transit', '--json']);
    expect(analyzePosts).toHaveBeenCalledWith(
      [],
      expect.anything(),
      expect.objectContaining({ collection: { source: 'search', status: 'ok' } }),
    );
    const payload = firstJson(logSpy) as { data: { tweets: TweetData[]; nextCursor: string | null }; jev: JevReport };
    expect(payload.data).toEqual({ tweets: [], nextCursor: null });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('wraps mentions, home, user-tweets, likes, and list-timeline', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerSearchCommands(program, ctx);
    registerHomeCommand(program, ctx);
    registerUserTweetsCommand(program, ctx);
    registerUserCommands(program, ctx);
    registerListsCommand(program, ctx);
    vi.spyOn(TwitterClient.prototype, 'search').mockResolvedValue({ success: true, tweets: [makeTweet('m1')] });
    vi.spyOn(TwitterClient.prototype, 'getHomeTimeline').mockResolvedValue({
      success: true,
      tweets: [makeTweet('h1')],
    });
    vi.spyOn(TwitterClient.prototype, 'getUserIdByUsername').mockResolvedValue({
      success: true,
      userId: '42',
      username: 'alice',
      name: 'Alice',
    });
    vi.spyOn(TwitterClient.prototype, 'getUserTweetsPaged').mockResolvedValue({
      success: true,
      tweets: [makeTweet('u1')],
      nextCursor: 'NEXT',
    });
    vi.spyOn(TwitterClient.prototype, 'getLikes').mockResolvedValue({ success: true, tweets: [makeTweet('l1')] });
    vi.spyOn(TwitterClient.prototype, 'getListTimeline').mockResolvedValue({
      success: true,
      tweets: [makeTweet('lt1')],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockExit();

    await program.parseAsync([
      'node',
      'bird',
      'mentions',
      '--user',
      'alice',
      '--jev',
      '--relevance',
      'transit',
      '--json',
    ]);
    expect((firstJson(logSpy) as { data: TweetData[] }).data[0]?.id).toBe('m1');
    logSpy.mockClear();

    await program.parseAsync(['node', 'bird', 'home', '--jev', '--relevance', 'transit', '--json']);
    expect((firstJson(logSpy) as { data: TweetData[] }).data[0]?.id).toBe('h1');
    logSpy.mockClear();

    await program.parseAsync([
      'node',
      'bird',
      'user-tweets',
      'alice',
      '--cursor',
      'START',
      '--jev',
      '--relevance',
      'transit',
      '--json',
    ]);
    expect(analyzePosts).toHaveBeenCalledWith(
      [makeTweet('u1')],
      expect.anything(),
      expect.objectContaining({
        collection: { source: 'user-tweets', status: 'ok', nextCursor: 'NEXT' },
      }),
    );
    expect((firstJson(logSpy) as { data: { tweets: TweetData[]; nextCursor: string } }).data.nextCursor).toBe('NEXT');
    logSpy.mockClear();

    await program.parseAsync(['node', 'bird', 'likes', '--jev', '--relevance', 'transit', '--json']);
    expect((firstJson(logSpy) as { data: TweetData[] }).data[0]?.id).toBe('l1');
    logSpy.mockClear();

    await program.parseAsync(['node', 'bird', 'list-timeline', '12345', '--jev', '--relevance', 'transit', '--json']);
    expect((firstJson(logSpy) as { data: TweetData[] }).data[0]?.id).toBe('lt1');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('expands bookmark folders and empty bookmark collections', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerBookmarksCommand(program, ctx);
    const folderSpy = vi.spyOn(TwitterClient.prototype, 'getBookmarkFolderTimeline').mockResolvedValue({
      success: true,
      tweets: [makeTweet('b1')],
    });
    const bookmarksSpy = vi.spyOn(TwitterClient.prototype, 'getBookmarks').mockResolvedValue({
      success: true,
      tweets: [],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = mockExit();

    await program.parseAsync([
      'node',
      'bird',
      'bookmarks',
      '--folder-id',
      '1976792203235119344',
      '--jev',
      '--relevance',
      'transit',
      '--json',
    ]);
    expect(folderSpy).toHaveBeenCalled();
    expect(analyzePosts).toHaveBeenCalledWith(
      [makeTweet('b1')],
      expect.anything(),
      expect.objectContaining({ collection: { source: 'bookmarks', status: 'ok' } }),
    );
    expect((firstJson(logSpy) as { data: TweetData[] }).data[0]?.id).toBe('b1');

    logSpy.mockClear();
    (analyzePosts as ReturnType<typeof vi.fn>).mockClear();
    await program.parseAsync(['node', 'bird', 'bookmarks', '--jev', '--relevance', 'transit', '--json']);
    expect(bookmarksSpy).toHaveBeenCalled();
    expect(analyzePosts).toHaveBeenCalledWith(
      [],
      expect.anything(),
      expect.objectContaining({ collection: { source: 'bookmarks', status: 'ok' } }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('marks failed bookmark parent expansion as collection failed and still prints tweets', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerBookmarksCommand(program, ctx);
    const bookmark = makeTweet('10', { inReplyToStatusId: '9' });
    vi.spyOn(TwitterClient.prototype, 'getBookmarks').mockResolvedValue({ success: true, tweets: [bookmark] });
    vi.spyOn(TwitterClient.prototype, 'getTweet').mockResolvedValue({ success: false, error: 'missing parent' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = mockExit();

    await program.parseAsync([
      'node',
      'bird',
      'bookmarks',
      '--include-parent',
      '--jev',
      '--relevance',
      'transit',
      '--json',
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(analyzePosts).toHaveBeenCalledWith(
      [bookmark],
      expect.anything(),
      expect.objectContaining({ collection: { source: 'bookmarks', status: 'failed' } }),
    );
    const payload = firstJson(logSpy) as { data: TweetData[]; jev: JevReport };
    expect(payload.data[0]?.id).toBe('10');
    expect(payload.jev.error?.code).toBe('collection_failed');
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('Failed to fetch parent tweet');
  });

  it('keeps non-JEV bookmark parent fallback silent and prints original tweets', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerBookmarksCommand(program, ctx);
    const bookmark = makeTweet('10', { inReplyToStatusId: '9' });
    vi.spyOn(TwitterClient.prototype, 'getBookmarks').mockResolvedValue({ success: true, tweets: [bookmark] });
    vi.spyOn(TwitterClient.prototype, 'getTweet').mockResolvedValue({ success: false, error: 'missing parent' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = mockExit();

    await program.parseAsync(['node', 'bird', 'bookmarks', '--include-parent', '--json']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    expect(analyzePosts).not.toHaveBeenCalled();
    expect(ctx.printTweetsResult).toHaveBeenCalledWith(
      { tweets: [bookmark], nextCursor: undefined },
      expect.objectContaining({ json: true, usePagination: false }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual([bookmark]);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('Failed to fetch parent tweet');
  });

  it('requires --with-tweets for news JEV before credentials, including the trending alias', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerNewsCommand(program, ctx);
    mockExit();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(program.parseAsync(['node', 'bird', 'news', '--jev', '--relevance', 'transit'])).rejects.toThrow(
      'exit 2',
    );
    await expect(program.parseAsync(['node', 'bird', 'trending', '--jev', '--relevance', 'transit'])).rejects.toThrow(
      'exit 2',
    );
    expect(ctx.resolveCredentialsFromOptions).not.toHaveBeenCalled();
    expect(analyzePosts).not.toHaveBeenCalled();
  });

  it('flattens news tweets into one collection and preserves items', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerNewsCommand(program, ctx);
    const items: NewsItem[] = [
      { id: 'n1', headline: 'One', tweets: [makeTweet('t1'), makeTweet('t2')] },
      { id: 'n2', headline: 'Two', tweets: [makeTweet('t3')] },
    ];
    const newsSpy = vi.spyOn(TwitterClient.prototype, 'getNews').mockResolvedValue({ success: true, items });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockExit();

    await program.parseAsync(['node', 'bird', 'news', '--with-tweets', '--jev', '--relevance', 'transit', '--json']);
    expect(newsSpy).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ withTweets: true, strictCollection: true }),
    );
    const selected = (analyzePosts as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as TweetData[];
    expect(selected.map((tweet) => tweet.id)).toEqual(['t1', 't2', 't3']);
    const payload = firstJson(logSpy) as { data: NewsItem[]; jev: JevReport };
    expect(payload.data).toEqual(items);
    expect(payload.jev.selection.source).toBe('news');
  });

  it('passes news strict collection failures to the engine without dropping items', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerNewsCommand(program, ctx);
    const items: NewsItem[] = [{ id: 'n1', headline: 'Partial', tweets: [makeTweet('t1')] }];
    vi.spyOn(TwitterClient.prototype, 'getNews').mockResolvedValue({
      success: false,
      error: 'Failed to fetch news tab: news',
      items,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = mockExit();

    await program.parseAsync(['node', 'bird', 'news', '--with-tweets', '--jev', '--relevance', 'transit', '--json']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(analyzePosts).toHaveBeenCalledWith(
      [makeTweet('t1')],
      expect.anything(),
      expect.objectContaining({ collection: { source: 'news', status: 'failed' } }),
    );
    const payload = firstJson(logSpy) as { data: NewsItem[] };
    expect(payload.data).toEqual(items);
  });

  it('does not pass strictCollection outside JEV news', async () => {
    const { ctx, analyzePosts } = createJevContext();
    const program = new Command();
    registerNewsCommand(program, ctx);
    const newsSpy = vi.spyOn(TwitterClient.prototype, 'getNews').mockResolvedValue({ success: true, items: [] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockExit();

    await program.parseAsync(['node', 'bird', 'news', '--with-tweets']);
    expect(newsSpy.mock.calls[0]?.[1]?.strictCollection).not.toBe(true);
    expect(analyzePosts).not.toHaveBeenCalled();
  });

  it('renders both post and collection scopes in terminal output', async () => {
    const { ctx } = createJevContext();
    const program = new Command();
    registerSearchCommands(program, ctx);
    vi.spyOn(TwitterClient.prototype, 'search').mockResolvedValue({ success: true, tweets: [makeTweet('1')] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockExit();

    await program.parseAsync([
      'node',
      'bird',
      'search',
      'cats',
      '--jev',
      '--relevance',
      'transit',
      '--jev-scope',
      'both',
    ]);
    const text = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(text).toContain('Analysis');
    expect(text).toContain('collection');
    expect(text).toContain('relevance_collection');
    expect(text).toContain('relevance_post');
  });
});

describe('command JEV real engine', () => {
  beforeEach(() => {
    vi.stubEnv('TYPESAFE_API_KEY', FAKE_KEY);
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('global fetch should not be called');
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(REAL_ENGINE_CASES)('$name uses analyzePosts with mocked fetch for both scopes', async (testCase) => {
    const { fetch, calls } = mockJevFetch();
    const analyzePosts: AnalyzePosts = (posts, spec, options) => realAnalyzePosts(posts, spec, { ...options, fetch });
    const { ctx } = createJevContext(analyzePosts);
    const program = new Command();
    testCase.register(program, ctx);
    testCase.mock();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = mockExit();

    await program.parseAsync(testCase.argv);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual([`${JEV_BASE_URL}/v1/systemone`, `${JEV_BASE_URL}/v1/systemone`]);
    expect(calls.every((call) => call.init?.redirect === 'error')).toBe(true);

    const payload = firstJson(logSpy) as { data: unknown; jev: JevReport };
    expect(Object.keys(payload)).toEqual(['data', 'jev']);
    expect(payload.data).toEqual(testCase.expected);
    expect(payload.jev.requestedModel).toBe(JEV_MODEL);
    expect(payload.jev.error).toBeUndefined();
    expect(payload.jev.selection.source).toBe(testCase.source);
    expect(payload.jev.selection.status).toBe('ok');
    expect(payload.jev.requests.map((receipt) => receipt.id)).toEqual(['collection', 'post:1']);
    expect(payload.jev.requests.every((receipt) => receipt.status === 'ok')).toBe(true);
    expect(payload.jev.requests.every((receipt) => receipt.model === JEV_MODEL)).toBe(true);
    expectCategory(payload.jev.collection.relevance_collection);
    expectCategory(payload.jev.posts[0]?.results.relevance_post);
    const serialized = `${JSON.stringify(payload)}\n${errorSpy.mock.calls.map((call) => String(call[0])).join('\n')}`;
    expect(serialized).not.toContain(FAKE_KEY);
  });
});
