import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function checksFor(pnpmPath) {
  if (!pnpmPath || !['.js', '.cjs', '.mjs'].includes(extname(pnpmPath))) {
    throw new Error('Run this check through pnpm run check using the project-pinned pnpm CLI.');
  }
  return [
    { label: 'Build', args: ['run', 'build:dist'] },
    { label: 'Offline tests', args: ['exec', 'vitest', 'run', '--exclude', 'tests/live/**'] },
    { label: 'Lint', args: ['run', 'lint'] },
  ].map((check) => ({ ...check, command: process.execPath, args: [pnpmPath, ...check.args] }));
}

function signalExitCode(signal) {
  return 128 + (constants.signals[signal] ?? 1);
}

export async function runChecks(checks, { cwd = root, env = process.env, output = process.stdout } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bird-check-'));
  let child;
  let interrupted;
  let exitCode = 0;
  const interrupt = (signal) => {
    interrupted = signal;
    child?.kill(signal);
  };
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  try {
    for (const check of checks) {
      if (interrupted) {
        exitCode = signalExitCode(interrupted);
        break;
      }
      output.write(`Running ${check.label}...\n`);
      const logPath = join(directory, 'output.log');
      const log = await open(logPath, 'w', 0o600);
      let outcome;
      try {
        outcome = await new Promise((resolveOutcome) => {
          let launchError;
          child = spawn(check.command, check.args, {
            cwd,
            env: { ...env, BIRD_LIVE: '0' },
            shell: false,
            stdio: ['ignore', log.fd, log.fd],
          });
          child.once('error', (error) => {
            launchError = error;
          });
          child.once('close', (code, signal) => resolveOutcome({ code, signal, launchError }));
          if (interrupted) {
            child.kill(interrupted);
          }
        });
      } finally {
        child = undefined;
        await log.close();
      }
      if (interrupted || outcome.signal) {
        exitCode = signalExitCode(interrupted ?? outcome.signal);
      } else if (outcome.launchError) {
        exitCode = outcome.launchError.code === 'ENOENT' ? 127 : 1;
      } else {
        exitCode = outcome.code ?? 1;
      }
      if (exitCode !== 0) {
        output.write(`FAIL ${check.label} (exit ${exitCode})\n`);
        if (outcome.launchError) {
          output.write(`${outcome.launchError.message}\n`);
        }
        await pipeline(createReadStream(logPath), output, { end: false });
        break;
      }
      output.write(`PASS ${check.label}\n`);
    }
  } catch (error) {
    output.write(`Check runner failed: ${error.message}\n`);
    exitCode ||= 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      output.write(`Cannot remove check logs at ${directory}: ${error.message}\n`);
      exitCode ||= 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) {
      throw new Error('Use pnpm run check without arguments; run individual tools for focused checks.');
    }
    process.exitCode = await runChecks(checksFor(process.env.npm_execpath));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
