import { readFileSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { createJevPresets, JEV_MODEL, JEV_SPEC_MAX_BYTES, parseJevMaxPosts, validateJevSpec } from '../lib/jev-spec.js';
import type { JevCollectionContext, JevReport, JevSpec } from '../lib/jev-types.js';
import type { TweetData } from '../lib/twitter-client-types.js';
import { jevShouldExit, printJevAnalysis, printJevJson } from './jev-output.js';
import type { CliContext } from './shared.js';

const JEV_SCOPES = new Set(['post', 'collection', 'both']);

export type JevCommandOptions = {
  jev?: boolean;
  jevSpec?: string;
  relevance?: string;
  sentiment?: string;
  jevScope?: string;
  jevMaxPosts?: string;
};

export type PreparedJev =
  | { enabled: false }
  | {
      enabled: true;
      spec: JevSpec;
      apiKey: string;
      maxPosts: number;
    };

export class JevPrepareError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'JevPrepareError';
  }
}

export function addJevOptions(command: Command): Command {
  command
    .option('--jev', 'Authorize sending selected posts and disclosed context to TypeSafe')
    .option('--jev-spec <path>', 'JSON file with analysis tasks')
    .option('--relevance <criterion>', 'Preset relevance criterion')
    .option('--sentiment <subject>', 'Preset sentiment subject')
    .option('--jev-scope <scope>', 'Preset analysis scope: post, collection, or both')
    .option('--jev-max-posts <n>', 'Maximum unique selected posts (default: 100)');
  return command;
}

export function prepareJev(flags: JevCommandOptions, env: NodeJS.ProcessEnv = process.env): PreparedJev {
  const hasCompanionFlags = hasJevCompanionFlags(flags);
  if (!flags.jev) {
    if (hasCompanionFlags) {
      throw new JevPrepareError('JEV options require --jev.');
    }
    return { enabled: false };
  }

  const hasSpec = flags.jevSpec !== undefined;
  const hasRelevance = flags.relevance !== undefined;
  const hasSentiment = flags.sentiment !== undefined;
  const hasScope = flags.jevScope !== undefined;

  if (hasSpec && (hasRelevance || hasSentiment)) {
    throw new JevPrepareError('--jev-spec cannot be combined with --relevance or --sentiment.');
  }
  if (hasSpec && hasScope) {
    throw new JevPrepareError('--jev-scope applies only to presets.');
  }
  if (!hasSpec && !hasRelevance && !hasSentiment) {
    throw new JevPrepareError('--jev requires --jev-spec or --relevance/--sentiment.');
  }

  const specPath = hasSpec ? requirePresentValue(flags.jevSpec, '--jev-spec cannot be blank.') : undefined;
  const relevance = hasRelevance
    ? requirePresentValue(flags.relevance, '--relevance cannot be blank.').trim()
    : undefined;
  const sentiment = hasSentiment
    ? requirePresentValue(flags.sentiment, '--sentiment cannot be blank.').trim()
    : undefined;
  let scope: 'post' | 'collection' | 'both' | undefined;
  if (hasScope) {
    const scopeRaw = flags.jevScope?.trim() ?? '';
    if (!JEV_SCOPES.has(scopeRaw)) {
      throw new JevPrepareError('Invalid --jev-scope. Expected post, collection, or both.');
    }
    scope = scopeRaw as 'post' | 'collection' | 'both';
  }

  let spec: JevSpec;
  try {
    spec = specPath
      ? validateJevSpec(loadSpecJson(specPath))
      : createJevPresets({
          relevance,
          sentiment,
          scope,
        });
  } catch (error) {
    if (error instanceof JevPrepareError) {
      throw error;
    }
    throw new JevPrepareError(error instanceof Error ? error.message : 'Invalid JEV specification.');
  }

  const apiKey = env.TYPESAFE_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new JevPrepareError('Missing TYPESAFE_API_KEY.');
  }

  let maxPosts: number;
  try {
    maxPosts = parseJevMaxPosts(flags.jevMaxPosts);
  } catch (error) {
    throw new JevPrepareError(error instanceof Error ? error.message : 'Invalid --jev-max-posts.');
  }
  return { enabled: true, spec, apiKey, maxPosts };
}

export function prepareJevOrExit(
  ctx: CliContext,
  flags: JevCommandOptions,
  env: NodeJS.ProcessEnv = process.env,
): PreparedJev {
  try {
    return prepareJev(flags, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JEV options.';
    console.error(`${ctx.p('err')}${message}`);
    process.exit(2);
    return { enabled: false };
  }
}

export async function completeJevCommand(input: {
  ctx: CliContext;
  prepared: Extract<PreparedJev, { enabled: true }>;
  posts: readonly TweetData[];
  collection: JevCollectionContext;
  json: boolean;
  data: unknown;
  printOrdinary: () => void;
  collectionError?: string;
}): Promise<void> {
  const report = await analyzeGuarded(input.ctx, input.prepared, input.posts, input.collection);
  if (input.json) {
    printJevJson(input.data, report);
  } else {
    input.printOrdinary();
    printJevAnalysis(input.ctx, report);
  }
  if (report.error) {
    console.error(`${input.ctx.p('err')}${report.error.message}`);
  }
  if (input.collectionError) {
    console.error(`${input.ctx.p('err')}${input.collectionError}`);
  }
  if (input.collectionError || jevShouldExit(report)) {
    // Drain stdout (JSON or terminal analysis) before the process ends.
    process.exitCode = 1;
  }
}

function hasJevCompanionFlags(flags: JevCommandOptions): boolean {
  return (
    flags.jevSpec !== undefined ||
    flags.relevance !== undefined ||
    flags.sentiment !== undefined ||
    flags.jevScope !== undefined ||
    flags.jevMaxPosts !== undefined
  );
}

function requirePresentValue(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === '') {
    throw new JevPrepareError(message);
  }
  return value;
}

function loadSpecJson(path: string): unknown {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    throw new JevPrepareError('Cannot read --jev-spec.');
  }
  if (!stats.isFile()) {
    throw new JevPrepareError('--jev-spec must be a JSON file.');
  }
  if (stats.size > JEV_SPEC_MAX_BYTES) {
    throw new JevPrepareError('--jev-spec exceeds 64 KiB.');
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new JevPrepareError('Cannot read --jev-spec.');
  }
  if (Buffer.byteLength(raw, 'utf8') > JEV_SPEC_MAX_BYTES) {
    throw new JevPrepareError('--jev-spec exceeds 64 KiB.');
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new JevPrepareError('--jev-spec is not valid JSON.');
  }
}

async function analyzeGuarded(
  ctx: CliContext,
  prepared: Extract<PreparedJev, { enabled: true }>,
  posts: readonly TweetData[],
  collection: JevCollectionContext,
): Promise<JevReport> {
  try {
    return await ctx.analyzePosts(posts, prepared.spec, {
      apiKey: prepared.apiKey,
      maxPosts: prepared.maxPosts,
      collection,
    });
  } catch {
    return safeFailedReport(prepared.spec, collection, posts);
  }
}

function safeFailedReport(spec: JevSpec, collection: JevCollectionContext, posts: readonly TweetData[]): JevReport {
  const postIds: string[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    if (seen.has(post.id)) {
      continue;
    }
    seen.add(post.id);
    postIds.push(post.id);
  }
  return {
    schemaVersion: 1,
    requestedModel: JEV_MODEL,
    tasks: spec.tasks,
    selection: {
      source: collection.source,
      status: collection.status,
      ...(collection.nextCursor === undefined ? {} : { nextCursor: collection.nextCursor }),
      occurrenceCount: posts.length,
      postCount: postIds.length,
      postIds,
      coverage: 'selected_posts_only',
    },
    posts: [],
    collection: {},
    requests: [],
    usage: { inputTokens: 0, outputTokens: 0, complete: false },
    error: { code: 'provider_error', message: 'JEV analysis failed.' },
  };
}
