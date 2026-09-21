import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeJevCommand, JevPrepareError, prepareJev } from '../src/cli/jev.js';
import { jevShouldExit, printJevAnalysis, printJevJson } from '../src/cli/jev-output.js';
import { createProgram } from '../src/cli/program.js';
import { type CliContext, createCliContext } from '../src/cli/shared.js';
import { registerPostCommands } from '../src/commands/post.js';
import { registerReadCommands } from '../src/commands/read.js';
import { registerSearchCommands } from '../src/commands/search.js';
import { createJevPresets, JEV_MODEL } from '../src/lib/jev-spec.js';
import type { JevOutcome, JevReport } from '../src/lib/jev-types.js';
import { TwitterClient } from '../src/lib/twitter-client.js';
import type { TweetData } from '../src/lib/twitter-client-types.js';

const FAKE_KEY = 'ts_test_fake_key';
const UNKNOWN_OPTION = /unknown option/i;

const identity = (text: string): string => text;

function makeTweet(id: string): TweetData {
  return {
    id,
    text: `text-${id}`,
    author: { username: 'alice', name: 'Alice' },
    createdAt: '2020-01-01T00:00:00Z',
  };
}

function commandOptionNames(name: string): string[] {
  const ctx = createCliContext([]);
  const program = createProgram(ctx);
  const cmd = program.commands.find((candidate) => candidate.name() === name);
  if (!cmd) {
    throw new Error(`Expected ${name} command`);
  }
  return cmd.options.flatMap((option) => (option.long ? [option.long] : []));
}

function makeReport(overrides: Partial<JevReport> = {}): JevReport {
  const spec = createJevPresets({ relevance: 'transit', sentiment: 'transit', scope: 'both' });
  return {
    schemaVersion: 1,
    requestedModel: JEV_MODEL,
    tasks: spec.tasks,
    selection: {
      source: 'search',
      status: 'ok',
      occurrenceCount: 1,
      postCount: 1,
      postIds: ['1'],
      coverage: 'selected_posts_only',
    },
    posts: [
      {
        postId: '1',
        results: {
          relevance_post: {
            status: 'ok',
            requestId: 'r1',
            type: 'category',
            value: 'relevant',
            probabilities: { relevant: 0.8, irrelevant: 0.1, unclear: 0.1 },
            confidence: 0.8,
          },
          sentiment_post: {
            status: 'ok',
            requestId: 'r1',
            type: 'boolean',
            value: true,
            probability: 0.7,
            threshold: 0.5,
          },
        },
      },
    ],
    collection: {
      relevance_collection: {
        status: 'ok',
        requestId: 'r0',
        type: 'score',
        value: 2.4,
        probabilities: { '0': 0.1, '1': 0.2, '2': 0.4, '3': 0.3 },
        confidence: 0.4,
      },
      sentiment_collection: { status: 'skipped', reason: 'empty_selection' },
    },
    requests: [],
    usage: { inputTokens: 4, outputTokens: 2, complete: true },
    ...overrides,
  };
}

function mockCtx(analyzePosts = vi.fn()) {
  return {
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
    printTweets: vi.fn(),
    printTweetsResult: vi.fn(),
    analyzePosts,
  } as unknown as CliContext;
}

describe('prepareJev', () => {
  it('is disabled without flags', () => {
    expect(prepareJev({}, {})).toEqual({ enabled: false });
  });

  it('rejects companion flags without --jev', () => {
    expect(() => prepareJev({ relevance: 'x' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(JevPrepareError);
    expect(() => prepareJev({ jevSpec: 'spec.json' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      'JEV options require --jev.',
    );
    expect(() => prepareJev({ jevScope: 'post' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      'JEV options require --jev.',
    );
    expect(() => prepareJev({ jevMaxPosts: '10' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      'JEV options require --jev.',
    );
  });

  it('rejects bare --jev', () => {
    expect(() => prepareJev({ jev: true }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      '--jev requires --jev-spec or --relevance/--sentiment.',
    );
  });

  it('rejects spec mixed with presets or scope', () => {
    expect(() => prepareJev({ jev: true, jevSpec: 'a.json', relevance: 'x' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      '--jev-spec cannot be combined with --relevance or --sentiment.',
    );
    expect(() =>
      prepareJev({ jev: true, jevSpec: 'a.json', jevScope: 'both' }, { TYPESAFE_API_KEY: FAKE_KEY }),
    ).toThrow('--jev-scope applies only to presets.');
  });

  it('rejects explicitly blank companion values and detects conflicts by flag presence', () => {
    expect(() =>
      prepareJev({ jev: true, relevance: 'transit', sentiment: '' }, { TYPESAFE_API_KEY: FAKE_KEY }),
    ).toThrow('--sentiment cannot be blank.');
    expect(() =>
      prepareJev({ jev: true, relevance: '   ', sentiment: 'buses' }, { TYPESAFE_API_KEY: FAKE_KEY }),
    ).toThrow('--relevance cannot be blank.');
    expect(() => prepareJev({ jev: true, jevSpec: '   ' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      '--jev-spec cannot be blank.',
    );
    expect(() => prepareJev({ jev: true, jevSpec: '', relevance: 'transit' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      '--jev-spec cannot be combined with --relevance or --sentiment.',
    );
    expect(() => prepareJev({ jev: true, jevSpec: 'a.json', jevScope: '' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      '--jev-scope applies only to presets.',
    );
    expect(() =>
      prepareJev({ jev: true, relevance: 'transit', jevScope: '   ' }, { TYPESAFE_API_KEY: FAKE_KEY }),
    ).toThrow('Invalid --jev-scope. Expected post, collection, or both.');
  });

  it('rejects invalid scope', () => {
    expect(() => prepareJev({ jev: true, relevance: 'x', jevScope: 'thread' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      'Invalid --jev-scope. Expected post, collection, or both.',
    );
  });

  it('requires TYPESAFE_API_KEY', () => {
    expect(() => prepareJev({ jev: true, relevance: 'x' }, {})).toThrow('Missing TYPESAFE_API_KEY.');
    expect(() => prepareJev({ jev: true, relevance: 'x' }, { TYPESAFE_API_KEY: '   ' })).toThrow(
      'Missing TYPESAFE_API_KEY.',
    );
  });

  it('builds presets and defaults max posts', () => {
    const prepared = prepareJev(
      { jev: true, relevance: 'transit', sentiment: 'buses' },
      { TYPESAFE_API_KEY: FAKE_KEY },
    );
    expect(prepared.enabled).toBe(true);
    if (!prepared.enabled) {
      throw new Error('expected enabled');
    }
    expect(prepared.apiKey).toBe(FAKE_KEY);
    expect(prepared.maxPosts).toBe(100);
    expect(prepared.spec.tasks.map((task) => task.id)).toEqual(['relevance_post', 'sentiment_post']);
  });

  it('applies preset scope both', () => {
    const prepared = prepareJev({ jev: true, relevance: 'transit', jevScope: 'both' }, { TYPESAFE_API_KEY: FAKE_KEY });
    expect(prepared.enabled).toBe(true);
    if (!prepared.enabled) {
      throw new Error('expected enabled');
    }
    expect(prepared.spec.tasks.map((task) => `${task.id}:${task.scope}`)).toEqual([
      'relevance_post:post',
      'relevance_collection:collection',
    ]);
  });

  it('rejects invalid max posts', () => {
    expect(() => prepareJev({ jev: true, relevance: 'x', jevMaxPosts: '0' }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      'Maximum post count is invalid.',
    );
  });

  it('loads a strict JSON spec and rejects oversized or invalid files without logging content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bird-jev-spec-'));
    const specPath = join(dir, 'ok.json');
    const hugePath = join(dir, 'huge.json');
    const invalidPath = join(dir, 'bad.json');
    const secret = 'UNIQUE_SPEC_SECRET_PAYLOAD';
    writeFileSync(
      specPath,
      JSON.stringify({
        tasks: [
          {
            id: 'tone',
            scope: 'post',
            instructions: 'Classify tone.',
            output: { type: 'category', labels: ['calm', 'heated'] },
          },
        ],
      }),
    );
    const spacedPath = join(dir, 'ok spec.json ');
    writeFileSync(
      spacedPath,
      JSON.stringify({
        tasks: [
          {
            id: 'spaced',
            scope: 'post',
            instructions: 'Classify tone.',
            output: { type: 'category', labels: ['calm', 'heated'] },
          },
        ],
      }),
    );
    writeFileSync(hugePath, 'x'.repeat(64 * 1024 + 1));
    writeFileSync(invalidPath, `{${secret}`);

    const prepared = prepareJev({ jev: true, jevSpec: specPath }, { TYPESAFE_API_KEY: FAKE_KEY });
    expect(prepared.enabled).toBe(true);
    if (!prepared.enabled) {
      throw new Error('expected enabled');
    }
    expect(prepared.spec.tasks[0]?.id).toBe('tone');

    const spaced = prepareJev({ jev: true, jevSpec: spacedPath }, { TYPESAFE_API_KEY: FAKE_KEY });
    expect(spaced.enabled).toBe(true);
    if (!spaced.enabled) {
      throw new Error('expected enabled');
    }
    expect(spaced.spec.tasks[0]?.id).toBe('spaced');

    expect(() => prepareJev({ jev: true, jevSpec: hugePath }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      '--jev-spec exceeds 64 KiB.',
    );
    expect(() => prepareJev({ jev: true, jevSpec: invalidPath }, { TYPESAFE_API_KEY: FAKE_KEY })).toThrow(
      '--jev-spec is not valid JSON.',
    );
  });
});

describe('jev output', () => {
  it('prints one JSON envelope', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const report = makeReport();
    try {
      printJevJson([{ id: '1' }], report);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(payload).toEqual({ data: [{ id: '1' }], jev: report });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('renders compact post and collection outcomes', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ctx = mockCtx();
    try {
      printJevAnalysis(ctx, makeReport());
      const text = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(text).toContain('Analysis');
      expect(text).toContain('1 posts (1 selected)');
      expect(text).toContain('collection');
      expect(text).toContain('relevance_collection: 2.4');
      expect(text).toContain('sentiment_collection: skipped (empty_selection)');
      expect(text).toContain('relevance_post: relevant');
      expect(text).toContain('sentiment_post: yes');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('treats empty_selection as success and other skips as failure', () => {
    const skipped: JevOutcome = { status: 'skipped', reason: 'empty_selection' };
    expect(
      jevShouldExit(
        makeReport({
          error: undefined,
          posts: [],
          collection: { relevance_collection: skipped },
        }),
      ),
    ).toBe(false);
    expect(
      jevShouldExit(
        makeReport({
          collection: { relevance_collection: { status: 'skipped', reason: 'collection_failed' } },
        }),
      ),
    ).toBe(true);
    expect(jevShouldExit(makeReport({ error: { code: 'provider_error', message: 'JEV analysis failed.' } }))).toBe(
      true,
    );
  });
});

describe('jev CLI flags', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('shows --jev on eligible commands and not on writes or metadata', () => {
    expect(commandOptionNames('read')).toContain('--jev');
    expect(commandOptionNames('search')).toContain('--jev');
    expect(commandOptionNames('likes')).toContain('--jev');
    expect(commandOptionNames('list-timeline')).toContain('--jev');
    expect(commandOptionNames('news')).toContain('--jev');
    expect(commandOptionNames('tweet')).not.toContain('--jev');
    expect(commandOptionNames('lists')).not.toContain('--jev');
    expect(commandOptionNames('following')).not.toContain('--jev');
    expect(commandOptionNames('whoami')).not.toContain('--jev');
  });

  it('validates flags before credentials and does not call the engine', async () => {
    const ctx = mockCtx();
    const program = new Command();
    registerSearchCommands(program, ctx);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(program.parseAsync(['node', 'bird', 'search', 'cats', '--jev'])).rejects.toThrow('exit 2');
    expect(ctx.resolveCredentialsFromOptions).not.toHaveBeenCalled();
    expect(ctx.analyzePosts).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('--jev requires --jev-spec or --relevance/--sentiment.'),
    );
    exitSpy.mockRestore();
  });

  it('rejects missing key before credentials', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const ctx = mockCtx();
    const program = new Command();
    registerReadCommands(program, ctx);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(program.parseAsync(['node', 'bird', 'read', '1', '--jev', '--relevance', 'transit'])).rejects.toThrow(
      'exit 2',
    );
    expect(ctx.resolveCredentialsFromOptions).not.toHaveBeenCalled();
    expect(ctx.analyzePosts).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('rejects unknown --jev on write commands', async () => {
    const ctx = mockCtx();
    const program = new Command();
    registerPostCommands(program, ctx);
    const chunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(program.parseAsync(['node', 'bird', 'tweet', 'hello', '--jev'])).rejects.toThrow('exit 1');
    expect(chunks.join('')).toMatch(UNKNOWN_OPTION);
    expect(ctx.resolveCredentialsFromOptions).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('uses a generic error when the engine throws and preserves content', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', FAKE_KEY);
    const analyzePosts = vi.fn(async () => {
      throw new Error('secret TYPESAFE_API_KEY leaked');
    });
    const ctx = mockCtx(analyzePosts);
    const program = new Command();
    registerReadCommands(program, ctx);
    vi.spyOn(TwitterClient.prototype, 'getTweet').mockResolvedValue({
      success: true,
      tweet: makeTweet('1'),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['node', 'bird', 'read', '1', '--jev', '--relevance', 'transit', '--json']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload.data.id).toBe('1');
    expect(payload.jev.error.message).toBe('JEV analysis failed.');
    expect(payload.jev.requestedModel).toBe(JEV_MODEL);
    const stderr = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(stderr).toContain('JEV analysis failed.');
    expect(stderr).not.toContain('secret');
    expect(stderr).not.toContain('leaked');
    expect(JSON.stringify(payload)).not.toContain(FAKE_KEY);
  });

  it('rejects a blank companion option supplied through the CLI', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', FAKE_KEY);
    const ctx = mockCtx();
    const program = new Command();
    registerSearchCommands(program, ctx);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      program.parseAsync(['node', 'bird', 'search', 'cats', '--jev', '--relevance', 'transit', '--sentiment', '']),
    ).rejects.toThrow('exit 2');
    expect(ctx.resolveCredentialsFromOptions).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--sentiment cannot be blank.'));
    exitSpy.mockRestore();
  });

  it('sets exitCode after printing JSON instead of calling process.exit', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', FAKE_KEY);
    const prepared = prepareJev({ jev: true, relevance: 'transit' }, { TYPESAFE_API_KEY: FAKE_KEY });
    if (!prepared.enabled) {
      throw new Error('expected enabled');
    }
    const ctx = mockCtx(
      vi.fn(async () =>
        makeReport({
          error: { code: 'provider_error', message: 'JEV analysis failed.' },
        }),
      ),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await completeJevCommand({
      ctx,
      prepared,
      posts: [makeTweet('1')],
      collection: { source: 'read', status: 'ok' },
      json: true,
      data: { id: '1' },
      printOrdinary: () => {
        throw new Error('ordinary printer should not run for JSON');
      },
    });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(expect.objectContaining({ data: { id: '1' } }));
  });
});
