import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import afterPack from '../scripts/after-pack.cjs';
import { generateNotices } from '../scripts/notices.mjs';
import { collectSourceFiles, release } from '../scripts/release.mjs';

let root;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'markedown-release-test-')); });
afterEach(async () => {
  const relative = path.relative(tmpdir(), root);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('markedown-release-test-')) throw new Error('Unsafe release test cleanup path.');
  await rm(root, { recursive: true, force: true });
});

async function fixtureFile(relative, text) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, text, 'utf8');
}

describe('release delivery', () => {
  it('keeps conflicting license declarations distinct and verifies bundled component source', async () => {
    const hash = text => createHash('sha256').update(text).digest('hex');
    await fixtureFile('package.json', JSON.stringify({ name: 'markedown-windows', version: '1.0.0' }));
    await fixtureFile('package-lock.json', JSON.stringify({ packages: { 'node_modules/component': { version: '2.0.0' }, 'node_modules/electron': { version: '44.2.0', dev: true } } }));
    await fixtureFile('node_modules/component/package.json', JSON.stringify({ name: 'component', version: '2.0.0', license: 'CPAL-1.0 OR AGPL-1.0' }));
    await fixtureFile('node_modules/component/index.js', 'original runtime');
    await fixtureFile('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '44.2.0', license: 'MIT' }));
    await fixtureFile('resources/native-licenses/component-LICENSE.txt', 'original full license');
    await fixtureFile('resources/source-archives/component.tar.gz', 'original source archive');
    await fixtureFile('resources/native-licenses/component-provenance.json', JSON.stringify({ schemaVersion: 1, package: 'component', packageVersion: '2.0.0', sourceLicenseDeclaration: 'CPAL 1 or later OR AGPL 3 or later', selectedLicense: 'CPAL-1.0', licenseMetadataNote: 'Package metadata differs from source license.', files: [{ file: 'component-LICENSE.txt', sha256: hash('original full license') }], sourceArchive: { path: 'resources/source-archives/component.tar.gz', sha256: hash('original source archive') }, installedFiles: [{ file: 'index.js', sha256: hash('original runtime') }] }));
    await generateNotices(root);
    const manifest = JSON.parse(await readFile(path.join(root, 'resources/THIRD_PARTY_DEPENDENCIES.json'), 'utf8'));
    const component = manifest.packages.find(item => item.name === 'component');
    expect(component.license).toBe('CPAL-1.0 OR AGPL-1.0');
    expect(component.sourceLicenseDeclaration).toBe('CPAL 1 or later OR AGPL 3 or later');
    expect(component.distributionLicense).toBe('CPAL-1.0');
    expect(component.warnings).toContain('Package metadata differs from source license.');
    await fixtureFile('resources/source-archives/component.tar.gz', 'changed source archive');
    await expect(generateNotices(root)).rejects.toThrow('Supplemental source archive differs');
    await fixtureFile('resources/source-archives/component.tar.gz', 'original source archive');
    await fixtureFile('node_modules/component/index.js', 'changed runtime');
    await expect(generateNotices(root)).rejects.toThrow('Installed file differs');
  });

  it('collects installed production license texts, includes Electron, and flags missing declarations without replacing them', async () => {
    await fixtureFile('package.json', JSON.stringify({ name: 'markedown-windows', productName: 'Markedown', version: '0.1.6' }));
    await fixtureFile('package-lock.json', JSON.stringify({ packages: {
      '': { version: '0.1.6' },
      'node_modules/runtime-a': { version: '1.0.0' },
      'node_modules/unlicensed': { version: '2.0.0' },
      'node_modules/optional-other-platform': { version: '3.0.0', optional: true },
      'node_modules/dev-only': { version: '4.0.0', dev: true },
      'node_modules/electron': { version: '44.2.0', dev: true },
    } }));
    await fixtureFile('node_modules/runtime-a/package.json', JSON.stringify({ name: 'runtime-a', version: '1.0.0', license: 'MIT', repository: { url: 'https://example.invalid/runtime-a' } }));
    await fixtureFile('node_modules/runtime-a/LICENSE', 'Original runtime-a copyright and permission text.\n');
    await fixtureFile('node_modules/unlicensed/package.json', JSON.stringify({ name: 'unlicensed', version: '2.0.0' }));
    await fixtureFile('node_modules/dev-only/package.json', JSON.stringify({ name: 'dev-only', version: '4.0.0', license: 'MIT' }));
    await fixtureFile('node_modules/dev-only/LICENSE', 'Development-only text that must not appear.');
    await fixtureFile('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '44.2.0', license: 'MIT' }));
    await fixtureFile('node_modules/electron/LICENSE', 'Electron permission text.');
    await fixtureFile('node_modules/electron/dist/LICENSES.chromium.html', '<html>Separate Chromium notices.</html>');
    await fixtureFile('resources/ThirdPartyNotices.md', 'Authored source notice must stay unchanged.');
    await fixtureFile('resources/native-licenses/PROVENANCE.md', 'Verified upstream source and exact version scope.');
    await fixtureFile('resources/native-licenses/UPSTREAM.txt', 'Verbatim supplemental license text.');
    const result = await generateNotices(root);
    expect(result.packages).toBe(3);
    expect(result.licenseFiles).toBe(2);
    const output = await readFile(path.join(root, 'resources', 'THIRD_PARTY_LICENSES.txt'), 'utf8');
    expect(output).toContain('Original runtime-a copyright and permission text.\n');
    expect(output).toContain('Electron permission text.');
    expect(output).not.toContain('Development-only text');
    expect(output).not.toContain('<html>Separate Chromium notices.</html>');
    expect(output).toContain('Verbatim supplemental license text.');
    const manifest = JSON.parse(await readFile(path.join(root, 'resources', 'THIRD_PARTY_DEPENDENCIES.json'), 'utf8'));
    expect(manifest.packages.find(item => item.name === 'unlicensed').license).toBe('UNDECLARED');
    expect(manifest.packages.find(item => item.name === 'electron').bundledRuntimeNotices).toEqual(['LICENSES.chromium.html']);
    expect(manifest.omittedOptionalPackages).toHaveLength(1);
    expect(manifest.supplementalFiles).toHaveLength(2);
    expect(manifest.supplementalFiles[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(path.join(root, 'resources', 'ThirdPartyNotices.md'), 'utf8')).toBe('Authored source notice must stay unchanged.');
  });

  it('stages portable metadata and notices beside the executable and rejects an out-of-tree hook path', async () => {
    await fixtureFile('package.json', JSON.stringify({ productName: 'Markedown', version: '0.1.6' }));
    await fixtureFile('README.md', 'Chinese build instructions.');
    for (const name of ['THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_DEPENDENCIES.json', 'ThirdPartyNotices.md']) await fixtureFile(`resources/${name}`, `contents of ${name}`);
    const output = path.join(root, 'release', 'win-unpacked');
    await mkdir(output, { recursive: true });
    const context = { electronPlatformName: 'win32', appOutDir: output, packager: { projectDir: root, config: { directories: { output: 'release' } } } };
    await afterPack(context);
    expect(JSON.parse(await readFile(path.join(output, 'portable.json'), 'utf8'))).toEqual({ format: 1, portable: true, product: 'Markedown', version: '0.1.6' });
    expect(await readFile(path.join(output, 'README.zh-CN.md'), 'utf8')).toBe('Chinese build instructions.');
    expect(await readFile(path.join(output, 'THIRD_PARTY_LICENSES.txt'), 'utf8')).toBe('contents of THIRD_PARTY_LICENSES.txt');
    const linuxOutput = path.join(root, 'release', 'linux-unpacked');
    await mkdir(linuxOutput, { recursive: true });
    await afterPack({ ...context, electronPlatformName: 'linux', appOutDir: linuxOutput });
    expect(await readdir(linuxOutput)).not.toContain('portable.json');
    expect(await readFile(path.join(linuxOutput, 'README.zh-CN.md'), 'utf8')).toBe('Chinese build instructions.');
    await expect(afterPack({ ...context, appOutDir: root })).rejects.toThrow('outside');
    expect(await readdir(root)).not.toContain('portable.json');
  });

  it('selects complete source inputs without dependency trees, generated outputs, caches or local agent data', async () => {
    for (const file of ['README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', '.gitignore']) await fixtureFile(file, 'source input');
    for (const directory of ['src', 'tests', 'scripts', 'resources', 'reference']) await fixtureFile(`${directory}/kept.txt`, 'keep');
    await fixtureFile('src/node_modules/secret.txt', 'omit');
    await fixtureFile('src/.cache/secret.txt', 'omit');
    await fixtureFile('scripts/test-results/secret.txt', 'omit');
    await fixtureFile('resources/data/secret.txt', 'omit');
    await fixtureFile('reference/.git/config', 'omit');
    await fixtureFile('reference/.codex/settings.json', 'omit');
    await fixtureFile('reference/.agents/instructions.md', 'omit');
    await fixtureFile('src/debug.log', 'omit');
    await fixtureFile('dist/main/index.cjs', 'omit');
    await fixtureFile('release/existing.zip', 'omit');
    const files = (await collectSourceFiles(root)).map(filename => filename.split(path.sep).join('/'));
    expect(files).toHaveLength(12);
    expect(files).toContain('package-lock.json');
    expect(files).toContain('reference/kept.txt');
    expect(files).not.toContain('dist/main/index.cjs');
    expect(files.every(filename => !filename.includes('secret') && !filename.includes('.codex') && !filename.includes('.agents'))).toBe(true);
  });

  it('reports Linux release artifacts in check mode', async () => {
    for (const file of ['README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', '.gitignore']) await fixtureFile(file, file === 'package.json' ? JSON.stringify({ productName: 'Markedown', version: '0.3.2', build: { directories: { output: 'release' } } }) : 'source input');
    for (const directory of ['src', 'tests', 'scripts', 'resources', 'reference']) await fixtureFile(`${directory}/kept.txt`, 'keep');
    for (const name of ['THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_DEPENDENCIES.json', 'ThirdPartyNotices.md']) await fixtureFile(`resources/${name}`, `contents of ${name}`);
    const result = await release({ root, checkOnly: true, platform: 'linux' });
    expect(result.names).toEqual({
      appImage: 'Markedown-0.3.2-Linux-x64.AppImage',
      deb: 'Markedown-0.3.2-Linux-x64.deb',
      tarball: 'Markedown-0.3.2-Linux-x64.tar.gz',
      source: 'Markedown-0.3.2-Linux-Source.zip',
    });
  });
});
