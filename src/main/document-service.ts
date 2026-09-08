import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { defaultSettings, themeNames, tableStyleNames, type DocumentPatch, type DocumentSession, type FileRevision, type LineEnding, type Result, type Settings } from '../shared/contracts';
import { canonicalPath } from './workspace-service';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const sourceRecommendation = 1024 * 1024;
const sourceRequirement = 5 * sourceRecommendation;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const clone = (document: DocumentSession): DocumentSession => ({ ...document, selection: { ...document.selection }, revision: document.revision ? { ...document.revision } : null });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function physicalPath(filename: string): Promise<string> {
  const absolute = path.resolve(filename);
  try { return await realpath(absolute); }
  catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(await physicalPath(parent), path.basename(absolute));
  }
}

function detectLineEnding(source: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let first: LineEnding | undefined;
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== '\n') continue;
    const ending: LineEnding = index > 0 && source[index - 1] === '\r' ? 'CRLF' : 'LF';
    if (ending === 'CRLF') crlf++; else lf++;
    first ??= ending;
  }
  return crlf === lf ? first ?? 'LF' : crlf > lf ? 'CRLF' : 'LF';
}

async function readDocument(filename: string) {
  // Read and stat the same file handle so a concurrent rename cannot mix two revisions.
  const file = await open(filename, 'r');
  try {
    const bytes = await file.readFile();
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error('The selected path is not a regular file.');
    const bom = bytes.subarray(0, 3).equals(BOM);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
    if (text.includes('\0')) throw new Error('This file contains binary data and cannot be opened as UTF-8 text.');
    return {
      source: text.replace(/\r\n?/g, '\n'), bom,
      lineEnding: detectLineEnding(text),
      revision: { hash: hash(bytes), size: bytes.byteLength, mtimeMs: metadata.mtimeMs },
    };
  } finally { await file.close(); }
}

async function revisionAt(filename: string): Promise<FileRevision | null> {
  try {
    const file = await open(filename, 'r');
    try {
      const bytes = await file.readFile();
      const metadata = await file.stat();
      return { hash: hash(bytes), size: bytes.byteLength, mtimeMs: metadata.mtimeMs };
    } finally { await file.close(); }
  } catch (error) { if (missing(error)) return null; throw error; }
}

const sameRevision = (a: FileRevision | null, b: FileRevision | null) => a?.hash === b?.hash && a?.size === b?.size;
const preferenceKey = (filename: string) => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);

export async function atomicWrite(filename: string, bytes: Uint8Array, validate?: () => Promise<void>): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, 'wx');
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    if (validate) await validate();
    await rename(temporary, filename);
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(filename), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
  }
}

class SaveConflict extends Error {}

function validateRecovery(value: unknown): DocumentSession {
  if (!value || typeof value !== 'object') throw new Error('Recovery record is not an object.');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.document || typeof record.document !== 'object') throw new Error('Unsupported recovery record.');
  const doc = record.document as DocumentSession;
  if (typeof doc.id !== 'string' || !/^[a-f\d-]{36}$/i.test(doc.id) || typeof doc.source !== 'string' || typeof doc.savedSource !== 'string' || typeof doc.title !== 'string' || (doc.path !== null && (typeof doc.path !== 'string' || !path.isAbsolute(doc.path))) || !['LF', 'CRLF'].includes(doc.lineEnding) || typeof doc.bom !== 'boolean' || (doc.mathNumberingPrefix !== undefined && (typeof doc.mathNumberingPrefix !== 'string' || doc.mathNumberingPrefix.length > 24 || /[\x00-\x1f\x7f]/.test(doc.mathNumberingPrefix)))) throw new Error('Invalid recovery document.');
  if (doc.revision !== null && (!doc.revision || typeof doc.revision.hash !== 'string' || !/^[a-f\d]{64}$/i.test(doc.revision.hash) || !Number.isFinite(doc.revision.size) || !Number.isFinite(doc.revision.mtimeMs))) throw new Error('Invalid recovery revision.');
  const clamp = (position: unknown) => typeof position === 'number' && Number.isFinite(position) ? Math.max(0, Math.min(doc.source.length, Math.trunc(position))) : 0;
  return {
    ...doc, mathNumberingPrefix: typeof doc.mathNumberingPrefix === 'string' ? doc.mathNumberingPrefix.trim() : defaultSettings.mathNumberingPrefix, dirty: true, recovered: true,
    mode: Buffer.byteLength(doc.source) > sourceRequirement || doc.mode === 'source' ? 'source' : 'live',
    selection: { anchor: clamp(doc.selection?.anchor), head: clamp(doc.selection?.head) },
    scrollTop: Number.isFinite(doc.scrollTop) ? Math.max(0, doc.scrollTop) : 0,
    editVersion: Number.isSafeInteger(doc.editVersion) && doc.editVersion >= 0 ? doc.editVersion : 0,
  };
}

export class DocumentService {
  readonly docs = new Map<string, DocumentSession>();
  readonly recoveryErrors: string[] = [];
  private readonly recoveryDirectory: string;
  private readonly documentPreferencesPath: string;
  private readonly documentNumberingPrefixes = new Map<string, string>();
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryQueue: Promise<void> = Promise.resolve();
  private readonly saveQueues = new Map<string, Promise<unknown>>();
  private readonly identities = new Map<string, string>();
  private readonly pendingDestinations = new Map<string, string>();
  private readonly invalidRecoveryFiles = new Set<string>();
  private readonly ignoredExternalRevisions = new Map<string, FileRevision | null>();

  constructor(readonly dataDir: string) {
    this.recoveryDirectory = path.join(dataDir, 'recovery');
    this.documentPreferencesPath = path.join(dataDir, 'document-preferences.json');
  }

  async initialize(): Promise<{ recoveryErrors: string[] }> {
    await mkdir(this.recoveryDirectory, { recursive: true });
    try {
      const stored = JSON.parse(await readFile(this.documentPreferencesPath, 'utf8')) as unknown;
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
        if (path.isAbsolute(key) && typeof value === 'string' && value.length <= 24 && !/[\x00-\x1f\x7f]/.test(value)) this.documentNumberingPrefixes.set(preferenceKey(key), value.trim());
      }
    } catch (error) { if (!missing(error) && !(error instanceof SyntaxError)) throw error; }
    for (const filename of await readdir(this.recoveryDirectory)) {
      if (!filename.endsWith('.json')) continue;
      try {
        const doc = validateRecovery(JSON.parse(await readFile(path.join(this.recoveryDirectory, filename), 'utf8')));
        if (filename !== `${doc.id}.json` || this.docs.has(doc.id)) throw new Error('Duplicate or mismatched recovery identifier.');
        if (doc.path) {
          const key = await canonicalPath(doc.path);
          if (this.identities.has(key)) throw new Error('Duplicate recovered file path.');
          this.identities.set(key, doc.id);
        }
        this.docs.set(doc.id, doc);
      } catch (error) {
        this.invalidRecoveryFiles.add(filename);
        this.recoveryErrors.push(`${filename}: ${errorMessage(error)}`);
      }
    }
    return { recoveryErrors: [...this.recoveryErrors] };
  }

  create(options: { defaultLineEnding: Settings['defaultLineEnding']; mathNumberingPrefix?: string } = defaultSettings): DocumentSession {
    const doc: DocumentSession = {
      id: randomUUID(), path: null, title: 'Untitled', source: '', savedSource: '', dirty: false, recovered: false,
      bom: false, lineEnding: options.defaultLineEnding, revision: null, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 0,
      mathNumberingPrefix: options.mathNumberingPrefix ?? defaultSettings.mathNumberingPrefix,
    };
    this.docs.set(doc.id, doc);
    this.scheduleRecovery();
    return clone(doc);
  }

  async open(filename: string, options: Partial<Pick<Settings, 'mathNumberingPrefix'>> = defaultSettings): Promise<DocumentSession> {
    const absolute = await physicalPath(filename);
    const identity = await canonicalPath(absolute);
    const pending = this.pendingDestinations.get(identity);
    if (pending) await this.saveQueues.get(pending);
    const existing = this.identities.get(identity);
    if (existing && this.docs.has(existing)) return clone(this.docs.get(existing)!);
    const contents = await readDocument(absolute);
    const doc: DocumentSession = {
      id: randomUUID(), path: absolute, title: path.basename(absolute), ...contents, savedSource: contents.source,
      dirty: false, recovered: false, mode: Buffer.byteLength(contents.source) > sourceRecommendation ? 'source' : 'live',
      selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 0,
      mathNumberingPrefix: this.documentNumberingPrefixes.get(preferenceKey(absolute)) ?? options.mathNumberingPrefix ?? defaultSettings.mathNumberingPrefix,
    };
    // Concurrent open requests can finish reading the same file together.
    const pendingAfterRead = this.pendingDestinations.get(identity);
    if (pendingAfterRead) await this.saveQueues.get(pendingAfterRead);
    const raced = this.identities.get(identity);
    if (raced && this.docs.has(raced)) return clone(this.docs.get(raced)!);
    this.identities.set(identity, doc.id);
    this.docs.set(doc.id, doc);
    this.scheduleRecovery();
    return clone(doc);
  }

  update(id: string, patch: DocumentPatch): void {
    const doc = this.require(id);
    if (!patch || typeof patch !== 'object') throw new Error('Invalid document update.');
    const { source, mode, selection, scrollTop, editVersion } = patch;
    if (typeof source !== 'string' || !['live', 'source'].includes(mode) || !Number.isSafeInteger(editVersion) || editVersion < 0 || typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || !selection || typeof selection !== 'object' || !Number.isSafeInteger(selection.anchor) || !Number.isSafeInteger(selection.head)) throw new Error('Invalid document update.');
    if (editVersion < doc.editVersion) return;
    if (patch.mathNumberingPrefix !== undefined && (typeof patch.mathNumberingPrefix !== 'string' || patch.mathNumberingPrefix.length > 24 || /[\x00-\x1f\x7f]/.test(patch.mathNumberingPrefix))) throw new Error('Invalid document equation number prefix.');
    const normalized = source.replace(/\r\n?/g, '\n');
    const clamp = (value: number) => Math.max(0, Math.min(normalized.length, value));
    Object.assign(doc, {
      source: normalized,
      mode: Buffer.byteLength(normalized) > sourceRequirement || mode === 'source' ? 'source' : 'live',
      selection: { anchor: clamp(selection.anchor), head: clamp(selection.head) },
      scrollTop: Math.max(0, scrollTop), editVersion,
      dirty: doc.recovered || normalized !== doc.savedSource,
    });
    if (patch.mathNumberingPrefix !== undefined) {
      doc.mathNumberingPrefix = patch.mathNumberingPrefix.trim();
      if (doc.path) this.documentNumberingPrefixes.set(preferenceKey(doc.path), doc.mathNumberingPrefix);
    }
    this.scheduleRecovery();
  }

  async save(id: string, targetPath?: string, automatic = false): Promise<Result<DocumentSession>> {
    const previous = this.saveQueues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.saveNow(id, targetPath, automatic));
    this.saveQueues.set(id, operation);
    try { return await operation; } finally { if (this.saveQueues.get(id) === operation) this.saveQueues.delete(id); }
  }

  private async saveNow(id: string, targetPath?: string, automatic = false): Promise<Result<DocumentSession>> {
    let reservation: string | undefined;
    try {
      const doc = this.require(id);
      if (automatic && (doc.recovered || !doc.path)) return { status: 'cancelled' };
      const requestedPath = targetPath ? path.resolve(targetPath) : doc.path;
      if (!requestedPath) return { status: 'cancelled' };
      const snapshot = clone(doc);
      const destination = await physicalPath(requestedPath);
      const identity = await canonicalPath(destination);
      const owner = this.identities.get(identity) ?? this.pendingDestinations.get(identity);
      if (owner && owner !== id) return { status: 'conflict', message: 'This file is already open in another document.' };
      this.pendingDestinations.set(identity, id);
      reservation = identity;
      const sameFile = snapshot.path !== null && identity === await canonicalPath(snapshot.path);
      const expected = sameFile ? snapshot.revision : await revisionAt(destination);
      if (!sameRevision(expected, await revisionAt(destination))) throw new SaveConflict('The file has changed outside Markedown. Reload it or save a copy.');
      const text = snapshot.lineEnding === 'CRLF' ? snapshot.source.replace(/\n/g, '\r\n') : snapshot.source;
      const bytes = snapshot.bom ? Buffer.concat([BOM, Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8');
      await atomicWrite(destination, bytes, async () => {
        if (!sameRevision(expected, await revisionAt(destination))) throw new SaveConflict('The file changed while saving. Reload it or save a copy.');
      });
      const metadata = await stat(destination);
      for (const [key, documentId] of this.identities) if (documentId === id) this.identities.delete(key);
      this.identities.set(identity, id);
      doc.path = destination;
      doc.title = path.basename(destination);
      doc.revision = { hash: hash(bytes), size: bytes.byteLength, mtimeMs: metadata.mtimeMs };
      doc.savedSource = snapshot.source;
      doc.dirty = doc.source !== snapshot.source;
      if (!automatic) doc.recovered = false;
      this.documentNumberingPrefixes.set(preferenceKey(destination), doc.mathNumberingPrefix || '');
      this.ignoredExternalRevisions.delete(id);
      this.scheduleRecovery();
      return { status: 'ok', value: clone(doc) };
    } catch (error) {
      return error instanceof SaveConflict ? { status: 'conflict', message: error.message } : { status: 'error', message: errorMessage(error) };
    } finally { if (reservation && this.pendingDestinations.get(reservation) === id) this.pendingDestinations.delete(reservation); }
  }

  async close(id: string): Promise<void> {
    await this.saveQueues.get(id);
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const [key, documentId] of this.identities) if (documentId === id) this.identities.delete(key);
    this.docs.delete(id);
    this.ignoredExternalRevisions.delete(id);
    await this.flushRecovery();
  }

  async closeMany(approvals: Array<{ id: string; editVersion: number; source: string }>): Promise<Result<boolean>> {
    const ids = new Set(approvals.map(approval => approval.id));
    for (;;) {
      const pending = [...ids].map(id => this.saveQueues.get(id)).filter((queue): queue is Promise<unknown> => Boolean(queue));
      if (!pending.length) break;
      await Promise.all(pending);
    }
    for (const approval of approvals) {
      const doc = this.docs.get(approval.id);
      if (!doc || doc.editVersion !== approval.editVersion || doc.source !== approval.source) return { status: 'conflict', message: 'A document changed while closing. Review the current documents and try again.' };
    }
    const documents = [...ids].map(id => this.docs.get(id)!);
    const identities = [...this.identities].filter(([, id]) => ids.has(id));
    const ignored = [...this.ignoredExternalRevisions].filter(([id]) => ids.has(id));
    let release!: () => void;
    const closing = new Promise<void>(resolve => { release = resolve; });
    // Keep ownership reserved while recovery cleanup may still require rollback.
    for (const id of ids) {
      this.saveQueues.set(id, closing);
      this.docs.delete(id);
      this.ignoredExternalRevisions.delete(id);
    }
    for (const [identity, id] of identities) {
      this.pendingDestinations.set(identity, id);
      this.identities.delete(identity);
    }
    try {
      await this.flushRecovery();
      return { status: 'ok', value: true };
    } catch (error) {
      for (const doc of documents) this.docs.set(doc.id, doc);
      for (const [identity, id] of identities) this.identities.set(identity, id);
      for (const [id, revision] of ignored) this.ignoredExternalRevisions.set(id, revision);
      this.scheduleRecovery();
      return { status: 'error', message: errorMessage(error) };
    } finally {
      for (const [identity, id] of identities) if (this.pendingDestinations.get(identity) === id) this.pendingDestinations.delete(identity);
      for (const id of ids) if (this.saveQueues.get(id) === closing) this.saveQueues.delete(id);
      release();
    }
  }

  async checkExternal(id: string): Promise<'unchanged' | 'reloaded' | 'conflict' | 'deleted'> {
    const doc = this.require(id);
    if (!doc.path || this.saveQueues.has(id)) return 'unchanged';
    const revision = await revisionAt(doc.path);
    if (this.ignoredExternalRevisions.has(id) && sameRevision(this.ignoredExternalRevisions.get(id)!, revision)) return 'unchanged';
    if (sameRevision(doc.revision, revision)) return 'unchanged';
    if (!revision) return 'deleted';
    if (doc.dirty || doc.recovered) return 'conflict';
    const version = doc.editVersion;
    const contents = await readDocument(doc.path);
    if (doc.dirty || doc.recovered || doc.editVersion !== version) return 'conflict';
    this.applyReload(doc, contents);
    return 'reloaded';
  }

  async resolveExternal(id: string, action: 'reload' | 'cancel'): Promise<Result<DocumentSession>> {
    try {
      await this.saveQueues.get(id);
      const doc = this.require(id);
      if (!doc.path) return { status: 'cancelled' };
      if (action === 'cancel') {
        this.ignoredExternalRevisions.set(id, await revisionAt(doc.path));
        return { status: 'cancelled' };
      }
      const version = doc.editVersion;
      const contents = await readDocument(doc.path);
      if (doc.editVersion !== version) return { status: 'conflict', message: 'The document changed while reloading. Please review your edits and try again.' };
      this.applyReload(doc, contents);
      return { status: 'ok', value: clone(doc) };
    } catch (error) { return { status: 'error', message: errorMessage(error) }; }
  }

  private applyReload(doc: DocumentSession, contents: Awaited<ReturnType<typeof readDocument>>) {
    this.ignoredExternalRevisions.delete(doc.id);
    Object.assign(doc, contents, { savedSource: contents.source, dirty: false, recovered: false, editVersion: doc.editVersion + 1 });
    doc.selection = { anchor: Math.min(doc.selection.anchor, doc.source.length), head: Math.min(doc.selection.head, doc.source.length) };
    if (Buffer.byteLength(contents.source) > sourceRequirement) doc.mode = 'source';
    this.scheduleRecovery();
  }

  private require(id: string): DocumentSession {
    const doc = this.docs.get(id);
    if (!doc) throw new Error('The document is no longer open.');
    return doc;
  }

  private scheduleRecovery() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => { void this.flushRecovery().catch(error => this.recoveryErrors.push(errorMessage(error))); }, 220);
    this.recoveryTimer.unref();
  }

  async flushRecovery(): Promise<void> {
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined; }
    const operation = this.recoveryQueue.catch(() => undefined).then(async () => {
      await mkdir(this.recoveryDirectory, { recursive: true });
      const retained = new Set<string>();
      for (const doc of this.docs.values()) {
        if (!doc.dirty && !doc.recovered) continue;
        retained.add(doc.id);
        const record = JSON.stringify({ version: 1, document: clone(doc) });
        await atomicWrite(path.join(this.recoveryDirectory, `${doc.id}.json`), Buffer.from(record, 'utf8'));
      }
      for (const filename of await readdir(this.recoveryDirectory)) {
        if (/^[a-f\d-]{36}\.json$/i.test(filename) && !retained.has(filename.slice(0, -5)) && !this.invalidRecoveryFiles.has(filename)) await unlink(path.join(this.recoveryDirectory, filename));
      }
      const preferences = Object.fromEntries(this.documentNumberingPrefixes);
      await atomicWrite(this.documentPreferencesPath, Buffer.from(JSON.stringify(preferences, null, 2), 'utf8'));
    });
    this.recoveryQueue = operation;
    return operation;
  }
}

export function validatedSettings(value: unknown): Settings {
  const settings: Settings = defaultSettingsForPlatform();
  if (!value || typeof value !== 'object') return settings;
  const input = value as Record<string, unknown>;
  const enums: Partial<Record<keyof Settings, readonly string[]>> = {
    theme: themeNames, darkTheme: themeNames, language: ['system', 'zh-CN', 'en'], pageSize: ['A4', 'Letter'],
    startup: ['new', 'recent', 'workspace'], defaultExtension: ['md', 'markdown', 'txt'], defaultLineEnding: ['LF', 'CRLF'],
    dropFolders: ['open', 'ignore'], dropMarkdown: ['open', 'insertLink'], dropDocuments: ['import', 'ignore'], fileFilter: ['markdown', 'text', 'all'],
    spellcheck: ['off', 'auto', 'en-US', 'en-GB'], headingStyle: ['atx', 'setext'], bulletMarker: ['-', '*', '+'], orderedMarker: ['increment', 'one'],
    diagramTheme: ['default', 'neutral', 'dark', 'forest'], smartPunctuation: ['off', 'typing', 'render'], doubleQuoteStyle: ['curly', 'guillemet'],
    singleQuoteStyle: ['curly', 'singleGuillemet'], windowStyle: ['integrated', 'classic'], fontSizeMode: ['auto', 'custom'],
    codeLanguageTrigger: ['typed', 'menu', 'always', 'never'], mathNumbering: ['none', 'all', 'labelled'], mathNumberingStyle: ['document', 'section'], citationStyle: ['numeric', 'author-date'], mathOutput: ['svg', 'mathml'],
    mathAlignment: ['left', 'center', 'right'], mathNumberPosition: ['left', 'right'], tableStyle: tableStyleNames,
    editorWhitespace: ['preserve', 'breaks', 'collapse'], exportWhitespace: ['preserve', 'breaks', 'collapse'],
  };
  for (const [key, fallback] of Object.entries(defaultSettings)) {
    const name = key as keyof Settings;
    if (typeof fallback === 'boolean' && typeof input[key] === 'boolean') (settings as unknown as Record<string, unknown>)[key] = input[key];
    if (typeof input[key] === 'string' && enums[name]?.includes(input[key])) (settings as unknown as Record<string, unknown>)[key] = input[key];
  }
  if (['graphite','paper','system'].includes(String(input.theme))) settings.showToolbar = false;
  if (input.theme === 'graphite') settings.theme = 'night';
  if (input.theme === 'paper') settings.theme = 'newsprint';
  if (input.theme === 'system') { settings.theme = 'github'; settings.separateDarkTheme = true; }
  const ranges: Partial<Record<keyof Settings, [number, number]>> = { fontSize: [12, 32], readingWidth: [480, 1400], indentWidth: [1, 8], zoom: [50, 200], readingSpeed: [50, 1000] };
  for (const [key, bounds] of Object.entries(ranges)) if (typeof input[key] === 'number' && Number.isFinite(input[key])) (settings as unknown as Record<string, unknown>)[key] = Math.min(bounds[1], Math.max(bounds[0], Math.round(input[key])));
  for (const key of ['pandocPath', 'imageFolder', 'exportFolder'] as const) if (typeof input[key] === 'string' && !/[\x00-\x1f]/.test(input[key])) settings[key] = input[key].trim();
  // Equation number prefixes are plain text inserted before generated numbers
  // (for example "S" produces S1, S2). Keep them short and free of controls so
  // they are safe in HTML, PDF and citation anchors.
  if (typeof input.mathNumberingPrefix === 'string' && input.mathNumberingPrefix.length <= 24 && !/[\x00-\x1f\x7f]/.test(input.mathNumberingPrefix)) settings.mathNumberingPrefix = input.mathNumberingPrefix.trim();
  if (!settings.imageFolder) settings.imageFolder = 'assets';
  if (typeof input.codeIndentWidth === 'number' && Number.isFinite(input.codeIndentWidth)) settings.codeIndentWidth = Math.min(8, Math.max(1, Math.round(input.codeIndentWidth)));
  if (typeof input.defaultCodeLanguage === 'string' && /^[a-zA-Z0-9_+#.-]{0,40}$/.test(input.defaultCodeLanguage.trim())) settings.defaultCodeLanguage = input.defaultCodeLanguage.trim();
  for (const key of ['wordChineseFont', 'wordLatinFont'] as const) {
    if (typeof input[key] === 'string' && input[key].trim() && input[key].length <= 100 && !/[\x00-\x1f\x7f]/.test(input[key])) settings[key] = input[key].trim();
  }
  if (typeof input.wordTextColor === 'string' && /^#[a-f\d]{6}$/i.test(input.wordTextColor)) settings.wordTextColor = input.wordTextColor.toUpperCase();
  const wordSize = (value: number) => Math.min(72, Math.max(6, Math.round(value * 2) / 2));
  if (typeof input.wordBodyFontSize === 'number' && Number.isFinite(input.wordBodyFontSize)) settings.wordBodyFontSize = wordSize(input.wordBodyFontSize);
  if (Array.isArray(input.wordHeadingSizes) && input.wordHeadingSizes.length === 6 && input.wordHeadingSizes.every(value => typeof value === 'number' && Number.isFinite(value))) settings.wordHeadingSizes = input.wordHeadingSizes.map(wordSize);
  for (const key of ['recentWorkspaces', 'recentFiles'] as const) if (Array.isArray(input[key])) {
    const seen = new Set<string>();
    settings[key] = input[key].filter((item): item is string => {
      if (typeof item !== 'string' || !path.isAbsolute(item) || /[\x00-\x1f]/.test(item)) return false;
      const identity = process.platform === 'win32' ? path.normalize(item).toLowerCase() : path.normalize(item);
      if (seen.has(identity)) return false; seen.add(identity); return true;
    }).slice(0, key === 'recentFiles' ? 30 : 10);
  }
  if (input.startup === undefined && input.reopenWorkspace === true) settings.startup = 'workspace';
  if (Array.isArray(input.exportPresets)) {
    const formats = new Set(defaultSettings.exportPresets.map(preset => preset.format));
    const seen = new Set<string>();
    settings.exportPresets = input.exportPresets.filter((entry): entry is Settings['exportPresets'][number] => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80 || !formats.has(entry.format) || seen.has(entry.id)) return false;
      seen.add(entry.id); return true;
    }).slice(0, 32).map(entry => ({ id: entry.id, name: entry.name.trim(), format: entry.format }));
  }
  if (input.shortcuts && typeof input.shortcuts === 'object' && !Array.isArray(input.shortcuts)) settings.shortcuts = Object.fromEntries(Object.entries(input.shortcuts).filter(([command, accelerator]) => /^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(command) && typeof accelerator === 'string' && accelerator.length <= 80 && /^[a-zA-Z0-9+,./; '\\[\]\\-]*$/.test(accelerator)));
  if (!settings.recordHistory) { settings.recentFiles = []; settings.recentWorkspaces = []; }
  return settings;
}

export function defaultSettingsForPlatform(): Settings {
  const settings: Settings = structuredClone(defaultSettings);
  if (process.platform !== 'win32') settings.defaultLineEnding = 'LF';
  return settings;
}

export async function loadSettings(dataDir: string): Promise<Settings> {
  try { return validatedSettings(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'))); }
  catch (error) { if (missing(error) || error instanceof SyntaxError) return validatedSettings(null); throw error; }
}

const settingsQueues = new Map<string, Promise<Settings>>();
export type SettingsUpdate = Partial<Settings> | ((current: Settings) => Partial<Settings>);
export async function saveSettings(dataDir: string, partial: SettingsUpdate): Promise<Settings> {
  const key = path.resolve(dataDir);
  const prior = settingsQueues.get(key);
  const operation = (prior ?? Promise.resolve(undefined)).catch(() => undefined).then(async () => {
    const current = await loadSettings(dataDir);
    const settings = validatedSettings({ ...current, ...(typeof partial === 'function' ? partial(current) : partial) });
    await mkdir(dataDir, { recursive: true });
    await atomicWrite(path.join(dataDir, 'settings.json'), Buffer.from(JSON.stringify(settings, null, 2), 'utf8'));
    return settings;
  });
  settingsQueues.set(key, operation);
  try { return await operation; } finally { if (settingsQueues.get(key) === operation) settingsQueues.delete(key); }
}
