import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { Command } from 'commander';
import { addJevOptions, completeJevCommand, type JevCommandOptions, prepareJevOrExit } from '../cli/jev.js';
import type { CliContext } from '../cli/shared.js';
import type { TweetData } from '../lib/twitter-client-types.js';

const INPUT_MAX_BYTES = 4 * 1024 * 1024;
type InputPost = Omit<TweetData, 'author' | 'quotedTweet'> & {
  author?: { username: string; name?: string };
  quotedTweet?: InputPost;
};

export function registerAnalyzeCommand(program: Command, ctx: CliContext): void {
  addJevOptions(
    program
      .command('analyze')
      .description('Analyze supplied posts without contacting X (requires --jev)')
      .requiredOption('--input <path>', 'JSON array of posts; maximum 4 MiB')
      .option('--json', 'Output original input and analysis as one JSON document'),
  ).action(async (options: JevCommandOptions & { input: string; json?: boolean }) => {
    const prepared = prepareJevOrExit(ctx, options);
    if (!prepared.enabled) {
      console.error(`${ctx.p('err')}analyze requires --jev.`);
      process.exitCode = 2;
      return;
    }
    let data: InputPost[];
    try {
      data = readPosts(options.input);
    } catch (error) {
      console.error(`${ctx.p('err')}${error instanceof Error ? error.message : 'Invalid --input.'}`);
      process.exitCode = 2;
      return;
    }
    const posts = data.map(toTweet);
    await completeJevCommand({
      ctx,
      prepared,
      posts,
      collection: { source: 'input', status: 'ok' },
      json: Boolean(options.json),
      data,
      printOrdinary: () => ctx.printTweets(posts, { emptyMessage: 'No supplied posts.' }),
    });
  });
}

function readPosts(path: string): InputPost[] {
  let raw: string;
  try {
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > INPUT_MAX_BYTES) {
        throw new Error('Invalid file.');
      }
      const buffer = Buffer.alloc(INPUT_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) {
          break;
        }
        length += read;
      }
      if (length > INPUT_MAX_BYTES) {
        throw new Error('Invalid file.');
      }
      raw = buffer.subarray(0, length).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error('--input must be a readable JSON file no larger than 4 MiB.');
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('--input is not valid JSON.');
  }
  if (!Array.isArray(data) || !data.every((post) => isPost(post))) {
    throw new Error(
      '--input must be an array of posts with nonblank string id, string text, and valid optional context.',
    );
  }
  return data;
}

function isPost(value: unknown, depth = 0): value is InputPost {
  if (depth > 16 || !value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const post = value as Record<string, unknown>;
  if (typeof post.id !== 'string' || !post.id.trim() || typeof post.text !== 'string') {
    return false;
  }
  for (const key of ['authorId', 'createdAt', 'conversationId', 'inReplyToStatusId']) {
    if (post[key] !== undefined && typeof post[key] !== 'string') {
      return false;
    }
  }
  if (post.author !== undefined) {
    if (!post.author || typeof post.author !== 'object' || Array.isArray(post.author)) {
      return false;
    }
    const author = post.author as Record<string, unknown>;
    if (typeof author.username !== 'string' || (author.name !== undefined && typeof author.name !== 'string')) {
      return false;
    }
  }
  return post.quotedTweet === undefined || isPost(post.quotedTweet, depth + 1);
}

function toTweet(post: InputPost): TweetData {
  const { author, quotedTweet, ...rest } = post;
  return {
    ...rest,
    author: { username: author?.username ?? 'unknown', name: author?.name ?? author?.username ?? 'unknown' },
    ...(quotedTweet === undefined ? {} : { quotedTweet: toTweet(quotedTweet) }),
  };
}
