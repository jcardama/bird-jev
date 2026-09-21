import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPatchedProvider, digestFile, hashPackageTree, readArchive } from './package/archive.js';
import { assertInstalledBundle, installTarball, runSmoke } from './package/consumer.js';
import {
  assertOutsideCheckout,
  checkoutRoot,
  createIsolatedEnv,
  readGitState,
  readToolchain,
  requireSuccess,
  resolveNpm,
  runProcess,
  withOfflineNpm,
  writeIsolatedNpmConfig,
} from './package/env.js';
import { BUNDLED_PACKAGE, evaluatePolicy, planArtifactSource } from './package/policy.js';
import {
  assertReceiptMatchesArtifact,
  buildReceipt,
  readReceipt,
  receiptPathFor,
  runtimeReceiptPath,
  writeReceipt,
} from './package/receipt.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export const USAGE =
  'Usage: node scripts/check-package.js [--output <absolute-external-directory>] [--tarball <verified.tgz>]';

export function parseArgs(argv) {
  let output;
  let tarball;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--output' || arg.startsWith('--output=')) {
      output = readFlagValue(argv, i, arg, '--output');
      if (arg === '--output') {
        i += 1;
      }
      if (!output || output.startsWith('-')) {
        throw new Error('--output requires an absolute external directory');
      }
      continue;
    }
    if (arg === '--tarball' || arg.startsWith('--tarball=')) {
      tarball = readFlagValue(argv, i, arg, '--tarball');
      if (arg === '--tarball') {
        i += 1;
      }
      if (!tarball || tarball.startsWith('-')) {
        throw new Error('--tarball requires an absolute path to a .tgz');
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
  if (output !== undefined && !isAbsolute(output)) {
    throw new Error('--output must be an absolute path outside the checkout');
  }
  if (tarball !== undefined && !isAbsolute(tarball)) {
    throw new Error('--tarball must be an absolute path');
  }
  return { output, tarball, help };
}

export { planArtifactSource };

export async function runPackageCheck({
  argv = process.argv.slice(2),
  root = checkoutRoot(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assertSourceReady(pkg);

  const outputDir = args.output
    ? await prepareOutputDir(root, args.output)
    : await mkdtemp(join(tmpdir(), 'bird-jev-artifact-'));
  const workDir = await mkdtemp(join(tmpdir(), 'bird-jev-package-work-'));
  const home = join(workDir, 'home');
  await mkdir(home, { recursive: true });
  await writeIsolatedNpmConfig(home);
  const env = createIsolatedEnv(home);
  const npmCommand = await resolveNpm();

  try {
    const git = await readGitState(root);
    if (!COMMIT_SHA.test(git.gitSha ?? '')) {
      throw new Error('Cannot bind package verification to the checkout Git state');
    }
    if (git.dirty) {
      stdout.write(
        'WARNING: working tree is dirty; the receipt will record dirty=true and is not a publishable release candidate.\n',
      );
    }

    const plan = planArtifactSource(args);
    let tarball;
    let digest;
    let originalReceipt;
    let originalSource;
    if (plan.action === 'reuse') {
      tarball = await prepareTarballPath(root, plan.tarball);
      digest = await digestFile(tarball);
      originalReceipt = receiptPathFor(tarball, pkg);
      const receipt = await readReceipt(originalReceipt);
      assertReceiptMatchesArtifact(receipt, digest, pkg, git);
      originalSource = receipt.source;
    }

    stdout.write(`Hashing local patched ${BUNDLED_PACKAGE}...\n`);
    const bundleRoot = join(root, 'node_modules', BUNDLED_PACKAGE);
    assertPatchedProvider(await readFile(join(bundleRoot, 'dist/providers/chromeSqliteMac.js')));
    const expectedBundle = await hashPackageTree(bundleRoot);
    if (plan.action === 'pack') {
      stdout.write('Packing npm tarball...\n');
      tarball = await packNpm({ root, destination: outputDir, env, npmCommand, pkg });
      digest = await digestFile(tarball);
    }
    const retained = join(outputDir, `${pkg.name}-${pkg.version}.tgz`);
    if (resolve(tarball) !== resolve(retained)) {
      await copyFile(tarball, retained, constants.COPYFILE_EXCL);
      const copied = await digestFile(retained);
      if (copied.sha256 !== digest.sha256 || copied.bytes !== digest.bytes) {
        throw new Error('Retained tarball bytes do not match the inspected artifact');
      }
      tarball = retained;
      digest = copied;
    }

    stdout.write('Inspecting archive...\n');
    const entries = await readArchive(tarball);
    evaluatePolicy(entries, { expectedPackage: pkg, expectedBundle: expectedBundle.files });

    const beforeInstall = await digestFile(tarball);
    if (beforeInstall.sha256 !== digest.sha256 || beforeInstall.integrity !== digest.integrity) {
      throw new Error('Artifact bytes changed before install');
    }

    stdout.write('Installing isolated consumer...\n');
    const consumer = join(workDir, 'consumer');
    await mkdir(consumer, { recursive: true });
    await installTarball({ tarball, consumer, env, npmCommand });
    await assertInstalledBundle(consumer, expectedBundle.files, pkg, env);

    stdout.write('Running consumer smoke tests...\n');
    const fetchMockPath = join(root, 'scripts/package/fetch-mock.js');
    const verification = await runSmoke({ consumer, env, root, pkg, fetchMockPath, npmCommand });
    verification.policy = 'pass';
    verification.install = 'pass';

    const toolchain = await readToolchain(home, npmCommand);
    const artifact = {
      filename: basename(tarball),
      bytes: digest.bytes,
      sha256: digest.sha256,
      sha512: digest.sha512,
      integrity: digest.integrity,
    };
    if (plan.action === 'reuse') {
      const sidecar = runtimeReceiptPath(tarball, process.version);
      await writeReceipt(sidecar, {
        schemaVersion: 1,
        originalReceipt,
        source: originalSource,
        checkedAgainst: { gitSha: git.gitSha, dirty: git.dirty },
        toolchain,
        artifact,
        verification: { pack: 'reused', ...verification },
      });
      stdout.write(
        `PASS package artifact\nartifact: ${tarball}\noriginal receipt preserved: ${originalReceipt}\nruntime: ${sidecar}\nsha256: ${digest.sha256}\n`,
      );
    } else {
      const receipt = buildReceipt({
        pkg,
        source: git,
        toolchain,
        artifact,
        bundleFiles: expectedBundle.files,
        verification,
        pack: 'created',
      });
      const receiptPath = receiptPathFor(tarball, pkg);
      await writeReceipt(receiptPath, receipt);
      stdout.write(
        `PASS package artifact\nartifact: ${tarball}\nreceipt: ${receiptPath}\nsha256: ${digest.sha256}\nintegrity: ${digest.integrity}\n`,
      );
    }
    if (git.dirty) {
      stdout.write('dirty: true\n');
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    stderr.write(`${message}\n`);
    return 1;
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      stderr.write(`Cannot remove work directory ${workDir}: ${error instanceof Error ? error.message : error}\n`);
    }
  }
}

function readFlagValue(argv, index, arg, flag) {
  if (arg === flag) {
    return argv[index + 1];
  }
  return arg.slice(`${flag}=`.length);
}

function assertSourceReady(pkg) {
  if (pkg.private === true) {
    throw new Error('package.json is private; refuse to pack');
  }
  if (pkg.name !== 'bird-jev') {
    throw new Error(`unexpected package name ${pkg.name}`);
  }
  if (pkg.scripts?.prepack !== 'npm run build:dist') {
    throw new Error('prepack must be npm run build:dist');
  }
  const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies;
  if (!Array.isArray(bundled) || bundled[0] !== BUNDLED_PACKAGE) {
    throw new Error(`${BUNDLED_PACKAGE} must be declared in bundleDependencies`);
  }
}

async function prepareOutputDir(root, output) {
  const resolved = await assertOutsideCheckout(root, output, '--output');
  await mkdir(resolved, { recursive: true });
  const real = await realpath(resolved);
  await assertOutsideCheckout(root, real, '--output');
  return real;
}

async function prepareTarballPath(root, tarball) {
  const resolved = await assertOutsideCheckout(root, tarball, '--tarball');
  const st = await stat(resolved);
  if (!st.isFile()) {
    throw new Error('--tarball must be a regular file');
  }
  return realpath(resolved);
}

async function packNpm({ root, destination, env, npmCommand, pkg }) {
  await assertAbsent(join(destination, `${pkg.name}-${pkg.version}.tgz`));
  await assertAbsent(receiptPathFor(join(destination, `${pkg.name}-${pkg.version}.tgz`), pkg));
  const result = await runProcess(npmCommand, ['pack', '--json', '--pack-destination', destination], {
    cwd: root,
    env: withOfflineNpm(env),
    timeoutMs: 180_000,
  });
  requireSuccess(result, 'npm pack');
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm pack did not return JSON\n${result.stdout}\n${result.stderr}`);
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (records.length !== 1 || typeof records[0]?.filename !== 'string') {
    throw new Error(`npm pack returned an unexpected result\n${result.stdout}`);
  }
  const filename = records[0].filename;
  const tarball = isAbsolute(filename) ? filename : join(destination, filename);
  return tarball;
}

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`Refusing to overwrite an existing artifact or receipt: ${path}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = await runPackageCheck();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}
