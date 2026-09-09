import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, ChevronRight, PanelLeft } from 'lucide-react';
import { themeLabels, themeNames, type Settings } from '../shared/contracts';
import './chrome.css';

interface Props { zh: boolean; title: string; settings: Settings; hasDocument: boolean; sourceMode: boolean; focus: boolean; typewriter: boolean; canBack: boolean; canForward: boolean; command(name: string): void; update(patch: Partial<Settings>): void }
interface Item { label: string; command?: string; shortcut?: string; checked?: boolean; disabled?: boolean; action?: () => void; children?: Item[] }

/** Keep scrollable menus outside each other's clipping containers. */
function useMenuPosition(popup: RefObject<HTMLDivElement | null>, anchor: HTMLElement | null, nested: boolean) {
  useLayoutEffect(() => {
    const element = popup.current;
    if (!element || !anchor) return;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const size = element.getBoundingClientRect();
      const margin = 6;
      let left = nested ? rect.right - 2 : rect.left;
      if (nested && left + size.width > innerWidth - margin) left = rect.left - size.width + 2;
      left = Math.max(margin, Math.min(left, innerWidth - size.width - margin));
      const top = Math.max(36, Math.min(nested ? rect.top - 5 : rect.bottom, innerHeight - size.height - margin));
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [popup, anchor, nested]);
}

export default function TopBar(p: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [submenuIndex, setSubmenuIndex] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const rootPopup = useRef<HTMLDivElement>(null);
  const submenuPopup = useRef<HTMLDivElement>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const submenuAnchor = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const t = (cn: string, en: string) => p.zh ? cn : en;
  const item = (cn: string, en: string, command: string, shortcut = '', requiresDoc = true): Item => ({ label: t(cn, en), command, shortcut: p.settings.shortcuts[command] || shortcut, disabled: requiresDoc && !p.hasDocument });
  const separator: Item = { label: '' };
  const menus: Record<string, Item[]> = {
    file: [item('新建', 'New', 'new', 'Ctrl+N', false), item('新建窗口', 'New window', 'newWindow', 'Ctrl+Shift+N', false), item('打开…', 'Open…', 'open', 'Ctrl+O', false), item('打开文件夹…', 'Open folder…', 'workspace', 'Ctrl+Shift+O', false), item('导入…', 'Import…', 'import', '', false), separator, item('保存', 'Save', 'save', 'Ctrl+S'), item('另存为…', 'Save as…', 'saveAs', 'Ctrl+Shift+S'), item('导出…', 'Export…', 'export'), separator, ...p.settings.recentFiles.slice(0, 6).map(path => ({ label: path.split(/[/\\]/).at(-1) || path, action: () => p.command(`openRecent:${path}`) })), ...(p.settings.recentFiles.length ? [separator] : []), item('关闭文稿', 'Close document', 'close', 'Ctrl+W')],
    edit: [item('偏好设置…', 'Preferences…', 'settings', 'Ctrl+,', false), separator, item('撤销', 'Undo', 'undo', 'Ctrl+Z'), item('重做', 'Redo', 'redo', 'Ctrl+Y'), separator, item('剪切', 'Cut', 'cut', 'Ctrl+X'), item('复制', 'Copy', 'copy', 'Ctrl+C'), item('粘贴', 'Paste', 'paste', 'Ctrl+V'), item('全选', 'Select all', 'selectAll', 'Ctrl+A'), separator,
      item('查找…', 'Find…', 'find', 'Ctrl+F'), item('替换…', 'Replace…', 'replace', 'Ctrl+H'), separator,
      { label: t('学术引用', 'Academic references'), disabled: !p.hasDocument, children: [item('插入文献引用…', 'Insert citation…', 'citations', 'Ctrl+Shift+C'), item('插入公式引用…', 'Insert equation reference…', 'equationReferences', 'Ctrl+Shift+R'), item('为当前公式添加标签', 'Label current equation', 'equationLabel'), item('文档编号设置…', 'Document numbering settings…', 'equationNumberingSettings'), item('添加参考文献列表', 'Append bibliography', 'bibliography'), separator, item('刷新文献数据', 'Refresh references', 'refreshReferences')] },
      { label: t('格式', 'Format'), disabled: !p.hasDocument, children: [item('正文', 'Paragraph', 'paragraph'), ...[1, 2, 3, 4, 5, 6].map(n => item(`标题 ${n}`, `Heading ${n}`, `heading${n}`, `Ctrl+${n}`)), item('加粗', 'Bold', 'bold', 'Ctrl+B'), item('斜体', 'Italic', 'italic', 'Ctrl+I'), item('删除线', 'Strikethrough', 'strike'), item('高亮', 'Highlight', 'mark'), item('引用', 'Quote', 'quote'), item('无序列表', 'Bullet list', 'unorderedList'), item('有序列表', 'Numbered list', 'orderedList'), item('任务列表', 'Task list', 'task'), item('链接', 'Link', 'link', 'Ctrl+K'), item('插入图片…', 'Insert images…', 'image'), item('行内代码', 'Inline code', 'code'), item('代码块', 'Code block', 'codeblock'), item('行间公式', 'Display equation', 'math'), item('行内公式', 'Inline equation', 'inlineMath'), item('分隔线', 'Horizontal rule', 'hr')] }],
    view: [ { ...item('侧边栏', 'Sidebar', 'sidebar', '', false) }, { ...item('源代码模式', 'Source code mode', 'mode', 'Ctrl+/'), checked: p.sourceMode }, { ...item('专注模式', 'Focus mode', 'focusMode', 'F8', false), checked: p.focus }, { ...item('打字机模式', 'Typewriter mode', 'typewriter', 'F9', false), checked: p.typewriter }, separator, { label: t('状态栏', 'Status bar'), checked: p.settings.showStatusBar, action: () => p.update({ showStatusBar: !p.settings.showStatusBar }) }, { label: t('格式工具栏', 'Formatting toolbar'), checked: p.settings.showToolbar, action: () => p.update({ showToolbar: !p.settings.showToolbar }) }, separator, item('放大', 'Zoom in', 'zoomIn', 'Ctrl++', false), item('缩小', 'Zoom out', 'zoomOut', 'Ctrl+-', false), item('实际大小', 'Actual size', 'zoomReset', 'Ctrl+0', false) ],
    theme: themeNames.map(theme => ({ label: themeLabels[theme], checked: p.settings.theme === theme, action: () => p.update({ theme, separateDarkTheme: false }) })),
    help: [item('Markdown 指南', 'Markdown guide', 'guide', '', false), item('关于 Markedown', 'About Markedown', 'about', '', false)],
  };
  const names: Record<string, string> = { file: t('文件', 'File'), edit: t('编辑', 'Edit'), view: t('视图', 'View'), theme: t('主题', 'Themes'), help: t('帮助', 'Help') };
  const submenu = open && submenuIndex !== null ? menus[open][submenuIndex] : undefined;
  useMenuPosition(rootPopup, open ? triggers.current[open] : null, false);
  useMenuPosition(submenuPopup, submenu ? submenuAnchor.current : null, true);
  const focusFirst = (nested = false) => requestAnimationFrame(() => (nested ? submenuPopup : rootPopup).current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
  const show = (name: string | null, focus = false) => { setSubmenuIndex(null); setOpen(name); if (focus) focusFirst(); };
  const close = (restoreFocus = true) => { if (restoreFocus && open) triggers.current[open]?.focus(); show(null); };
  const showSubmenu = (index: number, anchor: HTMLButtonElement, focus = false) => { submenuAnchor.current = anchor; setSubmenuIndex(index); if (focus) focusFirst(true); };
  const closeSubmenu = () => { setSubmenuIndex(null); submenuAnchor.current?.focus(); };
  useEffect(() => {
    const down = (event: PointerEvent) => { if (![ref.current, rootPopup.current, submenuPopup.current].some(element => element?.contains(event.target as Node))) show(null); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'F10' || (event.altKey && /^[fevth]$/i.test(event.key))) { event.preventDefault(); const name = ({ f: 'file', e: 'edit', v: 'view', t: 'theme', h: 'help' } as Record<string, string>)[event.key.toLowerCase()] || 'file'; show(name, true); }
      if (event.key === 'Escape' && !event.defaultPrevented) close();
    };
    document.addEventListener('pointerdown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  const navigate = (event: KeyboardEvent<HTMLDivElement>, nested: boolean) => {
    const elements = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = elements.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!nested) setSubmenuIndex(null); elements[(index + (event.key === 'ArrowDown' ? 1 : -1) + elements.length) % elements.length]?.focus(); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); if (!nested) setSubmenuIndex(null); (event.key === 'Home' ? elements[0] : elements.at(-1))?.focus(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (nested) { if (event.key === 'ArrowLeft') closeSubmenu(); }
      else {
        const childIndex = menus[open!].findIndex(entry => entry.children && entry.label === elements[index]?.getAttribute('aria-label'));
        if (event.key === 'ArrowRight' && childIndex !== -1) showSubmenu(childIndex, elements[index], true);
        else { const keys = Object.keys(names); show(keys[(keys.indexOf(open!) + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length], true); }
      }
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); nested ? closeSubmenu() : close(); }
    if (event.key === 'Tab') close(false);
  };
  const renderItems = (entries: Item[], nested = false) => entries.map((entry, index) => entry.label ? <button key={index} aria-label={entry.label} aria-keyshortcuts={entry.shortcut?.replaceAll('Ctrl', 'Control')} role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={entry.checked} aria-haspopup={entry.children ? 'menu' : undefined} aria-expanded={entry.children ? submenuIndex === index : undefined} aria-controls={entry.children && submenuIndex === index ? `${menuId}-submenu` : undefined} disabled={entry.disabled}
    onPointerEnter={event => { if (!nested) entry.children && !entry.disabled ? showSubmenu(index, event.currentTarget) : setSubmenuIndex(null); }}
    onClick={event => { if (entry.children) { showSubmenu(index, event.currentTarget, true); return; } close(); entry.action ? entry.action() : entry.command && p.command(entry.command); }}><span className="menu-check">{entry.checked && <Check size={14} />}</span><span>{entry.label}</span>{entry.shortcut && <kbd>{entry.shortcut}</kbd>}{entry.children && <ChevronRight className="menu-chevron" size={14} />}</button> : <div key={index} role="separator" className="menu-separator" />);
  return <header className={`topbar ${p.settings.windowStyle}`} ref={ref}>
    <button className="chrome-icon" title={t('切换侧栏', 'Toggle sidebar')} aria-label={t('切换侧栏', 'Toggle sidebar')} onClick={() => p.command('sidebar')}><PanelLeft size={15} /></button>
    <button className="chrome-icon" title={t('后退', 'Back')} aria-label={t('后退', 'Back')} disabled={!p.canBack} onClick={() => p.command('back')}><ArrowLeft size={15} /></button>
    <button className="chrome-icon" title={t('前进', 'Forward')} aria-label={t('前进', 'Forward')} disabled={!p.canForward} onClick={() => p.command('forward')}><ArrowRight size={15} /></button>
    <nav className="top-menus" aria-label={t('主菜单', 'Main menu')} role="menubar">{Object.keys(names).map(name => <div className="menu-anchor" key={name}>
      <button ref={element => { triggers.current[name] = element; }} className="menu-trigger" role="menuitem" aria-haspopup="menu" aria-expanded={open === name} aria-controls={open === name ? `${menuId}-menu` : undefined} onClick={() => show(open === name ? null : name)} onPointerEnter={() => { if (open && open !== name) show(name); }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show(name, true); } }}>{names[name]}</button>
    </div>)}</nav><div className="window-title" title={p.title}>{p.title}</div><div className="window-controls-space" />
    {open && createPortal(<div ref={rootPopup} id={`${menuId}-menu`} className={`menu-popup menu-${open}`} role="menu" aria-label={names[open]} onKeyDown={event => navigate(event, false)}>{renderItems(menus[open])}</div>, document.body)}
    {submenu?.children && createPortal(<div ref={submenuPopup} id={`${menuId}-submenu`} className="menu-popup menu-submenu" role="menu" aria-label={submenu.label} onKeyDown={event => navigate(event, true)}>{renderItems(submenu.children, true)}</div>, document.body)}
  </header>;
}
