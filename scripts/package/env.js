import { spawn } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEPT_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'USER',
  'LOGNAME',
  'CI',
  'GITHUB_ACTIONS',
];

export function checkoutRoot(fromUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(fromUrl)), '../..');
}

export function isInsideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function assertOutsideCheckout(root, candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error(`${label} must be an absolute path outside the checkout`);
  }
  if (!isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path outside the checkout`);
  }
  const resolved = resolve(candidate);
  if (isInsideRoot(root, resolved)) {
    throw new Error(`${label} must be outside the checkout: ${resolved}`);
  }
  let ancestor = resolved;
  while (true) {
    try {
      const canonical = resolve(await realpath(ancestor), relative(ancestor, resolved));
      if (isInsideRoot(await realpath(root), canonical)) {
        throw new Error(`${label} must be outside the checkout: ${canonical}`);
      }
      return canonical;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      ancestor = parent;
    }
  }
}

export async function resolveNpm() {
  const sibling = join(dirname(process.execPath), 'npm');
  try {
    await access(sibling, constants.X_OK);
    return sibling;
  } catch {
    return 'npm';
  }
}

export async function writeIsolatedNpmConfig(home) {
  await mkdir(join(home, 'tmp'), { recursive: true });
  await mkdir(join(home, 'cache'), { recursive: true });
  await mkdir(join(home, 'prefix'), { recursive: true });
  const npmrc = [
    'registry=https://registry.npmjs.org/',
    'access=public',
    'audit=false',
    'fund=false',
    'update-notifier=false',
    '',
  ].join('\n');
  await writeFile(join(home, '.npmrc'), npmrc, { mode: 0o600 });
  await writeFile(join(home, 'npmrc-global'), npmrc, { mode: 0o600 });
}

export function createIsolatedEnv(home, extra = {}) {
  const env = {};
  for (const key of KEPT_ENV) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
  env.HOME = home;
  env.TMPDIR = join(home, 'tmp');
  env.npm_config_userconfig = join(home, '.npmrc');
  env.npm_config_globalconfig = join(home, 'npmrc-global');
  env.npm_config_cache = join(home, 'cache');
  env.npm_config_prefix = join(home, 'prefix');
  env.npm_config_registry = 'https://registry.npmjs.org/';
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  env.npm_config_loglevel = 'error';
  env.NO_UPDATE_NOTIFIER = '1';
  env.BIRD_LIVE = '0';
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

export function withOfflineNpm(env) {
  return {
    ...env,
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
  };
}

export function runProcess(command, args, { cwd, env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let killTimer;
    const finish = (handler) => {
      if (settled) {
        return;
      }
      settled = true;
      handler();
    };
    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
    });
    const terminate = (signal) => {
      try {
        if (process.platform === 'win32') {
          child.kill(signal);
        } else if (child.pid) {
          process.kill(-child.pid, signal);
        }
      } catch (error) {
        if (error.code !== 'ESRCH') {
          finish(() => rejectProcess(error));
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      killTimer = setTimeout(() => terminate('SIGKILL'), 500);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      finish(() => rejectProcess(error));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      finish(() =>
        resolveProcess({
          code: code ?? 1,
          signal,
          timedOut,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        }),
      );
    });
  });
}

export function requireSuccess(result, label) {
  if (result.timedOut || result.code !== 0) {
    throw new Error(
      `${label} failed (${result.timedOut ? 'timed out' : `exit ${result.code}`})\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

export async function readGitState(root) {
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    GIT_OPTIONAL_LOCKS: '0',
  };
  try {
    const sha = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, env: gitEnv, timeoutMs: 10_000 });
    const status = await runProcess('git', ['status', '--porcelain'], { cwd: root, env: gitEnv, timeoutMs: 10_000 });
    if (sha.code !== 0 || status.code !== 0) {
      return { gitSha: null, dirty: true, status: `${sha.stderr}${status.stderr}` };
    }
    return {
      gitSha: sha.stdout.trim(),
      dirty: status.stdout.trim() !== '',
      status: status.stdout,
    };
  } catch (error) {
    return {
      gitSha: null,
      dirty: true,
      status: error instanceof Error ? error.message : 'git unavailable',
    };
  }
}

export async function readToolchain(home, npmCommand) {
  const env = createIsolatedEnv(home);
  const npm = await runProcess(npmCommand, ['--version'], { cwd: home, env, timeoutMs: 10_000 });
  requireSuccess(npm, 'npm --version');
  return {
    node: process.version,
    npm: npm.stdout.trim(),
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
  };
}

export function toolPackageVersions(root) {
  return {
    typescript: readInstalledVersion(root, 'typescript'),
    typesNode: readInstalledVersion(root, '@types/node'),
  };
}

function readInstalledVersion(root, name) {
  const pkgPath = join(root, 'node_modules', ...name.split('/'), 'package.json');
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`Cannot resolve installed version for ${name}`);
  }
  return version;
}
