import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseStableTag, validateReleaseArtifact, validateReleaseIdentity } from '../scripts/package/release.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = parse(await readFile(join(root, '.github/workflows/publish.yml'), 'utf8')) as {
  jobs: Record<
    string,
    { env?: Record<string, string>; permissions?: Record<string, string>; steps: Array<Record<string, unknown>> }
  >;
  on: { release: { types: string[] } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
};
const publishStep = workflow.jobs.publish.steps.find((step) => step.name === 'Publish verified package');
const publisher = publishStep?.run;
const fixtures: string[] = [];
const sha = 'a'.repeat(40);
const INVALID_STABLE_TAG = /stable|Unsupported|leading zero/;

if (typeof publisher !== 'string') {
  throw new Error('Publish workflow has no inline publisher');
}

afterEach(async () => {
  for (const path of fixtures.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function digest(bytes: Buffer) {
  const sha512 = createHash('sha512').update(bytes).digest();
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha512: sha512.toString('hex'),
    sha1: createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${sha512.toString('base64')}`,
  };
}

function metadata(version: string, artifact = digest(Buffer.from('verified artifact'))) {
  return {
    name: 'bird-jev',
    version,
    dist: { integrity: artifact.integrity, shasum: artifact.sha1 },
    bin: { bird: 'dist/cli.js' },
  };
}

function receipt(version: string, artifact: ReturnType<typeof digest> = digest(Buffer.from('verified artifact'))) {
  return {
    schemaVersion: 1,
    source: { gitSha: sha, dirty: false },
    package: { name: 'bird-jev', version },
    artifact: {
      filename: `bird-jev-${version}.tgz`,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      sha512: artifact.sha512,
      integrity: artifact.integrity,
    },
    verification: {
      pack: 'created',
      policy: 'pass',
      install: 'pass',
      cli: 'pass',
      esm: 'pass',
      typescript: 'pass',
      analyze: 'pass',
    },
  };
}

type PublisherOptions = {
  version?: string;
  bytes?: Buffer;
  receipt?: unknown;
  responses?: Array<Response | Error>;
  npmResult?: { status: number; stdout?: string; stderr?: string };
  entries?: Array<{ name: string; type?: 'file' | 'symlink' | 'directory' }>;
  env?: Record<string, string>;
};

async function runPublisher(options: PublisherOptions = {}) {
  const version = options.version ?? '0.10.1';
  const bytes = options.bytes ?? Buffer.from('verified artifact');
  const artifact = digest(bytes);
  const artifactDir = '/artifact';
  const tarball = `${artifactDir}/bird-jev-${version}.tgz`;
  const receiptPath = `${artifactDir}/bird-jev-${version}.receipt.json`;
  const files = new Map<string, Buffer | string>([
    [tarball, bytes],
    [receiptPath, JSON.stringify(options.receipt === undefined ? receipt(version, artifact) : options.receipt)],
  ]);
  const entries = options.entries ?? [
    { name: `bird-jev-${version}.tgz` },
    { name: `bird-jev-${version}.receipt.json` },
  ];
  const responses = [...(options.responses ?? [])];
  const fetches: string[] = [];
  const publishes: Array<{ args: string[]; env: Record<string, string> }> = [];
  const timers: number[] = [];
  const logs: string[] = [];
  const baseEnv = {
    RELEASE_TAG: `v${version}`,
    RELEASE_SHA: sha,
    VERIFY_SHA: sha,
    VERIFY_VERSION: version,
    VERIFY_FILENAME: `bird-jev-${version}.tgz`,
    VERIFY_ARTIFACT_DIGEST: artifact.sha256,
    ARTIFACT_DIR: artifactDir,
    GITHUB_SHA: sha,
    PATH: '/bin',
    GITHUB_ACTIONS: 'true',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'jcardama/bird-jev',
    GITHUB_REPOSITORY_ID: '1',
    GITHUB_REPOSITORY_OWNER_ID: '2',
    GITHUB_RUN_ID: '3',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REF: `refs/tags/v${version}`,
    GITHUB_EVENT_NAME: 'release',
    GITHUB_WORKFLOW_REF: 'jcardama/bird-jev/.github/workflows/publish.yml@refs/tags/v0.10.1',
    GITHUB_WORKFLOW_SHA: sha,
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_TEMP: '/tmp',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/request',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-token',
    NODE_AUTH_TOKEN: 'must-not-survive',
    NPM_TOKEN: 'must-not-survive',
    GITHUB_STEP_SUMMARY: '/summary',
    ...options.env,
  };

  let resolveExit: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const fs = {
    readdirSync(path: string) {
      if (path !== artifactDir) {
        throw new Error(`Unexpected directory read: ${path}`);
      }
      return entries.map((entry) => ({
        name: entry.name,
        isSymbolicLink: () => entry.type === 'symlink',
      }));
    },
    lstatSync(path: string) {
      const name = path.slice(artifactDir.length + 1);
      const entry = entries.find((candidate) => candidate.name === name);
      if (!entry) {
        throw new Error(`Unexpected stat: ${path}`);
      }
      return {
        isSymbolicLink: () => entry.type === 'symlink',
        isFile: () => (entry.type ?? 'file') === 'file',
      };
    },
    readFileSync(path: string, encoding?: string) {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`Unexpected file read: ${path}`);
      }
      if (encoding === 'utf8') {
        return Buffer.isBuffer(value) ? value.toString('utf8') : value;
      }
      return Buffer.isBuffer(value) ? value : Buffer.from(value);
    },
    mkdtempSync(prefix: string) {
      return `${prefix}home`;
    },
    mkdirSync() {},
    writeFileSync(path: string, value: string) {
      files.set(path, value);
    },
    appendFileSync(path: string, value: string) {
      files.set(path, value);
      logs.push(value);
    },
  };
  const sandbox = createContext({
    AbortSignal: { timeout: (ms: number) => ({ ms }) },
    Buffer,
    console: { error: (...values: unknown[]) => logs.push(values.join(' ')) },
    fetch: async (url: string) => {
      fetches.push(url);
      const next = responses.shift();
      if (!next) {
        throw new Error(`Unexpected registry request: ${url}`);
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    process: {
      env: baseEnv,
      exit: (code: number) => resolveExit(code),
      exitCode: undefined,
      versions: { node: '24.20.0' },
    },
    require(name: string) {
      if (name === 'node:fs') {
        return fs;
      }
      if (name === 'node:path') {
        return awaitlessPath;
      }
      if (name === 'node:os') {
        return { tmpdir: () => '/tmp' };
      }
      if (name === 'node:crypto') {
        return { createHash };
      }
      if (name === 'node:child_process') {
        return {
          spawnSync(command: string, args: string[], spawnOptions?: { env?: Record<string, string> }) {
            if (command !== 'npm') {
              throw new Error(`Unexpected command: ${command}`);
            }
            if (args[0] === '--version') {
              return { status: 0, stdout: '11.16.0\n', stderr: '' };
            }
            publishes.push({ args, env: spawnOptions?.env ?? {} });
            return {
              status: options.npmResult?.status ?? 0,
              stdout: options.npmResult?.stdout ?? '',
              stderr: options.npmResult?.stderr ?? '',
            };
          },
        };
      }
      throw new Error(`Unexpected module import: ${name}`);
    },
    setTimeout(callback: () => void, ms: number) {
      timers.push(ms);
      callback();
      return 1;
    },
  });
  // vm tests execute the workflow's trusted inline block with only its declared boundaries.
  new Script(publisher).runInContext(sandbox, { timeout: 1000 });
  const code = await exited;
  return { artifact, code, fetches, logs, publishes, timers };
}

const awaitlessPath = {
  join: (...parts: string[]) => parts.join('/').replaceAll('//', '/'),
};

function registryJson(status: number, body?: object): Response {
  return {
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

describe('publish workflow contract', () => {
  it('keeps the release trigger, artifact handoff, and least-privilege boundaries', () => {
    expect(workflow.on.release.types).toEqual(['published']);
    expect(workflow.concurrency).toEqual({ group: 'npm-publish-bird-jev', 'cancel-in-progress': false });
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.verify.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.publish.permissions).toEqual({ 'id-token': 'write' });
    expect(workflow.jobs.verify.env?.RELEASE_SHA).toContain('github.sha');
    expect(workflow.jobs.publish.env?.VERIFY_ARTIFACT_DIGEST).toContain('needs.verify.outputs.artifactDigest');
    expect(JSON.stringify(workflow.jobs.publish.steps)).not.toContain('actions/checkout');
    expect(JSON.stringify(workflow.jobs.publish.steps)).not.toContain('pnpm install');
    expect(JSON.stringify(workflow.jobs.publish.steps)).not.toContain('npm run build');
    const download = workflow.jobs.publish.steps.find((step) => step.name === 'Download verified artifact');
    if (!download) {
      throw new Error('Publish workflow does not download its verified artifact');
    }
    expect((download.with as Record<string, string>)['artifact-ids']).toBe(`\${{ needs.verify.outputs.artifact-id }}`);
    const publisherNode = workflow.jobs.publish.steps.find((step) => step.name === 'Setup Node.js');
    if (!publisherNode) {
      throw new Error('Publish workflow does not configure Node');
    }
    expect((publisherNode.with as Record<string, string>)['node-version']).toBe('24');
    expect((publisherNode.with as Record<string, string>).cache).toBeUndefined();
    expect(workflow.jobs.verify.env).not.toHaveProperty('ARTIFACT_DIR');
    expect(workflow.jobs.verify.steps.find((step) => step.name === 'Install dependencies')?.run as string).toBe(
      'pnpm install --frozen-lockfile --ignore-scripts',
    );
    expect(workflow.jobs.verify.steps.find((step) => step.name === 'Pin npm')?.run as string).toBe(
      'npm install -g npm@11.16.0 --ignore-scripts',
    );
    expect(workflow.jobs.publish.steps.find((step) => step.name === 'Pin npm')?.run as string).toBe(
      'npm install -g npm@11.16.0 --ignore-scripts',
    );
    expect(JSON.stringify(workflow.jobs.verify.steps)).toContain('Node 22.14+');
    expect(workflow.jobs.verify.steps.find((step) => step.name === 'Verify npm artifact')?.run as string).toBe(
      'pnpm run check:package --output "$ARTIFACT_DIR"',
    );
  });

  it('publishes once with an isolated OIDC/provenance environment', async () => {
    const result = await runPublisher({
      responses: [
        registryJson(404),
        registryJson(200, { 'dist-tags': { latest: '0.10.0' } }),
        registryJson(200, metadata('0.10.1')),
      ],
    });
    expect(result.code).toBe(0);
    expect(result.publishes).toHaveLength(1);
    expect(result.publishes[0]?.args).toEqual([
      'publish',
      '/artifact/bird-jev-0.10.1.tgz',
      '--ignore-scripts',
      '--access',
      'public',
      '--tag',
      'latest',
      '--registry',
      'https://registry.npmjs.org/',
    ]);
    expect(result.publishes[0]?.env).toMatchObject({
      HOME: '/tmp/bird-jev-publish-home',
      npm_config_userconfig: '/tmp/bird-jev-publish-home/.npmrc',
      npm_config_registry: 'https://registry.npmjs.org/',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/request',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-token',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY_ID: '1',
      GITHUB_REPOSITORY_OWNER_ID: '2',
      RUNNER_ENVIRONMENT: 'github-hosted',
    });
    expect(result.publishes[0]?.env).not.toHaveProperty('NODE_AUTH_TOKEN');
    expect(result.publishes[0]?.env).not.toHaveProperty('NPM_TOKEN');
  });

  it('skips an exactly matching immutable version without publishing or tag writes', async () => {
    const result = await runPublisher({ responses: [registryJson(200, metadata('0.10.1'))] });
    expect(result.code).toBe(0);
    expect(result.publishes).toHaveLength(0);
    expect(result.fetches).toHaveLength(1);
  });

  it.each([
    ['mismatched immutable artifact', [registryJson(200, metadata('0.10.1', digest(Buffer.from('other'))))]],
    ['only 404 absence', [registryJson(404), registryJson(404)]],
    ['registry authentication error', [registryJson(401)]],
    ['registry forbidden error', [registryJson(403)]],
    ['registry server error', [registryJson(500)]],
    ['unsupported latest', [registryJson(404), registryJson(200, { 'dist-tags': { latest: '1.0.0-beta' } })]],
    ['registry network error', [new Error('network down')]],
    ['malformed registry JSON', [{ status: 200, text: async () => 'not json' } as Response]],
    ['equal latest', [registryJson(404), registryJson(200, { 'dist-tags': { latest: '0.10.1' } })]],
    ['newer latest', [registryJson(404), registryJson(200, { 'dist-tags': { latest: '0.10.2' } })]],
  ])('fails closed for %s', async (_name, responses) => {
    const result = await runPublisher({ responses });
    expect(result.code).toBe(1);
    expect(result.publishes).toHaveLength(0);
    expect(result.logs.join('\n')).toContain('outcome: failed');
  });

  it.each([
    { VERIFY_SHA: 'b'.repeat(40) },
    { GITHUB_SHA: 'b'.repeat(40) },
    { RELEASE_TAG: 'v0.10.2' },
    { VERIFY_FILENAME: '../other.tgz' },
    { VERIFY_ARTIFACT_DIGEST: 'b'.repeat(64) },
  ])('rejects mismatched publisher inputs %j before contacting npm', async (env) => {
    const result = await runPublisher({ env });
    expect(result.code).toBe(1);
    expect(result.fetches).toHaveLength(0);
    expect(result.publishes).toHaveLength(0);
  });

  it.each([
    ['null', null],
    ['schema', { ...receipt('0.10.1'), schemaVersion: 2 }],
    ['dirty source', { ...receipt('0.10.1'), source: { gitSha: sha, dirty: true } }],
    ['source SHA', { ...receipt('0.10.1'), source: { gitSha: 'b'.repeat(40), dirty: false } }],
    ['package', { ...receipt('0.10.1'), package: { name: 'other', version: '0.10.1' } }],
    ['version', { ...receipt('0.10.1'), package: { name: 'bird-jev', version: '0.10.2' } }],
    ['missing verification', { ...receipt('0.10.1'), verification: {} }],
    ['pack', { ...receipt('0.10.1'), verification: { ...receipt('0.10.1').verification, pack: 'reused' } }],
    ...['filename', 'bytes', 'sha256', 'sha512', 'integrity'].map((field) => [
      field,
      { ...receipt('0.10.1'), artifact: { ...receipt('0.10.1').artifact, [field]: 'mismatch' } },
    ]),
  ])('rejects invalid receipt %s before contacting npm', async (_label, invalidReceipt) => {
    const result = await runPublisher({ receipt: invalidReceipt });
    expect(result.code).toBe(1);
    expect(result.fetches).toHaveLength(0);
    expect(result.publishes).toHaveLength(0);
  });

  it('compares versions beyond Number precision using BigInt', async () => {
    const result = await runPublisher({
      version: '9007199254740993.0.0',
      responses: [
        registryJson(404),
        registryJson(200, { 'dist-tags': { latest: '9007199254740992.0.0' } }),
        registryJson(200, metadata('9007199254740993.0.0')),
      ],
    });
    expect(result.code).toBe(0);
    expect(result.publishes).toHaveLength(1);
  });

  it('does not retry publish while waiting for registry visibility', async () => {
    const result = await runPublisher({
      responses: [
        registryJson(404),
        registryJson(200, { 'dist-tags': { latest: '0.10.0' } }),
        registryJson(404),
        registryJson(200, metadata('0.10.1')),
      ],
    });
    expect(result.code).toBe(0);
    expect(result.publishes).toHaveLength(1);
    expect(result.timers).toEqual([3000]);
  });

  it('fails after bounded visibility polling without another publish attempt', async () => {
    const result = await runPublisher({
      responses: [
        registryJson(404),
        registryJson(200, { 'dist-tags': { latest: '0.10.0' } }),
        ...Array.from({ length: 8 }, () => registryJson(404)),
      ],
    });
    expect(result.code).toBe(1);
    expect(result.publishes).toHaveLength(1);
    expect(result.timers).toHaveLength(7);
  });

  it('does not retry a failed npm publish', async () => {
    const result = await runPublisher({
      npmResult: { status: 1, stdout: 'publish failed', stderr: 'denied' },
      responses: [registryJson(404), registryJson(200, { 'dist-tags': { latest: '0.10.0' } })],
    });
    expect(result.code).toBe(1);
    expect(result.publishes).toHaveLength(1);
  });

  it.each([
    [
      'a symlink',
      [{ name: 'bird-jev-0.10.1.tgz', type: 'symlink' as const }, { name: 'bird-jev-0.10.1.receipt.json' }],
    ],
    [
      'an unexpected file',
      [{ name: 'bird-jev-0.10.1.tgz' }, { name: 'bird-jev-0.10.1.receipt.json' }, { name: 'extra' }],
    ],
  ])('rejects artifact directories containing %s', async (_name, entries) => {
    const result = await runPublisher({ entries, responses: [] });
    expect(result.code).toBe(1);
    expect(result.publishes).toHaveLength(0);
  });
});

async function createGitFixture() {
  const fixture = await mkdtemp(join(tmpdir(), 'bird-release-'));
  fixtures.push(fixture);
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'bird-jev',
      version: '0.10.1',
      repository: { url: 'git+https://github.com/jcardama/bird-jev.git' },
    }),
  );
  runGit(fixture, ['init', '--initial-branch=main']);
  runGit(fixture, ['config', 'user.email', 'release-test@example.invalid']);
  runGit(fixture, ['config', 'user.name', 'Release Test']);
  runGit(fixture, ['add', 'package.json']);
  runGit(fixture, ['commit', '-m', 'release fixture']);
  const gitSha = runGit(fixture, ['rev-parse', 'HEAD']).stdout.trim();
  runGit(fixture, ['tag', 'v0.10.1']);
  runGit(fixture, ['update-ref', 'refs/remotes/origin/main', gitSha]);
  await writeFile(join(fixture, '.git/info/exclude'), 'event.json\nartifact/\noutput\n');
  const eventPath = join(fixture, 'event.json');
  await writeFile(
    eventPath,
    JSON.stringify({ action: 'published', release: { tag_name: 'v0.10.1', draft: false, prerelease: false } }),
  );
  const env = {
    RELEASE_TAG: 'v0.10.1',
    RELEASE_SHA: gitSha,
    GITHUB_SHA: gitSha,
    GITHUB_REPOSITORY: 'jcardama/bird-jev',
    GITHUB_REF: 'refs/tags/v0.10.1',
    GITHUB_EVENT_NAME: 'release',
    GITHUB_EVENT_PATH: eventPath,
  };
  return { env, fixture, gitSha };
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result;
}

describe('release identity and artifact eligibility', () => {
  it('requires a three-part stable tag without leading zeroes', () => {
    expect(parseStableTag('v0.10.1')).toBe('0.10.1');
    for (const tag of ['0.10.1', 'v0.10', 'v01.10.1', 'v0.10.1-beta']) {
      expect(() => parseStableTag(tag)).toThrow(INVALID_STABLE_TAG);
    }
  });

  it('requires canonical GitHub repository and origin/main ancestry', async () => {
    const fixture = await createGitFixture();
    await expect(validateReleaseIdentity({ root: fixture.fixture, env: fixture.env })).resolves.toMatchObject({
      tag: 'v0.10.1',
      sha: fixture.gitSha,
    });
    await expect(
      validateReleaseIdentity({ root: fixture.fixture, env: { ...fixture.env, GITHUB_REPOSITORY: 'fork/bird-jev' } }),
    ).rejects.toThrow('GITHUB_REPOSITORY');
    runGit(fixture.fixture, ['update-ref', '-d', 'refs/remotes/origin/main']);
    await expect(validateReleaseIdentity({ root: fixture.fixture, env: fixture.env })).rejects.toThrow(
      'refs/remotes/origin/main',
    );
  });

  it('rejects mismatched event SHA, tag version, and a dirty checkout', async () => {
    const { fixture, env } = await createGitFixture();
    await expect(
      validateReleaseIdentity({ root: fixture, env: { ...env, RELEASE_SHA: 'b'.repeat(40) } }),
    ).rejects.toThrow('GITHUB_SHA');
    await expect(
      validateReleaseIdentity({
        root: fixture,
        env: { ...env, RELEASE_SHA: 'b'.repeat(40), GITHUB_SHA: 'b'.repeat(40) },
      }),
    ).rejects.toThrow('Checked-out SHA');
    await writeFile(join(fixture, 'unexpected'), 'dirty');
    await expect(validateReleaseIdentity({ root: fixture, env })).rejects.toThrow('Working tree is dirty');
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({
        name: 'bird-jev',
        version: '0.10.2',
        repository: { url: 'git+https://github.com/jcardama/bird-jev.git' },
      }),
    );
    await expect(validateReleaseIdentity({ root: fixture, env })).rejects.toThrow('does not match tag version');
  });

  it('rejects a tagged commit outside origin/main history', async () => {
    const { fixture, env } = await createGitFixture();
    runGit(fixture, ['commit', '--allow-empty', '-m', 'unmerged commit']);
    const unmergedSha = runGit(fixture, ['rev-parse', 'HEAD']).stdout.trim();
    runGit(fixture, ['tag', '-f', 'v0.10.1']);
    await expect(
      validateReleaseIdentity({ root: fixture, env: { ...env, RELEASE_SHA: unmergedSha, GITHUB_SHA: unmergedSha } }),
    ).rejects.toThrow('is not an ancestor');
  });

  it('rejects dirty, malformed, tampered, and symlinked release artifacts', async () => {
    const fixture = await createGitFixture();
    const artifactDir = join(fixture.fixture, 'artifact');
    await mkdir(artifactDir);
    const bytes = Buffer.from('artifact');
    const artifact = digest(bytes);
    const receiptData = receipt('0.10.1', artifact);
    receiptData.source.gitSha = fixture.gitSha;
    await writeFile(join(artifactDir, 'bird-jev-0.10.1.tgz'), bytes);
    await writeFile(join(artifactDir, 'bird-jev-0.10.1.receipt.json'), JSON.stringify(receiptData));
    const output = join(fixture.fixture, 'output');
    const env = { ...fixture.env, ARTIFACT_DIR: artifactDir, GITHUB_OUTPUT: output };
    await expect(
      validateReleaseArtifact({
        root: fixture.fixture,
        env,
        loadReceipt: () => import('../scripts/package/receipt.js'),
      }),
    ).resolves.toMatchObject({ filename: 'bird-jev-0.10.1.tgz' });
    await writeFile(join(artifactDir, 'bird-jev-0.10.1.tgz'), 'tampered');
    await expect(
      validateReleaseArtifact({
        root: fixture.fixture,
        env,
        loadReceipt: () => import('../scripts/package/receipt.js'),
      }),
    ).rejects.toThrow('sha512');
    await writeFile(join(artifactDir, 'bird-jev-0.10.1.tgz'), bytes);
    await writeFile(join(artifactDir, 'bird-jev-0.10.1.receipt.json'), 'not json');
    await expect(
      validateReleaseArtifact({
        root: fixture.fixture,
        env,
        loadReceipt: () => import('../scripts/package/receipt.js'),
      }),
    ).rejects.toThrow('Unexpected token');
    receiptData.source.dirty = true;
    await writeFile(join(artifactDir, 'bird-jev-0.10.1.receipt.json'), JSON.stringify(receiptData));
    await expect(
      validateReleaseArtifact({
        root: fixture.fixture,
        env,
        loadReceipt: () => import('../scripts/package/receipt.js'),
      }),
    ).rejects.toThrow('clean source');
    rmSync(join(artifactDir, 'bird-jev-0.10.1.receipt.json'));
    await symlink('bird-jev-0.10.1.tgz', join(artifactDir, 'bird-jev-0.10.1.receipt.json'));
    await expect(
      validateReleaseArtifact({
        root: fixture.fixture,
        env,
        loadReceipt: () => import('../scripts/package/receipt.js'),
      }),
    ).rejects.toThrow('symlink');
  });
});
