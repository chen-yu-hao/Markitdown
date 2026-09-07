import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite, DocumentService, loadSettings, saveSettings } from '../src/main/document-service';
import { canonicalPath, isWithinRoot, listDirectory, searchWorkspace } from '../src/main/workspace-service';
import type { DocumentSession } from '../src/shared/contracts';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

let directory: string;
let services: DocumentService[];
beforeEach(async () => { directory = await fs.mkdtemp(path.join(tmpdir(), 'markedown-storage-')); services = []; });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services) { service.docs.clear(); await service.flushRecovery(); }
  const relative = path.relative(tmpdir(), directory);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('markedown-storage-')) throw new Error('Unsafe test cleanup path.');
  await fs.rm(directory, { recursive: true, force: true });
});

async function service(name = 'data') {
  const instance = new DocumentService(path.join(directory, name));
  services.push(instance);
  await instance.initialize();
  return instance;
}
function update(instance: DocumentService, doc: DocumentSession, source: string, extra = {}) {
  instance.update(doc.id, { source, editVersion: instance.docs.get(doc.id)!.editVersion + 1, mode: 'live', selection: { anchor: source.length, head: source.length }, scrollTop: 0, ...extra });
}
async function textFile(name: string, source: string | Buffer) {
  const filename = path.join(directory, name);
  await fs.writeFile(filename, source);
  return filename;
}

describe('document files', () => {
  it.each([
    ['LF majority', 'a\r\nb\nc\n', 'LF', 'a\nb\nc\n'],
    ['CRLF majority', 'a\nb\r\nc\r\n', 'CRLF', 'a\r\nb\r\nc\r\n'],
    ['tie beginning with CRLF', 'a\r\nb\n', 'CRLF', 'a\r\nb\r\n'],
    ['tie beginning with LF', 'a\nb\r\n', 'LF', 'a\nb\n'],
    ['lone CR only', 'a\rb\r', 'LF', 'a\nb\n'],
    ['lone CR does not vote against CRLF', 'a\rb\rc\r\nd\r', 'CRLF', 'a\r\nb\r\nc\r\nd\r\n'],
  ])('matches original mixed newline policy: %s', async (_name, source, lineEnding, expected) => {
    const filename = await textFile('mixed.md', source);
    const store = await service();
    const doc = await store.open(filename);
    expect(doc.lineEnding).toBe(lineEnding);
    expect(doc.source).toBe(source.replace(/\r\n?/g, '\n'));
    expect((await store.save(doc.id)).status).toBe('ok');
    expect(await fs.readFile(filename, 'utf8')).toBe(expected);
  });

  it('round trips UTF-8 BOM, CRLF, Chinese, combining characters and emoji', async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# \u4e2d\u6587\r\ne\u0301 \ud83d\ude00\r\n')]);
    const filename = await textFile('\u4e2d\u6587 notes.md', original);
    const store = await service();
    const doc = await store.open(filename);
    expect(doc).toMatchObject({ bom: true, lineEnding: 'CRLF', dirty: false });
    expect(doc.source).toBe('# \u4e2d\u6587\ne\u0301 \ud83d\ude00\n');
    expect((await store.save(doc.id)).status).toBe('ok');
    expect(await fs.readFile(filename)).toEqual(original);
    update(store, doc, doc.source + 'tail\n');
    expect((await store.save(doc.id)).status).toBe('ok');
    expect(await fs.readFile(filename)).toEqual(Buffer.concat([original, Buffer.from('tail\r\n')]));
    expect(store.docs.get(doc.id)!.dirty).toBe(false);
  });

  it('preserves LF without adding a BOM or trailing newline', async () => {
    const filename = await textFile('lf.txt', 'first\nlast');
    const store = await service();
    const doc = await store.open(filename);
    await store.save(doc.id);
    expect(await fs.readFile(filename, 'utf8')).toBe('first\nlast');
    expect(doc).toMatchObject({ bom: false, lineEnding: 'LF' });
  });

  it('rejects malformed UTF-8 and binary data', async () => {
    const store = await service();
    await expect(store.open(await textFile('bad.txt', Buffer.from([0xc3, 0x28])))).rejects.toThrow();
    await expect(store.open(await textFile('binary.txt', 'hello\0world'))).rejects.toThrow('binary');
    expect(store.docs.size).toBe(0);
  });

  it('deduplicates simultaneous opens and Windows case aliases', async () => {
    const filename = await textFile('Same.MD', 'text');
    const store = await service();
    const [a, b] = await Promise.all([store.open(filename), store.open(path.join(directory, 'sub', '..', 'Same.MD'))]);
    expect(a.id).toBe(b.id);
    if (process.platform === 'win32') expect((await store.open(filename.toUpperCase())).id).toBe(a.id);
    expect(store.docs.size).toBe(1);
  });

  it('follows resolved file targets for open and Save As without replacing an alias', async () => {
    const target = await textFile('physical.md', 'original');
    const alias = await textFile('file-alias.md', 'alias entry stays intact');
    const actualRealpath = fs.realpath;
    vi.spyOn(fs, 'realpath').mockImplementation(async filename => String(filename) === alias ? actualRealpath(target) : actualRealpath(filename));
    const store = await service();
    const doc = await store.open(alias);
    expect(doc.path).toBe(await actualRealpath(target));
    expect(doc.source).toBe('original');
    expect((await store.open(target)).id).toBe(doc.id);
    update(store, doc, 'edited through alias');
    expect((await store.save(doc.id)).status).toBe('ok');
    expect(await fs.readFile(target, 'utf8')).toBe('edited through alias');
    expect(await fs.readFile(alias, 'utf8')).toBe('alias entry stays intact');
    const other = store.create();
    update(store, other, 'Save As draft');
    expect((await store.save(other.id, alias)).status).toBe('conflict');
    await store.close(doc.id);
    const saved = await store.save(other.id, alias);
    expect(saved).toMatchObject({ status: 'ok', value: { path: await actualRealpath(target) } });
    expect(await fs.readFile(target, 'utf8')).toBe('Save As draft');
    expect(await fs.readFile(alias, 'utf8')).toBe('alias entry stays intact');
    expect((await store.open(alias)).id).toBe(other.id);
  });

  it('preserves real file symlinks when the OS permits their creation', async ({ skip }) => {
    const target = await textFile('real-target.md', 'original');
    const alias = path.join(directory, 'real-link.md');
    try { await fs.symlink(target, alias, 'file'); }
    catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { skip(); return; } throw error; }
    const store = await service();
    const doc = await store.open(alias);
    expect(doc.path).toBe(await fs.realpath(target));
    update(store, doc, 'saved through real link');
    expect((await store.save(doc.id)).status).toBe('ok');
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('saved through real link');
    expect((await store.open(target)).id).toBe(doc.id);
  });

  it('resolves a new Save As path through an existing directory junction', async () => {
    const target = path.join(directory, 'real-folder');
    const alias = path.join(directory, 'folder-alias');
    await fs.mkdir(target);
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const store = await service();
    const doc = store.create();
    update(store, doc, 'new file');
    const saved = await store.save(doc.id, path.join(alias, 'new.md'));
    const targetFile = path.join(target, 'new.md');
    expect(saved).toMatchObject({ status: 'ok', value: { path: await fs.realpath(targetFile) } });
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(targetFile, 'utf8')).toBe('new file');
    expect((await store.open(path.join(alias, 'new.md'))).id).toBe(doc.id);
  });

  it('rejects malformed patches before changing any document state', async () => {
    const store = await service();
    const doc = store.create();
    const baseline = structuredClone(store.docs.get(doc.id));
    const valid = { source: 'must not be partially assigned', mode: 'live', editVersion: 1, scrollTop: 0, selection: { anchor: 0, head: 0 } };
    for (const patch of [
      { ...valid, selection: undefined }, { ...valid, selection: { anchor: NaN, head: 0 } },
      { ...valid, selection: { anchor: 0, head: 'invalid' } }, { ...valid, scrollTop: Infinity },
      { ...valid, mode: 'invalid' }, { ...valid, editVersion: -1 }, { ...valid, source: null },
    ]) {
      expect(() => store.update(doc.id, patch as never)).toThrow('Invalid document update');
      expect(store.docs.get(doc.id)).toEqual(baseline);
    }
  });

  it('detects same-size external edits even with the original mtime', async () => {
    const filename = await textFile('conflict.md', 'alpha');
    const store = await service();
    const doc = await store.open(filename);
    const metadata = await fs.stat(filename);
    update(store, doc, 'local');
    await fs.writeFile(filename, 'bravo');
    await fs.utimes(filename, metadata.atime, metadata.mtime);
    expect(await store.checkExternal(doc.id)).toBe('conflict');
    expect((await store.save(doc.id)).status).toBe('conflict');
    expect(await fs.readFile(filename, 'utf8')).toBe('bravo');
    expect(store.docs.get(doc.id)!.source).toBe('local');
    expect((await store.resolveExternal(doc.id, 'cancel')).status).toBe('cancelled');
    expect((await store.resolveExternal(doc.id, 'reload')).status).toBe('ok');
    expect(store.docs.get(doc.id)).toMatchObject({ source: 'bravo', savedSource: 'bravo', dirty: false });
  });

  it('reloads a clean document while clamping its selection', async () => {
    const filename = await textFile('reload.md', 'long original');
    const store = await service();
    const doc = await store.open(filename);
    update(store, doc, doc.source);
    await fs.writeFile(filename, 'new');
    expect(await store.checkExternal(doc.id)).toBe('reloaded');
    expect(store.docs.get(doc.id)).toMatchObject({ source: 'new', dirty: false, selection: { anchor: 3, head: 3 }, editVersion: 2 });
  });

  it('reports deletion and refuses to silently recreate the file', async () => {
    const filename = await textFile('deleted.md', 'initial');
    const store = await service();
    const doc = await store.open(filename);
    update(store, doc, 'changed');
    await fs.unlink(filename);
    expect(await store.checkExternal(doc.id)).toBe('deleted');
    expect((await store.save(doc.id)).status).toBe('conflict');
    const copy = path.join(directory, 'copy.md');
    expect((await store.save(doc.id, copy)).status).toBe('ok');
    expect(await fs.readFile(copy, 'utf8')).toBe('changed');
  });

  it('suppresses only the cancelled external revision and prompts for later edits or deletion', async () => {
    const filename = await textFile('ignored.md', 'original');
    const store = await service();
    const doc = await store.open(filename);
    update(store, doc, 'local draft');
    await fs.writeFile(filename, 'first external');
    expect(await store.checkExternal(doc.id)).toBe('conflict');
    expect((await store.resolveExternal(doc.id, 'cancel')).status).toBe('cancelled');
    expect(await store.checkExternal(doc.id)).toBe('unchanged');
    expect((await store.save(doc.id)).status).toBe('conflict');
    await fs.writeFile(filename, 'later external');
    expect(await store.checkExternal(doc.id)).toBe('conflict');
    await fs.unlink(filename);
    expect(await store.checkExternal(doc.id)).toBe('deleted');
    await store.resolveExternal(doc.id, 'cancel');
    expect(await store.checkExternal(doc.id)).toBe('unchanged');
    await fs.writeFile(filename, 'recreated');
    expect(await store.checkExternal(doc.id)).toBe('conflict');
    expect((await store.resolveExternal(doc.id, 'reload')).status).toBe('ok');
    expect(await store.checkExternal(doc.id)).toBe('unchanged');
  });

  it('preserves the original and removes temporary files when Windows blocks replacement', async () => {
    const filename = await textFile('locked.md', 'original');
    const store = await service();
    const doc = await store.open(filename);
    update(store, doc, 'edited');
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === filename) throw Object.assign(new Error('Sharing violation'), { code: 'EPERM' });
      return rename(from, to);
    });
    expect(await store.save(doc.id)).toMatchObject({ status: 'error', message: 'Sharing violation' });
    expect(await fs.readFile(filename, 'utf8')).toBe('original');
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(store.docs.get(doc.id)!.dirty).toBe(true);
  });

  it.runIf(process.platform === 'win32')('preserves the original under a real Windows FileShare.None lock', async () => {
    const cacheRoot = path.resolve('.cache');
    await fs.mkdir(cacheRoot, { recursive: true });
    const lockDirectory = await fs.mkdtemp(path.join(cacheRoot, 'markedown-lock-'));
    const filename = path.join(lockDirectory, '\u4e2d\u6587 exclusive.md');
    const original = Buffer.from('original\r\ncontent\r\n', 'utf8');
    await fs.writeFile(filename, original);
    const store = await service();
    const doc = await store.open(filename);
    update(store, doc, 'new draft\n');
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = ConvertFrom-Json -InputObject ([Console]::ReadLine())
$stream = [IO.File]::Open([string]$request.path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  [Console]::WriteLine('LOCKED')
  [Console]::Out.Flush()
  [void][Console]::ReadLine()
} finally { $stream.Dispose() }
`;
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const holder = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let closed = false;
    let diagnostic = '';
    const exited = new Promise<number | null>(resolve => holder.once('close', code => { closed = true; resolve(code); }));
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Windows lock helper timed out: ${diagnostic}`)), 6000);
      let output = '';
      holder.stdout.setEncoding('utf8');
      holder.stderr.setEncoding('utf8');
      holder.stdout.on('data', chunk => {
        output += chunk;
        if (/(?:^|\n)LOCKED\r?\n/.test(output)) { clearTimeout(timeout); resolve(); }
      });
      holder.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
      holder.on('error', error => { clearTimeout(timeout); reject(error); });
      holder.once('close', code => { clearTimeout(timeout); reject(new Error(`Windows lock helper exited ${code}: ${diagnostic}`)); });
      holder.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
    });
    holder.stdin.write(`${JSON.stringify({ path: filename })}\n`, 'utf8');
    try {
      try {
        await ready;
        const result = await store.save(doc.id);
        expect(result.status).toBe('error');
        expect(store.docs.get(doc.id)).toMatchObject({ source: 'new draft\n', savedSource: 'original\ncontent\n', dirty: true });
        expect((await fs.readdir(lockDirectory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
      } finally {
        holder.stdin.end('RELEASE\n');
        const timeout = setTimeout(() => holder.kill(), 2000);
        try { await exited; } finally { clearTimeout(timeout); }
      }
      expect(await fs.readFile(filename)).toEqual(original);
      expect((await store.save(doc.id)).status).toBe('ok');
      expect(await fs.readFile(filename, 'utf8')).toBe('new draft\r\n');
      expect((await fs.readdir(lockDirectory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      if (!closed) { holder.kill(); await exited; }
      const relative = path.relative(cacheRoot, lockDirectory);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(lockDirectory).startsWith('markedown-lock-')) throw new Error('Unsafe Windows lock test cleanup path.');
      await fs.rm(lockDirectory, { recursive: true, force: true });
    }
  }, 15000);

  it('keeps edits made during an in-flight save dirty', async () => {
    const filename = await textFile('race.md', 'initial');
    const store = await service();
    const doc = await store.open(filename);
    update(store, doc, 'snapshot');
    let reached!: () => void;
    let release!: () => void;
    const atRename = new Promise<void>(resolve => { reached = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === filename) { reached(); await barrier; }
      return rename(from, to);
    });
    const saving = store.save(doc.id);
    await atRename;
    update(store, doc, 'newer edit');
    release();
    expect(await saving).toMatchObject({ status: 'ok', value: { source: 'newer edit', savedSource: 'snapshot', dirty: true } });
    expect(await fs.readFile(filename, 'utf8')).toBe('snapshot');
    expect((await store.save(doc.id)).status).toBe('ok');
    expect(await fs.readFile(filename, 'utf8')).toBe('newer edit');
    expect(store.docs.get(doc.id)!.dirty).toBe(false);
  });

  it('does not replace another open document with Save As', async () => {
    const store = await service();
    const first = await store.open(await textFile('first.md', 'one'));
    const second = await store.open(await textFile('second.md', 'two'));
    update(store, first, 'replacement');
    expect((await store.save(first.id, second.path!)).status).toBe('conflict');
    expect(await fs.readFile(second.path!, 'utf8')).toBe('two');
  });

  it('reserves an unopened destination against simultaneous Save As operations', async () => {
    const store = await service();
    const first = store.create();
    const second = store.create();
    update(store, first, 'first draft');
    update(store, second, 'second draft');
    const filename = path.join(directory, 'shared.md');
    const outcomes = await Promise.all([store.save(first.id, filename), store.save(second.id, filename)]);
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['conflict', 'ok']);
    expect([...store.docs.values()].filter(doc => doc.path === filename)).toHaveLength(1);
    const saved = outcomes.find(outcome => outcome.status === 'ok')!;
    if (saved.status === 'ok') expect(await fs.readFile(filename, 'utf8')).toBe(saved.value.source);
  });

  it('uses strict 1 MiB and 5 MiB thresholds and rejects stale renderer updates', async () => {
    const store = await service();
    const exact = await store.open(await textFile('exact.md', 'a'.repeat(1024 * 1024)));
    expect(exact.mode).toBe('live');
    const preferred = await store.open(await textFile('preferred.md', 'a'.repeat(1024 * 1024 + 1)));
    expect(preferred.mode).toBe('source');
    update(store, preferred, 'a'.repeat(5 * 1024 * 1024));
    expect(store.docs.get(preferred.id)!.mode).toBe('live');
    update(store, preferred, 'a'.repeat(5 * 1024 * 1024 + 1));
    expect(store.docs.get(preferred.id)!.mode).toBe('source');
    store.update(preferred.id, { source: 'stale', editVersion: 0, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0 });
    expect(store.docs.get(preferred.id)!.source.length).toBe(5 * 1024 * 1024 + 1);
  });
});

describe('recovery and settings', () => {
  it('closes an approved batch together and preserves all documents if one changes during a pending save', async () => {
    const store = await service();
    const filename = await textFile('close-race.md', 'saved');
    const first = await store.open(filename);
    const second = store.create();
    update(store, first, 'pending save');
    update(store, second, 'second draft');
    const approvals = [...store.docs.values()].map(({ id, editVersion, source }) => ({ id, editVersion, source }));
    let reached!: () => void;
    let release!: () => void;
    const atRename = new Promise<void>(resolve => { reached = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === filename) { reached(); await barrier; }
      return rename(from, to);
    });
    const saving = store.save(first.id);
    await atRename;
    const closing = store.closeMany(approvals);
    update(store, second, 'newer second draft');
    release();
    await saving;
    expect((await closing).status).toBe('conflict');
    expect(store.docs.size).toBe(2);
    expect(store.docs.get(second.id)!.source).toBe('newer second draft');
    const fresh = [...store.docs.values()].map(({ id, editVersion, source }) => ({ id, editVersion, source }));
    expect(await store.closeMany(fresh)).toEqual({ status: 'ok', value: true });
    expect(store.docs.size).toBe(0);
    expect(await fs.readdir(path.join(directory, 'data', 'recovery'))).toEqual([]);
  });

  it('restores an entire close batch when recovery cleanup fails', async () => {
    const store = await service();
    const filename = await textFile('close-rollback.md', 'original');
    const first = await store.open(filename);
    const second = store.create();
    update(store, first, 'first draft');
    update(store, second, 'second draft');
    await fs.writeFile(filename, 'external');
    await store.resolveExternal(first.id, 'cancel');
    await store.flushRecovery();
    const unlink = fs.unlink;
    vi.spyOn(fs, 'unlink').mockImplementation(async target => {
      if (String(target).endsWith(`${second.id}.json`)) throw new Error('Recovery directory locked');
      return unlink(target);
    });
    const approvals = [...store.docs.values()].map(({ id, editVersion, source }) => ({ id, editVersion, source }));
    expect(await store.closeMany(approvals)).toMatchObject({ status: 'error', message: 'Recovery directory locked' });
    expect(store.docs.size).toBe(2);
    expect((await store.open(filename)).id).toBe(first.id);
    expect(await store.checkExternal(first.id)).toBe('unchanged');
    expect(store.docs.get(second.id)!.source).toBe('second draft');
  });

  it('marks every recovery dirty until explicitly saved, even when source matches its saved snapshot', async () => {
    const original = await service();
    const doc = original.create();
    update(original, doc, 'same');
    original.docs.get(doc.id)!.savedSource = 'same';
    await original.flushRecovery();
    const restored = await service();
    expect(restored.docs.get(doc.id)).toMatchObject({ source: 'same', savedSource: 'same', dirty: true, recovered: true });
    update(restored, doc, 'same');
    expect(restored.docs.get(doc.id)!.dirty).toBe(true);
    expect((await restored.save(doc.id, path.join(directory, 'explicit.md'))).status).toBe('ok');
    expect(restored.docs.get(doc.id)).toMatchObject({ dirty: false, recovered: false });
  });

  it('restores selection and requires an explicit save before automatic writes', async () => {
    const filename = await textFile('recover.md', 'saved');
    const original = await service();
    const doc = await original.open(filename);
    update(original, doc, 'unsaved', { selection: { anchor: 2, head: 4 }, scrollTop: 123 });
    await original.flushRecovery();
    const restored = await service();
    expect(restored.docs.get(doc.id)).toMatchObject({ source: 'unsaved', savedSource: 'saved', dirty: true, recovered: true, selection: { anchor: 2, head: 4 }, scrollTop: 123 });
    expect((await restored.save(doc.id, undefined, true)).status).toBe('cancelled');
    expect(await fs.readFile(filename, 'utf8')).toBe('saved');
    expect((await restored.save(doc.id)).status).toBe('ok');
    expect(restored.docs.get(doc.id)!.recovered).toBe(false);
    update(restored, doc, 'after explicit save');
    expect((await restored.save(doc.id, undefined, true)).status).toBe('ok');
    expect(await fs.readFile(filename, 'utf8')).toBe('after explicit save');
  });

  it('isolates corrupt recovery records and removes records for closed tabs', async () => {
    const original = await service();
    const doc = original.create();
    update(original, doc, 'recover me');
    await original.flushRecovery();
    const corruptName = `${randomUUID()}.json`;
    const recoveryDirectory = path.join(directory, 'data', 'recovery');
    await fs.writeFile(path.join(recoveryDirectory, corruptName), '{broken');
    const restored = await service();
    expect(restored.docs.size).toBe(1);
    expect(restored.recoveryErrors).toHaveLength(1);
    await restored.close(doc.id);
    expect(await fs.readdir(recoveryDirectory)).toEqual([corruptName]);
  });

  it('does not recreate recovery entries for documents that have been saved', async () => {
    const store = await service();
    const doc = store.create();
    update(store, doc, 'draft');
    await store.flushRecovery();
    expect(await fs.readdir(path.join(directory, 'data', 'recovery'))).toHaveLength(1);
    await store.save(doc.id, path.join(directory, 'saved.md'));
    await store.flushRecovery();
    expect(await fs.readdir(path.join(directory, 'data', 'recovery'))).toEqual([]);
  });

  it('validates settings and serializes simultaneous partial changes', async () => {
    const data = path.join(directory, 'settings');
    expect(await loadSettings(data)).toMatchObject({ fontSize: 17, autoSave: true });
    await Promise.all([saveSettings(data, { theme: 'night', fontSize: 999 }), saveSettings(data, { language: 'zh-CN', readingWidth: 10 })]);
    expect(await loadSettings(data)).toMatchObject({ theme: 'night', language: 'zh-CN', fontSize: 32, readingWidth: 480 });
    await fs.writeFile(path.join(data, 'settings.json'), '{broken');
    expect(await loadSettings(data)).toMatchObject({ theme: 'github', fontSize: 17 });
  });

  it('rechecks a destination immediately before atomic replacement', async () => {
    const filename = await textFile('atomic.md', 'original');
    await expect(atomicWrite(filename, Buffer.from('replacement'), async () => { throw new Error('conflict'); })).rejects.toThrow('conflict');
    expect(await fs.readFile(filename, 'utf8')).toBe('original');
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('workspace', () => {
  it('excludes original package directory extensions from listings and recursive search', async () => {
    for (const extension of ['app', 'appex', 'bundle', 'framework', 'key', 'numbers', 'pages', 'photoslibrary', 'playground', 'plugin', 'rtfd', 'xcodeproj', 'xcworkspace']) {
      const container = path.join(directory, `sample.${extension}`);
      await fs.mkdir(container);
      await fs.writeFile(path.join(container, 'internal.md'), 'needle');
    }
    await textFile('ordinary.md', 'needle');
    expect((await listDirectory(directory)).map(entry => entry.name)).toEqual(['ordinary.md']);
    expect((await searchWorkspace(directory, 'needle', true)).hits).toHaveLength(1);
    await expect(listDirectory(path.join(directory, 'sample.app'))).rejects.toThrow('packages');
    await expect(searchWorkspace(path.join(directory, 'sample.app'), 'needle', true)).rejects.toThrow('packages');
  });

  it.runIf(process.platform === 'win32')('respects Windows Hidden attributes and safely handles literal Unicode paths', async () => {
    const hiddenFile = await textFile('private.md', 'needle');
    const hiddenFolder = path.join(directory, 'hidden-folder');
    await fs.mkdir(hiddenFolder);
    await fs.writeFile(path.join(hiddenFolder, 'secret.md'), 'needle');
    const visibleName = '\u4e2d\u6587 `$literal.md';
    await textFile(visibleName, 'needle');
    const attrib = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'attrib.exe');
    await promisify(execFile)(attrib, ['+H', hiddenFile], { windowsHide: true });
    await promisify(execFile)(attrib, ['+H', hiddenFolder], { windowsHide: true });
    expect((await listDirectory(directory)).map(entry => entry.name)).toEqual([visibleName]);
    expect((await searchWorkspace(directory, 'needle', true)).hits.map(hit => path.basename(hit.path))).toEqual([visibleName]);
  });

  it.runIf(process.platform === 'win32')('cancels an active Windows metadata worker', async () => {
    await textFile('normal.md', 'needle');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    try { expect((await searchWorkspace(directory, 'needle', true, controller.signal)).cancelled).toBe(true); }
    finally { clearTimeout(timer); }
  });

  it('lists directories lazily, filters hidden/unsupported files and sorts naturally', async () => {
    await fs.mkdir(path.join(directory, 'folder'));
    await fs.mkdir(path.join(directory, '.hidden'));
    await textFile('note10.MD', 'x');
    await textFile('note2.txt', 'x');
    await textFile('image.png', 'x');
    await textFile('.private.md', 'x');
    expect((await listDirectory(directory)).map(entry => entry.name)).toEqual(['folder', 'note2.txt', 'note10.MD']);
  });

  it('finds literal matches with correct UTF-16 offsets, line numbers and case handling', async () => {
    const filename = await textFile('unicode.md', '\u0130 \ud83d\ude00 Test\r\nTest [a.b] test');
    const result = await searchWorkspace(directory, 'test', false);
    expect(result.hits).toEqual([
      { path: filename, line: 1, column: 6, offset: 5, preview: '\u0130 \ud83d\ude00 Test' },
      { path: filename, line: 2, column: 1, offset: 10, preview: 'Test [a.b] test' },
      { path: filename, line: 2, column: 12, offset: 21, preview: 'Test [a.b] test' },
    ]);
    expect((await searchWorkspace(directory, 'Test', true)).hits).toHaveLength(2);
    expect((await searchWorkspace(directory, '[a.b]', true)).hits).toHaveLength(1);
  });

  it('caps results at 500 and reports cancellation', async () => {
    await textFile('many.md', 'needle\n'.repeat(501));
    const result = await searchWorkspace(directory, 'needle', true);
    expect(result).toMatchObject({ truncated: true, cancelled: false });
    expect(result.hits).toHaveLength(500);
    const controller = new AbortController();
    controller.abort();
    expect(await searchWorkspace(directory, 'needle', true, controller.signal)).toMatchObject({ hits: [], cancelled: true });
  });

  it('ignores directory junctions and enforces path boundaries', async () => {
    const inside = path.join(directory, 'inside');
    const outside = path.join(directory, 'outside');
    await fs.mkdir(inside);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.md'), 'needle');
    await fs.symlink(outside, path.join(inside, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await listDirectory(inside)).toEqual([]);
    expect((await searchWorkspace(inside, 'needle', true)).hits).toEqual([]);
    expect(isWithinRoot(path.join(inside, 'note.md'), inside)).toBe(true);
    expect(isWithinRoot(`${inside}-sibling`, inside)).toBe(false);
    expect(isWithinRoot(path.join(inside, '..', 'outside'), inside)).toBe(false);
    expect(await canonicalPath(path.join(inside, 'link'))).toBe(await canonicalPath(outside));
  });
});
