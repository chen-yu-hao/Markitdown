import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, shell } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DocumentService, loadSettings, saveSettings, type SettingsUpdate } from './document-service';
import { canonicalPath, isWithinRoot, listDirectory, searchWorkspace } from './workspace-service';
import { imageResponse, importImages } from './image-service';
import { exportDocument, findPandoc, importDocumentToMarkdown } from './export-service';
import { assertWritableDataDirectory, exportExtensions, newDocumentFilename, recentPaths, resolvedTheme, setNewFileRegistration, titleBarColors, validExportFormat } from './platform-service';
import { prepareClose } from './close-policy';
import type { AppEvent, DocumentPatch, DocumentSession, ExportFormat, ImageInput, Result, Settings } from '../shared/contracts';
import { defaultSettings } from '../shared/contracts';
import { ExtensionRegistry } from '../shared/extensions';
import { ZoteroService } from './zotero-service';
import { CitationService } from './citation-service';
import { listMarkdownExtensions } from '../shared/markdown';

protocol.registerSchemesAsPrivileged([{ scheme: 'markedown-image', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName('Markedown');
if (process.platform === 'win32') app.setAppUserModelId('com.zhuanz.markedown');
const testMode = process.argv.includes('--test-mode');
const testData = process.env.MARKEDOWN_DATA_DIR;
const portable = existsSync(path.join(path.dirname(process.execPath), 'portable.json'));
if (testData) app.setPath('userData', path.resolve(testData));
else if (portable) app.setPath('userData', path.join(path.dirname(process.execPath), 'data'));
const singleInstance = testMode || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let service: DocumentService;
let settings: Settings;
let zotero: ZoteroService;
let citations: CitationService;
const extensions = new ExtensionRegistry();
const referenceSearches = new Map<number, AbortController>();
const windows = new Map<number, BrowserWindow>();
const owners = new Map<string, number>();
const workspaces = new Map<number, string>();
const searches = new Map<number, AbortController>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saving = new Set<string>();
const externallyNotified = new Set<string>();
const closing = new Set<number>();
const closeRequests = new Set<number>();
const rendererReady = new Set<number>();
const initialErrors = new Map<number, string[]>();
const integratedWindows = new Set<number>();

let polling = false;
let reportedRecoveryErrors = 0;
let firstWindow = true;
const textExtensions = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdtxt', 'txt', 'text'];
const maxImageBytes = 64 * 1024 * 1024;
const maxImageBatchBytes = 256 * 1024 * 1024;
const fail = (error: unknown): Result<never> => ({ status: 'error', message: error instanceof Error ? error.message : String(error) });
const chinese = () => settings?.language === 'zh-CN' || (settings?.language !== 'en' && app.getLocale().startsWith('zh'));
const tr = (zh: string, en: string) => chinese() ? zh : en;
const emit = (windowId: number | undefined, event: AppEvent) => {
  const win = windowId === undefined ? undefined : windows.get(windowId);
  if (!win || win.isDestroyed()) return;
  if (event.type === 'error' && !rendererReady.has(win.id)) {
    initialErrors.set(win.id, [...initialErrors.get(win.id) || [], event.message]);
    return;
  }
  win.webContents.send('markedown:event', event);
};
function publish(document: DocumentSession, activate = false) { emit(owners.get(document.id), { type: 'document', document, activate }); }
async function persistSettings(patch: SettingsUpdate) {
  settings = await saveSettings(service.dataDir, patch);
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue;
    applyWindowSettings(win);
    emit(win.id, { type: 'settings', settings });
  }
  return settings;
}
function applyWindowSettings(win: BrowserWindow) {
  win.setMenu(null);
  win.webContents.setZoomFactor(settings.zoom / 100);
  win.webContents.session.setSpellCheckerEnabled(settings.spellcheck !== 'off');
  if (settings.spellcheck === 'en-US' || settings.spellcheck === 'en-GB') win.webContents.session.setSpellCheckerLanguages([settings.spellcheck]);
  else if (settings.spellcheck === 'auto') {
    const available = win.webContents.session.availableSpellCheckerLanguages;
    const language = available.includes(app.getLocale()) ? app.getLocale() : 'en-US';
    if (available.includes(language)) win.webContents.session.setSpellCheckerLanguages([language]);
  }
  if (integratedWindows.has(win.id)) win.setTitleBarOverlay(titleBarColors(settings, nativeTheme.shouldUseDarkColors));
}
async function rememberPath(windowId: number, key: 'recentFiles' | 'recentWorkspaces', filename: string) {
  if (!settings.recordHistory) return;
  try {
    await persistSettings(current => current.recordHistory ? { [key]: recentPaths(current[key], filename, key === 'recentFiles' ? 30 : 10) } : {});
  } catch (error) {
    emit(windowId, { type: 'error', message: `${tr('无法更新最近记录', 'Unable to update recent history')}: ${error instanceof Error ? error.message : String(error)}` });
  }
}
async function selectWorkspace(win: BrowserWindow, directory: string) {
  if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error('Choose a valid folder.');
  await listDirectory(directory, settings);
  workspaces.set(win.id, directory);
  await rememberPath(win.id, 'recentWorkspaces', directory);
  return directory;
}
function own(win: BrowserWindow, id: string) {
  if (owners.get(id) !== win.id) throw new Error('This document is not owned by this window.');
  const doc = service.docs.get(id);
  if (!doc) throw new Error('Document has already closed.');
  return doc;
}
function applyPatch(id: string, patch: DocumentPatch) {
  if (!patch || typeof patch.source !== 'string' || !Number.isSafeInteger(patch.editVersion) || patch.editVersion < 0 || !['live', 'source'].includes(patch.mode)
    || !patch.selection || !Number.isSafeInteger(patch.selection.anchor) || !Number.isSafeInteger(patch.selection.head)
    || patch.selection.anchor < 0 || patch.selection.head < 0 || patch.selection.anchor > patch.source.length || patch.selection.head > patch.source.length
    || !Number.isFinite(patch.scrollTop) || patch.scrollTop < 0) throw new Error('Invalid document update.');
  service.update(id, patch);
}
function scheduleAutoSave(id: string) {
  clearTimeout(saveTimers.get(id));
  const doc = service.docs.get(id);
  if (!settings.autoSave || !doc?.dirty || !doc.path || doc.recovered || closeRequests.has(owners.get(id) ?? -1)) return;
  saveTimers.set(id, setTimeout(async () => {
    saveTimers.delete(id);
    if (saving.has(id)) { scheduleAutoSave(id); return; }
    saving.add(id);
    try {
      const result = await service.save(id, undefined, true);
      if (result.status === 'ok') { publish(result.value); if (result.value.dirty) scheduleAutoSave(id); }
      else if (result.status === 'conflict') notifyExternal(id, false);
      else if (result.status === 'error') emit(owners.get(id), { type: 'error', message: result.message });
    } finally { saving.delete(id); }
  }, 1100));
}
function notifyExternal(id: string, deleted: boolean) {
  if (externallyNotified.has(id)) return;
  externallyNotified.add(id);
  emit(owners.get(id), { type: 'external', id, deleted });
}
async function saveWithDialog(win: BrowserWindow, id: string, saveAs = false): Promise<Result<DocumentSession>> {
  const doc = own(win, id);
  let target: string | undefined;
  if (!doc.path || saveAs) {
    const result = await dialog.showSaveDialog(win, {
      title: tr('保存 Markdown 文稿', 'Save Markdown document'),
      defaultPath: doc.path || path.join(workspaces.get(win.id) || app.getPath('documents'), newDocumentFilename(doc.title, settings)),
      filters: [{ name: 'Markdown / Text', extensions: [settings.defaultExtension, ...textExtensions.filter(extension => extension !== settings.defaultExtension)] }],
    });
    if (result.canceled || !result.filePath) return { status: 'cancelled' };
    target = result.filePath;
  }
  clearTimeout(saveTimers.get(id));
  saving.add(id);
  try {
    const result = await service.save(id, target);
    if (result.status === 'ok') { externallyNotified.delete(id); publish(result.value); if (result.value.path) await rememberPath(win.id, 'recentFiles', result.value.path); if (result.value.dirty) scheduleAutoSave(id); }
    return result;
  } finally { saving.delete(id); }
}
async function closeDocuments(win: BrowserWindow, ids: string[], entireWindow = false): Promise<Result<boolean>> {
  if (closeRequests.has(win.id)) return { status: 'cancelled' };
  closeRequests.add(win.id);
  for (const [id, owner] of owners) if (owner === win.id) clearTimeout(saveTimers.get(id));
  try {
    const prepared = await prepareClose(ids, {
      read: id => owners.get(id) === win.id ? service.docs.get(id) : undefined,
      decide: async doc => {
        const { response } = await dialog.showMessageBox(win, {
          type: 'question', title: 'Markedown', message: tr(`保存对“${doc.title}”的更改？`, `Save changes to "${doc.title}"?`),
          buttons: [tr('保存', 'Save'), tr('不保存', "Don't Save"), tr('取消', 'Cancel')], cancelId: 2, defaultId: 0, noLink: true,
        });
        return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
      },
      save: id => saveWithDialog(win, id),
    });
    if (prepared.status !== 'ok') return prepared;
    if (entireWindow && [...owners].some(([id, owner]) => owner === win.id && !ids.includes(id))) return { status: 'cancelled' };
    const enabled = win.isEnabled();
    win.setEnabled(false);
    try {
      const result = await service.closeMany(prepared.value);
      if (result.status === 'ok') for (const id of ids) {
        clearTimeout(saveTimers.get(id));
        saveTimers.delete(id);
        owners.delete(id);
        externallyNotified.delete(id);
      }
      return result;
    } finally { if (!win.isDestroyed()) win.setEnabled(enabled); }
  } finally {
    closeRequests.delete(win.id);
    for (const [id, owner] of owners) if (owner === win.id) scheduleAutoSave(id);
  }
}

async function checkExternalChanges(windowId?: number) {
  if (polling) return;
  polling = true;
  try {
    for (const doc of [...service.docs.values()]) {
      const owner = owners.get(doc.id);
      if ((windowId !== undefined && owner !== windowId) || saving.has(doc.id) || closeRequests.has(owner ?? -1)) continue;
      try {
        const result = await service.checkExternal(doc.id);
        if (result === 'reloaded') { externallyNotified.delete(doc.id); const current = service.docs.get(doc.id); if (current) publish(current); }
        else if (result === 'conflict' || result === 'deleted') notifyExternal(doc.id, result === 'deleted');
      } catch (error) { emit(owner, { type: 'error', message: String(error) }); }
    }
    for (const message of service.recoveryErrors.slice(reportedRecoveryErrors)) for (const win of windows.values()) emit(win.id, { type: 'error', message });
    reportedRecoveryErrors = service.recoveryErrors.length;
  } finally { polling = false; }
}

async function selectedImages(filenames: string[]): Promise<ImageInput[]> {
  if (filenames.length > 100) throw new Error('Select up to 100 images at a time.');
  const metadata = await Promise.all(filenames.map(filename => stat(filename)));
  if (metadata.some(file => !file.isFile() || file.size > maxImageBytes) || metadata.reduce((size, file) => size + file.size, 0) > maxImageBatchBytes) throw new Error('Images are limited to 64 MiB each and 256 MiB per batch.');
  const inputs: ImageInput[] = [];
  let totalBytes = 0;
  for (const filename of filenames) {
    const file = await open(filename, 'r');
    try {
      const current = await file.stat();
      if (!current.isFile() || current.size > maxImageBytes || totalBytes + current.size > maxImageBatchBytes) throw new Error('Images are limited to 64 MiB each and 256 MiB per batch.');
      const bytes = Buffer.alloc(current.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > current.size) throw new Error('An image changed while reading. Select it again.');
      totalBytes += length;
      inputs.push({ name: path.basename(filename), bytes: bytes.subarray(0, length) });
    } finally { await file.close(); }
  }
  return inputs;
}
async function openPaths(win: BrowserWindow, paths: string[]): Promise<DocumentSession[]> {
  if (paths.some(filename => typeof filename !== 'string' || !path.isAbsolute(filename))) throw new Error('Choose absolute local file paths.');
  const opened: DocumentSession[] = [];
  const errors: string[] = [];
  let succeeded = 0;
  for (const filename of paths) {
    try {
      const doc = await service.open(filename);
      const owner = owners.get(doc.id);
      if (owner !== undefined && owner !== win.id) {
        const existing = windows.get(owner);
        existing?.restore(); existing?.show(); existing?.focus(); publish(doc, true);
      } else { owners.set(doc.id, win.id); opened.push(doc); publish(doc, true); }
      succeeded++;
      if (doc.path) await rememberPath(win.id, 'recentFiles', doc.path);
    } catch (error) { errors.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (errors.length && !succeeded) throw new Error(errors.join('\n'));
  for (const message of errors) emit(win.id, { type: 'error', message });
  return opened;
}
function argvFiles(argv: string[]) { return argv.filter(arg => path.isAbsolute(arg) && textExtensions.includes(path.extname(arg).slice(1).toLowerCase())); }
async function importDocumentPaths(win: BrowserWindow, filenames: string[]): Promise<DocumentSession[]> {
  if (filenames.length > 100) throw new Error('Import up to 100 documents at a time.');
  const imported: DocumentSession[] = [];
  for (const filename of filenames) {
    if (!path.isAbsolute(filename) || !(await stat(filename)).isFile()) throw new Error('Choose a local document file.');
    const destination = await dialog.showSaveDialog(win, {
      title: tr('导入为 Markdown', 'Import as Markdown'),
      defaultPath: path.join(workspaces.get(win.id) || path.dirname(filename), `${path.parse(filename).name}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (destination.canceled || !destination.filePath) continue;
    const identity = await canonicalPath(destination.filePath);
    if (identity === await canonicalPath(filename)) throw new Error('Choose a different output file to preserve the original document.');
    for (const opened of service.docs.values()) if (opened.path && await canonicalPath(opened.path) === identity) throw new Error('The import destination is already open. Choose another file.');
    const source = await importDocumentToMarkdown(filename, destination.filePath, settings);
    const doc = service.create(settings);
    service.update(doc.id, { source, mode: 'live', editVersion: 1, selection: { anchor: 0, head: 0 }, scrollTop: 0 });
    owners.set(doc.id, win.id);
    const result = await service.save(doc.id, destination.filePath);
    const current = result.status === 'ok' ? result.value : service.docs.get(doc.id)!;
    publish(current, true);
    imported.push(current);
    if (result.status === 'ok' && result.value.path) await rememberPath(win.id, 'recentFiles', result.value.path);
    else if (result.status === 'error' || result.status === 'conflict') emit(win.id, { type: 'error', message: result.message });
  }
  return imported;
}
async function createWindow(paths: string[] = []) {
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 700, minHeight: 480, title: 'Markedown', show: false,
    backgroundColor: titleBarColors(settings, nativeTheme.shouldUseDarkColors).color, icon: path.join(app.getAppPath(), 'resources', 'icon.png'),
    ...(settings.windowStyle === 'integrated' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarColors(settings, nativeTheme.shouldUseDarkColors) } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  windows.set(win.id, win);
  if (settings.windowStyle === 'integrated') integratedWindows.add(win.id);
  applyWindowSettings(win);
  if (firstWindow) {
    for (const doc of service.docs.values()) owners.set(doc.id, win.id);
    if (settings.startup === 'workspace' && settings.recentWorkspaces[0]) {
      const root = settings.recentWorkspaces[0];
      if (await stat(root).then(s => s.isDirectory()).catch(() => false)) workspaces.set(win.id, root);
    }
    if (!paths.length && service.docs.size === 0 && settings.startup === 'recent') paths = settings.recentFiles.slice(0, 10);
    firstWindow = false;
  }
  await openPaths(win, paths).catch(error => emit(win.id, { type: 'error', message: String(error) }));
  if (![...owners.values()].includes(win.id)) { const doc = service.create(settings); owners.set(doc.id, win.id); }
  win.webContents.setWindowOpenHandler(({ url }) => { void safeExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('close', event => {
    if (closing.has(win.id)) return;
    event.preventDefault();
    if (closeRequests.has(win.id)) return;
    if (win.webContents.isDestroyed()) {
      closeRequests.add(win.id);
      void service.flushRecovery().catch(error => dialog.showErrorBox('Markedown', String(error))).finally(() => { closing.add(win.id); closeRequests.delete(win.id); win.destroy(); });
      return;
    }
    const ids = [...owners].filter(([, owner]) => owner === win.id).map(([id]) => id);
    void closeDocuments(win, ids, true).then(result => {
      if (result.status === 'ok') { closing.add(win.id); win.close(); }
      else if (result.status === 'error' || result.status === 'conflict') void dialog.showMessageBox(win, { type: 'warning', title: 'Markedown', message: tr('文稿仍保持打开。', 'Your documents remain open.'), detail: result.message });
    }).catch(error => dialog.showErrorBox('Markedown', String(error)));
  });
  win.on('focus', () => { if (rendererReady.has(win.id)) void checkExternalChanges(win.id); });
  win.on('closed', () => { windows.delete(win.id); integratedWindows.delete(win.id); workspaces.delete(win.id); searches.get(win.id)?.abort(); searches.delete(win.id); referenceSearches.get(win.id)?.abort(); referenceSearches.delete(win.id); initialErrors.delete(win.id); rendererReady.delete(win.id); closeRequests.delete(win.id); closing.delete(win.id); });
  if (process.env.MARKEDOWN_DEV_URL) await win.loadURL(process.env.MARKEDOWN_DEV_URL);
  else await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}
async function safeExternal(raw: string) {
  if (typeof raw !== 'string') return;
  try { const url = new URL(raw); if (['http:', 'https:', 'mailto:'].includes(url.protocol)) await shell.openExternal(url.href); } catch { /* Invalid links stay in the editor. */ }
}
function installMenu() {
  Menu.setApplicationMenu(null);
  for (const win of windows.values()) win.setMenu(null);
}
function installIPC() {
  const handle = (name: string, fn: (win: BrowserWindow, ...args: any[]) => unknown) => ipcMain.handle(`markedown:${name}`, (event, ...args) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !windows.has(win.id) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted IPC sender.');
    return fn(win, ...args);
  });
  handle('references.status', () => zotero.status());
  handle('references.search', async (win, query: string) => {
    if (typeof query !== 'string' || query.length > 300) throw new Error('Invalid reference search.');
    referenceSearches.get(win.id)?.abort();
    const controller = new AbortController(); referenceSearches.set(win.id, controller);
    try { return await zotero.search(query, controller.signal); }
    finally { if (referenceSearches.get(win.id) === controller) referenceSearches.delete(win.id); }
  });
  handle('references.cancelSearch', win => { referenceSearches.get(win.id)?.abort(); referenceSearches.delete(win.id); });
  handle('references.resolve', (_win, source: string, refresh = false) => citations.resolve(source, { ...settings }, refresh === true));
  handle('extensions.list', () => [...listMarkdownExtensions(), ...extensions.list()]);
  handle('bootstrap', win => {
    rendererReady.add(win.id);
    const recoveryErrors = [...service.recoveryErrors, ...initialErrors.get(win.id) || []];
    initialErrors.delete(win.id);
    return { documents: [...service.docs.values()].filter(doc => owners.get(doc.id) === win.id), settings, workspace: workspaces.get(win.id) || null, recoveryErrors, locale: app.getLocale(), version: app.getVersion() };
  });
  handle('newDocument', win => { const doc = service.create(settings); owners.set(doc.id, win.id); return doc; });
  handle('newWindow', () => createWindow().then(() => undefined));
  handle('openFiles', async (win, paths?: string[]) => {
    try {
      if (!paths) { const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: textExtensions }] }); if (result.canceled) return { status: 'cancelled' }; paths = result.filePaths; }
      if (!Array.isArray(paths) || paths.length > 100) throw new Error('Select up to 100 files at a time.');
      return { status: 'ok', value: await openPaths(win, paths) };
    } catch (error) { return fail(error); }
  });
  handle('updateDocument', (win, id: string, patch: DocumentPatch) => {
    own(win, id); applyPatch(id, patch);
    scheduleAutoSave(id);
  });
  handle('saveDocument', async (win, id: string, patch: DocumentPatch, saveAs = false) => { try { own(win, id); applyPatch(id, patch); return await saveWithDialog(win, id, saveAs); } catch (error) { return fail(error); } });
  handle('closeDocument', async (win, id: string) => { try { own(win, id); return await closeDocuments(win, [id]); } catch (error) { return fail(error); } });
  handle('resolveExternal', async (win, id: string, action: 'reload' | 'copy' | 'cancel') => {
    try {
      own(win, id);
      const result = action === 'copy' ? await saveWithDialog(win, id, true) : await service.resolveExternal(id, action);
      if (action === 'cancel') externallyNotified.delete(id);
      if (result.status === 'ok') { externallyNotified.delete(id); publish(result.value); }
      return result;
    } catch (error) { return fail(error); }
  });
  handle('chooseWorkspace', async (win, directory?: string) => {
    try {
      if (!directory) { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); if (result.canceled) return { status: 'cancelled' }; directory = result.filePaths[0]; }
      if (typeof directory !== 'string') throw new Error('Choose a valid folder.');
      return { status: 'ok', value: await selectWorkspace(win, directory) };
    } catch (error) { return fail(error); }
  });
  handle('listDirectory', async (win, directory: string) => {
    try { const root = workspaces.get(win.id); if (!root || !isWithinRoot(await canonicalPath(directory), await canonicalPath(root))) throw new Error('Folder is outside the workspace.'); return { status: 'ok', value: await listDirectory(directory, settings) }; } catch (error) { return fail(error); }
  });
  handle('searchWorkspace', async (win, query: string, caseSensitive: boolean) => {
    try { const root = workspaces.get(win.id); if (!root || typeof query !== 'string') throw new Error('Open a workspace first.'); searches.get(win.id)?.abort(); const controller = new AbortController(); searches.set(win.id, controller); return { status: 'ok', value: await searchWorkspace(root, query, !!caseSensitive, controller.signal, settings) }; } catch (error) { return fail(error); }
  });
  handle('cancelSearch', win => { searches.get(win.id)?.abort(); });
  handle('updateSettings', async (_win, patch: Partial<Settings>) => { await persistSettings(patch); for (const id of service.docs.keys()) scheduleAutoSave(id); return settings; });
  handle('importImages', async (win, id: string, inputs?: ImageInput[]) => {
    try {
      const doc = own(win, id);
      if (!doc.path) return { status: 'error', message: tr('请先保存文稿，再插入图片。', 'Save the document before inserting images.') };
      if (!inputs) {
        const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: tr('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'avif'] }] });
        if (result.canceled) return { status: 'cancelled' };
        inputs = await selectedImages(result.filePaths);
      }
      if (!Array.isArray(inputs) || inputs.length > 100 || inputs.some(input => !input || typeof input.name !== 'string' || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > maxImageBytes) || inputs.reduce((size, input) => size + input.bytes.byteLength, 0) > maxImageBatchBytes) throw new Error('Images are limited to 100 files, 64 MiB each and 256 MiB per batch.');
      return { status: 'ok', value: await importImages(doc, inputs, settings) };
    } catch (error) { return fail(error); }
  });
  handle('exportDocument', async (win, id: string, patch: DocumentPatch, format: ExportFormat) => {
    try {
      own(win, id); applyPatch(id, patch);
      if (!validExportFormat(format)) throw new Error('Unsupported export format.');
      const doc = structuredClone(service.docs.get(id)!);
      const exportSettings = { ...structuredClone(settings), theme: resolvedTheme(settings, nativeTheme.shouldUseDarkColors) };
      const extension = exportExtensions[format];
      const suggested = path.join(exportSettings.exportFolder || (doc.path ? path.dirname(doc.path) : app.getPath('documents')), path.parse(doc.title).name + `.${extension}`);
      const destination = await dialog.showSaveDialog(win, { title: tr('导出文稿', 'Export document'), defaultPath: suggested, filters: [{ name: format.toUpperCase(), extensions: [extension] }] });
      if (destination.canceled || !destination.filePath) return { status: 'cancelled' };
      const targetIdentity = await canonicalPath(destination.filePath);
      for (const openDoc of service.docs.values()) if (openDoc.path && await canonicalPath(openDoc.path) === targetIdentity) throw new Error('Export to a different file to preserve the open source document.');
      const references = await citations.resolve(doc.source, exportSettings);
      if (references.missing.length) throw new Error(tr('无法导出：以下文献未找到，请连接 Zotero 并核对条目键：', 'Cannot export: connect Zotero and check unresolved item keys: ') + references.missing.join(', '));
      await exportDocument(doc, format, destination.filePath, exportSettings, references);
      if (exportSettings.revealAfterExport) shell.showItemInFolder(destination.filePath);
      return { status: 'ok', value: destination.filePath };
    } catch (error) { return fail(error); }
  });
  handle('findPandoc', () => findPandoc(settings.pandocPath));
  handle('choosePandoc', async win => { const result = await dialog.showOpenDialog(win, { filters: [{ name: 'Pandoc', extensions: ['exe'] }], properties: ['openFile'] }); return result.canceled ? null : result.filePaths[0]; });
  handle('chooseExportFolder', async win => { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  handle('editCommand', (win, action: string) => { if (action === 'cut' || action === 'copy' || action === 'paste') win.webContents[action](); else throw new Error('Unsupported edit command.'); });
  handle('windowCommand', (win, action: string) => { if (action === 'minimize') win.minimize(); else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); else if (action === 'close') win.close(); else throw new Error('Unknown window command.'); });
  handle('settingsAction', async (win, action: string) => {
    try {
      if (action === 'clearHistory') { await persistSettings({ recentFiles: [], recentWorkspaces: [] }); return { status: 'ok', value: tr('历史记录已清除。', 'Recent history cleared.') }; }
      if (action === 'resetSettings') { await persistSettings(structuredClone(defaultSettings)); return { status: 'ok', value: tr('设置已重置。窗口外观在新窗口生效。', 'Settings reset. Window frame changes apply to new windows.') }; }
      if (action === 'debug') { win.webContents.openDevTools({ mode: 'detach' }); return { status: 'ok', value: tr('开发者工具已打开。', 'Developer tools opened.') }; }
      if (action === 'registerNewFile' || action === 'unregisterNewFile') {
        const enabled = action === 'registerNewFile';
        const result = await setNewFileRegistration(enabled);
        return { status: 'ok', value: enabled
          ? tr(`已注册 ${result.changed} 项资源管理器新建菜单，保留 ${result.preserved} 项其他应用已有配置。`, `${result.changed} Explorer New-file entries registered; ${result.preserved} existing third-party entries preserved.`)
          : tr(`已移除 ${result.changed} 项 Markedown 注册的新建菜单。`, `${result.changed} Markedown-owned Explorer New-file entries removed.`) };
      }
      let destination: string;
      if (action === 'dataFolder') destination = service.dataDir;
      else if (action === 'recoveryFolder') destination = path.join(service.dataDir, 'recovery');
      else if (action === 'advancedSettings') { await saveSettings(service.dataDir, {}); destination = path.join(service.dataDir, 'settings.json'); }
      else if (action === 'themeFolder') { destination = path.join(service.dataDir, 'themes'); await mkdir(destination, { recursive: true }); await writeFile(path.join(destination, 'README.txt'), 'Markedown Themes\n\nGithub, Newsprint, Night, Pixyll, Whitey\n\nThese built-in themes are independently implemented. Third-party CSS loading is not supported in this release.\n', 'utf8'); }
      else return { status: 'error', message: tr('不支持此设置操作。', 'Unsupported settings action.') };
      const error = await shell.openPath(destination);
      if (error) throw new Error(error);
      return { status: 'ok', value: destination };
    } catch (error) { return fail(error); }
  });
  handle('importDocuments', async win => {
    try {
      const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents', extensions: ['docx', 'odt', 'epub', 'html', 'htm', 'rtf', 'rst', 'textile', 'mediawiki', 'wiki', 'opml'] }] });
      if (result.canceled) return { status: 'cancelled' };
      return { status: 'ok', value: await importDocumentPaths(win, result.filePaths) };
    } catch (error) { return fail(error); }
  });
  handle('handleDrop', async (win, paths: string[]) => {
    try {
      if (!Array.isArray(paths) || paths.length > 100 || paths.some(filename => typeof filename !== 'string' || !path.isAbsolute(filename))) throw new Error('Drop up to 100 local files or folders.');
      const documents: DocumentSession[] = [];
      let workspace: string | undefined;
      for (const filename of paths) {
        const info = await stat(filename);
        if (info.isDirectory()) { if (settings.dropFolders === 'open') workspace = await selectWorkspace(win, filename); continue; }
        if (textExtensions.includes(path.extname(filename).slice(1).toLowerCase())) {
          if (settings.dropMarkdown === 'open') documents.push(...await openPaths(win, [filename]));
          // insertLink is handled at the renderer's precise drop caret before this API.
        } else if (settings.dropDocuments === 'import') documents.push(...await importDocumentPaths(win, [filename]));
      }
      return { status: 'ok', value: { documents, ...(workspace ? { workspace } : {}) } };
    } catch (error) { return fail(error); }
  });
  handle('openExternal', (_win, url: string) => safeExternal(url));
  handle('revealFile', (_win, filename: string) => { if (typeof filename === 'string' && path.isAbsolute(filename)) shell.showItemInFolder(filename); });
}

if (singleInstance) void app.whenReady().then(async () => {
  try {
    await assertWritableDataDirectory(app.getPath('userData'));
    service = new DocumentService(app.getPath('userData'));
    zotero = new ZoteroService(app.getPath('userData'));
    extensions.register({ manifest: { id: 'markedown.zotero', name: 'Zotero', version: '1.0.0', apiVersion: 1, capabilities: ['references'] }, references: { id: 'zotero', name: 'Zotero', status: () => zotero.status(), search: (query, signal) => zotero.search(query, signal), resolve: (keys, refresh) => zotero.resolve(keys, refresh) } });
    extensions.seal();
    citations = new CitationService(extensions.referenceProvider('zotero')!);
    await service.initialize();
    reportedRecoveryErrors = service.recoveryErrors.length;
    settings = await loadSettings(service.dataDir);
    protocol.handle('markedown-image', async request => {
      try {
        const url = new URL(request.url);
        const id = decodeURIComponent(url.pathname.slice(1));
        const doc = service.docs.get(id);
        if (url.hostname !== 'document' || !doc) return new Response(null, { status: 404 });
        const image = await imageResponse(doc.path, url.searchParams.get('src') || '', { thumbnails: settings.imageThumbnails });
        return image ? new Response(new Uint8Array(image.data), { headers: { 'Content-Type': image.mime, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } }) : new Response(null, { status: 404 });
      } catch { return new Response(null, { status: 404 }); }
    });
    installIPC(); installMenu();
    nativeTheme.on('updated', () => { for (const win of windows.values()) { applyWindowSettings(win); emit(win.id, { type: 'settings', settings }); } });
    await createWindow(argvFiles(process.argv));
    setInterval(() => { void checkExternalChanges(); }, 2000).unref();
    app.on('second-instance', (_event, argv) => { const win = BrowserWindow.getFocusedWindow() || [...windows.values()][0]; if (win) { win.restore(); win.show(); win.focus(); void openPaths(win, argvFiles(argv)).catch(error => emit(win.id, { type: 'error', message: String(error) })); } });
    app.on('activate', () => { if (windows.size === 0) void createWindow(); });
  } catch (error) { dialog.showErrorBox('Markedown', `${tr('无法启动应用，请确认数据目录可写。', 'Cannot start. Check that the data directory is writable.')}\n\n${String(error)}`); app.quit(); }
});
app.on('window-all-closed', () => app.quit());
