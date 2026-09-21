import { posix } from 'node:path';
import { sha256Buffer } from './archive.js';

export const BUNDLED_PACKAGE = '@steipete/sweet-cookie';
export const BUNDLED_VERSION = '0.1.0';
export const FORBIDDEN_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
export const REQUIRED_ROOT_FILES = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'dist/cli.js',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/lib/query-ids.json',
  'dist/lib/features.json',
];
export const REQUIRED_BUNDLE_FILES = ['package.json', 'LICENSE', 'dist/providers/chromeSqliteMac.js'];

const ROOT_FILES = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE']);
const BUNDLE_PREFIX = `node_modules/${BUNDLED_PACKAGE}/`;
const TRAILING_SLASHES = /\/+$/;

export class PackagePolicyError extends Error {
  constructor(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list.join('\n'));
    this.name = 'PackagePolicyError';
    this.messages = list;
  }
}

export function planArtifactSource(args) {
  if (args.tarball) {
    return { action: 'reuse', tarball: args.tarball };
  }
  return { action: 'pack' };
}

export function evaluatePolicy(entries, { expectedPackage, expectedBundle }) {
  const errors = [];
  const files = new Map();
  for (const entry of entries) {
    try {
      inspectEntry(entry, errors);
      if (isFileType(entry.type)) {
        const relative = packageRelative(entry.path);
        if (files.has(relative)) {
          errors.push(`Duplicate archive path: ${entry.path}`);
        }
        files.set(relative, entry);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const required of REQUIRED_ROOT_FILES) {
    if (!files.has(required)) {
      errors.push(`Missing required file package/${required}`);
    }
  }

  const manifestEntry = files.get('package.json');
  if (manifestEntry) {
    try {
      evaluateManifest(parseJsonFile(manifestEntry, 'package/package.json'), expectedPackage);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const licenseEntry = files.get('LICENSE');
  if (licenseEntry && !licenseEntry.content.toString('utf8').includes('MIT License')) {
    errors.push('package/LICENSE is not an MIT license');
  }

  const cli = files.get('dist/cli.js');
  if (cli) {
    const mode = cli.mode & 0o777;
    if (mode !== 0o755) {
      errors.push(`package/dist/cli.js mode ${mode.toString(8)} is not 0755`);
    }
    if (!cli.content.toString('utf8').startsWith('#!/usr/bin/env node')) {
      errors.push('package/dist/cli.js is missing its Node shebang');
    }
  }

  for (const jsonName of ['dist/lib/query-ids.json', 'dist/lib/features.json']) {
    const jsonEntry = files.get(jsonName);
    if (jsonEntry) {
      try {
        parseJsonFile(jsonEntry, `package/${jsonName}`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  evaluateBundle(files, expectedBundle, errors);

  if (errors.length > 0) {
    throw new PackagePolicyError(errors);
  }
  return { files };
}

function inspectEntry(entry, errors) {
  const rawPath = entry.path ?? '';
  if (rawPath.includes('\0')) {
    throw new PackagePolicyError('Archive path contains a null byte');
  }
  if (rawPath.startsWith('/') || isWindowsPath(rawPath) || rawPath.includes('\\')) {
    throw new PackagePolicyError(`Absolute or non-posix archive path: ${rawPath}`);
  }
  const trimmed = rawPath.replace(TRAILING_SLASHES, '');
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '..' || part === '')) {
    throw new PackagePolicyError(`Unsafe archive path: ${rawPath}`);
  }
  if (parts[0] !== 'package') {
    throw new PackagePolicyError(`Archive entry is not under package/: ${rawPath}`);
  }
  if ((entry.mode ?? 0) & 0o7000) {
    throw new PackagePolicyError(`Archive entry has setuid/setgid/sticky bits: ${rawPath}`);
  }

  if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
    const relative = parts.slice(1).join('/');
    if (relative === `node_modules/${BUNDLED_PACKAGE}` || relative.startsWith(BUNDLE_PREFIX)) {
      throw new PackagePolicyError(
        `npm pack stored a ${entry.type} for ${BUNDLED_PACKAGE} at ${rawPath} instead of the patched file contents. Stopped without copying or rewriting the pnpm layout.`,
      );
    }
    if (linkEscapes(trimmed, entry.linkpath)) {
      throw new PackagePolicyError(`Archive link escapes package/: ${rawPath} -> ${entry.linkpath ?? ''}`);
    }
    throw new PackagePolicyError(`Archive contains a ${entry.type}: ${rawPath}`);
  }

  if (entry.type === 'Directory') {
    const relative = parts.slice(1).join('/');
    if (relative !== '' && !isAllowedDirectory(relative)) {
      errors.push(`Forbidden directory: package/${relative}`);
    }
    return;
  }

  if (!isFileType(entry.type)) {
    throw new PackagePolicyError(`Unsupported archive entry type ${entry.type}: ${rawPath}`);
  }

  const relative = parts.slice(1).join('/');
  if (!isAllowedFile(relative)) {
    throw new PackagePolicyError(`Forbidden archive path: ${rawPath}`);
  }

  const mode = (entry.mode ?? 0) & 0o777;
  if (relative === 'dist/cli.js') {
    return;
  }
  if (mode & 0o111) {
    throw new PackagePolicyError(`${rawPath} is unexpectedly executable (${mode.toString(8)})`);
  }
}

function evaluateManifest(pkg, expectedPackage) {
  if (pkg.name !== expectedPackage.name) {
    throw new PackagePolicyError(`package name ${pkg.name} does not match ${expectedPackage.name}`);
  }
  if (pkg.version !== expectedPackage.version) {
    throw new PackagePolicyError(`package version ${pkg.version} does not match ${expectedPackage.version}`);
  }
  if (pkg.private === true) {
    throw new PackagePolicyError('packed package.json must not set private');
  }
  if (pkg.type !== 'module') {
    throw new PackagePolicyError('packed package.json type must be module');
  }
  if (pkg.main !== 'dist/index.js') {
    throw new PackagePolicyError('packed main must be dist/index.js');
  }
  if (pkg.types !== 'dist/index.d.ts') {
    throw new PackagePolicyError('packed types must be dist/index.d.ts');
  }
  if (pkg.bin?.bird !== 'dist/cli.js') {
    throw new PackagePolicyError('packed bin.bird must be dist/cli.js');
  }
  if (pkg.license !== 'MIT') {
    throw new PackagePolicyError('packed license must be MIT');
  }
  if (pkg.engines?.node !== '>=22') {
    throw new PackagePolicyError('packed engines.node must be >=22');
  }
  const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies;
  if (!Array.isArray(bundled) || bundled.length !== 1 || bundled[0] !== BUNDLED_PACKAGE) {
    throw new PackagePolicyError(`bundleDependencies must be exactly [${BUNDLED_PACKAGE}]`);
  }
  if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') {
    throw new PackagePolicyError('publishConfig.registry must be https://registry.npmjs.org/');
  }
  if (pkg.publishConfig?.access !== 'public') {
    throw new PackagePolicyError('publishConfig.access must be public');
  }
  if (pkg.scripts?.prepack !== 'npm run build:dist') {
    throw new PackagePolicyError('prepack must be npm run build:dist');
  }
  for (const name of FORBIDDEN_INSTALL_SCRIPTS) {
    if (pkg.scripts?.[name]) {
      throw new PackagePolicyError(`packed package.json must not declare consumer hook ${name}`);
    }
  }
  if (pkg.dependencies?.[BUNDLED_PACKAGE] !== BUNDLED_VERSION) {
    throw new PackagePolicyError(`${BUNDLED_PACKAGE} must stay pinned at ${BUNDLED_VERSION}`);
  }
}

function evaluateBundle(files, expectedBundle, errors) {
  const bundled = new Map();
  for (const [relative, entry] of files) {
    if (relative.startsWith(BUNDLE_PREFIX)) {
      bundled.set(relative.slice(BUNDLE_PREFIX.length), entry);
    }
  }

  if (bundled.size === 0) {
    errors.push(
      `npm pack did not include ${BUNDLED_PACKAGE} file contents in the tarball. Ignore npm's bundled-file count and inspect the archive; stopped without copying or rewriting the pnpm layout.`,
    );
    return;
  }

  for (const required of REQUIRED_BUNDLE_FILES) {
    if (!bundled.has(required)) {
      errors.push(`Missing bundled file ${BUNDLE_PREFIX}${required}`);
    }
  }

  const bundledPkg = bundled.get('package.json');
  if (bundledPkg) {
    try {
      const pkg = parseJsonFile(bundledPkg, `package/${BUNDLE_PREFIX}package.json`);
      if (pkg.name !== BUNDLED_PACKAGE) {
        errors.push(`Bundled package name is ${pkg.name}`);
      }
      if (pkg.version !== BUNDLED_VERSION) {
        errors.push(`Bundled ${BUNDLED_PACKAGE} version ${pkg.version} is not ${BUNDLED_VERSION}`);
      }
      if (pkg.license !== 'MIT') {
        errors.push(`Bundled ${BUNDLED_PACKAGE} license must be MIT`);
      }
      if (hasRuntimeDependencies(pkg)) {
        errors.push(`Bundled ${BUNDLED_PACKAGE} must not declare runtime dependencies`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const bundledLicense = bundled.get('LICENSE');
  if (bundledLicense && !bundledLicense.content.toString('utf8').includes('MIT License')) {
    errors.push(`package/${BUNDLE_PREFIX}LICENSE is not an MIT license`);
  }

  for (const [rel, hash] of expectedBundle) {
    const entry = bundled.get(rel);
    if (!entry) {
      errors.push(`Bundled ${BUNDLED_PACKAGE} is missing ${rel} from the patched local tree`);
      continue;
    }
    const actual = sha256Buffer(entry.content);
    if (actual !== hash) {
      errors.push(`Bundled ${BUNDLED_PACKAGE} file ${rel} does not match the patched local bytes (${actual})`);
    }
  }
  for (const rel of bundled.keys()) {
    if (!expectedBundle.has(rel)) {
      errors.push(`Bundled ${BUNDLED_PACKAGE} has extra file ${rel} not present in the patched local tree`);
    }
  }
}

function hasRuntimeDependencies(pkg) {
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ]) {
    const value = pkg[field];
    if (value && typeof value === 'object' && Object.keys(value).length > 0) {
      return true;
    }
    if (Array.isArray(value) && value.length > 0) {
      return true;
    }
  }
  return false;
}

function parseJsonFile(entry, label) {
  try {
    return JSON.parse(entry.content.toString('utf8'));
  } catch {
    throw new PackagePolicyError(`${label} is not valid JSON`);
  }
}

function packageRelative(rawPath) {
  const trimmed = rawPath.replace(TRAILING_SLASHES, '');
  const parts = trimmed.split('/');
  return parts.slice(1).join('/');
}

function isFileType(type) {
  return type === 'File' || type === 'OldFile' || type === 'ContiguousFile' || type === undefined;
}

function isWindowsPath(path) {
  const first = path.charCodeAt(0);
  const a = 'A'.charCodeAt(0);
  const z = 'Z'.charCodeAt(0);
  const la = 'a'.charCodeAt(0);
  const lz = 'z'.charCodeAt(0);
  const letter = (first >= a && first <= z) || (first >= la && first <= lz);
  return letter && path[1] === ':';
}

function isAllowedDirectory(relative) {
  if (relative === 'dist' || relative.startsWith('dist/')) {
    return true;
  }
  if (relative === 'node_modules' || relative === 'node_modules/@steipete') {
    return true;
  }
  if (relative === `node_modules/${BUNDLED_PACKAGE}` || relative.startsWith(BUNDLE_PREFIX)) {
    return true;
  }
  return false;
}

function isAllowedFile(relative) {
  if (ROOT_FILES.has(relative)) {
    return true;
  }
  if (relative.startsWith('dist/')) {
    return isAllowedArtifactFile(relative.slice('dist/'.length));
  }
  if (relative.startsWith(BUNDLE_PREFIX)) {
    return isAllowedBundleFile(relative.slice(BUNDLE_PREFIX.length));
  }
  return false;
}

function isAllowedBundleFile(relative) {
  if (relative === 'LICENSE' || relative === 'README.md' || relative === 'package.json') {
    return true;
  }
  if (relative.startsWith('dist/')) {
    return isAllowedArtifactFile(relative.slice('dist/'.length)) || relative.endsWith('.md');
  }
  return relative.endsWith('.md');
}

function isAllowedArtifactFile(relative) {
  return (
    relative.endsWith('.d.ts.map') ||
    relative.endsWith('.d.ts') ||
    relative.endsWith('.js.map') ||
    relative.endsWith('.js') ||
    relative.endsWith('.json')
  );
}

function linkEscapes(entryPath, linkpath) {
  if (typeof linkpath !== 'string' || linkpath === '') {
    return true;
  }
  if (linkpath.startsWith('/') || isWindowsPath(linkpath) || linkpath.includes('\\') || linkpath.includes('\0')) {
    return true;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(entryPath), linkpath));
  return resolved === '..' || resolved.startsWith('../') || !resolved.startsWith('package/');
}
