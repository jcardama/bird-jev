import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const fixtures: string[] = [];

afterEach(() => {
  for (const path of fixtures.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('npm package build', () => {
  it('packs the distribution and patched dependency without consumer installation hooks', () => {
    expect(manifest.private).not.toBe(true);
    expect(manifest.files).toEqual(['dist', 'README.md', 'CHANGELOG.md', 'LICENSE']);
    expect(manifest.bundleDependencies).toEqual(['@steipete/sweet-cookie']);
    expect(manifest.dependencies['@steipete/sweet-cookie']).toBe('0.1.0');
    expect(manifest.pnpm.patchedDependencies['@steipete/sweet-cookie']).toBe('patches/@steipete__sweet-cookie.patch');
    expect(manifest.scripts.prepack).toBe('npm run build:dist');
    for (const name of ['prepare', 'preinstall', 'install', 'postinstall', 'postpack']) {
      expect(manifest.scripts[name]).toBeUndefined();
    }
  });

  it(
    'cleans only generated output before compilation and copies executable assets',
    { skip: process.platform === 'win32', timeout: 60_000 },
    () => {
      const fixture = mkdtempSync(join(tmpdir(), 'bird package build '));
      fixtures.push(fixture);
      for (const dir of ['bin', 'scripts', 'src/lib', 'dist']) {
        mkdirSync(join(fixture, dir), { recursive: true });
      }
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({
          scripts: {
            prepack: manifest.scripts.prepack,
            'build:dist': manifest.scripts['build:dist'],
          },
        }),
      );
      writeFileSync(join(fixture, 'dist/stale-secret.txt'), 'synthetic private sentinel');
      writeFileSync(join(fixture, 'preserve.txt'), 'outside the generated directory');
      writeFileSync(join(fixture, 'user.npmrc'), '');
      writeFileSync(join(fixture, 'global.npmrc'), '');
      for (const file of ['query-ids.json', 'features.json']) {
        writeFileSync(join(fixture, 'src/lib', file), JSON.stringify({ file }));
      }
      copyFileSync(new URL('scripts/copy-dist-assets.js', root), join(fixture, 'scripts/copy-dist-assets.js'));
      writeFileSync(join(fixture, 'scripts/package.json'), '{"type":"module"}');
      const compiler = join(fixture, 'bin/tsc');
      writeFileSync(
        compiler,
        `#!/usr/bin/env node
const fs = require('node:fs');
if (fs.existsSync('dist')) throw new Error('dist was not cleaned before compilation');
fs.mkdirSync('dist');
fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\\n', { mode: 0o600 });
fs.writeFileSync('dist/index.js', 'export {};\\n');
`,
      );
      chmodSync(compiler, 0o755);
      const result = spawnSync('npm', ['run', 'prepack'], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: [join(fixture, 'bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
          HOME: fixture,
          npm_config_userconfig: join(fixture, 'user.npmrc'),
          npm_config_globalconfig: join(fixture, 'global.npmrc'),
          npm_config_cache: join(fixture, 'cache'),
          npm_config_update_notifier: 'false',
          npm_config_offline: 'true',
        },
      });
      expect({
        error: result.error,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toMatchObject({
        error: undefined,
        status: 0,
      });
      expect(existsSync(join(fixture, 'dist/stale-secret.txt'))).toBe(false);
      expect(readFileSync(join(fixture, 'preserve.txt'), 'utf8')).toBe('outside the generated directory');
      expect(readFileSync(join(fixture, 'dist/cli.js'), 'utf8')).toBe('#!/usr/bin/env node\n');
      expect(statSync(join(fixture, 'dist/cli.js')).mode & 0o777).toBe(0o755);
      for (const file of ['query-ids.json', 'features.json']) {
        expect(readFileSync(join(fixture, 'dist/lib', file), 'utf8')).toBe(JSON.stringify({ file }));
      }
    },
  );
});
