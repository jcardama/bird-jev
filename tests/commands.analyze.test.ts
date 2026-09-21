import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_COMMANDS } from '../src/cli/program.js';
import type { CliContext } from '../src/cli/shared.js';
import { registerAnalyzeCommand } from '../src/commands/analyze.js';
import { analyzePosts } from '../src/lib/jev.js';
import { JEV_MODEL } from '../src/lib/jev-spec.js';

let dir: string;
let input: string;
let spec: string;
const fetchMock = vi.fn<typeof fetch>();
const resolveCredentials = vi.fn();
const log = vi.spyOn(console, 'log').mockImplementation(() => {});
const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

const posts = [
  {
    id: '1',
    text: 'First view',
    author: { username: 'reader' },
    conversationId: 'thread',
    quotedTweet: { id: 'q', text: 'Context' },
    _raw: { private: 'not-sent' },
  },
  { id: '2', text: 'Second view' },
];

beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  dir = mkdtempSync(join(tmpdir(), 'bird-analyze-test-'));
  input = join(dir, 'posts.json');
  spec = join(dir, 'tasks.json');
  writeFileSync(input, JSON.stringify(posts));
  writeFileSync(
    spec,
    JSON.stringify({
      tasks: [
        { id: 'stance', scope: 'post', instructions: 'Classify', output: { type: 'category', labels: ['yes', 'no'] } },
      ],
    }),
  );
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          model: JEV_MODEL,
          answers: { stance: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0 } } },
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      ),
  );
  log.mockClear();
  errorLog.mockClear();
  resolveCredentials.mockClear();
  process.exitCode = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

async function run(args = ['--jev', '--jev-spec', spec, '--json']) {
  const program = new Command();
  const ctx = {
    p: () => '',
    resolveCredentialsFromOptions: resolveCredentials,
    analyzePosts: (selected, tasks, options) => analyzePosts(selected, tasks, { ...options, fetch: fetchMock }),
  } as Pick<CliContext, 'p' | 'resolveCredentialsFromOptions' | 'analyzePosts'> as CliContext;
  registerAnalyzeCommand(program, ctx);
  await program.parseAsync(['analyze', '--input', input, ...args], { from: 'user' });
  return log.mock.calls.length ? JSON.parse(String(log.mock.calls[0][0])) : undefined;
}

describe('analyze supplied posts', () => {
  it('is a known command, preserves input, and uses only the allowlisted provider projection', async () => {
    expect(KNOWN_COMMANDS.has('analyze')).toBe(true);
    const report = await run();
    expect(report.data).toEqual(posts);
    expect(report.jev.selection).toMatchObject({ source: 'input', status: 'ok', postIds: ['1', '2'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveCredentials).not.toHaveBeenCalled();
    const rawBody = fetchMock.mock.calls[0][1]?.body;
    if (typeof rawBody !== 'string') {
      throw new Error('Expected a JSON request body.');
    }
    const body = JSON.parse(rawBody);
    expect(body.state).toMatchObject({ id: '1', conversationId: 'thread', quotedTweet: { id: 'q', text: 'Context' } });
    expect(JSON.stringify(body)).not.toContain('not-sent');
    expect(process.exitCode).toBe(0);
  });

  it('rejects missing consent before reading input or calling the provider', async () => {
    input = join(dir, 'absent.json');
    await run([]);
    expect(process.exitCode).toBe(2);
    expect(errorLog).toHaveBeenCalledWith('analyze requires --jev.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['key', 'spec'])('rejects a missing %s before provider access', async (missing) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    if (missing === 'key') {
      vi.stubEnv('TYPESAFE_API_KEY', '');
    }
    try {
      await expect(run(missing === 'spec' ? ['--jev'] : undefined)).rejects.toThrow('exit');
      expect(exit).toHaveBeenCalledWith(2);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it.each([
    'not-json',
    '{}',
    '[null]',
    '[{"id":"","text":"x"}]',
    '[{"id":"1","text":3}]',
    '[{"id":"1","text":"x","quotedTweet":null}]',
    '[{"id":"1","text":"x","authorId":3}]',
    '[{"id":"1","text":"x","author":{"username":3}}]',
  ])('rejects malformed input %s before provider access', async (raw) => {
    writeFileSync(input, raw);
    await run();
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized files', async () => {
    writeFileSync(input, ' '.repeat(4 * 1024 * 1024 + 1));
    await run();
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains an empty selection without provider calls', async () => {
    writeFileSync(input, '[]');
    const report = await run();
    expect(report.data).toEqual([]);
    expect(report.jev.selection.postCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('enforces the unique post cap before calls without truncating data', async () => {
    const report = await run(['--jev', '--jev-spec', spec, '--jev-max-posts', '1', '--json']);
    expect(report.data).toEqual(posts);
    expect(report.jev.error.code).toBe('post_limit');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('enforces provider payload limits before calls', async () => {
    writeFileSync(input, JSON.stringify([{ id: '1', text: 'x'.repeat(64 * 1024) }]));
    const report = await run();
    expect(report.jev.error.code).toBe('payload_limit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves valid results and emits exit 1 on an invalid individual answer', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            model: JEV_MODEL,
            answers: {
              stance: { type: 'choice', choice: 'untrusted-value', confidence: 1, probabilities: { yes: 1, no: 0 } },
            },
            usage: { input_tokens: 1, output_tokens: 2 },
          }),
        ),
    );
    const report = await run();
    expect(report.data).toEqual(posts);
    expect(report.jev.posts[0].results.stance.error.message).toBe('Category choice is not a declared label.');
    expect(report.jev.posts[1].results.stance.status).toBe('ok');
    expect(JSON.stringify(report.jev)).not.toContain('untrusted-value');
    expect(process.exitCode).toBe(1);
  });
});
