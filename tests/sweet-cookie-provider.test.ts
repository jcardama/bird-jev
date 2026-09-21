import childProcess from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { isBuiltin, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type ChromeSqliteMacModule = {
  getCookiesFromChromeSqliteMac: (
    options: {
      profile?: string;
      includeExpired?: boolean;
      debug?: boolean;
      timeoutMs?: number;
    },
    origins: string[],
    allowlistNames: Set<string> | null,
  ) => Promise<{ cookies: Array<{ name: string; value: string }>; warnings: string[] }>;
};

type CryptoModule = {
  deriveAes128CbcKeyFromPassword: (password: string, options: { iterations: number }) => Buffer;
};

type SecurityCall = {
  account: string;
  service: string;
};

const SCHEMA_PATH = fileURLToPath(new URL('./fixtures/cookie-provider/schema.sql', import.meta.url));
const SWEET_COOKIE_ROOT = dirname(dirname(fileURLToPath(import.meta.resolve('@steipete/sweet-cookie'))));
const PROVIDER_PATH = join(SWEET_COOKIE_ROOT, 'dist/providers/chromeSqliteMac.js');
const CRYPTO_PATH = join(SWEET_COOKIE_ROOT, 'dist/providers/chromeSqlite/crypto.js');

const KEYCHAIN_PASSWORD = 'test-safe-storage-password';
const COOKIE_NAME = 'auth_token';
const COOKIE_VALUE = 'synthetic-auth-token';
const ORIGINS = ['https://x.com'];

const originalExistsSync = fs.existsSync.bind(fs);
const originalSetTimeout = globalThis.setTimeout;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

const securityCalls: SecurityCall[] = [];
const timeoutMsCalls: number[] = [];
const existsSyncCalls: string[] = [];

let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
let keychainPassword = KEYCHAIN_PASSWORD;
let workDir = '';
let deriveAes128CbcKeyFromPassword: CryptoModule['deriveAes128CbcKeyFromPassword'];
let getCookiesFromChromeSqliteMac: ChromeSqliteMacModule['getCookiesFromChromeSqliteMac'];

function chromeCookiesPath(home: string): string {
  return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Network', 'Cookies');
}

function braveCookiesPath(home: string): string {
  return join(
    home,
    'Library',
    'Application Support',
    'BraveSoftware',
    'Brave-Browser',
    'Default',
    'Network',
    'Cookies',
  );
}

function parseSecurityArgs(args: string[]): SecurityCall {
  const accountIndex = args.indexOf('-a');
  const serviceIndex = args.indexOf('-s');
  const account = accountIndex >= 0 ? args[accountIndex + 1] : undefined;
  const service = serviceIndex >= 0 ? args[serviceIndex + 1] : undefined;
  return {
    account: account ?? '',
    service: service ?? '',
  };
}

function fakeSecurityChild(password: string): childProcess.ChildProcess {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr,
    kill: () => true,
  });
  queueMicrotask(() => {
    if (password.length > 0) {
      stdout.write(password);
    }
    stdout.end();
    stderr.end();
    child.emit('close', 0);
  });
  return child as unknown as childProcess.ChildProcess;
}

function stubDarwin(): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: 'darwin',
  });
}

function restorePlatform(): void {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
}

function installTimeoutCapture(): void {
  const patched = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
    if (typeof delay === 'number') {
      timeoutMsCalls.push(delay);
    }
    return originalSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  globalThis.setTimeout = patched;
}

function installBoundaryMocks(home: string): void {
  securityCalls.length = 0;
  timeoutMsCalls.length = 0;
  existsSyncCalls.length = 0;
  keychainPassword = KEYCHAIN_PASSWORD;

  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
    const pathText = String(target);
    existsSyncCalls.push(pathText);
    return originalExistsSync(target);
  });
  vi.spyOn(childProcess, 'spawn').mockImplementation(((file: unknown, args?: unknown) => {
    if (file !== 'security' || !Array.isArray(args)) {
      throw new Error(`unexpected spawn: ${String(file)}`);
    }
    securityCalls.push(parseSecurityArgs(args.map(String)));
    return fakeSecurityChild(keychainPassword);
  }) as typeof childProcess.spawn);

  syncBuiltinESMExports();
  stubDarwin();
  installTimeoutCapture();
}

function restoreBoundaryMocks(): void {
  globalThis.setTimeout = originalSetTimeout;
  restorePlatform();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
}

function encryptCookieValue(plaintext: string, password: string): Buffer {
  const key = deriveAes128CbcKeyFromPassword(password, { iterations: 1003 });
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext, 'utf8'), cipher.final()]);
}

function writeCookiesDatabase(dbPath: string): void {
  fs.mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    db.prepare(
      `INSERT INTO cookies (name, value, host_key, path, expires_utc, samesite, encrypted_value, is_secure, is_httponly)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(COOKIE_NAME, '', '.x.com', '/', 0, 0, encryptCookieValue(COOKIE_VALUE, KEYCHAIN_PASSWORD), 1, 1);
  } finally {
    db.close();
  }
}

async function readCookies(options: Parameters<ChromeSqliteMacModule['getCookiesFromChromeSqliteMac']>[0] = {}) {
  return getCookiesFromChromeSqliteMac(options, ORIGINS, new Set([COOKIE_NAME]));
}

describe.skipIf(!isBuiltin('node:sqlite'))('patched @steipete/sweet-cookie chromeSqliteMac provider', () => {
  beforeAll(async () => {
    ({ DatabaseSync } = await import('node:sqlite'));
    const cryptoModule = (await import(pathToFileURL(CRYPTO_PATH).href)) as CryptoModule;
    const providerModule = (await import(pathToFileURL(PROVIDER_PATH).href)) as ChromeSqliteMacModule;
    deriveAes128CbcKeyFromPassword = cryptoModule.deriveAes128CbcKeyFromPassword;
    getCookiesFromChromeSqliteMac = providerModule.getCookiesFromChromeSqliteMac;
  });

  beforeEach(() => {
    workDir = fs.mkdtempSync(join(os.tmpdir(), 'sweet-cookie-provider-'));
  });

  afterEach(() => {
    restoreBoundaryMocks();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('contains the Brave path markers in the installed patched provider', () => {
    const source = fs.readFileSync(PROVIDER_PATH, 'utf8');
    expect(source).toContain('bravesoftware');
    expect(source).toContain('brave-browser');
    expect(source).toContain('brave browser');
  });

  it('uses Chrome Safe Storage for the default Chrome cookies root', async () => {
    const home = join(workDir, 'home');
    writeCookiesDatabase(chromeCookiesPath(home));
    installBoundaryMocks(home);

    const result = await readCookies();

    expect(securityCalls).toEqual([{ account: 'Chrome', service: 'Chrome Safe Storage' }]);
    expect(result.cookies).toEqual([expect.objectContaining({ name: COOKIE_NAME, value: COOKIE_VALUE })]);
    expect(result.warnings).toEqual([]);
  });

  it('uses Brave Safe Storage for the default Brave root when Chrome is absent', async () => {
    const home = join(workDir, 'home');
    writeCookiesDatabase(braveCookiesPath(home));
    installBoundaryMocks(home);

    const result = await readCookies();

    expect(
      existsSyncCalls.some((candidate) =>
        candidate.startsWith(join(home, 'Library', 'Application Support', 'Google', 'Chrome')),
      ),
    ).toBe(true);
    expect(
      existsSyncCalls.some((candidate) =>
        candidate.startsWith(join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser')),
      ),
    ).toBe(true);
    expect(securityCalls).toEqual([{ account: 'Brave', service: 'Brave Safe Storage' }]);
    expect(result.cookies[0]?.value).toBe(COOKIE_VALUE);
  });

  it('prefers the Chrome root when both default Chrome and Brave databases exist', async () => {
    const home = join(workDir, 'home');
    writeCookiesDatabase(chromeCookiesPath(home));
    writeCookiesDatabase(braveCookiesPath(home));
    installBoundaryMocks(home);

    await readCookies();

    expect(securityCalls).toEqual([{ account: 'Chrome', service: 'Chrome Safe Storage' }]);
  });

  it.each([
    { marker: 'bravesoftware', segment: 'BRAVESOFTWARE' },
    { marker: 'brave-browser', segment: 'Brave-Browser' },
    { marker: 'brave browser', segment: 'BRAVE BROWSER' },
  ] as const)('selects Brave keychain for custom paths containing $marker', async ({ segment }) => {
    const dbPath = join(workDir, 'custom', segment, 'Cookies');
    writeCookiesDatabase(dbPath);
    installBoundaryMocks(join(workDir, 'unused-home'));

    await readCookies({ profile: dbPath });

    expect(securityCalls).toEqual([{ account: 'Brave', service: 'Brave Safe Storage' }]);
  });

  it('selects Chrome keychain for custom paths without Brave markers', async () => {
    const dbPath = join(workDir, 'custom', 'Google', 'Chrome', 'Cookies');
    writeCookiesDatabase(dbPath);
    installBoundaryMocks(join(workDir, 'unused-home'));

    await readCookies({ profile: dbPath });

    expect(securityCalls).toEqual([{ account: 'Chrome', service: 'Chrome Safe Storage' }]);
  });

  it('defaults the keychain timeout to 3000ms', async () => {
    const home = join(workDir, 'home');
    writeCookiesDatabase(chromeCookiesPath(home));
    installBoundaryMocks(home);

    await readCookies();

    expect(timeoutMsCalls).toContain(3000);
  });

  it('forwards an explicit keychain timeout', async () => {
    const home = join(workDir, 'home');
    writeCookiesDatabase(chromeCookiesPath(home));
    installBoundaryMocks(home);

    await readCookies({ timeoutMs: 50 });

    expect(timeoutMsCalls).toContain(50);
  });

  it('warns with the Chrome Safe Storage label when the password is empty', async () => {
    const home = join(workDir, 'home');
    writeCookiesDatabase(chromeCookiesPath(home));
    installBoundaryMocks(home);
    keychainPassword = '   ';

    const result = await readCookies();

    expect(result.cookies).toEqual([]);
    expect(result.warnings).toEqual(['macOS Keychain returned an empty Chrome Safe Storage password.']);
  });

  it('warns with the Brave Safe Storage label when the password is empty', async () => {
    const dbPath = join(workDir, 'custom', 'brave-browser', 'Cookies');
    writeCookiesDatabase(dbPath);
    installBoundaryMocks(join(workDir, 'unused-home'));
    keychainPassword = '';

    const result = await readCookies({ profile: dbPath });

    expect(result.cookies).toEqual([]);
    expect(result.warnings).toEqual(['macOS Keychain returned an empty Brave Safe Storage password.']);
  });

  it('decrypts sqlite cookie values with the derived AES-128-CBC key', async () => {
    const home = join(workDir, 'home');
    writeCookiesDatabase(chromeCookiesPath(home));
    installBoundaryMocks(home);

    const result = await readCookies({ profile: 'Default', includeExpired: false });

    expect(result.cookies).toEqual([
      expect.objectContaining({
        name: COOKIE_NAME,
        value: COOKIE_VALUE,
        domain: 'x.com',
      }),
    ]);
    expect(result.warnings).toEqual([]);
  });
});
