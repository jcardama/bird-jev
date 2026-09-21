import { type Command, Option } from 'commander';
import { addJevOptions, completeJevCommand, type JevCommandOptions, prepareJevOrExit } from '../cli/jev.js';
import { ordinaryTweetsJsonData } from '../cli/jev-output.js';
import { parsePaginationFlags } from '../cli/pagination.js';
import type { CliContext } from '../cli/shared.js';
import { mentionsQueryFromUserOption, normalizeHandle } from '../lib/normalize-handle.js';
import { TwitterClient } from '../lib/twitter-client.js';

export function registerSearchCommands(program: Command, ctx: CliContext): void {
  addJevOptions(
    program
      .command('search')
      .description('Search for tweets')
      .argument('<query>', 'Search query (e.g., "@clawdbot" or "from:clawdbot")')
      .option('-n, --count <number>', 'Number of tweets to fetch', '10')
      .addOption(new Option('--mode <mode>', 'Search ranking').choices(['top', 'latest']).default('latest'))
      .option('--all', 'Fetch all search results (paged)')
      .option('--max-pages <number>', 'Stop after N pages when using --all or --cursor')
      .option('--cursor <string>', 'Resume pagination from a cursor')
      .option('--json', 'Output as JSON')
      .option('--json-full', 'Output as JSON with full raw API response in _raw field'),
  ).action(
    async (
      query: string,
      cmdOpts: {
        count?: string;
        mode?: 'top' | 'latest';
        all?: boolean;
        maxPages?: string;
        cursor?: string;
        json?: boolean;
        jsonFull?: boolean;
      } & JevCommandOptions,
    ) => {
      const prepared = prepareJevOrExit(ctx, cmdOpts);
      const opts = program.opts();
      const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
      const quoteDepth = ctx.resolveQuoteDepthFromOptions(opts);
      const count = Number(cmdOpts.count ?? '10');

      const pagination = parsePaginationFlags(cmdOpts);
      if (!pagination.ok) {
        console.error(`${ctx.p('err')}${pagination.error}`);
        process.exit(1);
      }
      const maxPages = pagination.maxPages;

      const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);

      for (const warning of warnings) {
        console.error(`${ctx.p('warn')}${warning}`);
      }

      if (!cookies.authToken || !cookies.ct0) {
        console.error(`${ctx.p('err')}Missing required credentials`);
        process.exit(1);
      }

      const usePagination = pagination.usePagination;
      if (maxPages !== undefined && !usePagination) {
        console.error(`${ctx.p('err')}--max-pages requires --all or --cursor.`);
        process.exit(1);
      }
      if (!cmdOpts.all && (!Number.isSafeInteger(count) || count <= 0)) {
        console.error(`${ctx.p('err')}Invalid --count. Expected a positive integer.`);
        process.exit(1);
      }

      const client = new TwitterClient({ cookies, timeoutMs, quoteDepth });
      const includeRaw = cmdOpts.jsonFull ?? false;
      const searchOptions = {
        includeRaw,
        maxPages,
        cursor: pagination.cursor,
        mode: cmdOpts.mode === 'top' ? ('Top' as const) : ('Latest' as const),
      };
      const result = cmdOpts.all
        ? await client.getAllSearchResults(query, searchOptions)
        : await client.search(query, count, searchOptions);

      const isJson = Boolean(cmdOpts.json || cmdOpts.jsonFull);
      const tweets = result.tweets ?? [];

      if (prepared.enabled) {
        await completeJevCommand({
          ctx,
          prepared,
          posts: tweets,
          collection: {
            source: 'search',
            status: result.success ? 'ok' : 'failed',
            nextCursor: result.nextCursor,
          },
          json: isJson,
          data: ordinaryTweetsJsonData(tweets, result.nextCursor, Boolean(usePagination)),
          printOrdinary: () => {
            ctx.printTweetsResult(
              { tweets, nextCursor: result.nextCursor },
              {
                json: false,
                usePagination: Boolean(usePagination),
                emptyMessage: 'No tweets found.',
              },
            );
          },
          collectionError: result.success ? undefined : `Search failed: ${result.error}`,
        });
        return;
      }

      if (result.success) {
        ctx.printTweetsResult(result, {
          json: isJson,
          usePagination: Boolean(usePagination),
          emptyMessage: 'No tweets found.',
        });
      } else {
        console.error(`${ctx.p('err')}Search failed: ${result.error}`);
        process.exit(1);
      }
    },
  );

  addJevOptions(
    program
      .command('mentions')
      .description('Find tweets mentioning a user (defaults to current user)')
      .option('-u, --user <handle>', 'User handle (e.g. @steipete)')
      .option('-n, --count <number>', 'Number of tweets to fetch', '10')
      .option('--json', 'Output as JSON')
      .option('--json-full', 'Output as JSON with full raw API response in _raw field'),
  ).action(
    async (cmdOpts: { user?: string; count?: string; json?: boolean; jsonFull?: boolean } & JevCommandOptions) => {
      const prepared = prepareJevOrExit(ctx, cmdOpts);
      const opts = program.opts();
      const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
      const quoteDepth = ctx.resolveQuoteDepthFromOptions(opts);
      const count = Number.parseInt(cmdOpts.count || '10', 10);

      const fromUserOpt = mentionsQueryFromUserOption(cmdOpts.user);
      if (fromUserOpt.error) {
        console.error(`${ctx.p('err')}${fromUserOpt.error}`);
        process.exit(2);
      }

      let query: string | null = fromUserOpt.query;

      const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);

      for (const warning of warnings) {
        console.error(`${ctx.p('warn')}${warning}`);
      }

      if (!cookies.authToken || !cookies.ct0) {
        console.error(`${ctx.p('err')}Missing required credentials`);
        process.exit(1);
      }

      const client = new TwitterClient({ cookies, timeoutMs, quoteDepth });

      if (!query) {
        const who = await client.getCurrentUser();
        const handle = normalizeHandle(who.user?.username);
        if (handle) {
          query = `@${handle}`;
        } else {
          console.error(
            `${ctx.p('err')}Could not determine current user (${who.error ?? 'Unknown error'}). Use --user <handle>.`,
          );
          process.exit(1);
        }
      }

      const includeRaw = cmdOpts.jsonFull ?? false;
      const result = await client.search(query, count, { includeRaw });
      const isJson = Boolean(cmdOpts.json || cmdOpts.jsonFull);
      const tweets = result.tweets ?? [];

      if (prepared.enabled) {
        await completeJevCommand({
          ctx,
          prepared,
          posts: tweets,
          collection: { source: 'mentions', status: result.success ? 'ok' : 'failed' },
          json: isJson,
          data: tweets,
          printOrdinary: () => {
            ctx.printTweets(tweets, {
              json: false,
              emptyMessage: 'No mentions found.',
            });
          },
          collectionError: result.success ? undefined : `Failed to fetch mentions: ${result.error}`,
        });
        return;
      }

      if (result.success) {
        ctx.printTweets(result.tweets, {
          json: cmdOpts.json || cmdOpts.jsonFull,
          emptyMessage: 'No mentions found.',
        });
      } else {
        console.error(`${ctx.p('err')}Failed to fetch mentions: ${result.error}`);
        process.exit(1);
      }
    },
  );
}
