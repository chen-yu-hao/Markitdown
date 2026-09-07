import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Braces, Check, Database, Plus, RefreshCw, Search, WifiOff, X } from 'lucide-react';
import type { Settings } from '../shared/contracts';
import type { CitationRenderData, ReferenceItem, ReferenceStatus } from '../shared/academic-contracts';
import { getEquationIndex } from '../shared/markdown';
import './academic.css';

export interface AcademicPanelProps {
  source: string;
  settings: Settings;
  zh: boolean;
  onInsert(text: string, bibliography?: boolean): void;
  onClose(): void;
  onError(message: string): void;
  initialTab?: 'citations' | 'equations';
}
type SearchItem = Pick<ReferenceItem, 'key' | 'title' | 'authors' | 'year'>;

export default function AcademicPanel({ source, settings, zh, onInsert, onClose, onError, initialTab = 'citations' }: AcademicPanelProps) {
  const [tab, setTab] = useState(initialTab);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SearchItem[]>([]);
  const [selected, setSelected] = useState<Map<string, SearchItem>>(() => new Map());
  const [equationLabel, setEquationLabel] = useState('');
  const [status, setStatus] = useState<ReferenceStatus | null>(null);
  const [cached, setCached] = useState<CitationRenderData | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const consumedRefresh = useRef(0);
  const callbacks = useRef({ onClose, onError });
  callbacks.current = { onClose, onError };
  const t = (cn: string, en: string) => zh ? cn : en;
  const equations = useMemo(() => getEquationIndex(source, settings).equations, [source, settings]);
  const filteredEquations = equations.filter(equation => `${equation.label || ''} ${equation.source}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const validEquationSelection = Boolean(equationLabel) && equations.some(equation => equation.label === equationLabel && !equation.duplicate);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    search.current?.focus();
    return () => { sequence.current++; void window.markedown.references.cancelSearch().catch(() => {}); previous?.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    const forceRefresh = refresh > consumedRefresh.current;
    consumedRefresh.current = refresh;
    void window.markedown.references.status().then(value => { if (active) setStatus(value); }).catch(error => { if (active) setStatus({ available: false, message: String(error) }); });
    void window.markedown.references.resolve(source, forceRefresh).then(value => { if (active) setCached(value); }).catch(error => { if (active) setSearchError(String(error)); });
    return () => { active = false; };
  }, [source, refresh]);

  useEffect(() => {
    const request = ++sequence.current;
    if (tab !== 'citations') { setBusy(false); void window.markedown.references.cancelSearch().catch(() => {}); return; }
    setBusy(true);
    setSearchError('');
    const timer = setTimeout(() => {
      void window.markedown.references.cancelSearch().catch(() => {}).then(() => {
        if (request !== sequence.current) return;
        return window.markedown.references.search(query.trim()).then(result => {
          if (request !== sequence.current) return;
          setItems(result.items); setHasMore(result.hasMore); setBusy(false);
        });
      }).catch(error => {
        if (request !== sequence.current) return;
        setItems([]); setHasMore(false); setBusy(false); setSearchError(String(error));
      });
    }, 280);
    return () => { clearTimeout(timer); sequence.current++; void window.markedown.references.cancelSearch().catch(() => {}); };
  }, [query, tab, refresh]);

  const cachedItems = (cached?.entries || []).filter(item => `${item.key} ${item.title} ${item.authors} ${item.year}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const visibleItems = [...items, ...cachedItems.filter(item => !items.some(result => result.key === item.key))];
  const offline = status?.available === false || cached?.offline && !status?.available;
  function changeTab(next: typeof tab) { setTab(next); setQuery(''); search.current?.focus(); }
  function toggle(item: SearchItem) { setSelected(previous => { const next = new Map(previous); if (next.has(item.key)) next.delete(item.key); else next.set(item.key, item); return next; }); }
  function insert() {
    try {
      if (tab === 'equations') {
        if (!validEquationSelection) return;
        dialog.current?.close();
        onInsert(`\\eqref{${equationLabel}}`);
      } else {
        const keys = [...selected.keys()].filter(key => /^[A-Z0-9]{8}$/.test(key));
        if (!keys.length) return;
        dialog.current?.close();
        onInsert(`[${keys.map(key => '@' + key).join('; ')}]`, true);
      }
      onClose();
    } catch (error) { callbacks.current.onError(error instanceof Error ? error.message : String(error)); }
  }

  return <dialog ref={dialog} className="academic-dialog" aria-labelledby="academic-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="academic-layout" onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); insert(); } }}>
      <header className="academic-header"><h2 id="academic-title">{t('插入学术引用', 'Insert Academic Reference')}</h2><button type="button" className="academic-icon" aria-label={t('关闭', 'Close')} title={t('关闭', 'Close')} onClick={onClose}><X size={18}/></button></header>
      <div className="academic-tabs" role="tablist" aria-label={t('引用类型', 'Reference type')}>
        <button type="button" role="tab" aria-selected={tab === 'citations'} onClick={() => changeTab('citations')}><BookOpen size={15}/>{t('文献', 'Literature')}</button>
        <button type="button" role="tab" aria-selected={tab === 'equations'} onClick={() => changeTab('equations')}><Braces size={15}/>{t('公式', 'Equations')}</button>
      </div>
      <label className="academic-search"><Search size={16}/><input ref={search} maxLength={300} aria-label={tab === 'citations' ? t('检索文献', 'Search references') : t('检索公式', 'Search equations')} placeholder={tab === 'citations' ? t('标题、作者、年份或 Zotero 条目键', 'Title, author, year or Zotero item key') : t('公式标签或 LaTeX 内容', 'Equation label or LaTeX source')} value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" className="academic-icon" title={t('清空搜索', 'Clear search')} aria-label={t('清空搜索', 'Clear search')} onClick={() => { setQuery(''); search.current?.focus(); }}><X size={14}/></button>}</label>
      <div className={`academic-status${searchError && !visibleItems.length && tab === 'citations' ? ' is-error' : ''}`} role="status">
        {tab === 'equations' ? <>{filteredEquations.length} {t('条公式', 'equations')}</> : <>{offline ? <WifiOff size={13}/> : <Database size={13}/>}<span>{busy ? t('正在检索…', 'Searching…') : searchError && !visibleItems.length ? searchError : offline ? t(`Zotero 离线 · ${cached?.entries.length || 0} 条缓存文献`, `Zotero offline · ${cached?.entries.length || 0} cached references`) : status?.available ? `Zotero${status.version ? ' ' + status.version : ''} · ${visibleItems.length} ${t('条结果', 'results')}` : t('正在检查 Zotero…', 'Checking Zotero…')}{hasMore && !busy ? t(' · 结果已截断，请缩小检索范围', ' · More results available; refine the search') : ''}</span><button type="button" className="academic-icon" aria-label={t('刷新连接和文献', 'Refresh connection and references')} title={t('刷新连接和文献', 'Refresh connection and references')} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13}/></button></>}
      </div>
      <div className="academic-results" role="tabpanel" aria-busy={tab === 'citations' && busy}>
        {tab === 'citations' ? visibleItems.length ? visibleItems.map(item => <label className="academic-result" key={item.key}>
          <input type="checkbox" checked={selected.has(item.key)} onChange={() => toggle(item)}/><span className="academic-result-body"><span className="academic-result-title">{item.title || item.key}</span><span className="academic-result-meta"><span>{item.authors}</span><span>{item.year}</span><code>{item.key}</code>{!items.some(result => result.key === item.key) && <span>{t('缓存', 'Cached')}</span>}</span></span>
        </label>) : <p className="academic-empty">{busy ? t('正在检索文献…', 'Searching references…') : offline ? t('没有匹配的缓存文献。打开 Zotero 后刷新。', 'No matching cached references. Open Zotero, then refresh.') : t('没有匹配的文献', 'No matching references')}</p> : filteredEquations.length ? filteredEquations.map((equation, index) => <label className="academic-result" key={`${equation.from}:${index}`}>
          <input type="radio" name="academic-equation" disabled={!equation.label || equation.duplicate} checked={Boolean(equation.label) && !equation.duplicate && equationLabel === equation.label} onChange={() => setEquationLabel(equation.label || '')}/><span className="academic-result-body"><span className="academic-result-title">{equation.label || t('未设置标签', 'No label')}{equation.number ? `  (${equation.number})` : ''}{equation.duplicate ? t(' · 标签重复', ' · Duplicate label') : ''}</span><pre className="academic-equation-source">{equation.source}</pre></span>
        </label>) : <p className="academic-empty">{t('没有匹配的公式', 'No matching equations')}</p>}
      </div>
      {tab === 'citations' && selected.size > 0 && <div className="academic-selected"><Check size={13}/><span>{t(`已选 ${selected.size} 条`, `${selected.size} selected`)}</span><span className="academic-selected-list">{[...selected.values()].map(item => item.title || item.key).join(' · ')}</span></div>}
      <footer className="academic-footer"><span className="academic-footer-note">{tab === 'citations' ? t('引用顺序按选择顺序排列。', 'Citation order follows your selection.') : ''}</span><div className="academic-actions"><button type="button" className="academic-command" onClick={onClose}>{t('取消', 'Cancel')}</button><button type="button" className="academic-command primary" disabled={tab === 'citations' ? selected.size === 0 : !validEquationSelection} onClick={insert}><Plus size={14}/>{t('插入', 'Insert')}</button></div></footer>
    </div>
  </dialog>;
}
