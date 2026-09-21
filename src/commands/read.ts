import type { Command } from 'commander';
import { addJevOptions, completeJevCommand, type JevCommandOptions, prepareJevOrExit } from '../cli/jev.js';
import { ordinaryTweetsJsonData } from '../cli/jev-output.js';
import { parsePaginationFlags } from '../cli/pagination.js';
import type { CliContext } from '../cli/shared.js';
import { formatStatsLine } from '../lib/output.js';
import { addThreadMetadata, filterAuthorChain, filterAuthorOnly, filterFullChain } from '../lib/thread-filters.js';
import { TwitterClient } from '../lib/twitter-client.js';
import type { TweetData, TweetWithMeta } from '../lib/twitter-client-types.js';

export function registerReadCommands(program: Command, ctx: CliContext): void {
  addJevOptions(
    program
      .command('read')
      .description('Read/fetch a tweet by ID or URL')
      .argument('<tweet-id-or-url>', 'Tweet ID or URL to read')
      .option('--json', 'Output as JSON')
      .option('--json-full', 'Output as JSON with full raw API response in _raw field'),
  ).action(async (tweetIdOrUrl: string, cmdOpts: { json?: boolean; jsonFull?: boolean } & JevCommandOptions) => {
    const prepared = prepareJevOrExit(ctx, cmdOpts);
    const opts = program.opts();
    const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
    const quoteDepth = ctx.resolveQuoteDepthFromOptions(opts);

    const tweetId = ctx.extractTweetId(tweetIdOrUrl);

    const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);

    for (const warning of warnings) {
      console.error(`${ctx.p('warn')}${warning}`);
    }

    if (!cookies.authToken || !cookies.ct0) {
      console.error(`${ctx.p('err')}Missing required credentials`);
      process.exit(1);
    }

    const client = new TwitterClient({ cookies, timeoutMs, quoteDepth });
    const includeRaw = cmdOpts.jsonFull ?? false;
    const result = await client.getTweet(tweetId, { includeRaw });
    const isJson = Boolean(cmdOpts.json || cmdOpts.jsonFull);

    if (prepared.enabled) {
      const tweet = result.tweet;
      await completeJevCommand({
        ctx,
        prepared,
        posts: tweet ? [tweet] : [],
        collection: { source: 'read', status: result.success && result.tweet ? 'ok' : 'failed' },
        json: isJson,
        data: tweet ?? null,
        printOrdinary: () => {
          if (tweet) {
            ctx.printTweets([tweet], { showSeparator: false });
            console.log(formatStatsLine(tweet, ctx.getOutput()));
          }
        },
        collectionError: result.success && result.tweet ? undefined : `Failed to read tweet: ${result.error}`,
      });
      return;
    }

    if (result.success && result.tweet) {
      if (cmdOpts.json || cmdOpts.jsonFull) {
        console.log(JSON.stringify(result.tweet, null, 2));
      } else {
        ctx.printTweets([result.tweet], { showSeparator: false });
        console.log(formatStatsLine(result.tweet, ctx.getOutput()));
      }
    } else {
      console.error(`${ctx.p('err')}Failed to read tweet: ${result.error}`);
      process.exit(1);
    }
  });

  addJevOptions(
    program
      .command('replies')
      .description('List replies to a tweet (by ID or URL)')
      .argument('<tweet-id-or-url>', 'Tweet ID or URL')
      .option('--all', 'Fetch all replies (paged)')
      .option('--max-pages <number>', 'Fetch N pages (implies pagination)')
      .option('--delay <ms>', 'Delay in ms between page fetches', '1000')
      .option('--cursor <string>', 'Resume pagination from a cursor')
      .option('--json', 'Output as JSON')
      .option('--json-full', 'Output as JSON with full raw API response in _raw field'),
  ).action(
    async (
      tweetIdOrUrl: string,
      cmdOpts: {
        all?: boolean;
        maxPages?: string;
        delay?: string;
        cursor?: string;
        json?: boolean;
        jsonFull?: boolean;
      } & JevCommandOptions,
    ) => {
      const prepared = prepareJevOrExit(ctx, cmdOpts);
      const opts = program.opts();
      const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
      const quoteDepth = ctx.resolveQuoteDepthFromOptions(opts);
      const tweetId = ctx.extractTweetId(tweetIdOrUrl);

      const pagination = parsePaginationFlags(cmdOpts, { maxPagesImpliesPagination: true, includeDelay: true });
      if (!pagination.ok) {
        console.error(`${ctx.p('err')}${pagination.error}`);
        process.exit(1);
      }

      const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);

      for (const warning of warnings) {
        console.error(`${ctx.p('warn')}${warning}`);
      }

      if (!cookies.authToken || !cookies.ct0) {
        console.error(`${ctx.p('err')}Missing required credentials`);
        process.exit(1);
      }

      const client = new TwitterClient({ cookies, timeoutMs, quoteDepth });
      const includeRaw = cmdOpts.jsonFull ?? false;

      const result = pagination.usePagination
        ? await client.getRepliesPaged(tweetId, {
            includeRaw,
            maxPages: pagination.maxPages,
            cursor: pagination.cursor,
            pageDelayMs: pagination.pageDelayMs,
          })
        : await client.getReplies(tweetId, { includeRaw });

      const isJson = Boolean(cmdOpts.json || cmdOpts.jsonFull);
      const tweets = result.tweets ?? [];

      if (prepared.enabled) {
        await completeJevCommand({
          ctx,
          prepared,
          posts: tweets,
          collection: {
            source: 'replies',
            status: result.success ? 'ok' : 'failed',
            nextCursor: result.nextCursor,
          },
          json: isJson,
          data: ordinaryTweetsJsonData(tweets, result.nextCursor, pagination.usePagination),
          printOrdinary: () => {
            ctx.printTweetsResult(
              { tweets, nextCursor: result.nextCursor },
              {
                json: false,
                usePagination: pagination.usePagination,
                emptyMessage: 'No replies found.',
              },
            );
            if (result.nextCursor) {
              console.error(`${ctx.p('info')}More replies available. Use --cursor "${result.nextCursor}" to continue.`);
            }
          },
          collectionError: result.success ? undefined : `Failed to fetch replies: ${result.error}`,
        });
        return;
      }

      if (result.tweets) {
        ctx.printTweetsResult(result, {
          json: isJson,
          usePagination: pagination.usePagination,
          emptyMessage: 'No replies found.',
        });

        // Show pagination hint if there's more
        if (result.nextCursor && !isJson) {
          console.error(`${ctx.p('info')}More replies available. Use --cursor "${result.nextCursor}" to continue.`);
        }
      }

      if (!result.success) {
        console.error(`${ctx.p('err')}Failed to fetch replies: ${result.error}`);
        process.exit(1);
      }
    },
  );

  addJevOptions(
    program
      .command('thread')
      .description('Show the full conversation thread containing the tweet')
      .argument('<tweet-id-or-url>', 'Tweet ID or URL')
      .option('--all', 'Fetch all thread tweets (paged)')
      .option('--max-pages <number>', 'Fetch N pages (implies pagination)')
      .option('--delay <ms>', 'Delay in ms between page fetches', '1000')
      .option('--cursor <string>', 'Resume pagination from a cursor')
      .option('--json', 'Output as JSON')
      .option('--json-full', 'Output as JSON with full raw API response in _raw field')
      .option('--author-chain', 'Filter to the connected self-reply chain anchored at the focal tweet')
      .option('--author-only', 'Include all tweets from the focal tweet author')
      .option('--rooted-thread', 'Keep the full reply chain from root through the focal tweet and its descendants')
      .option('--thread-meta', 'Add thread metadata fields (isThread, threadPosition, hasSelfReplies, threadRootId)'),
  ).action(
    async (
      tweetIdOrUrl: string,
      cmdOpts: {
        all?: boolean;
        maxPages?: string;
        delay?: string;
        cursor?: string;
        json?: boolean;
        jsonFull?: boolean;
        authorChain?: boolean;
        authorOnly?: boolean;
        rootedThread?: boolean;
        threadMeta?: boolean;
      } & JevCommandOptions,
    ) => {
      const prepared = prepareJevOrExit(ctx, cmdOpts);
      const opts = program.opts();
      const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
      const quoteDepth = ctx.resolveQuoteDepthFromOptions(opts);
      const tweetId = ctx.extractTweetId(tweetIdOrUrl);

      const pagination = parsePaginationFlags(cmdOpts, { maxPagesImpliesPagination: true, includeDelay: true });
      if (!pagination.ok) {
        console.error(`${ctx.p('err')}${pagination.error}`);
        process.exit(1);
      }

      const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);

      for (const warning of warnings) {
        console.error(`${ctx.p('warn')}${warning}`);
      }

      if (!cookies.authToken || !cookies.ct0) {
        console.error(`${ctx.p('err')}Missing required credentials`);
        process.exit(1);
      }

      const client = new TwitterClient({ cookies, timeoutMs, quoteDepth });
      const includeRaw = cmdOpts.jsonFull ?? false;

      const result = pagination.usePagination
        ? await client.getThreadPaged(tweetId, {
            includeRaw,
            maxPages: pagination.maxPages,
            cursor: pagination.cursor,
            pageDelayMs: pagination.pageDelayMs,
          })
        : await client.getThread(tweetId, { includeRaw });

      // --- Thread filter flags ---
      const useAuthorChain = Boolean(cmdOpts.authorChain);
      const useAuthorOnly = Boolean(cmdOpts.authorOnly);
      const useRootedThread = Boolean(cmdOpts.rootedThread);
      const useThreadMeta = Boolean(cmdOpts.threadMeta);

      if (useAuthorChain && (useAuthorOnly || useRootedThread)) {
        console.error(
          `${ctx.p('warn')}--author-chain already limits to the connected self-reply chain; ` +
            'other filter flags are redundant.',
        );
      }
      if (useRootedThread && useAuthorOnly && !useAuthorChain) {
        console.error(
          `${ctx.p('warn')}--rooted-thread and --author-only are both active; ` +
            '--rooted-thread will run first, --author-only will then filter its output.',
        );
      }

      let filteredTweets: TweetData[] = result.tweets ?? [];
      const allConversationTweets: TweetData[] = result.tweets ?? [];

      if (useAuthorChain || useAuthorOnly || useRootedThread) {
        const focalTweet = allConversationTweets.find((t) => t.id === tweetId);
        if (focalTweet) {
          if (useAuthorChain) {
            filteredTweets = filterAuthorChain(allConversationTweets, focalTweet);
          } else {
            if (useRootedThread) {
              filteredTweets = filterFullChain(allConversationTweets, focalTweet);
            }
            if (useAuthorOnly) {
              filteredTweets = filterAuthorOnly(filteredTweets, focalTweet);
            }
          }
        } else {
          console.error(
            `${ctx.p('warn')}Focal tweet ${tweetId} not found in thread results; filter flags have no effect.`,
          );
        }
      }

      let finalTweets: Array<TweetData | TweetWithMeta> = filteredTweets;
      if (useThreadMeta) {
        finalTweets = filteredTweets.map((tweet) => addThreadMetadata(tweet, allConversationTweets));
      }
      // --- End thread filter flags ---

      const isJson = Boolean(cmdOpts.json || cmdOpts.jsonFull);

      if (prepared.enabled) {
        await completeJevCommand({
          ctx,
          prepared,
          posts: finalTweets,
          collection: {
            source: 'thread',
            status: result.success ? 'ok' : 'failed',
            nextCursor: result.nextCursor,
          },
          json: isJson,
          data: ordinaryTweetsJsonData(finalTweets, result.nextCursor, pagination.usePagination),
          printOrdinary: () => {
            ctx.printTweetsResult(
              { tweets: finalTweets as TweetData[], nextCursor: result.nextCursor },
              {
                json: false,
                usePagination: pagination.usePagination,
                emptyMessage: 'No thread tweets found.',
              },
            );
            if (result.nextCursor) {
              console.error(
                `${ctx.p('info')}More thread tweets available. Use --cursor "${result.nextCursor}" to continue.`,
              );
            }
          },
          collectionError: result.success ? undefined : `Failed to fetch thread: ${result.error}`,
        });
        return;
      }

      if (result.tweets) {
        ctx.printTweetsResult(
          { tweets: finalTweets as TweetData[], nextCursor: result.nextCursor },
          {
            json: isJson,
            usePagination: pagination.usePagination,
            emptyMessage: 'No thread tweets found.',
          },
        );

        // Show pagination hint if there's more
        if (result.nextCursor && !isJson) {
          console.error(
            `${ctx.p('info')}More thread tweets available. Use --cursor "${result.nextCursor}" to continue.`,
          );
        }
      }

      if (!result.success) {
        console.error(`${ctx.p('err')}Failed to fetch thread: ${result.error}`);
        process.exit(1);
      }
    },
  );
}
