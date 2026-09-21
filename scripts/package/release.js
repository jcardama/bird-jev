import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const USAGE = 'Usage: node scripts/package/release.js <identity|artifact>';

const PACKAGE_NAME = 'bird-jev';
const CANONICAL_REPOSITORY = 'git+https://github.com/jcardama/bird-jev.git';
const CANONICAL_GITHUB_REPOSITORY = 'jcardama/bird-jev';
const MAIN_REF = 'refs/remotes/origin/main';
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION_PART = /^[0-9]+$/;
const LINE_BREAK = /[\r\n]/;

export function parseStableVersion(version) {
  if (typeof version !== 'string') {
    throw new Error(`Unsupported version format: ${version}`);
  }
  const parts = version.split('.');
  if (parts.length !== 3) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  return parts.map((part) => parseVersionPart(part));
}

export function parseStableTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error(`Release tag is not a stable vMAJOR.MINOR.PATCH tag: ${tag}`);
  }
  const version = tag.slice(1);
  parseStableVersion(version);
  return version;
}

export async function validateReleaseIdentity({
  root = process.env.GITHUB_WORKSPACE || process.cwd(),
  env = process.env,
  git = runGit,
} = {}) {
  const tag = requiredEnv(env, 'RELEASE_TAG');
  const version = parseStableTag(tag);
  const expectedSha = readExpectedSha(env);
  assertCanonicalGitHubRepository(env);
  assertGitHubRef(env, tag);
  await assertPublishedRelease(env, tag);

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assertCanonicalPackage(pkg, version);

  const head = requireGitText(git(root, ['rev-parse', 'HEAD']), 'git rev-parse HEAD');
  const tagCommit = requireGitText(git(root, ['rev-parse', `${tag}^{commit}`]), `git rev-parse ${tag}^{commit}`);
  if (head !== expectedSha || tagCommit !== expectedSha) {
    throw new Error(`Checked-out SHA ${head} does not match tag ${tagCommit} and event ${expectedSha}`);
  }

  const status = requireGitText(git(root, ['status', '--porcelain']), 'git status --porcelain');
  if (status !== '') {
    throw new Error('Working tree is dirty; refusing to verify a release');
  }

  const main = git(root, ['rev-parse', '--verify', MAIN_REF]);
  if (main.error) {
    throw main.error;
  }
  if (main.status !== 0) {
    throw new Error(`Cannot resolve ${MAIN_REF} for ancestry check`);
  }
  const ancestor = git(root, ['merge-base', '--is-ancestor', expectedSha, MAIN_REF]);
  if (ancestor.error) {
    throw ancestor.error;
  }
  if (ancestor.status !== 0) {
    throw new Error(`Release commit ${expectedSha} is not an ancestor of ${MAIN_REF}`);
  }

  return { tag, version, sha: expectedSha, pkg };
}

export async function validateReleaseArtifact({
  root = process.env.GITHUB_WORKSPACE || process.cwd(),
  env = process.env,
  loadReceipt = () => import('./receipt.js'),
} = {}) {
  const identity = await validateReleaseIdentity({ root, env });
  const artifactDir = env.ARTIFACT_DIR;
  if (typeof artifactDir !== 'string' || artifactDir.trim() === '') {
    throw new Error('ARTIFACT_DIR must be set to the verified artifact directory');
  }

  const filename = `${PACKAGE_NAME}-${identity.version}.tgz`;
  const receiptName = `${PACKAGE_NAME}-${identity.version}.receipt.json`;
  await assertExactArtifactFiles(artifactDir, filename, receiptName);

  const tarball = join(artifactDir, filename);
  const digest = await digestFile(tarball);
  const receipt = JSON.parse(await readFile(join(artifactDir, receiptName), 'utf8'));
  if (receipt.source?.dirty !== false) {
    throw new Error('Release receipt must record a clean source tree');
  }
  if (receipt.artifact?.filename !== filename) {
    throw new Error(`Receipt filename ${receipt.artifact?.filename} does not match ${filename}`);
  }
  if (receipt.artifact?.sha512 !== digest.sha512) {
    throw new Error('Tarball sha512 does not match the receipt');
  }

  const { assertReceiptMatchesArtifact } = await loadReceipt();
  assertReceiptMatchesArtifact(receipt, digest, identity.pkg, { gitSha: identity.sha, dirty: false });

  await writeGitHubOutput(env.GITHUB_OUTPUT, {
    sha: identity.sha,
    filename,
    version: identity.version,
    artifactDigest: digest.sha256,
  });

  return { ...identity, digest, filename, receipt };
}

function parseVersionPart(part) {
  if (!VERSION_PART.test(part)) {
    throw new Error(`Unsupported version component: ${part}`);
  }
  if (part.length > 1 && part.startsWith('0')) {
    throw new Error(`Version component has a leading zero: ${part}`);
  }
  return BigInt(part);
}

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function readExpectedSha(env) {
  const sha = env.RELEASE_SHA || env.GITHUB_SHA;
  if (!COMMIT_SHA.test(sha ?? '')) {
    throw new Error('Release SHA is not a complete commit hash');
  }
  if (env.RELEASE_SHA && env.GITHUB_SHA && env.RELEASE_SHA !== env.GITHUB_SHA) {
    throw new Error('RELEASE_SHA does not match GITHUB_SHA');
  }
  return sha;
}

function assertCanonicalGitHubRepository(env) {
  if (env.GITHUB_REPOSITORY !== CANONICAL_GITHUB_REPOSITORY) {
    throw new Error(`GITHUB_REPOSITORY ${env.GITHUB_REPOSITORY} is not ${CANONICAL_GITHUB_REPOSITORY}`);
  }
}

function assertGitHubRef(env, tag) {
  if (env.GITHUB_REF && env.GITHUB_REF !== `refs/tags/${tag}`) {
    throw new Error(`GITHUB_REF ${env.GITHUB_REF} does not match refs/tags/${tag}`);
  }
  if (env.GITHUB_EVENT_NAME && env.GITHUB_EVENT_NAME !== 'release') {
    throw new Error(`GITHUB_EVENT_NAME is ${env.GITHUB_EVENT_NAME}, expected release`);
  }
}

async function assertPublishedRelease(env, tag) {
  const eventPath = requiredEnv(env, 'GITHUB_EVENT_PATH');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const release = event?.release;
  if (!release || typeof release !== 'object') {
    throw new Error('GitHub event is not a release payload');
  }
  if (event.action != null && event.action !== 'published') {
    throw new Error(`Release event action is ${event.action}, expected published`);
  }
  if (release.draft === true) {
    throw new Error('Draft releases cannot be published to npm');
  }
  if (release.prerelease === true) {
    throw new Error('Prerelease tags are not published by this workflow');
  }
  if (release.tag_name !== tag) {
    throw new Error(`Event tag ${release.tag_name} does not match ${tag}`);
  }
}

function assertCanonicalPackage(pkg, version) {
  if (pkg.private === true) {
    throw new Error('package.json is private; refuse to release');
  }
  if (pkg.name !== PACKAGE_NAME) {
    throw new Error(`unexpected package name ${pkg.name}`);
  }
  if (pkg.version !== version) {
    throw new Error(`package.json version ${pkg.version} does not match tag version ${version}`);
  }
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (repository !== CANONICAL_REPOSITORY) {
    throw new Error(`package repository ${repository} is not the canonical GitHub URL`);
  }
}

function runGit(root, args) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    shell: false,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
}

function requireGitText(result, label) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? '').trim();
}

async function digestFile(path) {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  const sha1 = createHash('sha1');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
    sha1.update(chunk);
  }
  const sha512Digest = sha512.digest();
  return {
    bytes,
    sha256: sha256.digest('hex'),
    sha512: sha512Digest.toString('hex'),
    sha1: sha1.digest('hex'),
    integrity: `sha512-${sha512Digest.toString('base64')}`,
  };
}

async function assertExactArtifactFiles(dir, filename, receiptName) {
  const entries = await readdir(dir, { withFileTypes: true });
  const actual = [];
  for (const entry of entries) {
    const st = await lstat(join(dir, entry.name));
    if (st.isSymbolicLink() || entry.isSymbolicLink()) {
      throw new Error(`Artifact directory contains a symlink: ${entry.name}`);
    }
    if (!st.isFile()) {
      throw new Error(`Artifact directory contains a non-file: ${entry.name}`);
    }
    actual.push(entry.name);
  }
  actual.sort((left, right) => left.localeCompare(right));
  const expected = [filename, receiptName].sort((left, right) => left.localeCompare(right));
  if (actual.length !== 2 || actual[0] !== expected[0] || actual[1] !== expected[1]) {
    throw new Error(`Artifact directory entries [${actual.join(', ')}] are not [${expected.join(', ')}]`);
  }
}

async function writeGitHubOutput(file, outputs) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('GITHUB_OUTPUT is not set');
  }
  const lines = [];
  for (const [name, value] of Object.entries(outputs)) {
    if (!OUTPUT_NAME.test(name)) {
      throw new Error(`Invalid output name ${name}`);
    }
    if (typeof value !== 'string' || value === '' || LINE_BREAK.test(value)) {
      throw new Error(`Invalid output value for ${name}`);
    }
    lines.push(`${name}=${value}`);
  }
  await appendFile(file, `${lines.join('\n')}\n`);
}

async function main() {
  const command = process.argv[2];
  if (command === 'identity') {
    const identity = await validateReleaseIdentity();
    process.stdout.write(`Release identity ${identity.tag} ${identity.sha}\n`);
    return;
  }
  if (command === 'artifact') {
    const artifact = await validateReleaseArtifact();
    process.stdout.write(`Release artifact ${artifact.filename} ${artifact.digest.sha256}\n`);
    return;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
