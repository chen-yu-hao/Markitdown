import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootFiles = ['README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', '.gitignore'];
const sourceDirectories = ['src', 'tests', 'scripts', 'resources', 'reference'];
const excludedDirectories = new Set(['node_modules', 'dist', 'release', '.git', '.codex', '.agents', '.cache', 'test-results', 'coverage', 'data', 'tmp', 'temp']);
const excludedFiles = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export async function collectSourceFiles(root = projectRoot) {
  const files = [];
  for (const filename of rootFiles) {
    if (!(await lstat(path.join(root, filename))).isFile()) throw new Error(`Required source file is missing: ${filename}`);
    files.push(filename);
  }
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink() || excludedFiles.has(entry.name) || /\.(?:log|tmp)$/i.test(entry.name)) continue;
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) { if (!excludedDirectories.has(entry.name)) await visit(filename); }
      else if (entry.isFile()) files.push(filename);
    }
  }
  for (const directory of sourceDirectories) {
    if (!(await lstat(path.join(root, directory))).isDirectory()) throw new Error(`Required source directory is missing: ${directory}`);
    await visit(directory);
  }
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

async function run(executable, args, cwd, capture = false) {
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let failure;
  child.on('error', error => { failure = error; });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
  const code = await new Promise(resolve => child.once('close', resolve));
  if (failure || code !== 0) throw new Error(`Archive command failed: ${failure?.message ?? (stderr.trim() || String(code))}`);
  return stdout;
}

async function sha256(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

async function sourceArchive(executable, destination, files, root, stem) {
  const staging = await mkdtemp(path.join(tmpdir(), 'markedown-source-'));
  const folder = path.join(staging, stem);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp.zip`);
  try {
    for (const filename of files) {
      const target = path.join(folder, filename);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(root, filename), target);
    }
    await run(executable, ['a', '-tzip', '-mx=7', '-mtc=off', '-mta=off', '-mcu=on', temporary, stem], staging);
    await run(executable, ['t', '-bd', temporary], staging);
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const relative = path.relative(tmpdir(), staging);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(staging).startsWith('markedown-source-')) throw new Error('Unsafe source staging cleanup path.');
    await rm(staging, { recursive: true, force: true });
  }
}

function releasePlatform(value = process.platform) {
  if (value === 'win32' || value === 'windows' || value === 'win') return { id: 'windows', label: 'Windows' };
  if (value === 'linux') return { id: 'linux', label: 'Linux' };
  throw new Error(`Unsupported release platform: ${value}`);
}

function artifactNames(product, version, platform) {
  const stem = `${product}-${version}-${platform.label}`;
  return platform.id === 'windows'
    ? { installer: `${stem}-x64-Setup.exe`, portable: `${stem}-x64.zip`, source: `${stem}-Source.zip` }
    : { appImage: `${stem}-x64.AppImage`, deb: `${stem}-x64.deb`, rpm: `${stem}-x64.rpm`, tarball: `${stem}-x64.tar.gz`, source: `${stem}-Source.zip` };
}

export async function release({ checkOnly = false, root = projectRoot, platform = process.platform } = {}) {
  const target = releasePlatform(platform);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-z\d.-]+)?$/i.test(manifest.version)) throw new Error('Invalid release version.');
  const output = path.resolve(root, manifest.build?.directories?.output ?? 'release');
  const product = 'Markit';
  const names = artifactNames(product, manifest.version, target);
  const files = await collectSourceFiles(root);
  const notices = ['THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_DEPENDENCIES.json', 'ThirdPartyNotices.md'];
  for (const filename of notices) if (!(await stat(path.join(root, 'resources', filename))).isFile()) throw new Error(`Missing ${filename}. Run npm run notices.`);
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js');
  if (checkOnly) {
    console.log(`Release inputs valid: ${files.length} source files; archive tool resolver available.`);
    console.log(`Expected outputs: ${Object.values(names).join(', ')}, SHA256SUMS.txt`);
    return { files: files.length, names };
  }
  const required = target.id === 'windows' ? [names.installer, names.portable] : [names.appImage, names.deb, names.rpm, names.tarball];
  for (const filename of required) if (!(await stat(path.join(output, filename))).isFile()) throw new Error(`Missing ${filename}. Run npm run dist:${target.id === 'windows' ? 'win' : 'linux'} to build the ${target.label} packages first.`);
  const executable = await getPath7za();
  if (target.id === 'windows') {
    const marker = JSON.parse(await run(executable, ['e', '-so', path.join(output, names.portable), 'portable.json'], output, true));
    if (marker.portable !== true || marker.version !== manifest.version) throw new Error('The ZIP is missing the current portable marker. Rebuild with the afterPack hook.');
    await run(executable, ['t', '-bd', path.join(output, names.portable)], output);
  } else {
    await run(executable, ['t', '-bd', path.join(output, names.tarball)], output);
  }
  await sourceArchive(executable, path.join(output, names.source), files, root, `${product}-${manifest.version}-${target.label}-Source`);
  for (const filename of notices) await copyFile(path.join(root, 'resources', filename), path.join(output, filename));
  await copyFile(path.join(root, 'README.md'), path.join(output, 'README.zh-CN.md'));
  const deliverables = [...Object.values(names), ...notices, 'README.zh-CN.md'].sort();
  const checksums = [];
  for (const filename of deliverables) checksums.push(`${await sha256(path.join(output, filename))}  ${filename}`);
  await writeFile(path.join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8');
  console.log(`Release ready in ${output}`);
  for (const filename of deliverables) console.log(`  ${filename}`);
  console.log('  SHA256SUMS.txt');
  return { output, deliverables, sourceFiles: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let platform;
  const unknown = process.argv.slice(2).filter(argument => {
    if (argument === '--check') return false;
    if (argument.startsWith('--platform=')) { platform = argument.slice('--platform='.length); return false; }
    return true;
  });
  if (unknown.length) throw new Error(`Unknown release arguments: ${unknown.join(', ')}`);
  await release({ checkOnly: process.argv.includes('--check'), platform });
}
