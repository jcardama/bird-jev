import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { list } from 'tar';

const PATCHED_PROVIDER_SHA256 = 'afc36b8f924985a9d703c866a8497dd0855805d83290a2136608de7b6b87d07b';

export async function digestFile(path) {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  const sha512Digest = sha512.digest();
  return {
    bytes,
    sha256: sha256.digest('hex'),
    sha512: sha512Digest.toString('hex'),
    integrity: `sha512-${sha512Digest.toString('base64')}`,
  };
}

export function sha256Buffer(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function assertPatchedProvider(content) {
  if (sha256Buffer(content) !== PATCHED_PROVIDER_SHA256) {
    throw new Error('Installed cookie provider does not match the verified patched bytes');
  }
}

export async function readArchive(file) {
  const pending = [];
  await list.asyncFile(
    {
      file,
      noResume: true,
      onReadEntry(entry) {
        const chunks = [];
        pending.push(
          new Promise((resolve, reject) => {
            entry.on('data', (chunk) => {
              chunks.push(chunk);
            });
            entry.on('error', reject);
            entry.on('end', () => {
              resolve({
                path: entry.path,
                type: entry.type,
                mode: entry.mode ?? 0,
                size: entry.size,
                linkpath: entry.linkpath,
                content: Buffer.concat(chunks),
              });
            });
          }),
        );
        entry.resume();
      },
    },
    [],
  );
  return Promise.all(pending);
}

export async function hashPackageTree(packageRoot) {
  const realRoot = await realpath(packageRoot);
  const rootStat = await stat(realRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Patched dependency is not a directory: ${realRoot}`);
  }
  const files = new Map();
  const stack = [{ dir: realRoot, rel: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const entries = await readdir(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      const nextRel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      const full = join(current.dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Patched dependency contains a symlink at ${nextRel}; refusing to follow, copy, or rewrite the pnpm layout.`,
        );
      }
      if (entry.isDirectory()) {
        stack.push({ dir: full, rel: nextRel });
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported type at ${nextRel} in the patched dependency`);
      }
      files.set(nextRel, sha256Buffer(await readFileBuffer(full)));
    }
  }
  return { realRoot, files };
}

async function readFileBuffer(path) {
  const chunks = [];
  for await (const chunk of createReadStream(path)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
