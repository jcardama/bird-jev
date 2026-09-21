import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BUNDLED_PACKAGE, BUNDLED_VERSION } from './policy.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function receiptPathFor(tarball, pkg) {
  return join(dirname(tarball), `${pkg.name}-${pkg.version}.receipt.json`);
}

export function runtimeReceiptPath(tarball, nodeVersion) {
  return `${tarball}.runtime-${nodeVersion}.json`;
}

export function buildReceipt({ pkg, source, toolchain, artifact, bundleFiles, verification, pack }) {
  const files = {};
  const names = [...bundleFiles.keys()].sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    files[name] = bundleFiles.get(name);
  }
  return {
    schemaVersion: 1,
    package: { name: pkg.name, version: pkg.version },
    source: {
      gitSha: source.gitSha,
      dirty: source.dirty,
    },
    toolchain,
    artifact: {
      filename: artifact.filename,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      sha512: artifact.sha512,
      integrity: artifact.integrity,
    },
    bundle: {
      name: BUNDLED_PACKAGE,
      version: BUNDLED_VERSION,
      files,
    },
    verification: {
      pack,
      ...verification,
    },
  };
}

export async function readReceipt(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

export async function writeReceipt(path, receipt) {
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return path;
}

export function assertReceiptMatchesArtifact(receipt, digest, pkg, source) {
  if (
    receipt.schemaVersion !== 1 ||
    typeof receipt.source?.dirty !== 'boolean' ||
    !COMMIT_SHA.test(receipt.source?.gitSha ?? '')
  ) {
    throw new Error('Original receipt has invalid provenance');
  }
  if (source && receipt.source?.gitSha !== source.gitSha) {
    throw new Error('Original receipt source commit does not match the checkout');
  }
  for (const stage of ['policy', 'install', 'cli', 'esm', 'typescript', 'analyze']) {
    if (receipt.verification?.[stage] !== 'pass') {
      throw new Error(`Original receipt has no passing ${stage} verification`);
    }
  }
  if (receipt.verification?.pack !== 'created') {
    throw new Error('Original receipt must identify the original pack operation');
  }
  if (receipt.package?.name !== pkg.name || receipt.package?.version !== pkg.version) {
    throw new Error(
      `Original receipt package ${receipt.package?.name}@${receipt.package?.version} does not match ${pkg.name}@${pkg.version}`,
    );
  }
  if (receipt.artifact?.sha256 !== digest.sha256) {
    throw new Error(`Tarball sha256 ${digest.sha256} does not match original receipt ${receipt.artifact?.sha256}`);
  }
  if (receipt.artifact?.integrity !== digest.integrity) {
    throw new Error('Tarball integrity does not match the original receipt');
  }
  if (receipt.artifact?.bytes !== digest.bytes) {
    throw new Error('Tarball size does not match the original receipt');
  }
}
