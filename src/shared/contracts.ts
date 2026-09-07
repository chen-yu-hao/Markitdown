import type { ReferencesAPI } from './academic-contracts';
import type { ExtensionManifest } from './extensions';
export type EditorMode = 'live' | 'source';
export type LineEnding = 'LF' | 'CRLF';
export interface FileRevision { hash: string; size: number; mtimeMs: number }
export interface Selection { anchor: number; head: number }
export interface DocumentSession {
  id: string;
  path: string | null;
  title: string;
  source: string;
  savedSource: string;
  dirty: boolean;
  recovered: boolean;
  bom: boolean;
  lineEnding: LineEnding;
  revision: FileRevision | null;
  mode: EditorMode;
  selection: Selection;
  scrollTop: number;
  editVersion: number;
}
export interface DocumentPatch {
  source: string;
  mode: EditorMode;
  selection: Selection;
  scrollTop: number;
  editVersion: number;
}
export type Result<T> = { status: 'ok'; value: T } | { status: 'cancelled' } | { status: 'conflict'; message: string } | { status: 'error'; message: string };
export type ThemeName = 'github' | 'newsprint' | 'night' | 'pixyll' | 'whitey';
export const themeNames: ThemeName[] = ['github', 'newsprint', 'night', 'pixyll', 'whitey'];
export const themeLabels: Record<ThemeName, string> = { github: 'Github', newsprint: 'Newsprint', night: 'Night', pixyll: 'Pixyll', whitey: 'Whitey' };
export interface Settings {
  theme: ThemeName;
  separateDarkTheme: boolean;
  darkTheme: ThemeName;
  language: 'system' | 'zh-CN' | 'en';
  fontSize: number;
  readingWidth: number;
  autoSave: boolean;
  reopenWorkspace: boolean;
  showToolbar: boolean;
  showStatusBar: boolean;
  pageSize: 'A4' | 'Letter';
  exportOutline: boolean;
  htmlRemoteImages: boolean;
  pandocPath: string;
  recentWorkspaces: string[];
  recentFiles: string[];
  startup: 'new' | 'recent' | 'workspace';
  defaultExtension: 'md' | 'markdown' | 'txt';
  saveOnSwitch: boolean;
  recordHistory: boolean;
  outlineCollapsible: boolean;
  dropFolders: 'open' | 'ignore';
  dropMarkdown: 'open' | 'insertLink';
  dropDocuments: 'import' | 'ignore';
  showHiddenFiles: boolean;
  fileFilter: 'markdown' | 'text' | 'all';
  indentWidth: number;
  alignIndent: boolean;
  pairBrackets: boolean;
  pairMarkdown: boolean;
  emojiAutocomplete: boolean;
  showActiveBlockSource: boolean;
  copyMarkdown: boolean;
  copyWholeLine: boolean;
  defaultLineEnding: LineEnding;
  spellcheck: 'off' | 'auto' | 'en-US' | 'en-GB';
  alwaysCenterCaret: boolean;
  strictMarkdown: boolean;
  headingStyle: 'atx' | 'setext';
  bulletMarker: '-' | '*' | '+';
  orderedMarker: 'increment' | 'one';
  autoLinks: boolean;
  inlineMath: boolean;
  subscript: boolean;
  superscript: boolean;
  highlight: boolean;
  githubAlerts: boolean;
  diagrams: boolean;
  diagramTheme: 'default' | 'neutral' | 'dark' | 'forest';
  smartPunctuation: 'off' | 'typing' | 'render';
  smartQuotes: boolean;
  doubleQuoteStyle: 'curly' | 'guillemet';
  singleQuoteStyle: 'curly' | 'singleGuillemet';
  smartDashes: boolean;
  unicodePunctuation: boolean;
  codeLineNumbers: boolean;
  codeWordWrap: boolean;
  codeAutoIndent: boolean;
  codeIndentWidth: number;
  codeAutoIndentOnTab: boolean;
  defaultCodeLanguage: string;
  codeLanguageTrigger: 'typed' | 'menu' | 'always' | 'never';
  latexDelimiters: boolean;
  mathCodeBlocks: boolean;
  mathPhysics: boolean;
  legacyInlineMath: boolean;
  mathNumbering: 'none' | 'all' | 'labelled';
  mathNumberingStyle: 'document' | 'section';
  citationStyle: 'numeric' | 'author-date';
  mathOutput: 'svg' | 'mathml';
  firstLineIndent: boolean;
  showLineBreaks: boolean;
  editorWhitespace: 'preserve' | 'breaks' | 'collapse';
  exportWhitespace: 'preserve' | 'breaks' | 'collapse';
  imageFolder: string;
  imageUseRelative: boolean;
  imageAutoEscape: boolean;
  imageThumbnails: boolean;
  exportFolder: string;
  revealAfterExport: boolean;
  exportTheme: boolean;
  exportPresets: ExportPreset[];
  wordChineseFont: string;
  wordLatinFont: string;
  wordTextColor: string;
  wordBodyFontSize: number;
  wordHeadingSizes: number[];
  wordHeadingBold: boolean;
  wordHeadingItalic: boolean;
  windowStyle: 'integrated' | 'classic';
  fontSizeMode: 'auto' | 'custom';
  zoom: number;
  ctrlWheelZoom: boolean;
  readingSpeed: number;
  shortcuts: Record<string, string>;
}
export interface ExportPreset { id: string; name: string; format: ExportFormat }
export const defaultExportPresets: ExportPreset[] = [
  ['pdf', 'PDF'], ['html', 'HTML'], ['htmlPlain', 'HTML (without styles)'], ['png', 'Image'],
  ['docx', 'Word'], ['odt', 'OpenOffice'], ['rtf', 'RTF'], ['epub', 'Epub'], ['tex', 'LaTeX'],
  ['mediawiki', 'MediaWiki'], ['rst', 'reStructuredText'], ['textile', 'Textile'], ['opml', 'OPML'],
].map(([format, name]) => ({ id: format, name, format: format as ExportFormat }));
export const defaultSettings: Settings = {
  theme: 'github', separateDarkTheme: false, darkTheme: 'night', language: 'system', fontSize: 17, readingWidth: 800,
  autoSave: true, reopenWorkspace: true, showToolbar: false, showStatusBar: true,
  pageSize: 'A4', exportOutline: true, htmlRemoteImages: false, pandocPath: '', recentWorkspaces: [],
  recentFiles: [], startup: 'new', defaultExtension: 'md', saveOnSwitch: false, recordHistory: true,
  outlineCollapsible: true, dropFolders: 'open', dropMarkdown: 'open', dropDocuments: 'import', showHiddenFiles: false, fileFilter: 'text',
  indentWidth: 2, alignIndent: true, pairBrackets: true, pairMarkdown: true, emojiAutocomplete: true,
  showActiveBlockSource: true, copyMarkdown: true, copyWholeLine: true, defaultLineEnding: 'CRLF', spellcheck: 'auto', alwaysCenterCaret: true,
  strictMarkdown: true, headingStyle: 'atx', bulletMarker: '-', orderedMarker: 'increment', autoLinks: true,
  inlineMath: true, subscript: false, superscript: false, highlight: true, githubAlerts: true,
  diagrams: true, diagramTheme: 'default', smartPunctuation: 'off', smartQuotes: false, doubleQuoteStyle: 'curly', singleQuoteStyle: 'curly', smartDashes: false, unicodePunctuation: false,
  codeLineNumbers: false, codeWordWrap: true, codeAutoIndent: true,
  codeIndentWidth: 4, codeAutoIndentOnTab: false, defaultCodeLanguage: '', codeLanguageTrigger: 'typed',
  latexDelimiters: true, mathCodeBlocks: true, mathPhysics: false, legacyInlineMath: false,
  mathNumbering: 'all', mathNumberingStyle: 'document', citationStyle: 'numeric', mathOutput: 'svg', firstLineIndent: false, showLineBreaks: true,
  editorWhitespace: 'preserve', exportWhitespace: 'preserve',
  imageFolder: 'assets', imageUseRelative: true, imageAutoEscape: true, imageThumbnails: true,
  exportFolder: '', revealAfterExport: false, exportTheme: true, exportPresets: defaultExportPresets,
  wordChineseFont: '宋体', wordLatinFont: 'Times New Roman', wordTextColor: '#000000',
  wordBodyFontSize: 12, wordHeadingSizes: [18, 16, 14, 12, 12, 12], wordHeadingBold: true,
  wordHeadingItalic: false,
  windowStyle: 'integrated', fontSizeMode: 'auto', zoom: 100, ctrlWheelZoom: true, readingSpeed: 200, shortcuts: {},
};
export interface DirectoryEntry { name: string; path: string; directory: boolean }
export interface SearchHit { path: string; line: number; column: number; offset: number; preview: string }
export interface SearchResults { hits: SearchHit[]; truncated: boolean; cancelled: boolean }
export interface Bootstrap { documents: DocumentSession[]; settings: Settings; workspace: string | null; recoveryErrors: string[]; locale: string; version: string }
export type AppEvent =
  | { type: 'document'; document: DocumentSession; activate?: boolean }
  | { type: 'external'; id: string; deleted: boolean }
  | { type: 'settings'; settings: Settings }
  | { type: 'command'; command: string }
  | { type: 'error'; message: string };
export type ExportFormat = 'html' | 'htmlPlain' | 'pdf' | 'png' | 'docx' | 'epub' | 'tex' | 'rtf' | 'odt' | 'mediawiki' | 'rst' | 'textile' | 'opml';
export type SettingsAction = 'clearHistory' | 'recoveryFolder' | 'themeFolder' | 'dataFolder' | 'advancedSettings' | 'resetSettings' | 'debug' | 'registerNewFile' | 'unregisterNewFile';
export interface ImageInput { name: string; bytes: Uint8Array }
export interface MarkedownAPI {
  references: ReferencesAPI;
  extensions: { list(): Promise<ExtensionManifest[]> };
  bootstrap(): Promise<Bootstrap>;
  newDocument(): Promise<DocumentSession>;
  newWindow(): Promise<void>;
  openFiles(paths?: string[]): Promise<Result<DocumentSession[]>>;
  updateDocument(id: string, patch: DocumentPatch): Promise<void>;
  saveDocument(id: string, patch: DocumentPatch, saveAs?: boolean): Promise<Result<DocumentSession>>;
  closeDocument(id: string): Promise<Result<boolean>>;
  resolveExternal(id: string, action: 'reload' | 'copy' | 'cancel'): Promise<Result<DocumentSession>>;
  chooseWorkspace(path?: string): Promise<Result<string>>;
  listDirectory(path: string): Promise<Result<DirectoryEntry[]>>;
  searchWorkspace(query: string, caseSensitive: boolean): Promise<Result<SearchResults>>;
  cancelSearch(): Promise<void>;
  updateSettings(settings: Partial<Settings>): Promise<Settings>;
  importImages(id: string, images?: ImageInput[]): Promise<Result<string[]>>;
  imageURL(id: string, destination: string): string;
  exportDocument(id: string, patch: DocumentPatch, format: ExportFormat): Promise<Result<string>>;
  findPandoc(): Promise<string | null>;
  choosePandoc(): Promise<string | null>;
  chooseExportFolder(): Promise<string | null>;
  settingsAction(action: SettingsAction): Promise<Result<string>>;
  handleDrop(paths: string[]): Promise<Result<{ documents: DocumentSession[]; workspace?: string }>>;
  importDocuments(): Promise<Result<DocumentSession[]>>;
  windowCommand(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  editCommand(action: 'cut' | 'copy' | 'paste'): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealFile(path: string): Promise<void>;
  droppedPaths(files: File[]): string[];
  onEvent(listener: (event: AppEvent) => void): () => void;
}
declare global { interface Window { markedown: MarkedownAPI } }
