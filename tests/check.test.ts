import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checksFor, runChecks } from '../scripts/check.js';

const runnerUrl = new URL('../scripts/check.js', import.meta.url);

function stage(label: string, source: string) {
  return { label, command: process.execPath, args: ['-e', source] };
}

function capture() {
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { output, text: () => text };
}

describe('offline check runner', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'bird check tests '));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('defines only the build, explicitly offline tests, and lint stages', () => {
    const pnpm = join(cwd, 'pnpm.cjs');
    expect(checksFor(pnpm)).toEqual([
      { label: 'Build', command: process.execPath, args: [pnpm, 'run', 'build:dist'] },
      {
        label: 'Offline tests',
        command: process.execPath,
        args: [pnpm, 'exec', 'vitest', 'run', '--exclude', 'tests/live/**'],
      },
      { label: 'Lint', command: process.execPath, args: [pnpm, 'run', 'lint'] },
    ]);
    expect(() => checksFor(undefined)).toThrow('pnpm run check');
    expect(() => checksFor('pnpm.cmd')).toThrow('pnpm run check');
  });

  it('runs serially, overrides live mode, and keeps successful child output quiet', async () => {
    const captured = capture();
    const result = await runChecks(
      [
        stage(
          'first',
          "require('node:fs').writeFileSync('order', process.env.BIRD_LIVE); console.log('hidden stdout'); console.error('hidden stderr');",
        ),
        stage('second', "require('node:fs').appendFileSync('order', ' second');"),
      ],
      { cwd, env: { ...process.env, BIRD_LIVE: '1' }, output: captured.output },
    );
    expect(result).toBe(0);
    expect(await readFile(join(cwd, 'order'), 'utf8')).toBe('0 second');
    expect(captured.text()).toBe('Running first...\nPASS first\nRunning second...\nPASS second\n');
  });

  it('replays complete failed output, preserves the code, and skips later stages', async () => {
    const captured = capture();
    const result = await runChecks(
      [
        stage(
          'failure',
          "const fs = require('node:fs'); fs.writeSync(1, 'stdout\\n' + 'x'.repeat(2 * 1024 * 1024)); fs.writeSync(2, '\\nstderr\\n'); process.exitCode = 7;",
        ),
        stage('unreachable', "throw new Error('must not run');"),
      ],
      { cwd, output: captured.output },
    );
    expect(result).toBe(7);
    expect(captured.text()).toBe(
      `Running failure...\nFAIL failure (exit 7)\nstdout\n${'x'.repeat(2 * 1024 * 1024)}\nstderr\n`,
    );
  });

  it('reports missing executables once and stops', async () => {
    const captured = capture();
    const result = await runChecks(
      [{ label: 'missing', command: join(cwd, 'no-such-program'), args: [] }, stage('unreachable', '')],
      { cwd, output: captured.output },
    );
    expect(result).toBe(127);
    expect(captured.text()).toContain('FAIL missing (exit 127)');
    expect(captured.text()).toContain('ENOENT');
    expect(captured.text()).not.toContain('unreachable');
  });

  it('preserves literal arguments and a working directory containing spaces', async () => {
    const captured = capture();
    const check = stage('arguments', 'require("node:fs").writeFileSync("argument", process.argv[1]);');
    check.args.push('space and * shell $ punctuation');
    expect(await runChecks([check], { cwd, output: captured.output })).toBe(0);
    expect(await readFile(join(cwd, 'argument'), 'utf8')).toBe('space and * shell $ punctuation');
  });

  it('invokes a package-manager entry whose path contains spaces and removes its logs', async () => {
    const pnpm = join(cwd, 'fake pnpm.cjs');
    await writeFile(
      pnpm,
      "require('node:fs').appendFileSync('commands', JSON.stringify(process.argv.slice(2)) + '\\n');",
    );
    const logsBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('bird-check-')));
    const captured = capture();
    expect(await runChecks(checksFor(pnpm), { cwd, output: captured.output })).toBe(0);
    const commands = (await readFile(join(cwd, 'commands'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(commands).toEqual([
      ['run', 'build:dist'],
      ['exec', 'vitest', 'run', '--exclude', 'tests/live/**'],
      ['run', 'lint'],
    ]);
    const remaining = (await readdir(tmpdir())).filter(
      (name) => name.startsWith('bird-check-') && !logsBefore.has(name),
    );
    expect(remaining).toEqual([]);
  });

  it('does not run checks when imported', () => {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(runnerUrl.href)})`],
      {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('');
  });

  it('fails clearly when invoked outside pnpm', () => {
    const child = spawnSync(process.execPath, [fileURLToPath(runnerUrl)], {
      cwd,
      env: { ...process.env, npm_execpath: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('pnpm run check');
  });

  it('treats a child signal as failure', { skip: process.platform === 'win32' }, async () => {
    const captured = capture();
    const result = await runChecks([stage('terminated', 'process.kill(process.pid, "SIGTERM");')], {
      cwd,
      output: captured.output,
    });
    expect(result).toBe(143);
    expect(captured.text()).toContain('FAIL terminated (exit 143)');
  });

  it('forwards cancellation to its child and stops scheduling', { skip: process.platform === 'win32' }, () => {
    const checks = [
      stage('waiting', 'setInterval(() => {}, 1000); process.kill(process.ppid, "SIGTERM");'),
      stage('unreachable', ''),
    ];
    const source = `const { runChecks } = await import(${JSON.stringify(runnerUrl.href)}); process.exitCode = await runChecks(${JSON.stringify(checks)});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(143);
    expect(child.stdout).toContain('FAIL waiting (exit 143)');
    expect(child.stdout).not.toContain('unreachable');
  });
});
