import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, USAGE } from '../scripts/check-package.js';
import { assertPatchedProvider, digestFile, readArchive, sha256Buffer } from '../scripts/package/archive.js';
import {
  assertOutsideCheckout,
  checkoutRoot,
  createIsolatedEnv,
  isInsideRoot,
  requireSuccess,
  runProcess,
  withOfflineNpm,
} from '../scripts/package/env.js';
import { readFetchLog } from '../scripts/package/fetch-mock.js';
import { BUNDLED_PACKAGE, evaluatePolicy, planArtifactSource } from '../scripts/package/policy.js';
import {
  assertReceiptMatchesArtifact,
  buildReceipt,
  receiptPathFor,
  writeReceipt,
} from '../scripts/package/receipt.js';

const root = checkoutRoot();
const runner = fileURLToPath(new URL('../scripts/check-package.js', import.meta.url));
const fixtures: string[] = [];
const ARTIFACT_EXECUTION = /Packing npm|Inspecting archive|Installing isolated|Running consumer/;

afterEach(() => {
  for (const path of fixtures.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function validPkg(overrides: Record<string, unknown> = {}) {
  return {
    name: 'bird-jev',
    version: '0.10.0',
    private: undefined,
    type: 'module',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    bin: { bird: 'dist/cli.js' },
    license: 'MIT',
    engines: { node: '>=22' },
    bundleDependencies: [BUNDLED_PACKAGE],
    publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' },
    scripts: { prepack: 'npm run build:dist' },
    dependencies: { [BUNDLED_PACKAGE]: '0.1.0' },
    ...overrides,
  };
}

function providerSource(): string {
  return 'export function patched() { return "BraveSoftware"; }\n';
}

function bundleFiles(overrides: Record<string, string> = {}) {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: BUNDLED_PACKAGE, version: '0.1.0', license: 'MIT' }),
    LICENSE: 'MIT License\n',
    'dist/providers/chromeSqliteMac.js': providerSource(),
    ...overrides,
  };
  const hashes = new Map<string, string>();
  for (const [rel, content] of Object.entries(files)) {
    hashes.set(rel, sha256(content));
  }
  return { files, hashes };
}

function fileEntry(relative: string, content: string, mode = 0o644) {
  return {
    path: `package/${relative}`,
    type: 'File' as const,
    mode,
    size: Buffer.byteLength(content),
    content: Buffer.from(content),
  };
}

function validEntries(options: { pkg?: Record<string, unknown>; bundle?: Record<string, string> } = {}) {
  const pkg = validPkg(options.pkg);
  const bundle = bundleFiles(options.bundle);
  return {
    bundle,
    entries: [
      fileEntry('package.json', JSON.stringify(pkg)),
      fileEntry('README.md', 'readme'),
      fileEntry('CHANGELOG.md', 'changes'),
      fileEntry('LICENSE', 'MIT License\n'),
      fileEntry('dist/cli.js', '#!/usr/bin/env node\nexport {};\n', 0o755),
      fileEntry('dist/index.js', 'export {};\n'),
      fileEntry('dist/index.d.ts', 'export {};\n'),
      fileEntry('dist/lib/query-ids.json', '{}'),
      fileEntry('dist/lib/features.json', '{}'),
      ...Object.entries(bundle.files).map(([rel, content]) =>
        fileEntry(`node_modules/${BUNDLED_PACKAGE}/${rel}`, content),
      ),
    ],
  };
}

async function writeTarball(
  tree: Record<string, string | { mode?: number; content: string; link?: undefined } | { link: string }>,
  mutate?: (entry: { path: string }) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), 'bird-package-tar-'));
  fixtures.push(dir);
  for (const [rel, value] of Object.entries(tree)) {
    const full = join(dir, 'package', rel);
    mkdirSync(dirname(full), { recursive: true });
    if (typeof value === 'string') {
      writeFileSync(full, value);
      continue;
    }
    if ('link' in value) {
      symlinkSync(value.link, full);
      continue;
    }
    writeFileSync(full, value.content);
    if (value.mode) {
      chmodSync(full, value.mode);
    }
  }
  const tarball = join(dir, 'package.tgz');
  await create(
    {
      gzip: true,
      file: tarball,
      cwd: dir,
      onWriteEntry: mutate,
    },
    ['package'],
  );
  return tarball;
}

describe('package gate arguments', () => {
  it('parses output and tarball reuse without packing', () => {
    expect(parseArgs(['--output', '/tmp/artifacts', '--tarball', '/tmp/bird-jev-0.10.0.tgz'])).toEqual({
      output: '/tmp/artifacts',
      tarball: '/tmp/bird-jev-0.10.0.tgz',
      help: false,
    });
    expect(planArtifactSource({ tarball: '/tmp/bird-jev-0.10.0.tgz' })).toEqual({
      action: 'reuse',
      tarball: '/tmp/bird-jev-0.10.0.tgz',
    });
    expect(planArtifactSource({})).toEqual({ action: 'pack' });
  });

  it('rejects relative output, unknown flags, and missing values', () => {
    expect(() => parseArgs(['--output', 'artifacts'])).toThrow('absolute');
    expect(() => parseArgs(['--tarball', 'package.tgz'])).toThrow('absolute');
    expect(() => parseArgs(['--dry-run'])).toThrow('Unknown argument');
    expect(() => parseArgs(['--output'])).toThrow('--output requires');
  });

  it('rejects destinations inside the checkout', async () => {
    expect(isInsideRoot(root, join(root, 'dist'))).toBe(true);
    await expect(assertOutsideCheckout(root, join(root, 'artifacts'), '--output')).rejects.toThrow(
      'outside the checkout',
    );
    await expect(assertOutsideCheckout(root, 'artifacts', '--output')).rejects.toThrow('absolute');
  });

  it('prints usage and does not pack when invoked with --help', { timeout: 10_000 }, () => {
    const child = spawnSync(process.execPath, [runner, '--help'], { encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(USAGE);
    expect(child.stderr).toBe('');
  });

  it('isolates npm from user config and keeps pack offline', () => {
    const env = createIsolatedEnv('/tmp/isolated-home');
    expect(env.npm_config_update_notifier).toBe('false');
    expect(env.NO_UPDATE_NOTIFIER).toBe('1');
    expect(env.npm_config_userconfig).toBe('/tmp/isolated-home/.npmrc');
    expect(env.npm_config_offline).toBeUndefined();
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.AUTH_TOKEN).toBeUndefined();
    expect(withOfflineNpm(env).npm_config_offline).toBe('true');
    expect(withOfflineNpm(env).npm_config_update_notifier).toBe('false');
  });

  it('fails clearly for an in-repo output directory without packing', { timeout: 10_000 }, () => {
    const child = spawnSync(process.execPath, [runner, '--output', join(root, 'artifacts')], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.status).toBe(1);
    expect(`${child.stdout}${child.stderr}`).toContain('outside the checkout');
    expect(`${child.stdout}${child.stderr}`).not.toContain('Packing npm tarball');
  });
});

describe('artifact isolation boundaries', () => {
  it('rejects dot-prefixed children and symlinked output before creating a directory', async () => {
    await expect(assertOutsideCheckout(root, join(root, '..artifacts'), '--output')).rejects.toThrow('outside');
    const dir = mkdtempSync(join(tmpdir(), 'bird-package-path-'));
    fixtures.push(dir);
    const checkout = join(dir, 'checkout');
    mkdirSync(checkout);
    const alias = join(dir, 'alias');
    symlinkSync(checkout, alias);
    await expect(assertOutsideCheckout(checkout, join(alias, 'nested'), '--output')).rejects.toThrow('outside');
    expect(existsSync(join(checkout, 'nested'))).toBe(false);
  });

  it('ends its own unresponsive process and reports the timeout', { timeout: 10_000 }, async () => {
    const child = await runProcess(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { env: createIsolatedEnv(tmpdir()), timeoutMs: 200 },
    );
    expect(child.timedOut).toBe(true);
    expect(child.code).not.toBe(0);
    expect(() => requireSuccess(child, 'synthetic child')).toThrow('timed out');
  });

  it('fails closed on malformed provider logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bird-package-fetch-'));
    fixtures.push(dir);
    const log = join(dir, 'calls.jsonl');
    writeFileSync(log, 'malformed');
    expect(() => readFetchLog(log)).toThrow(SyntaxError);
  });
});

describe('archive inspection', () => {
  it('reads actual tar paths, modes, and bytes', async () => {
    const tarball = await writeTarball({
      'package.json': '{"name":"bird-jev"}',
      'dist/cli.js': { content: '#!/usr/bin/env node\n', mode: 0o755 },
    });
    const entries = await readArchive(tarball);
    const cli = entries.find((entry) => entry.path === 'package/dist/cli.js');
    expect(cli?.type).toBe('File');
    expect((cli?.mode ?? 0) & 0o777).toBe(0o755);
    expect(cli?.content.toString('utf8')).toBe('#!/usr/bin/env node\n');
    expect(sha256Buffer(cli?.content ?? Buffer.alloc(0))).toBe(sha256('#!/usr/bin/env node\n'));
  });

  it('rejects traversal, absolute paths, and escaping links', () => {
    expect(() =>
      evaluatePolicy(
        [{ path: 'package/../secret.env', type: 'File', mode: 0o644, content: Buffer.from('x'), size: 1 }],
        {
          expectedPackage: validPkg(),
          expectedBundle: new Map(),
        },
      ),
    ).toThrow('Unsafe archive path');
    expect(() =>
      evaluatePolicy([{ path: '/etc/passwd', type: 'File', mode: 0o644, content: Buffer.from('x'), size: 1 }], {
        expectedPackage: validPkg(),
        expectedBundle: new Map(),
      }),
    ).toThrow('Absolute');
    expect(() =>
      evaluatePolicy(
        [
          {
            path: `package/node_modules/${BUNDLED_PACKAGE}`,
            type: 'SymbolicLink',
            mode: 0o777,
            linkpath: '/tmp/unpatched',
            content: Buffer.alloc(0),
            size: 0,
          },
        ],
        { expectedPackage: validPkg(), expectedBundle: new Map() },
      ),
    ).toThrow('stored a SymbolicLink');
    expect(() =>
      evaluatePolicy(
        [
          {
            path: 'package/dist/escape',
            type: 'SymbolicLink',
            mode: 0o777,
            linkpath: '../../etc/passwd',
            content: Buffer.alloc(0),
            size: 0,
          },
        ],
        { expectedPackage: validPkg(), expectedBundle: new Map() },
      ),
    ).toThrow('escapes package');
  });
});

describe('artifact policy', () => {
  it('requires the verified patch bytes even when local and bundled unpatched bytes agree', () => {
    const content = readFileSync(join(root, 'node_modules', BUNDLED_PACKAGE, 'dist/providers/chromeSqliteMac.js'));
    expect(() => assertPatchedProvider(content)).not.toThrow();
    expect(() => assertPatchedProvider(Buffer.from('unpatched'))).toThrow('verified patched bytes');
  });

  it('accepts a tight allowlist with matching patched bundle hashes', () => {
    const { entries, bundle } = validEntries();
    expect(() => evaluatePolicy(entries, { expectedPackage: validPkg(), expectedBundle: bundle.hashes })).not.toThrow();
  });

  it('rejects forbidden private files and stale generated outputs', () => {
    const { entries, bundle } = validEntries();
    expect(() =>
      evaluatePolicy(
        [...entries, fileEntry('src/cli.ts', 'export {}\n'), fileEntry('.env', 'TYPESAFE_API_KEY=secret')],
        { expectedPackage: validPkg(), expectedBundle: bundle.hashes },
      ),
    ).toThrow('Forbidden archive path');
    expect(() =>
      evaluatePolicy([...entries, fileEntry('dist/stale-secret.txt', 'nope')], {
        expectedPackage: validPkg(),
        expectedBundle: bundle.hashes,
      }),
    ).toThrow('Forbidden archive path');
  });

  it('rejects a missing bundle instead of copying the pnpm layout', () => {
    const { entries, bundle } = validEntries();
    const withoutBundle = entries.filter((entry) => !entry.path.includes('node_modules'));
    expect(() => evaluatePolicy(withoutBundle, { expectedPackage: validPkg(), expectedBundle: bundle.hashes })).toThrow(
      'did not include @steipete/sweet-cookie file contents',
    );
  });

  it('rejects the wrong package version and consumer install hooks', () => {
    const wrongVersion = validEntries({ pkg: { version: '0.9.0' } });
    expect(() =>
      evaluatePolicy(wrongVersion.entries, { expectedPackage: validPkg(), expectedBundle: wrongVersion.bundle.hashes }),
    ).toThrow('version 0.9.0 does not match 0.10.0');

    const hooked = validEntries({
      pkg: { scripts: { prepack: 'npm run build:dist', prepare: 'true', postinstall: 'true' } },
    });
    expect(() =>
      evaluatePolicy(hooked.entries, { expectedPackage: validPkg(), expectedBundle: hooked.bundle.hashes }),
    ).toThrow('consumer hook');
  });

  it('rejects changed patched bytes and a missing project license', () => {
    const { entries, bundle } = validEntries();
    const changed = entries.map((entry) =>
      entry.path.endsWith('chromeSqliteMac.js')
        ? { ...entry, content: Buffer.from('export function patched() { return "unpatched"; }\n') }
        : entry,
    );
    expect(() => evaluatePolicy(changed, { expectedPackage: validPkg(), expectedBundle: bundle.hashes })).toThrow(
      'does not match the patched local bytes',
    );

    const noLicense = validEntries();
    const withoutLicense = noLicense.entries.filter((entry) => entry.path !== 'package/LICENSE');
    expect(() =>
      evaluatePolicy(withoutLicense, { expectedPackage: validPkg(), expectedBundle: noLicense.bundle.hashes }),
    ).toThrow('Missing required file package/LICENSE');
  });

  it('requires dist/cli.js mode 0755 and a Node shebang', () => {
    const unexec = validEntries();
    unexec.entries = unexec.entries.map((entry) =>
      entry.path === 'package/dist/cli.js' ? { ...entry, mode: 0o644 } : entry,
    );
    expect(() =>
      evaluatePolicy(unexec.entries, { expectedPackage: validPkg(), expectedBundle: unexec.bundle.hashes }),
    ).toThrow('mode 644 is not 0755');

    const noshebang = validEntries();
    noshebang.entries = noshebang.entries.map((entry) =>
      entry.path === 'package/dist/cli.js' ? { ...entry, content: Buffer.from('export {}\n') } : entry,
    );
    expect(() =>
      evaluatePolicy(noshebang.entries, { expectedPackage: validPkg(), expectedBundle: noshebang.bundle.hashes }),
    ).toThrow('shebang');
  });
});

describe('receipt identity', () => {
  it.each(['missing', 'digest', 'source'] as const)(
    'rejects %s provenance before inspecting or executing a reused artifact',
    { timeout: 10_000 },
    async (failure) => {
      const dir = mkdtempSync(join(tmpdir(), 'bird-package-reuse-'));
      fixtures.push(dir);
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const filename = `${pkg.name}-${pkg.version}.tgz`;
      const tarball = join(dir, filename);
      writeFileSync(tarball, 'must-not-be-opened-as-an-archive');
      const digest = await digestFile(tarball);
      const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 });
      expect(git.status).toBe(0);
      const receipt = buildReceipt({
        pkg,
        source: { gitSha: failure === 'source' ? 'f'.repeat(40) : git.stdout.trim(), dirty: true },
        toolchain: { node: process.version, npm: 'test' },
        artifact: {
          filename,
          ...digest,
          sha256: failure === 'digest' ? '0'.repeat(64) : digest.sha256,
        },
        bundleFiles: new Map(),
        verification: {
          policy: 'pass',
          install: 'pass',
          cli: 'pass',
          esm: 'pass',
          typescript: 'pass',
          analyze: 'pass',
        },
        pack: 'created',
      });
      if (failure !== 'missing') {
        await writeReceipt(receiptPathFor(tarball, pkg), receipt);
      }
      const output = join(dir, 'output');
      mkdirSync(join(dir, 'home', 'tmp'), { recursive: true });
      const result = spawnSync(process.execPath, [runner, '--tarball', tarball, '--output', output], {
        cwd: root,
        env: createIsolatedEnv(join(dir, 'home')),
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        failure === 'missing'
          ? `${pkg.name}-${pkg.version}.receipt.json`
          : failure === 'digest'
            ? 'sha256'
            : 'source commit',
      );
      expect(result.stdout).not.toMatch(ARTIFACT_EXECUTION);
      expect(existsSync(receiptPathFor(join(output, filename), pkg))).toBe(false);
    },
  );

  it('does not overwrite an existing original receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bird-package-receipt-'));
    fixtures.push(dir);
    const path = join(dir, 'receipt.json');
    await writeReceipt(path, { original: true });
    await expect(writeReceipt(path, { original: false })).rejects.toThrow('EEXIST');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ original: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('records dirty candidates and refuses a digest mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bird-package-receipt-'));
    fixtures.push(dir);
    const tarball = join(dir, 'bird-jev-0.10.0.tgz');
    writeFileSync(tarball, 'artifact-bytes');
    const digest = await digestFile(tarball);
    const receipt = buildReceipt({
      pkg: { name: 'bird-jev', version: '0.10.0' },
      source: { gitSha: 'a'.repeat(40), dirty: true },
      toolchain: { node: 'v24.20.0', npm: '11.16.0' },
      artifact: { filename: 'bird-jev-0.10.0.tgz', ...digest },
      bundleFiles: new Map([['dist/providers/chromeSqliteMac.js', sha256(providerSource())]]),
      verification: { policy: 'pass', install: 'pass', cli: 'pass', esm: 'pass', typescript: 'pass', analyze: 'pass' },
      pack: 'created',
    });
    expect(receipt.source.dirty).toBe(true);
    expect(receiptPathFor(tarball, { name: 'bird-jev', version: '0.10.0' })).toBe(
      join(dir, 'bird-jev-0.10.0.receipt.json'),
    );
    expect(() => assertReceiptMatchesArtifact(receipt, digest, { name: 'bird-jev', version: '0.10.0' })).not.toThrow();
    expect(() =>
      assertReceiptMatchesArtifact(
        receipt,
        { ...digest, sha256: '0'.repeat(64) },
        { name: 'bird-jev', version: '0.10.0' },
      ),
    ).toThrow('does not match original receipt');
  });
});
