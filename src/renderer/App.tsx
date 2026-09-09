import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlignLeft, ArrowDown, ArrowUp, Bold, Braces, Check, ChevronDown, ChevronRight, ChevronsLeftRight, Code2, Download, ExternalLink, FileCode2, FileImage, FilePlus2, FileText, Folder, FolderOpen, Highlighter, ImagePlus, Italic, Link, List, ListChecks, ListOrdered, LoaderCircle, Maximize2, Minimize2, Moon, MoreHorizontal, PanelLeft, Plus, Quote, Redo2, RefreshCw, Save, Search, Settings2, Strikethrough, Sun, Type, Undo2, X } from 'lucide-react';
import Editor, { type EditorHandle } from './Editor';
import { defaultSettings, type AppEvent, type DirectoryEntry, type DocumentPatch, type DocumentSession, type ExportFormat, type SearchHit, type Settings } from '../shared/contracts';
import { analyzeMarkdown } from '../shared/markdown';
import TopBar from './TopBar';
import { shortcutCommand } from '../shared/shortcuts';
import Preferences from './Preferences';
import './themes.css';
import AcademicPanel from './AcademicPanel';
import CitationCredits from './CitationCredits';
import DocumentTabs from './DocumentTabs';
import { emptyCitationData, type CitationRenderData } from '../shared/academic-contracts';
import { scanCitations } from '../shared/citations';

type Analysis = ReturnType<typeof analyzeMarkdown>;
const patchOf = (doc: DocumentSession): DocumentPatch => ({ source: doc.source, mode: doc.mode, selection: doc.selection, scrollTop: doc.scrollTop, editVersion: doc.editVersion, mathNumberingPrefix: doc.mathNumberingPrefix });
const basename = (path: string) => path.split(/[/\\]/).filter(Boolean).at(-1) || path;
const emptyAnalysis: Analysis = { headings: [], words: 0, characters: 0, lines: 0, readingMinutes: 0 };
function IconButton({ label, children, onClick, active, disabled, className = '' }: { label: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${active ? 'active' : ''} ${className}`} aria-label={label} title={label} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Modal({ title, onClose, children, wide = false }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>('button, input, select')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`}><header><h2>{title}</h2><IconButton label="Close" onClick={onClose}><X /></IconButton></header>{children}</div></div>;
}

function FileTree({ root, refresh, selected, onOpen, onError }: { root: string; refresh: number; selected: string | null; onOpen(path: string): void; onError(message: string): void }) {
  const [entries, setEntries] = useState<Record<string, DirectoryEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [selection, setSelection] = useState<string | null>(selected);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (directory: string) => {
    const result = await window.markedown.listDirectory(directory);
    if (result.status === 'ok') setEntries(previous => ({ ...previous, [directory]: result.value }));
    else if (result.status === 'error') onError(result.message);
  }, [onError]);
  useEffect(() => { setEntries({}); setExpanded(new Set([root])); setLoading(true); void load(root).finally(() => setLoading(false)); }, [root, refresh, load]);
  useEffect(() => setSelection(selected), [selected]);
  const rows = (directory: string, depth: number): ReactNode => (entries[directory] || []).map(entry => <div key={entry.path}>
    <button type="button" className={`tree-row ${selection === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 14 + depth * 16 }} title={entry.path} onClick={event => {
      if (event.detail > 1) return;
      setSelection(entry.path);
      if (entry.directory) { setExpanded(previous => { const next = new Set(previous); next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path); return next; }); if (!entries[entry.path]) void load(entry.path); }
      else onOpen(entry.path);
    }}>
      {entry.directory ? expanded.has(entry.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="tree-indent" />}
      {entry.directory ? <Folder size={15} className="folder-icon" /> : <FileText size={15} />}<span>{entry.name}</span>
    </button>{entry.directory && expanded.has(entry.path) && rows(entry.path, depth + 1)}
  </div>);
  return <div className="file-tree">{loading ? <div className="quiet-state"><LoaderCircle className="spin" size={18} /></div> : rows(root, 0)}</div>;
}

export default function App() {
  const [documents, setDocuments] = useState<DocumentSession[]>([]);
  const docsRef = useRef<DocumentSession[]>([]);
  const [activeId, setActiveId] = useState('');
  const activeIdRef = useRef('');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const settingsSequence = useRef(0);
  const pendingSettings = useRef(new Map<number, Partial<Settings>>());
  const confirmedSettings = useRef(settings);
  const applySettings = useCallback((server: Settings) => { confirmedSettings.current = server; const next = Object.assign({}, server, ...pendingSettings.current.values()) as Settings; settingsRef.current = next; setSettings(next); }, []);
  const [locale, setLocale] = useState('zh-CN');
  const zh = settings.language === 'zh-CN' || (settings.language === 'system' && locale.startsWith('zh'));
  const t = (cn: string, en: string) => zh ? cn : en;
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState('');
  const [navigation, setNavigation] = useState<{ ids: string[]; index: number }>({ ids: [], index: -1 });
  const navigationRef = useRef(navigation); navigationRef.current = navigation;
  const [collapsedHeadings, setCollapsedHeadings] = useState<Set<string>>(new Set());
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(window.innerWidth >= 850);
  const [sidebarTab, setSidebarTab] = useState<'files' | 'outline' | 'search'>('files');
  const [refresh, setRefresh] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const [typewriter, setTypewriter] = useState(false);
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const effectiveTheme = settings.separateDarkTheme && systemDark ? settings.darkTheme : settings.theme;
  const dark = effectiveTheme === 'night';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<'file' | 'editor' | 'image' | 'markdown' | 'export' | 'appearance' | 'general'>('file');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [academicOpen, setAcademicOpen] = useState<'citations' | 'equations' | null>(null);
  const [citationData, setCitationData] = useState<Record<string, CitationRenderData>>({});
  const [referenceRefresh, setReferenceRefresh] = useState(0);
  const consumedReferenceRefresh = useRef(0);
  const resolvedCitationSignatures = useRef(new Map<string, string>());
  const [exportOpen, setExportOpen] = useState(false);
  const modalOpenRef = useRef(false);
  modalOpenRef.current = settingsOpen || !!academicOpen || exportOpen;
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [pandoc, setPandoc] = useState<string | null | undefined>(undefined);
  const [toast, setToast] = useState<{ text: string; error: boolean; path?: string } | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [recoveryErrors, setRecoveryErrors] = useState<string[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [findOptions, setFindOptions] = useState({ caseSensitive: false, wholeWord: false, regex: false });
  const [findResult, setFindResult] = useState({ current: 0, total: 0 });
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [workspaceCase, setWorkspaceCase] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis>(emptyAnalysis);
  const editors = useRef(new Map<string, EditorHandle>());
  const [tabBusy, setTabBusy] = useState(false);
  const tabBusyRef = useRef(false);
  const removedDocuments = useRef(new Set<string>());
  const [transfer, setTransfer] = useState<{ id: string; editorState: unknown } | null>(null);
  const actions = useRef<(name: string) => void>(() => {});
  const mounted = useRef(false);
  const analysisWorker = useRef<Worker | null>(null);
  const analysisSequence = useRef(0);
  const select = useCallback((id: string, record = true) => {
    const previous = docsRef.current.find(doc => doc.id === activeIdRef.current);
    if (previous && previous.id !== id && previous.dirty && previous.path && !previous.recovered && settingsRef.current.saveOnSwitch) actions.current('savePrevious:' + previous.id);
    activeIdRef.current = id; setActiveId(id);
    if (record) setNavigation(previous => { if (previous.ids[previous.index] === id) return previous; const ids = [...previous.ids.slice(0, previous.index + 1), id].slice(-100); return { ids, index: ids.length - 1 }; });
  }, []);
  const replaceDocs = useCallback((next: DocumentSession[]) => { docsRef.current = next; setDocuments(next); }, []);
  const showError = useCallback((text: string) => setToast({ text, error: true }), []);
  const upsert = useCallback((incoming: DocumentSession, activate = false) => {
    if (removedDocuments.current.has(incoming.id) && !activate) return;
    if (activate) removedDocuments.current.delete(incoming.id);
    const previous = docsRef.current.find(doc => doc.id === incoming.id);
    let next = incoming;
    if (previous && (previous.editVersion > incoming.editVersion || (previous.editVersion === incoming.editVersion && previous.source === incoming.source))) next = { ...incoming, ...patchOf(previous), dirty: previous.source !== incoming.savedSource || incoming.recovered };
    replaceDocs(previous ? docsRef.current.map(doc => doc.id === next.id ? next : doc) : [...docsRef.current, next]);
    if (activate || !activeIdRef.current) select(next.id);
  }, [replaceDocs, select]);
  const onEvent = useCallback((event: AppEvent) => {
    if (event.type === 'document') upsert(event.document, event.activate);
    else if (event.type === 'settings') applySettings(event.settings);
    else if (event.type === 'command') actions.current(event.command);
    else if (event.type === 'error') showError(event.message);
    else if (event.type === 'external') setConflicts(previous => previous.includes(event.id) ? previous : [...previous, event.id]);
  }, [upsert, showError, applySettings]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.markedown.onEvent(onEvent);
    void window.markedown.bootstrap().then(initial => {
      if (!mounted.current) return;
      applySettings(initial.settings); setVersion(initial.version); setLocale(initial.locale); setWorkspace(initial.workspace); setRecoveryErrors(initial.recoveryErrors);
      if (initial.transfer) setTransfer(initial.transfer);
      for (const doc of initial.documents) upsert(doc);
      setReady(true);
    }).catch(error => showError(String(error)));
    return () => { mounted.current = false; unsubscribe(); };
  }, [onEvent, upsert, showError, applySettings]);
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const handler = () => setSystemDark(media.matches); media.addEventListener('change', handler); return () => media.removeEventListener('change', handler); }, []);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.documentElement.dataset.editorTheme = effectiveTheme; document.documentElement.lang = zh ? 'zh-CN' : 'en'; }, [dark, effectiveTheme, zh]);
  const active = documents.find(doc => doc.id === activeId);
  useEffect(() => {
    if (!active || active.mode === 'source' && active.source.length > 1024 * 1024 / 3 && new TextEncoder().encode(active.source).length > 1024 * 1024 && referenceRefresh <= consumedReferenceRefresh.current) return;
    let stale = false;
    const id = active.id;
    const timer = setTimeout(() => {
      const refresh = referenceRefresh > consumedReferenceRefresh.current;
      const scan = scanCitations(active.source, settings);
      if (!scan.keys.length) { consumedReferenceRefresh.current = referenceRefresh; resolvedCitationSignatures.current.delete(id); setCitationData(previous => ({ ...previous, [id]: emptyCitationData })); return; }
      const citationSource = [...new Set(scan.clusters.map(cluster => cluster.raw))].join('\n\n');
      const signature = settings.citationStyle + '\n' + citationSource;
      if (!refresh && resolvedCitationSignatures.current.get(id) === signature) return;
      void window.markedown.references.resolve(citationSource, refresh).then(data => {
        if (!stale) { consumedReferenceRefresh.current = referenceRefresh; resolvedCitationSignatures.current.set(id, signature); setCitationData(previous => ({ ...previous, [id]: data })); }
      }).catch(error => { if (!stale) showError(String(error)); });
    }, 350);
    return () => { stale = true; clearTimeout(timer); };
  }, [active?.id, active?.source, active?.mode, settings.citationStyle, settings.inlineMath, settings.latexDelimiters, settings.legacyInlineMath, referenceRefresh, showError]);
  const activeLineStart = active ? active.source.slice(0, active.selection.head).lastIndexOf('\n') + 1 : 0;
  const activeHeading = active ? /^#{1,6}(?=\s)/.exec(active.source.slice(activeLineStart)) : null;
  const paragraphStyle = activeHeading ? `heading${activeHeading[0].length}` : 'paragraph';
  useEffect(() => { document.title = active ? `${active.dirty || active.recovered ? '* ' : ''}${active.title} - Markedown` : 'Markedown'; }, [active?.title, active?.dirty, active?.recovered]);
  useEffect(() => {
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    analysisWorker.current = worker;
    worker.onmessage = event => { if (event.data.id === analysisSequence.current) setAnalysis(event.data.result); };
    return () => { worker.terminate(); analysisWorker.current = null; };
  }, []);
  useEffect(() => { const id = ++analysisSequence.current; const timer = setTimeout(() => analysisWorker.current?.postMessage({ id, source: active?.source || '', settings }), 180); return () => clearTimeout(timer); }, [active?.source, settings]);
  useEffect(() => { if (!toast || toast.error) return; const timer = setTimeout(() => setToast(null), 6000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (exportOpen || settingsOpen) void window.markedown.findPandoc().then(setPandoc).catch(() => setPandoc(null)); }, [exportOpen, settingsOpen, settings.pandocPath]);
  useEffect(() => {
    const editor = editors.current.get(activeId);
    if (findOpen) editor?.find(query, findOptions); else editor?.find('', findOptions);
  }, [activeId, findOpen, query, findOptions]);
  const searchSequence = useRef(0);
  useEffect(() => {
    const seq = ++searchSequence.current;
    void window.markedown.cancelSearch();
    if (!workspace || !workspaceQuery.trim()) { setHits([]); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => void window.markedown.searchWorkspace(workspaceQuery, workspaceCase).then(result => {
      if (seq !== searchSequence.current) return;
      setSearching(false);
      if (result.status === 'ok' && !result.value.cancelled) { setHits(result.value.hits); setSearchTruncated(result.value.truncated); }
      else if (result.status === 'error') showError(result.message);
    }).catch(error => { if (seq === searchSequence.current) { setSearching(false); showError(String(error)); } }), 260);
    return () => { clearTimeout(timer); void window.markedown.cancelSearch(); };
  }, [workspace, workspaceQuery, workspaceCase, settings.showHiddenFiles, settings.fileFilter, showError]);
  const change = useCallback((id: string, patch: DocumentPatch) => {
    const doc = docsRef.current.find(item => item.id === id);
    if (!doc || patch.editVersion < doc.editVersion) return;
    const next = { ...doc, ...patch, dirty: patch.source !== doc.savedSource || doc.recovered };
    replaceDocs(docsRef.current.map(item => item.id === id ? next : item));
    void window.markedown.updateDocument(id, patch).catch(error => showError(String(error)));
  }, [replaceDocs, showError]);
  async function newDocument() { try { upsert(await window.markedown.newDocument(), true); } catch (error) { showError(String(error)); } }
  async function openFiles(paths?: string[], offset?: number) {
    try {
      const result = await window.markedown.openFiles(paths);
      if (result.status === 'ok') {
        result.value.forEach(doc => upsert(doc, true));
        const id = result.value.at(-1)?.id;
        if (id && offset !== undefined) requestAnimationFrame(() => editors.current.get(id)?.scrollTo(offset));
      } else if (result.status === 'error') showError(result.message);
    } catch (error) { showError(String(error)); }
  }
  async function save(id = activeIdRef.current, saveAs = false) {
    const doc = docsRef.current.find(item => item.id === id); if (!doc) return false;
    const result = await window.markedown.saveDocument(id, patchOf(doc), saveAs);
    if (result.status === 'ok') { upsert(result.value); return true; }
    if (result.status === 'conflict') setConflicts(previous => previous.includes(id) ? previous : [...previous, id]);
    else if (result.status === 'error') showError(result.message);
    return false;
  }
  async function removeDocuments(ids: string[]) {
    const removed = new Set(ids);
    const index = docsRef.current.findIndex(doc => doc.id === activeIdRef.current);
    const remaining = docsRef.current.filter(doc => !removed.has(doc.id));
    for (const id of ids) { removedDocuments.current.add(id); editors.current.delete(id); resolvedCitationSignatures.current.delete(id); }
    replaceDocs(remaining);
    setCitationData(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))));
    setConflicts(items => items.filter(id => !removed.has(id)));
    if (removed.has(activeIdRef.current)) select(remaining[Math.min(index, remaining.length - 1)]?.id || '');
    if (!remaining.length) await newDocument();
  }
  async function closeDocument(id: string, others = false) {
    if (tabBusyRef.current) return;
    tabBusyRef.current = true; setTabBusy(true);
    try {
      const result = others ? await window.markedown.closeOtherDocuments(id) : await window.markedown.closeDocument(id);
      if (result.status === 'ok') await removeDocuments(Array.isArray(result.value) ? result.value : [id]);
      else if (result.status === 'error' || result.status === 'conflict') showError(result.message);
    } catch (error) { showError(String(error)); }
    finally { tabBusyRef.current = false; setTabBusy(false); }
  }
  async function detachDocument(id: string, position?: { x: number; y: number }) {
    if (tabBusyRef.current) return;
    const editor = editors.current.get(id);
    if (!editor) return;
    tabBusyRef.current = true; setTabBusy(true);
    let completed = false;
    try {
      const snapshot = editor.beginTransfer();
      if (!snapshot) { showError(t('请完成当前输入或图片插入后，再移动标签。', 'Finish the current input or image insertion before moving this tab.')); return; }
      const result = await window.markedown.detachDocument(id, snapshot.patch, snapshot.editorState, position);
      if (result.status === 'ok') { completed = true; await removeDocuments([id]); }
      else if (result.status === 'error' || result.status === 'conflict') showError(result.message);
    } catch (error) { showError(String(error)); }
    finally { if (!completed) editor.cancelTransfer(); tabBusyRef.current = false; setTabBusy(false); }
  }
  async function chooseWorkspace(path?: string) {
    const result = await window.markedown.chooseWorkspace(path);
    if (result.status === 'ok') { setWorkspace(result.value); setSidebar(true); setSidebarTab('files'); setRefresh(value => value + 1); }
    else if (result.status === 'error') showError(result.message);
  }
  async function updateSettings(patch: Partial<Settings>) {
    const id = ++settingsSequence.current; pendingSettings.current.set(id, patch); applySettings(confirmedSettings.current);
    try { const server = await window.markedown.updateSettings(patch); pendingSettings.current.delete(id); applySettings(server); }
    catch (error) { pendingSettings.current.delete(id); applySettings(confirmedSettings.current); showError(String(error)); }
  }
  async function insertImages(id: string, files?: File[]) {
    const doc = docsRef.current.find(item => item.id === id); if (!doc) return [];
    if (!doc.path && !await save(id)) return [];
    if (files && (files.length > 100 || files.some(file => file.size > 64 * 1024 * 1024) || files.reduce((size, file) => size + file.size, 0) > 256 * 1024 * 1024)) { showError(t('图片超过批量导入限制。', 'Image batch exceeds the import limit.')); return []; }
    const inputs = files ? await Promise.all(files.map(async file => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))) : undefined;
    const result = await window.markedown.importImages(id, inputs);
    if (result.status === 'ok') return result.value;
    if (result.status === 'error') showError(result.message);
    return [];
  }
  async function doExport(format: ExportFormat) {
    const doc = docsRef.current.find(item => item.id === activeIdRef.current); if (!doc || exporting) return;
    setExporting(format);
    try {
      const result = await window.markedown.exportDocument(doc.id, patchOf(doc), format);
      if (result.status === 'ok') { setExportOpen(false); setToast({ text: t('已导出', 'Exported'), error: false, path: result.value }); }
      else if (result.status === 'error') showError(result.message);
    } catch (error) { showError(String(error)); } finally { setExporting(null); }
  }
  function toggleMode() {
    const doc = docsRef.current.find(item => item.id === activeIdRef.current); if (!doc) return;
    if (doc.mode === 'source' && new TextEncoder().encode(doc.source).length > 5 * 1024 * 1024) { showError(t('超过 5 MiB 的文稿使用源码模式。', 'Documents over 5 MiB use source mode.')); return; }
    change(doc.id, { ...patchOf(doc), mode: doc.mode === 'source' ? 'live' : 'source' });
  }
  actions.current = name => {
    if (tabBusyRef.current) return;
    if (name.startsWith('savePrevious:')) { void save(name.slice(13)); return; }
    if (name.startsWith('openRecent:')) { void openFiles([name.slice(11)]); return; }
    if ((settingsOpen || academicOpen) && !['settings', 'equationNumberingSettings', 'about', 'zoomIn', 'zoomOut', 'zoomReset'].includes(name)) return;
    const editor = editors.current.get(activeIdRef.current);
    switch (name) {
      case 'cut': case 'copy': case 'paste': editor?.focus(); void window.markedown.editCommand(name).catch(error => showError(String(error))); break;
      case 'back': case 'forward': { const direction = name === 'back' ? -1 : 1; const history = navigationRef.current; let index = history.index + direction; while (index >= 0 && index < history.ids.length && !docsRef.current.some(d => d.id === history.ids[index])) index += direction; if (index >= 0 && index < history.ids.length) { setNavigation({ ...history, index }); select(history.ids[index], false); } break; }
      case 'zoomIn': void updateSettings({ zoom: Math.min(200, settingsRef.current.zoom + 10) }); break;
      case 'zoomOut': void updateSettings({ zoom: Math.max(50, settingsRef.current.zoom - 10) }); break;
      case 'zoomReset': void updateSettings({ zoom: 100 }); break;
      case 'import': void window.markedown.importDocuments().then(result => { if (result.status === 'ok') result.value.forEach(doc => upsert(doc, true)); else if (result.status === 'error') showError(result.message); }).catch(error => showError(String(error))); break;
      case 'about': setSettingsOpen(true); break;
      case 'guide': void window.markedown.newDocument().then(doc => { const source = '# Markedown\n\n'+t('即写即排版。点击排版区域即可编辑源码。','Write Markdown on a single live canvas. Click a rendered block to edit its source.')+'\n\n## '+t('常用快捷键','Keyboard shortcuts')+'\n\n- Ctrl+S '+t('保存','Save')+'\n- Ctrl+B **'+t('加粗','Bold')+'**\n- Ctrl+I *'+t('斜体','Italic')+'*\n- Ctrl+/ '+t('切换源码模式','Toggle source mode')+'\n- Ctrl+, '+t('偏好设置','Preferences')+'\n\n## Markdown\n\n- [ ] '+t('任务列表','Task list')+'\n- =='+t('高亮','Highlight')+'==\n\n> [!NOTE]\n> '+t('本地文稿始终保留 Markdown 源码。','Markdown source remains the document of record.')+'\n\n| '+t('主题','Theme')+' | '+t('风格','Style')+' |\n| --- | --- |\n| Github | Sans serif |\n| Newsprint | Paper |\n| Night | Dark |\n| Pixyll | Editorial |\n| Whitey | Centered titles |\n\n$E=mc^2$\n'; upsert(doc,true); change(doc.id,{...patchOf(doc),source,editVersion:1}); }); break;
      case 'new': void newDocument(); break;
      case 'newWindow': void window.markedown.newWindow(); break;
      case 'open': void openFiles(); break;
      case 'workspace': void chooseWorkspace(); break;
      case 'save': void save(); break;
      case 'saveAs': void save(activeIdRef.current, true); break;
      case 'close': if (activeIdRef.current) void closeDocument(activeIdRef.current); break;
      case 'export': setExportOpen(true); break;
      case 'citations': setAcademicOpen('citations'); break;
      case 'equationReferences': setAcademicOpen('equations'); break;
      case 'refreshReferences': setReferenceRefresh(value => value + 1); break;
      case 'settings': setSettingsCategory('file'); setSettingsQuery(''); setSettingsOpen(true); break;
      case 'equationNumberingSettings': setSettingsCategory('markdown'); setSettingsQuery(t('数学公式', 'Math')); setAcademicOpen(null); setSettingsOpen(true); break;
      case 'find': setFindOpen(true); break;
      case 'replace': setFindOpen(true); setReplaceOpen(true); break;
      case 'mode': toggleMode(); break;
      case 'sidebar': setSidebar(value => !value); break;
      case 'focusMode': setFocusMode(value => !value); break;
      case 'typewriter': setTypewriter(value => !value); break;
      default: editor?.command(name);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || modalOpenRef.current) return;
      const command = shortcutCommand(settingsRef.current.shortcuts, event);
      if (command) { event.preventDefault(); actions.current(command); }
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !settingsRef.current.ctrlWheelZoom) return;
      event.preventDefault(); actions.current(event.deltaY < 0 ? 'zoomIn' : 'zoomOut');
    };
    window.addEventListener('keydown', onKey); window.addEventListener('wheel', onWheel, { passive: false });
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('wheel', onWheel); };
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeAcademic = useCallback(() => { setAcademicOpen(null); requestAnimationFrame(() => editors.current.get(activeIdRef.current)?.focus()); }, []);
  const closeExport = useCallback(() => { if (!exporting) setExportOpen(false); }, [exporting]);
  const conflictId = conflicts[0];
  const conflictDoc = documents.find(doc => doc.id === conflictId);
  const resolveConflict = useCallback(async (action: 'reload' | 'copy' | 'cancel') => {
    if (!conflictId) return;
    const result = await window.markedown.resolveExternal(conflictId, action);
    if (result.status === 'ok') { upsert(result.value); setConflicts(items => items.filter(id => id !== conflictId)); }
    else if (action === 'cancel') setConflicts(items => items.filter(id => id !== conflictId));
    else if (result.status === 'error' || result.status === 'conflict') showError(result.message);
  }, [conflictId, upsert, showError]);
  const dismissConflict = useCallback(() => { void resolveConflict('cancel'); }, [resolveConflict]);
  const dismissRecoveryErrors = useCallback(() => setRecoveryErrors([]), []);
  const invalidRegex = useMemo(() => { if (!findOptions.regex || !query) return false; try { new RegExp(query); return false; } catch { return true; } }, [findOptions.regex, query]);
  const tool = (name: string, cn: string, en: string, glyph: ReactNode) => <IconButton key={name} label={t(cn, en)} onClick={() => actions.current(name)} disabled={!active}>{glyph}</IconButton>;
  function goToHeading(id: string) {
    const doc = docsRef.current.find(item => item.id === activeIdRef.current);
    if (!doc) return;
    const heading = analyzeMarkdown(doc.source, settingsRef.current).headings.find(item => item.id === id);
    if (heading) editors.current.get(doc.id)?.scrollTo(heading.offset);
  }

  return <div className={`app ${focusMode ? 'focus-mode' : ''}`} data-testid="app" onDragOver={event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); }} onDrop={event => {
    if (event.defaultPrevented || settingsOpen || academicOpen) return;
    const files = [...event.dataTransfer.files].filter(file => !file.type.startsWith('image/'));
    const paths = window.markedown.droppedPaths(files);
    if (!paths.length) return;
    event.preventDefault();
    void window.markedown.handleDrop(paths).then(result => {
      if (result.status === 'ok') { result.value.documents.forEach(doc => upsert(doc,true)); if (result.value.workspace) { setWorkspace(result.value.workspace); setSidebar(true); setSidebarTab('files'); setRefresh(value => value + 1); } }
      else if (result.status === 'error') showError(result.message);
    }).catch(error => showError(String(error)));
  }}>
    <TopBar zh={zh} title={active ? (active.dirty ? '• ' : '') + active.title + ' — Markedown' : 'Markedown'} settings={settings} hasDocument={!!active && !settingsOpen} sourceMode={active?.mode === 'source'} focus={focusMode} typewriter={typewriter} canBack={navigation.index > 0} canForward={navigation.index < navigation.ids.length - 1} command={name => actions.current(name)} update={patch => void updateSettings(patch)} />
    <div className="workspace" inert={settingsOpen} aria-hidden={settingsOpen}>
      {!focusMode && sidebar && <aside className="sidebar" data-testid="sidebar">
        <div className="sidebar-switcher" role="tablist" aria-label={t('工作区视图', 'Workspace views')}>
          {(['files', 'outline', 'search'] as const).map((tab, index) => <button key={tab} role="tab" aria-selected={sidebarTab === tab} title={[t('文件', 'Files'), t('大纲', 'Outline'), t('搜索', 'Search')][index]} onClick={() => setSidebarTab(tab)}>{[<Folder size={16} />, <AlignLeft size={16} />, <Search size={16} />][index]}<span>{[t('文件', 'Files'), t('大纲', 'Outline'), t('搜索', 'Search')][index]}</span></button>)}
        </div>
        {sidebarTab === 'files' && <><div className="sidebar-heading"><span title={workspace || ''}>{workspace ? basename(workspace) : t('工作区', 'Workspace')}</span><div><IconButton label={t('刷新', 'Refresh')} onClick={() => setRefresh(value => value + 1)} disabled={!workspace}><RefreshCw /></IconButton><IconButton label={t('打开文件夹', 'Open folder')} onClick={() => void chooseWorkspace()}><FolderOpen /></IconButton></div></div>{workspace ? <FileTree root={workspace} refresh={refresh + (settings.showHiddenFiles ? 1000000 : 0) + ['text','markdown','all'].indexOf(settings.fileFilter) * 2000000} selected={active?.path || null} onOpen={path => void openFiles([path])} onError={showError} /> : <div className="empty-workspace"><FolderOpen size={32} strokeWidth={1.2} /><button className="text-command" onClick={() => void chooseWorkspace()}><Plus size={15} />{t('打开文件夹', 'Open folder')}</button>{settings.recentWorkspaces.length > 0 && <div className="recent-workspaces"><span>{t('最近使用', 'Recent')}</span>{settings.recentWorkspaces.map(root => <button key={root} title={root} onClick={() => void chooseWorkspace(root)}><Folder size={14} /><span>{basename(root)}</span></button>)}</div>}</div>}</>}
        {sidebarTab === 'outline' && <><div className="sidebar-heading"><span>{t('文稿大纲', 'Document outline')}</span><span className="count">{analysis.headings.length}</span></div><div className="outline-list">{analysis.headings.length ? analysis.headings.filter((heading,index,all) => !settings.outlineCollapsible || !all.slice(0,index).some((ancestor, ancestorIndex) => collapsedHeadings.has(ancestor.id) && ancestor.level < heading.level && !all.slice(ancestorIndex+1,index).some(other => other.level <= ancestor.level))).map((heading, index, visible) => <button key={heading.id} style={{ paddingLeft: 16 + (heading.level - 1) * 12 }} onClick={() => goToHeading(heading.id)} title={heading.text}><span className="heading-level" role={settings.outlineCollapsible ? 'button' : undefined} aria-label={t('折叠或展开标题','Fold or expand heading')} onClick={event => { if (!settings.outlineCollapsible) return; event.stopPropagation(); setCollapsedHeadings(previous => { const next = new Set(previous); next.has(heading.id) ? next.delete(heading.id) : next.add(heading.id); return next; }); }}>{settings.outlineCollapsible ? collapsedHeadings.has(heading.id) ? '▸' : '▾' : 'H'+heading.level}</span><span>{heading.text}</span></button>) : <div className="quiet-state">{t('暂无标题', 'No headings')}</div>}</div></>}
        {sidebarTab === 'search' && <><div className="workspace-search"><div className="input-with-tools"><Search size={15} /><input aria-label={t('搜索工作区', 'Search workspace')} placeholder={t('搜索文稿', 'Search documents')} value={workspaceQuery} onChange={event => setWorkspaceQuery(event.target.value)} disabled={!workspace} /><IconButton label={t('区分大小写', 'Match case')} active={workspaceCase} onClick={() => setWorkspaceCase(value => !value)}><Type size={15} /></IconButton></div><div className="search-summary">{searching ? <LoaderCircle size={14} className="spin" /> : workspaceQuery ? `${hits.length}${searchTruncated ? '+' : ''} ${t('个结果', 'results')}` : workspace ? '' : t('未打开工作区', 'No workspace open')}</div></div><div className="search-results">{hits.map((hit, index) => <button key={`${hit.path}:${hit.offset}:${index}`} title={hit.path} onClick={() => void openFiles([hit.path], hit.offset)}><span className="search-location"><FileText size={13} /><strong>{basename(hit.path)}</strong><small>{hit.line}:{hit.column}</small></span><span className="search-preview">{hit.preview}</span></button>)}</div></>}
        <div className="sidebar-footer"><span>{t('本地文稿', 'Local documents')}</span><IconButton label={t('收起侧栏', 'Hide sidebar')} onClick={() => setSidebar(false)}><PanelLeft size={15} /></IconButton></div>
      </aside>}
      <main className="document-area">
        {!focusMode && <div className="tab-band">{!sidebar && <IconButton label={t('显示侧栏', 'Show sidebar')} onClick={() => setSidebar(true)}><PanelLeft /></IconButton>}<DocumentTabs documents={documents} activeId={activeId} zh={zh} busy={tabBusy} onSelect={select} onClose={id => void closeDocument(id)} onCloseOthers={id => void closeDocument(id, true)} onDetach={(id, position) => void detachDocument(id, position)} /><IconButton label={t('新建文稿', 'New document')} disabled={tabBusy} onClick={() => void newDocument()}><Plus /></IconButton></div>}
        {!focusMode && settings.showToolbar && <div className="format-toolbar"><div className="toolbar-group"><select className="heading-select" aria-label={t('段落样式', 'Paragraph style')} value={paragraphStyle} onChange={event => actions.current(event.target.value)} disabled={!active}><option value="paragraph">{t('正文', 'Text')}</option>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={`heading${level}`}>{t('标题', 'Heading')} {level}</option>)}</select>{tool('bold', '加粗', 'Bold', <Bold />)}{tool('italic', '斜体', 'Italic', <Italic />)}{tool('strike', '删除线', 'Strikethrough', <Strikethrough />)}{tool('mark', '高亮', 'Highlight', <Highlighter />)}<span className="divider" />{tool('link', '链接', 'Link', <Link />)}{tool('image', '插入图片', 'Insert image', <ImagePlus />)}{tool('code', '行内代码', 'Inline code', <Code2 />)}{tool('codeblock', '代码块', 'Code block', <Braces />)}<span className="divider" />{tool('quote', '引用', 'Quote', <Quote />)}{tool('unorderedList', '无序列表', 'Bullet list', <List />)}{tool('orderedList', '有序列表', 'Numbered list', <ListOrdered />)}{tool('task', '任务列表', 'Task list', <ListChecks />)}</div><div className="toolbar-right">{tool('undo', '撤销', 'Undo', <Undo2 />)}{tool('redo', '重做', 'Redo', <Redo2 />)}<span className="divider" /><IconButton label={t('专注模式', 'Focus mode')} active={focusMode} onClick={() => setFocusMode(value => !value)}><Maximize2 /></IconButton></div></div>}
        {findOpen && <div className="find-bar" data-testid="find-bar"><div className="find-primary"><IconButton label={t('替换', 'Replace')} active={replaceOpen} onClick={() => setReplaceOpen(value => !value)}>{replaceOpen ? <ChevronDown /> : <ChevronRight />}</IconButton><div className={`input-with-tools find-input ${invalidRegex ? 'invalid' : ''}`}><Search size={15} /><input autoFocus aria-label={t('查找内容', 'Find text')} placeholder={t('查找', 'Find')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') editors.current.get(activeId)?.findNext(event.shiftKey); if (event.key === 'Escape') setFindOpen(false); }} /><span className="find-count">{invalidRegex ? t('表达式无效', 'Invalid regex') : `${findResult.current} / ${findResult.total}`}</span></div><IconButton label={t('区分大小写', 'Match case')} active={findOptions.caseSensitive} onClick={() => setFindOptions(value => ({ ...value, caseSensitive: !value.caseSensitive }))}><Type /></IconButton><IconButton label={t('全字匹配', 'Whole word')} active={findOptions.wholeWord} onClick={() => setFindOptions(value => ({ ...value, wholeWord: !value.wholeWord }))}><ChevronsLeftRight /></IconButton><IconButton label={t('正则表达式', 'Regular expression')} active={findOptions.regex} onClick={() => setFindOptions(value => ({ ...value, regex: !value.regex }))}><span className="regex-symbol">.*</span></IconButton><IconButton label={t('上一个', 'Previous match')} onClick={() => editors.current.get(activeId)?.findNext(true)}><ArrowUp /></IconButton><IconButton label={t('下一个', 'Next match')} onClick={() => editors.current.get(activeId)?.findNext()}><ArrowDown /></IconButton><IconButton label={t('关闭查找', 'Close find')} onClick={() => setFindOpen(false)}><X /></IconButton></div>{replaceOpen && <div className="replace-row"><input aria-label={t('替换为', 'Replace with')} placeholder={t('替换为', 'Replace with')} value={replacement} onChange={event => setReplacement(event.target.value)} /><button className="text-command" disabled={!query || invalidRegex} onClick={() => editors.current.get(activeId)?.replace(replacement)}>{t('替换', 'Replace')}</button><button className="text-command" disabled={!query || invalidRegex} onClick={() => editors.current.get(activeId)?.replace(replacement, true)}>{t('全部替换', 'Replace all')}</button></div>}</div>}
        {active?.recovered && <div className="recovery-banner"><span>{t('已恢复未保存的文稿', 'Unsaved document recovered')}</span><button className="text-command" onClick={() => void save()}><Save size={14} />{t('保存恢复内容', 'Save recovered content')}</button></div>}
        <div className="editor-stack" data-testid="editor-stack">{!ready && <div className="editor-loading"><LoaderCircle className="spin" /></div>}{documents.map(doc => <Editor key={doc.id} ref={handle => { if (handle) editors.current.set(doc.id, handle); else editors.current.delete(doc.id); }} document={doc} active={doc.id === activeId} settings={{ ...settings, mathNumberingPrefix: doc.mathNumberingPrefix ?? settings.mathNumberingPrefix }} citations={citationData[doc.id] || emptyCitationData} fontSize={settings.fontSizeMode === 'auto' ? 17 : settings.fontSize} readingWidth={settings.readingWidth} theme={dark ? 'dark' : 'light'} typewriter={typewriter} transferState={transfer?.id === doc.id ? transfer.editorState : undefined} onTransferReady={async accepted => { await window.markedown.completeDocumentTransfer(doc.id, accepted); setTransfer(null); }} onChange={patch => change(doc.id, patch)} onImportImages={files => insertImages(doc.id, files)} onFindResult={result => { if (activeIdRef.current === doc.id) setFindResult(result); }} />)}</div>
        {!focusMode && settings.showStatusBar && <footer className="status-bar"><div><span>{analysis.words.toLocaleString()} {t('字', 'words')}</span><span className="status-secondary">{analysis.characters.toLocaleString()} {t('字符', 'characters')}</span><span className="status-secondary">{analysis.words ? Math.max(1, Math.ceil(analysis.words / settings.readingSpeed)) : 0} {t('分钟', 'min')}</span></div><div><IconButton label={t('打字机模式', 'Typewriter mode')} active={typewriter} onClick={() => setTypewriter(value => !value)}><AlignLeft size={14} /></IconButton><span>{active?.bom ? 'UTF-8 BOM' : 'UTF-8'}</span><span>{active?.lineEnding || 'LF'}</span><button className={`mode-button ${active?.mode === 'source' ? 'source' : ''}`} onClick={toggleMode} data-testid="mode-toggle"><Code2 size={13} />{active?.mode === 'source' ? t('源码', 'Source') : t('即时排版', 'Live')}</button></div></footer>}
      </main>
    </div>
    {focusMode && <div className="focus-exit"><IconButton label={t('退出专注模式', 'Exit focus mode')} onClick={() => setFocusMode(false)}><Minimize2 /></IconButton></div>}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}><span>{toast.text}</span>{toast.path && <button className="text-command" onClick={() => void window.markedown.revealFile(toast.path!)}><FolderOpen size={15} />{t('显示文件', 'Show file')}</button>}<IconButton label={t('关闭提示', 'Dismiss')} onClick={() => setToast(null)}><X /></IconButton></div>}
    <CitationCredits startup paused={!ready || !!toast || settingsOpen || !!academicOpen || exportOpen || !!conflictDoc || recoveryErrors.length > 0} />
    {settingsOpen && <Preferences settings={settings} zh={zh} version={version} pandoc={pandoc} update={updateSettings} documentPrefix={active?.mathNumberingPrefix ?? settings.mathNumberingPrefix} updateDocumentPrefix={value => { if (!active) return; change(active.id, { ...patchOf(active), mathNumberingPrefix: value }); }} close={closeSettings} error={showError} disableWritingModes={() => { setFocusMode(false); setTypewriter(false); }} initialCategory={settingsCategory} initialQuery={settingsQuery} />}
    {academicOpen && active && <AcademicPanel source={active.source} settings={settings} zh={zh} initialTab={academicOpen} onClose={closeAcademic} onError={showError} onInsert={(text, bibliography) => { editors.current.get(activeIdRef.current)?.insertText(text, bibliography); setAcademicOpen(null); }} />}
    {exportOpen && <Modal title={t('导出文稿', 'Export document')} onClose={closeExport}><div className="export-content"><div className="export-formats">{settings.exportPresets.map(({ format, id, name }) => <button key={id} className="export-format" disabled={!!exporting || (!['html','htmlPlain','pdf','png'].includes(format) && !pandoc)} onClick={() => void doExport(format)} title={!['html','htmlPlain','pdf','png'].includes(format) && !pandoc ? t('需要 Pandoc', 'Pandoc required') : format.toUpperCase()}>{exporting === format ? <LoaderCircle className="spin" /> : format === 'png' ? <FileImage /> : format === 'html' || format === 'tex' ? <FileCode2 /> : <FileText />}<strong>{name === 'Image' ? t('图像','Image') : name === 'HTML (without styles)' ? t('HTML（无样式）',name) : name}</strong>{format === 'png' && <span>{t('长图', 'Long image')}</span>}</button>)}</div><div className="export-options"><label><input type="checkbox" checked={settings.exportOutline} onChange={event => void updateSettings({ exportOutline: event.target.checked })} />{t('包含目录', 'Include table of contents')}</label><select aria-label={t('PDF 纸张', 'PDF paper')} value={settings.pageSize} onChange={event => void updateSettings({ pageSize: event.target.value as 'A4' | 'Letter' })}><option>A4</option><option>Letter</option></select></div>{!pandoc && <div className="pandoc-note">{t('Pandoc 未安装', 'Pandoc not installed')}<button className="text-command" onClick={() => void window.markedown.choosePandoc().then(path => { if (path) void updateSettings({ pandocPath: path }); })}><FolderOpen size={14} />{t('选择程序', 'Choose executable')}</button></div>}</div></Modal>}
    {conflictDoc && <Modal title={t('文件已在外部修改', 'File changed on disk')} onClose={dismissConflict}><div className="conflict-content"><FileText size={30} /><strong>{conflictDoc.title}</strong><p>{t('当前编辑内容尚未写回文件。', 'Your current edits have not been written to disk.')}</p><div className="modal-actions"><button className="text-command" onClick={() => void resolveConflict('reload')}>{t('重新加载', 'Reload')}</button><button className="primary-command" onClick={() => void resolveConflict('copy')}><Save size={15} />{t('另存副本', 'Save a copy')}</button><button className="text-command" onClick={dismissConflict}>{t('取消', 'Cancel')}</button></div></div></Modal>}
    {recoveryErrors.length > 0 && <Modal title={t('恢复记录提示', 'Recovery notices')} onClose={dismissRecoveryErrors}><div className="recovery-errors">{recoveryErrors.map((message, index) => <p key={index}>{message}</p>)}</div></Modal>}
  </div>;
}
