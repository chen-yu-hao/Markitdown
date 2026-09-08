import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentService, loadSettings, saveSettings, validatedSettings } from '../src/main/document-service';
import { defaultSettings } from '../src/shared/contracts';
import { themeTokens } from '../src/shared/themes';
import { listDirectory, searchWorkspace } from '../src/main/workspace-service';
import { assertWritableDataDirectory, exportExtensions, newDocumentFilename, recentPaths, resolvedTheme, titleBarColors, validExportFormat } from '../src/main/platform-service';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'markedown-platform-')); });
afterEach(async () => {
  const relative = path.relative(tmpdir(), root);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('markedown-platform-')) throw new Error('Unsafe platform test cleanup.');
  await rm(root, { recursive: true, force: true });
});

describe('settings and platform behaviors', () => {
  it('probes actual data directory writes and leaves no probe files behind', async () => {
    const directory = path.join(root, 'portable-data');
    await assertWritableDataDirectory(directory);
    expect(await readdir(directory)).toEqual([]);
    const blocked = path.join(root, 'file-instead-of-directory');
    await writeFile(blocked, 'Preserved');
    await expect(assertWritableDataDirectory(blocked)).rejects.toThrow();
    expect(await readFile(blocked, 'utf8')).toBe('Preserved');
  });

  it('migrates legacy themes and workspace startup without mutating defaults', () => {
    expect(validatedSettings({ theme: 'graphite', reopenWorkspace: true })).toMatchObject({ theme: 'night', startup: 'workspace' });
    expect(validatedSettings({ theme: 'paper' })).toMatchObject({ theme: 'newsprint' });
    expect(validatedSettings({ theme: 'system' })).toMatchObject({ theme: 'github', separateDarkTheme: true });
    expect(validatedSettings({ theme: ['night'], language: ['en'], pageSize: ['Letter'] })).toMatchObject({ theme: 'github', language: 'system', pageSize: 'A4' });
    const fresh = validatedSettings({});
    fresh.exportPresets[0].name = 'Changed';
    fresh.shortcuts.bold = 'Ctrl+B';
    expect(defaultSettings.exportPresets[0].name).toBe('PDF');
    expect(defaultSettings.shortcuts).toEqual({});
    expect(fresh.defaultLineEnding).toBe(process.platform === 'win32' ? 'CRLF' : 'LF');
  });

  it('validates complete settings and preserves explicit false values and valid export presets', async () => {
    const settings = await saveSettings(root, {
      showHiddenFiles: true, fileFilter: 'all', defaultExtension: 'txt', defaultLineEnding: 'LF', startup: 'recent', recordHistory: false,
      recentFiles: [path.join(root, 'private.md')], recentWorkspaces: [root], imageFolder: 'media', imageUseRelative: false,
      imageAutoEscape: false, imageThumbnails: false, exportTheme: false, exportFolder: root, revealAfterExport: true,
      windowStyle: 'classic', zoom: 999, indentWidth: -8, readingSpeed: 1, shortcuts: { bold: 'Ctrl+Shift+B' },
      exportPresets: [{ id: 'plain', name: ' Plain HTML ', format: 'htmlPlain' }, { id: 'wiki', name: 'Wiki', format: 'mediawiki' }],
    });
    expect(settings).toMatchObject({ showHiddenFiles: true, fileFilter: 'all', defaultExtension: 'txt', defaultLineEnding: 'LF', startup: 'recent', recentFiles: [], recentWorkspaces: [], imageFolder: 'media', imageUseRelative: false, imageAutoEscape: false, imageThumbnails: false, exportTheme: false, windowStyle: 'classic', zoom: 200, indentWidth: 1, readingSpeed: 50, shortcuts: { bold: 'Ctrl+Shift+B' } });
    expect((await loadSettings(root)).exportPresets).toEqual([{ id: 'plain', name: 'Plain HTML', format: 'htmlPlain' }, { id: 'wiki', name: 'Wiki', format: 'mediawiki' }]);
    expect(validatedSettings({ exportPresets: [{ id: '../bad', name: 'Bad', format: 'html' }, { id: 'bad', name: 'Bad', format: 'exe' }], zoom: NaN, shortcuts: { '__proto__': 'Ctrl+B', bad: '$(execute)' } })).toMatchObject({ exportPresets: [], zoom: 100, shortcuts: {} });
  });

  it('uses selected line endings for new documents while opened files keep their own encoding', async () => {
    const service = new DocumentService(path.join(root, 'data'));
    await service.initialize();
    const newDoc = service.create({ defaultLineEnding: 'LF' });
    expect(newDoc.lineEnding).toBe('LF');
    const other = service.create({ defaultLineEnding: 'CRLF' });
    service.update(other.id, { source: 'first\nlast', mode: 'live', editVersion: 1, selection: { anchor: 0, head: 0 }, scrollTop: 0 });
    const file = path.join(root, newDocumentFilename('Untitled.md', { defaultExtension: 'txt' }));
    expect((await service.save(other.id, file)).status).toBe('ok');
    expect(await readFile(file, 'utf8')).toBe('first\r\nlast');
    service.docs.clear(); await service.flushRecovery();
  });

  it('merges concurrent recent history updates using the latest committed settings', async () => {
    const filenames = ['first.md', 'second.md', 'third.md'].map(name => path.join(root, name));
    await Promise.all(filenames.map(filename => saveSettings(root, current => ({ recentFiles: recentPaths(current.recentFiles, filename) }))));
    expect((await loadSettings(root)).recentFiles).toEqual([...filenames].reverse());
    await Promise.all([
      saveSettings(root, { recordHistory: false }),
      saveSettings(root, current => current.recordHistory ? { recentFiles: [filenames[0]] } : {}),
    ]);
    expect((await loadSettings(root)).recentFiles).toEqual([]);
  });

  it('applies hidden and file type filters consistently to tree and search', async () => {
    await writeFile(path.join(root, 'note.md'), 'needle');
    await writeFile(path.join(root, 'plain.txt'), 'needle');
    await writeFile(path.join(root, 'other.csv'), 'needle');
    await writeFile(path.join(root, '.hidden.md'), 'needle');
    await writeFile(path.join(root, 'binary.bin'), 'needle\0binary');
    await mkdir(path.join(root, 'folder'));
    const markdown = { showHiddenFiles: false, fileFilter: 'markdown' as const };
    expect((await listDirectory(root, markdown)).map(entry => entry.name)).toEqual(['folder', 'note.md']);
    expect((await searchWorkspace(root, 'needle', true, undefined, markdown)).hits).toHaveLength(1);
    const all = { showHiddenFiles: true, fileFilter: 'all' as const };
    expect((await listDirectory(root, all)).map(entry => entry.name)).toContain('.hidden.md');
    expect((await searchWorkspace(root, 'needle', true, undefined, all)).hits).toHaveLength(4);
  });

  it('resolves independent dark themes, recent history identity and extra export extensions', () => {
    const settings = { ...structuredClone(defaultSettings), theme: 'newsprint' as const, separateDarkTheme: true, darkTheme: 'night' as const };
    expect(resolvedTheme(settings, false)).toBe('newsprint');
    expect(resolvedTheme(settings, true)).toBe('night');
    expect(titleBarColors(settings, true)).toMatchObject({ color: themeTokens.night.chrome, symbolColor: themeTokens.night.ink, height: 36 });
    expect(newDocumentFilename('notes.markdown', { defaultExtension: 'md' })).toBe('notes.md');
    const original = path.join(root, 'notes.md');
    const duplicate = process.platform === 'win32' ? original.toUpperCase() : original;
    expect(recentPaths([duplicate], original)).toEqual([original]);
    expect(exportExtensions.htmlPlain).toBe('html');
    expect(validExportFormat('mediawiki')).toBe(true);
    expect(validExportFormat('opml')).toBe(true);
    expect(validExportFormat('__proto__')).toBe(false);
  });
});
