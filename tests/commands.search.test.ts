import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../src/cli/shared.js';
import { registerSearchCommands } from '../src/commands/search.js';
import { TwitterClient } from '../src/lib/twitter-client.js';

describe('search command', () => {
  let program: Command;
  let mockContext: Partial<CliContext>;

  beforeEach(() => {
    program = new Command();
    mockContext = {
      resolveTimeoutFromOptions: () => undefined,
      resolveQuoteDepthFromOptions: () => undefined,
      resolveCredentialsFromOptions: async () => ({
        cookies: { authToken: 'auth', ct0: 'ct0', cookieHeader: 'auth=auth; ct0=ct0' },
        warnings: [],
      }),
      p: () => '',
      printTweetsResult: vi.fn(),
    };
  });

  it('requires --all or --cursor when --max-pages is provided', async () => {
    registerSearchCommands(program, mockContext as CliContext);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(program.parseAsync(['node', 'bird', 'search', 'cats', '--max-pages', '2'])).rejects.toThrow(
        'exit 1',
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--max-pages requires --all or --cursor'));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('requires positive --count when not paging', async () => {
    registerSearchCommands(program, mockContext as CliContext);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(program.parseAsync(['node', 'bird', 'search', 'cats', '--count', '0'])).rejects.toThrow('exit 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --count. Expected a positive integer.'));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('requires positive --max-pages when paging', async () => {
    registerSearchCommands(program, mockContext as CliContext);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(program.parseAsync(['node', 'bird', 'search', 'cats', '--all', '--max-pages', '0'])).rejects.toThrow(
        'exit 1',
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid --max-pages. Expected a positive integer.'),
      );
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('uses paged search when --all is set', async () => {
    registerSearchCommands(program, mockContext as CliContext);
    const getAllSpy = vi
      .spyOn(TwitterClient.prototype, 'getAllSearchResults')
      .mockResolvedValue({ success: true, tweets: [] });
    const searchSpy = vi.spyOn(TwitterClient.prototype, 'search').mockResolvedValue({ success: true, tweets: [] });

    try {
      await program.parseAsync(['node', 'bird', 'search', 'cats', '--all', '--json']);
      expect(getAllSpy).toHaveBeenCalledWith('cats', expect.objectContaining({ includeRaw: false, mode: 'Latest' }));
      expect(searchSpy).not.toHaveBeenCalled();
      expect(mockContext.printTweetsResult).toHaveBeenCalledWith(expect.objectContaining({ tweets: [] }), {
        json: true,
        usePagination: true,
        emptyMessage: 'No tweets found.',
      });
    } finally {
      getAllSpy.mockRestore();
      searchSpy.mockRestore();
    }
  });

  it.each([false, true])('passes Top to the selected client method (all=%s)', async (all) => {
    registerSearchCommands(program, mockContext as CliContext);
    const searchSpy = vi.spyOn(TwitterClient.prototype, 'search').mockResolvedValue({ success: true, tweets: [] });
    const allSpy = vi
      .spyOn(TwitterClient.prototype, 'getAllSearchResults')
      .mockResolvedValue({ success: true, tweets: [] });
    try {
      await program.parseAsync(['node', 'bird', 'search', 'q', '--mode', 'top', ...(all ? ['--all'] : [])]);
      const selected = all ? allSpy : searchSpy;
      const options = expect.objectContaining({ mode: 'Top' });
      const expectedArgs = all ? ['q', options] : ['q', 10, options];
      expect(selected).toHaveBeenCalledTimes(1);
      expect(selected.mock.calls[0]).toEqual(expectedArgs);
    } finally {
      searchSpy.mockRestore();
      allSpy.mockRestore();
    }
  });

  it.each([
    { flags: [] },
    { flags: ['--mode', 'latest'] },
  ])('uses Latest for a finite search with flags $flags', async ({ flags }) => {
    registerSearchCommands(program, mockContext as CliContext);
    const searchSpy = vi.spyOn(TwitterClient.prototype, 'search').mockResolvedValue({ success: true, tweets: [] });
    try {
      await program.parseAsync(['node', 'bird', 'search', 'q', ...flags]);
      expect(searchSpy).toHaveBeenCalledWith('q', 10, expect.objectContaining({ mode: 'Latest' }));
    } finally {
      searchSpy.mockRestore();
    }
  });

  it('rejects an unsupported mode before resolving credentials', async () => {
    const credentials = vi.fn();
    mockContext.resolveCredentialsFromOptions = credentials;
    program.exitOverride().configureOutput({ writeErr: () => undefined });
    registerSearchCommands(program, mockContext as CliContext);
    const action = program.parseAsync(['node', 'bird', 'search', 'q', '--mode', 'popular']);
    await expect(action).rejects.toThrow('Allowed choices');
    expect(credentials).not.toHaveBeenCalled();
  });

  it('honors --count and Top mode when --cursor is set', async () => {
    registerSearchCommands(program, mockContext as CliContext);
    const searchSpy = vi.spyOn(TwitterClient.prototype, 'search').mockResolvedValue({ success: true, tweets: [] });

    try {
      await program.parseAsync([
        'node',
        'bird',
        'search',
        'cats',
        '--cursor',
        'cursor-1',
        '--count',
        '20',
        '--mode',
        'top',
      ]);
      expect(searchSpy).toHaveBeenCalledWith('cats', 20, expect.objectContaining({ cursor: 'cursor-1', mode: 'Top' }));
      expect(mockContext.printTweetsResult).toHaveBeenCalledWith(expect.objectContaining({ tweets: [] }), {
        json: false,
        usePagination: true,
        emptyMessage: 'No tweets found.',
      });
    } finally {
      searchSpy.mockRestore();
    }
  });

  it.each(['0', '-1', '1.5', '20oops', 'Infinity'])('rejects invalid resumed count %s', async (count) => {
    registerSearchCommands(program, mockContext as CliContext);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        program.parseAsync(['node', 'bird', 'search', 'q', '--cursor', 'c', '--count', count]),
      ).rejects.toThrow('exit');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --count'));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
