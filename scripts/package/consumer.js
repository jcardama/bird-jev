import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashPackageTree } from './archive.js';
import { requireSuccess, runProcess, toolPackageVersions } from './env.js';
import { JEV_PROVIDER_URL, readFetchLog } from './fetch-mock.js';
import { BUNDLED_PACKAGE } from './policy.js';

const SYNTHETIC_KEY = 'synthetic-package-gate-key';
const PUBLIC_EXPORTS = ['analyzePosts', 'validateJevSpec', 'createJevPresets'];

export async function installTarball({ tarball, consumer, env, npmCommand }) {
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'bird-jev-package-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  const result = await runProcess(
    npmCommand,
    ['install', tarball, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
    { cwd: consumer, env, timeoutMs: 180_000 },
  );
  requireSuccess(result, 'npm install tarball');
}

export async function assertInstalledBundle(consumer, expectedBundle, pkg, env) {
  const birdRoot = join(consumer, 'node_modules', pkg.name);
  const installedPkg = JSON.parse(await readFile(join(birdRoot, 'package.json'), 'utf8'));
  if (installedPkg.name !== pkg.name || installedPkg.version !== pkg.version) {
    throw new Error(`Installed package is ${installedPkg.name}@${installedPkg.version}`);
  }
  const resolution = await runProcess(
    process.execPath,
    ['--input-type=module', '--eval', `console.log(import.meta.resolve(${JSON.stringify(BUNDLED_PACKAGE)}))`],
    { cwd: birdRoot, env, timeoutMs: 15_000 },
  );
  requireSuccess(resolution, `resolve installed ${BUNDLED_PACKAGE}`);
  const installedRoot = findPackageRoot(fileURLToPath(resolution.stdout.trim()), BUNDLED_PACKAGE);
  const bundledHashed = await hashPackageTree(join(birdRoot, 'node_modules', BUNDLED_PACKAGE));
  const hashed = await hashPackageTree(installedRoot);
  if (hashed.realRoot !== bundledHashed.realRoot) {
    throw new Error(`${BUNDLED_PACKAGE} resolved outside the bundled copy: ${hashed.realRoot}`);
  }
  compareHashes(expectedBundle, hashed.files, 'installed');
}

export async function runSmoke({ consumer, env, root, pkg, fetchMockPath, npmCommand }) {
  const bin = join(consumer, 'node_modules', '.bin', 'bird');
  const fetchLog = join(consumer, 'fetch-calls.jsonl');
  const guardEnv = {
    ...env,
    BIRD_PACKAGE_FETCH_GUARD: '1',
    BIRD_PACKAGE_FETCH_LOG: fetchLog,
    NODE_OPTIONS: `--import ${pathToFileURL(fetchMockPath).href}`,
  };
  await smokeCli(bin, guardEnv, pkg);
  await writeFile(fetchLog, '');
  await smokeEsm(consumer, { ...guardEnv, BIRD_PACKAGE_FETCH_GUARD: 'deny' }, root, fetchMockPath);
  const esmCalls = readFetchLog(fetchLog);
  if (esmCalls.length !== 3 || esmCalls.some((call) => call.denied)) {
    throw new Error(`Expected 3 contained library provider calls, got ${JSON.stringify(esmCalls)}`);
  }
  await smokeAnalyze(bin, guardEnv, root, consumer, fetchLog);
  await smokeTypescript(consumer, env, root, pkg, npmCommand);
  return {
    cli: 'pass',
    esm: 'pass',
    typescript: 'pass',
    analyze: 'pass',
  };
}

async function smokeCli(bin, env, pkg) {
  const version = await runProcess(bin, ['--version'], { cwd: dirname(bin), env, timeoutMs: 15_000 });
  requireSuccess(version, 'bird --version');
  if (!version.stdout.trim().startsWith(pkg.version)) {
    throw new Error(
      `bird --version output ${JSON.stringify(version.stdout.trim())} does not start with ${pkg.version}`,
    );
  }
  const help = await runProcess(bin, ['--help'], { cwd: dirname(bin), env, timeoutMs: 15_000 });
  requireSuccess(help, 'bird --help');
  if (!help.stdout.includes('analyze')) {
    throw new Error('bird --help does not mention analyze');
  }
  const analyzeHelp = await runProcess(bin, ['analyze', '--help'], { cwd: dirname(bin), env, timeoutMs: 15_000 });
  requireSuccess(analyzeHelp, 'bird analyze --help');
  if (!analyzeHelp.stdout.includes('--jev') || !analyzeHelp.stdout.includes('--input')) {
    throw new Error('bird analyze --help is missing --jev or --input');
  }
}

async function smokeEsm(consumer, env, root, fetchMockPath) {
  const script = join(consumer, 'esm-smoke.mjs');
  const posts = await readFile(join(root, 'tests/fixtures/package/posts.json'), 'utf8');
  const spec = await readFile(join(root, 'tests/fixtures/package/spec.json'), 'utf8');
  await writeFile(
    script,
    `import { analyzePosts, createJevPresets, validateJevSpec } from 'bird-jev';
import { createProviderFetch } from ${JSON.stringify(pathToFileURL(fetchMockPath).href)};

const exportsByName = { analyzePosts, createJevPresets, validateJevSpec };
for (const name of ${JSON.stringify(PUBLIC_EXPORTS)}) {
  if (typeof exportsByName[name] !== 'function') {
    throw new Error('Missing public export: ' + name);
  }
}
const spec = validateJevSpec(${spec});
const presets = createJevPresets({ relevance: 'packaging gate', scope: 'both' });
if (presets.tasks.length === 0) {
  throw new Error('createJevPresets returned no tasks');
}
const report = await analyzePosts(${posts}, spec, {
  apiKey: ${JSON.stringify(SYNTHETIC_KEY)},
  fetch: createProviderFetch(),
});
if (report.selection.source !== 'library') {
  throw new Error('library analysis selection source is not library');
}
if (report.requestedModel !== 'jev-1.13.0') {
  throw new Error('library analysis model mismatch');
}
if (report.collection.group_flag?.status !== 'ok') {
  throw new Error('collection task did not succeed');
}
if (report.posts.length !== 2) {
  throw new Error('expected two post results');
}
if (JSON.stringify(report).includes('not-sent')) {
  throw new Error('private input leaked into the report');
}
console.log('esm-ok');
`,
  );
  const result = await runProcess(process.execPath, [script], { cwd: consumer, env, timeoutMs: 30_000 });
  requireSuccess(result, 'public ESM import');
  if (!result.stdout.includes('esm-ok')) {
    throw new Error(`public ESM smoke produced no success marker\n${result.stdout}${result.stderr}`);
  }
}

async function smokeAnalyze(bin, env, root, consumer, fetchLog) {
  const postsPath = join(root, 'tests/fixtures/package/posts.json');
  const specPath = join(root, 'tests/fixtures/package/spec.json');
  const posts = JSON.parse(await readFile(postsPath, 'utf8'));
  await writeFile(fetchLog, '');

  const missing = await runProcess(bin, ['analyze', '--input', postsPath, '--json'], {
    cwd: consumer,
    env,
    timeoutMs: 15_000,
  });
  if (missing.code !== 2) {
    throw new Error(`missing --jev exited ${missing.code}, expected 2\n${missing.stdout}${missing.stderr}`);
  }
  if (!missing.stderr.includes('analyze requires --jev')) {
    throw new Error(`missing --jev stderr mismatch\n${missing.stderr}`);
  }
  assertNoProviderCalls(fetchLog, 'missing consent');

  const malformedPath = join(consumer, 'malformed.json');
  await writeFile(malformedPath, 'not-json');
  const analyzeEnv = { ...env, TYPESAFE_API_KEY: SYNTHETIC_KEY };
  const malformed = await runProcess(
    bin,
    ['analyze', '--input', malformedPath, '--jev', '--jev-spec', specPath, '--json'],
    { cwd: consumer, env: analyzeEnv, timeoutMs: 15_000 },
  );
  if (malformed.code !== 2) {
    throw new Error(`malformed input exited ${malformed.code}, expected 2\n${malformed.stdout}${malformed.stderr}`);
  }
  assertNoProviderCalls(fetchLog, 'malformed input');

  const emptyPath = join(consumer, 'empty.json');
  await writeFile(emptyPath, '[]');
  const empty = await runProcess(bin, ['analyze', '--input', emptyPath, '--jev', '--jev-spec', specPath, '--json'], {
    cwd: consumer,
    env: analyzeEnv,
    timeoutMs: 15_000,
  });
  requireSuccess(empty, 'empty analyze');
  const emptyReport = JSON.parse(empty.stdout);
  if (!Array.isArray(emptyReport.data) || emptyReport.data.length !== 0) {
    throw new Error('empty analyze did not preserve an empty input array');
  }
  if (emptyReport.jev.selection.postCount !== 0) {
    throw new Error('empty analyze should report zero posts');
  }
  assertNoProviderCalls(fetchLog, 'empty input');

  const success = await runProcess(bin, ['analyze', '--input', postsPath, '--jev', '--jev-spec', specPath, '--json'], {
    cwd: consumer,
    env: analyzeEnv,
    timeoutMs: 30_000,
  });
  requireSuccess(success, 'analyze saved posts');
  const report = JSON.parse(success.stdout);
  if (JSON.stringify(report.data) !== JSON.stringify(posts)) {
    throw new Error('analyze did not preserve the supplied posts');
  }
  if (report.jev.selection.source !== 'input' || report.jev.selection.status !== 'ok') {
    throw new Error('analyze selection is not input/ok');
  }
  if (report.jev.requestedModel !== 'jev-1.13.0') {
    throw new Error('analyze requestedModel mismatch');
  }
  if (report.jev.collection.group_flag?.status !== 'ok') {
    throw new Error('collection scope did not succeed');
  }
  if (report.jev.posts?.length !== 2 || report.jev.posts.some((row) => row.results.stance?.status !== 'ok')) {
    throw new Error('post scope did not succeed for both posts');
  }
  if (report.jev.usage?.inputTokens !== 3 || report.jev.usage?.outputTokens !== 6) {
    throw new Error(`unexpected usage ${JSON.stringify(report.jev.usage)}`);
  }
  if (JSON.stringify(report.jev).includes('not-sent')) {
    throw new Error('private input leaked into analyze results');
  }
  const calls = readFetchLog(fetchLog);
  if (calls.length !== 3 || calls.some((call) => call.denied)) {
    throw new Error(`expected 3 provider calls, got ${JSON.stringify(calls)}`);
  }
  if (calls.some((call) => call.url !== JEV_PROVIDER_URL)) {
    throw new Error('analyze issued an unexpected URL');
  }
}

async function smokeTypescript(consumer, env, root, pkg, npmCommand) {
  const versions = toolPackageVersions(root);
  const tsDir = join(consumer, 'ts-consumer');
  await mkdir(tsDir, { recursive: true });
  await writeFile(
    join(tsDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'bird-jev-ts-consumer',
        private: true,
        type: 'module',
        dependencies: {
          [pkg.name]: `file:${join(consumer, 'node_modules', pkg.name)}`,
        },
        devDependencies: {
          typescript: versions.typescript,
          '@types/node': versions.typesNode,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(tsDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(tsDir, 'consumer.ts'),
    `import { analyzePosts, createJevPresets, validateJevSpec } from 'bird-jev';

const spec = validateJevSpec({
  tasks: [
    {
      id: 'stance',
      scope: 'post',
      instructions: 'Classify',
      output: { type: 'category', labels: ['yes', 'no'] },
    },
    {
      id: 'group_flag',
      scope: 'collection',
      instructions: 'Together?',
      output: { type: 'boolean', threshold: 0.6 },
    },
  ],
});
const presets = createJevPresets({ relevance: 'packaging gate', scope: 'both' });

export const surface: {
  analyzePosts: typeof analyzePosts;
  specTaskCount: number;
  presetCount: number;
} = {
  analyzePosts,
  specTaskCount: spec.tasks.length,
  presetCount: presets.tasks.length,
};
`,
  );
  const install = await runProcess(npmCommand, ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: tsDir,
    env,
    timeoutMs: 180_000,
  });
  requireSuccess(install, 'typescript consumer npm install');
  const tsc = join(tsDir, 'node_modules', '.bin', 'tsc');
  const result = await runProcess(tsc, ['-p', 'tsconfig.json'], { cwd: tsDir, env, timeoutMs: 60_000 });
  requireSuccess(result, 'typescript consumer tsc');
}

function findPackageRoot(resolvedFile, name) {
  let dir = dirname(resolvedFile);
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.name === name) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`Cannot find package.json for ${name} from ${resolvedFile}`);
}

function compareHashes(expected, actual, label) {
  for (const [rel, hash] of expected) {
    if (actual.get(rel) !== hash) {
      throw new Error(`${label} ${BUNDLED_PACKAGE} file ${rel} does not match the patched local bytes`);
    }
  }
  for (const rel of actual.keys()) {
    if (!expected.has(rel)) {
      throw new Error(`${label} ${BUNDLED_PACKAGE} has extra file ${rel}`);
    }
  }
}

function assertNoProviderCalls(fetchLog, label) {
  const calls = readFetchLog(fetchLog);
  if (calls.length !== 0) {
    throw new Error(`${label} issued provider calls: ${JSON.stringify(calls)}`);
  }
}
