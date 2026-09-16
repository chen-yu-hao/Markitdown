import { getEquationIndex, renderMarkdown, type EquationIndex } from '../shared/markdown';
import type { Settings } from '../shared/contracts';
import type { CitationRenderData } from '../shared/academic-contracts';
import { alignTableColumn, deleteTableColumn, deleteTableRow, insertTableColumn, insertTableRow, pasteTableCells, replaceTableCell, resizeTable, tableCells, tableShape, type TableSourceEdit } from './table-edit';
import { mathNodeParts } from './math-node-source';
import './node-editors.css';

export interface NodeEditorTarget {
  owner: object;
  source: string;
  documentSource: string;
  from: number;
  anchor: HTMLElement;
  settings: Settings;
  equations?: EquationIndex;
  citations?: CitationRenderData;
  imageURL?: (destination: string) => string;
  open?(): void;
  apply(previous: string, next: string, event: string): boolean;
  close?(): void;
  navigate?(side: 'before' | 'after'): void;
}
interface ActiveNode { owner: object; panel: HTMLElement; close(): void; command(name: string): boolean }
let active: ActiveNode | undefined;
export const hasNodeEditor = (owner: object) => active?.owner === owner;
export function closeNodeEditor(owner?: object) { if (!owner || active?.owner === owner) active?.close(); }
export function nodeEditorCommand(name: string) { return active?.command(name) || false; }

/** Share lifecycle and menu routing with editors mounted inside document nodes. */
export function registerInlineNodeEditor(owner: object, surface: HTMLElement, close: () => void, command: (name: string) => boolean) {
  closeNodeEditor();
  const entry = { owner, panel: surface, close, command };
  active = entry;
  return () => { if (active === entry) active = undefined; };
}

export function panelFor(target: NodeEditorTarget, type: 'table' | 'math' | 'element', label?: [string, string]) {
  closeNodeEditor();
  target.open?.();
  const zh = target.settings.language === 'zh-CN' || target.settings.language === 'system' && document.documentElement.lang.startsWith('zh');
  const t = (cn: string, en: string) => zh ? cn : en;
  const panel = document.createElement('section');
  panel.className = `md-node-editor md-node-${type}`; panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', label ? t(...label) : type === 'table' ? t('表格编辑', 'Table editor') : t('公式编辑', 'Equation editor'));
  panel.dataset.tableStyle = target.settings.tableStyle;
  panel.innerHTML = `<header><strong></strong><button type="button" class="node-done"></button></header><div class="node-body"></div><div class="node-message" role="status"></div>`;
  panel.querySelector('strong')!.textContent = panel.getAttribute('aria-label');
  const done = panel.querySelector<HTMLButtonElement>('.node-done')!;
  done.textContent = t('完成', 'Done'); done.setAttribute('aria-label', t('完成节点编辑', 'Finish node editing'));
  const initialRect = target.anchor.getBoundingClientRect();
  document.body.append(panel);
  panel.style.left = `${Math.max(12, Math.min(innerWidth - panel.offsetWidth - 12, initialRect.left))}px`;
  panel.style.top = `${Math.max(60, Math.min(innerHeight - panel.offsetHeight - 16, initialRect.top))}px`;
  let closed = false, first = true, source = target.source, lastInput: HTMLTextAreaElement | undefined;
  panel.addEventListener('focusin', event => { if (event.target instanceof HTMLTextAreaElement) lastInput = event.target; });
  const close = () => {
    if (closed) return; closed = true; panel.remove();
    sizeObserver.disconnect(); window.removeEventListener('resize', fit);
    document.removeEventListener('pointerdown', outside, true);
    if (active?.panel === panel) active = undefined;
    target.close?.();
  };
  const fit = () => {
    panel.style.left = `${Math.max(12, Math.min(innerWidth - panel.offsetWidth - 12, parseFloat(panel.style.left) || 12))}px`;
    panel.style.top = `${Math.max(48, Math.min(innerHeight - panel.offsetHeight - 12, parseFloat(panel.style.top) || 48))}px`;
  };
  const sizeObserver = new ResizeObserver(fit); sizeObserver.observe(panel); window.addEventListener('resize', fit);
  const outside = (event: PointerEvent) => {
    if (event.composedPath().includes(panel)) return;
    if (event.composedPath().some(node => node instanceof HTMLElement && node.matches('.md-image-viewer'))) return;
    if (event.composedPath().some(node => node instanceof HTMLElement && (node.matches('.top-menus,.menu-popup') || node.getAttribute('role') === 'menuitem'))) return;
    // Consume a click on the old paper layout; it will be repaginated on close.
    if (hasNodeEditor(target.owner) && event.composedPath().some(node => node instanceof HTMLElement && node.classList.contains('article-preview'))) { event.preventDefault(); event.stopPropagation(); }
    close();
  };
  document.addEventListener('pointerdown', outside, true);
  done.onclick = close;
  active = { owner: target.owner, panel, close, command(name) {
    if (type === 'table' && ['zoomIn', 'zoomOut', 'zoomReset'].includes(name)) {
      panel.dispatchEvent(new CustomEvent('nodezoom', { detail: name })); return true;
    }
    if (['copy', 'paste', 'cut', 'selectAll'].includes(name)) {
      const input = lastInput?.isConnected ? lastInput : undefined;
      if (!input) return false;
      input.focus({ preventScroll: true });
      if (name === 'selectAll') input.select(); else void window.markedown.editCommand(name as 'copy' | 'cut' | 'paste');
      return true;
    }
    const wrappers: Record<string, [string, string]> = { bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'], mark: ['==', '=='], code: ['`', '`'], inlineMath: ['$', '$'], sup: ['<sup>', '</sup>'], sub: ['<sub>', '</sub>'], link: ['[', '](https://)'] };
    if (type === 'table' && wrappers[name] && lastInput?.isConnected) {
      const input = lastInput, [left, right] = wrappers[name], from = input.selectionStart, to = input.selectionEnd;
      input.setRangeText(left + input.value.slice(from, to) + right, from, to, 'select');
      input.dispatchEvent(new Event('input', { bubbles: true })); input.focus({ preventScroll: true }); return true;
    }
    if (wrappers[name] || /^(heading[1-6]|paragraph|quote|orderedList|unorderedList|task|hr|math|codeblock|image)$/.test(name)) {
      panel.querySelector('.node-message')!.textContent = t('请先完成节点编辑，再执行此格式操作。', 'Finish editing this node before applying this format.'); return true;
    }
    return false;
  } };
  panel.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && ['b', 'i'].includes(event.key.toLowerCase())) {
      event.preventDefault(); active?.command(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
    }
  });
  const change = (next: string, atomic = false) => {
    if (next === source) return true;
    const previous = source; source = next;
    if (!target.apply(previous, next, atomic ? 'input.node.commit' : first ? 'input.node.start' : 'input.type')) {
      source = previous; panel.querySelector('.node-message')!.textContent = t('文稿已发生其他修改，请关闭后重新打开此节点。', 'The document changed elsewhere. Close and reopen this node.');
      panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input,textarea,button:not(.node-done)').forEach(el => el.disabled = true);
      return false;
    }
    first = false; return true;
  };
  const render = (markdown: string) => {
    const full = target.documentSource.slice(0, target.from) + markdown + target.documentSource.slice(target.from + target.source.length);
    return renderMarkdown(markdown, { settings: target.settings, purpose: 'editor', imageURL: target.imageURL, equationIndex: type === 'math' ? getEquationIndex(full, target.settings) : target.equations, citations: target.citations, sourceOffset: target.from });
  };
  const body = panel.querySelector<HTMLElement>('.node-body')!;
  const button = (parent: HTMLElement, cn: string, en: string, action: () => void, text?: string) => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = text || t(cn, en); el.title = t(cn, en); el.setAttribute('aria-label', t(cn, en));
    el.onmousedown = event => event.preventDefault(); el.onclick = action; parent.append(el); return el;
  };
  return { panel, body, t, close, change, render, button, startEdit: () => { first = true; }, source: () => source, message: (text: string) => { panel.querySelector('.node-message')!.textContent = text; } };
}

export function openMathNode(target: NodeEditorTarget, block: boolean) {
  const parts = mathNodeParts(target.source); if (!parts) return false;
  const ui = panelFor(target, 'math');
  const input = document.createElement('textarea'); input.className = 'node-math-input'; input.spellcheck = false;
  input.rows = block ? 4 : 2; input.value = parts.tex; input.setAttribute('aria-label', 'LaTeX');
  const preview = document.createElement('div'); preview.className = 'node-math-preview md-rendered'; preview.setAttribute('aria-label', ui.t('公式预览', 'Equation preview'));
  ui.body.append(input, preview);
  const update = () => { const next = parts.prefix + input.value + parts.suffix; if (ui.change(next)) preview.innerHTML = ui.render(next); };
  input.oninput = update; preview.innerHTML = ui.render(target.source);
  ui.message(ui.t(block ? '实时预览 · Ctrl+Enter 完成 · Esc 撤销本次修改' : '实时预览 · Enter 完成 · Esc 撤销本次修改', block ? 'Live preview · Ctrl+Enter to finish · Esc to cancel this edit' : 'Live preview · Enter to finish · Esc to cancel this edit'));
  input.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); ui.change(target.source, true); ui.close(); return; }
    if (event.key === 'Enter' && (!block || event.ctrlKey || event.metaKey)) { event.preventDefault(); ui.close(); target.navigate?.(event.shiftKey ? 'before' : 'after'); return; }
    if (event.shiftKey || input.selectionStart !== input.selectionEnd) return;
    const before = block ? event.key === 'ArrowUp' && !input.value.slice(0, input.selectionStart).includes('\n') : event.key === 'ArrowLeft' && input.selectionStart === 0;
    const after = block ? event.key === 'ArrowDown' && !input.value.slice(input.selectionEnd).includes('\n') : event.key === 'ArrowRight' && input.selectionEnd === input.value.length;
    if (before || after) { event.preventDefault(); ui.close(); target.navigate?.(before ? 'before' : 'after'); }
  };
  input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

export function openInlineTable(target: NodeEditorTarget, table: HTMLTableElement, initialRow = 0, initialColumn = 0): boolean {
  const shape = tableShape(target.source);
  if (!shape || !table.isConnected || target.source.length > 512 * 1024) return false;
  table.classList.add('md-inline-table-editing');
  const host = table.parentElement || table, toolbar = document.createElement('div');
  toolbar.className = 'md-inline-table-toolbar'; toolbar.setAttribute('role', 'toolbar');
  const label = (cn: string, en: string) => target.settings.language === 'zh-CN' || target.settings.language === 'system' && document.documentElement.lang.startsWith('zh') ? cn : en;
  const button = (cn: string, en: string, action: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label(cn, en); b.title = label(cn, en); b.onclick = action; b.onmousedown = e => e.preventDefault(); toolbar.append(b); return b; };
  host.insertBefore(toolbar, table);
  let source = target.source, row = Math.max(0, Math.min(initialRow, shape.rows - 1)), column = Math.max(0, Math.min(initialColumn, shape.columns - 1));
  let unregister: (() => void) | undefined;
  const close = () => { toolbar.remove(); table.classList.remove('md-inline-table-editing'); unregister?.(); unregister = undefined; target.close?.(); };
  const apply = (next: string, event = 'input.node.inline') => { if (next === source) return true; const previous = source; if (!target.apply(previous, next, event)) return false; source = next; return true; };
  const replaceCell = (cell: HTMLTableCellElement) => { const edit = replaceTableCell(source, 0, row, column, cell.textContent || ''); if (!edit) return; const next = source.slice(0, edit.from) + edit.insert + source.slice(edit.to); apply(next); };
  const op = (fn: () => TableSourceEdit | null) => { const edit = fn(); if (edit) { const changed = apply(edit.from === 0 && edit.to === source.length ? edit.insert : source.slice(0, edit.from) + edit.insert + source.slice(edit.to), 'input.node.commit'); if (changed) close(); } };
  button('上方插入行', 'Insert row above', () => op(() => insertTableRow(source, 0, row, 'before')));
  button('下方插入行', 'Insert row below', () => op(() => insertTableRow(source, 0, row, 'after')));
  button('左侧插入列', 'Insert column left', () => op(() => insertTableColumn(source, 0, column)));
  button('右侧插入列', 'Insert column right', () => op(() => insertTableColumn(source, 0, column + 1)));
  button('删除行', 'Delete row', () => op(() => deleteTableRow(source, 0, row)));
  button('删除列', 'Delete column', () => op(() => deleteTableColumn(source, 0, column)));
  for (const [cn, en, align] of [['左对齐','Align left','left'],['居中','Align center','center'],['右对齐','Align right','right']] as const) button(cn, en, () => op(() => alignTableColumn(source, column, align)));
  button('完成', 'Done', close);
  const cells = [...table.querySelectorAll<HTMLTableCellElement>('th,td')];
  let focusedCell: HTMLTableCellElement | undefined;
  unregister = registerInlineNodeEditor(target.owner, host, close, name => {
    if (!['copy', 'cut', 'paste', 'selectAll'].includes(name) || !focusedCell) return false;
    focusedCell.focus({ preventScroll: true });
    if (name === 'selectAll') document.execCommand('selectAll');
    else void window.markedown.editCommand(name as 'copy' | 'cut' | 'paste');
    return true;
  });
  // Registering first closes any previous node editor. Enable the new editor
  // afterwards so a stale close callback cannot turn this view read-only.
  target.open?.();
  cells.forEach((cell, index) => {
    const tr = cell.parentElement as HTMLTableRowElement, r = tr.rowIndex, c = cell.cellIndex;
    cell.dataset.sourceRow = String(r); cell.dataset.sourceColumn = String(c); cell.tabIndex = 0;
    cell.addEventListener('click', event => { event.stopPropagation(); focusedCell = cell; row = r; column = c; cells.forEach(x => x.classList.remove('md-inline-cell-selected')); cell.classList.add('md-inline-cell-selected'); if (cell.contentEditable !== 'true') { cell.contentEditable = 'true'; cell.classList.add('md-inline-cell-input'); cell.focus(); } });
    cell.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); focusedCell = cell; row = r; column = c; cell.contentEditable = 'true'; cell.classList.add('md-inline-cell-input'); cell.focus(); document.execCommand('selectAll'); });
    cell.addEventListener('input', () => replaceCell(cell));
    cell.addEventListener('blur', () => { cell.contentEditable = 'false'; cell.classList.remove('md-inline-cell-input'); });
    cell.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); cell.blur(); } if (event.key === 'Tab') { event.preventDefault(); const next = cells[index + (event.shiftKey ? -1 : 1)]; if (next) next.focus(); } if (event.key === 'Escape') { event.preventDefault(); cell.blur(); } });
  });
  cells.find(cell => Number(cell.dataset.sourceRow) === row && Number(cell.dataset.sourceColumn) === column)?.classList.add('md-inline-cell-selected');
  return true;
}
export function openTableNode(target: NodeEditorTarget, initialRow = 0, initialColumn = 0, menuPoint?: { x: number; y: number }) {
  const shape = tableShape(target.source); if (!shape || target.source.length > 512 * 1024) return false;
  const ui = panelFor(target, 'table');
  const sizing = document.createElement('div'); sizing.className = 'node-table-sizing'; ui.panel.querySelector('header')!.after(sizing);
  const zoom = document.createElement('input'); zoom.type = 'range'; zoom.min = '50'; zoom.max = '200'; zoom.step = '10'; zoom.value = '100'; zoom.setAttribute('aria-label', ui.t('表格缩放', 'Table zoom'));
  const zoomLabel = document.createElement('output');
  sizing.append(zoom, zoomLabel);
  const setZoom = (value: number) => { zoom.value = String(Math.max(50, Math.min(200, value))); viewport.style.zoom = String(Number(zoom.value) / 100); zoomLabel.textContent = `${zoom.value}%`; };
  ui.button(sizing, '重置缩放', 'Reset table zoom', () => setZoom(100), '100%');
  let savedRect: DOMRect | undefined;
  ui.button(sizing, '最大化或还原', 'Maximize or restore', () => {
    if (!savedRect) { savedRect = ui.panel.getBoundingClientRect(); Object.assign(ui.panel.style, { left: '12px', top: '48px', width: 'calc(100vw - 24px)', height: 'calc(100vh - 60px)' }); }
    else { Object.assign(ui.panel.style, { left: `${savedRect.left}px`, top: `${savedRect.top}px`, width: `${savedRect.width}px`, height: `${savedRect.height}px` }); savedRect = undefined; }
  });
  const header = ui.panel.querySelector('header')!;
  header.onpointerdown = event => {
    if ((event.target as Element).closest('button') || event.button) return;
    const rect = ui.panel.getBoundingClientRect(), x = event.clientX, y = event.clientY; header.setPointerCapture(event.pointerId);
    header.onpointermove = move => { ui.panel.style.left = `${Math.max(12, Math.min(innerWidth - ui.panel.offsetWidth - 12, rect.left + move.clientX - x))}px`; ui.panel.style.top = `${Math.max(48, Math.min(innerHeight - ui.panel.offsetHeight - 12, rect.top + move.clientY - y))}px`; };
    header.onpointerup = () => { header.onpointermove = null; };
  };
  let row = Math.min(initialRow, shape.rows - 1), column = Math.min(initialColumn, shape.columns - 1), selection: 'cell' | 'row' | 'column' = 'cell';
  const tools = document.createElement('div'); tools.className = 'node-table-tools';
  const viewport = document.createElement('div'); viewport.className = 'node-table-viewport';
  zoom.oninput = () => setZoom(Number(zoom.value)); setZoom(100);
  ui.panel.addEventListener('nodezoom', event => setZoom((event as CustomEvent).detail === 'zoomReset' ? 100 : Number(zoom.value) + ((event as CustomEvent).detail === 'zoomIn' ? 10 : -10)));
  viewport.addEventListener('wheel', event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.stopPropagation(); setZoom(Number(zoom.value) + (event.deltaY < 0 ? 10 : -10)); } }, { passive: false });
  const footer = document.createElement('div'); footer.className = 'node-table-tools';
  ui.body.append(tools, viewport, footer);
  let field: HTMLTextAreaElement | undefined, originalCell = '', originalTable = '';
  const apply = (edit: TableSourceEdit | null) => {
    if (!edit) return false;
    const source = ui.source(), next = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
    if (!ui.change(next, true)) return false;
    if (!next) { ui.close(); return true; }
    const nextShape = tableShape(next)!; row = Math.min(row, nextShape.rows - 1); column = Math.min(column, nextShape.columns - 1); draw(); return true;
  };
  const operations: Array<[string, string, () => void]> = [
    ['上方插入行', 'Insert row above', () => { if (apply(insertTableRow(ui.source(), 0, row, 'before'))) editCell(); }],
    ['下方插入行', 'Insert row below', () => { const at = row + 1; if (apply(insertTableRow(ui.source(), 0, row, 'after'))) { row = at; draw(); editCell(); } }],
    ['左侧插入列', 'Insert column left', () => { if (apply(insertTableColumn(ui.source(), 0, column))) editCell(); }],
    ['右侧插入列', 'Insert column right', () => { const at = column + 1; if (apply(insertTableColumn(ui.source(), 0, at))) { column = at; draw(); editCell(); } }],
    ['删除行', 'Delete row', () => { apply(deleteTableRow(ui.source(), 0, row)); }],
    ['删除列', 'Delete column', () => { apply(deleteTableColumn(ui.source(), 0, column)); }],
  ];
  for (const [cn, en, action] of operations) ui.button(tools, cn, en, action);
  for (const [align, cn, en] of [['left', '列左对齐', 'Align column left'], ['center', '列居中', 'Align column center'], ['right', '列右对齐', 'Align column right']] as const) ui.button(tools, cn, en, () => { apply(alignTableColumn(ui.source(), column, align)); });
  ui.button(tools, '删除表格', 'Delete table', () => { ui.change('', true); ui.close(); });
  const rowsInput = document.createElement('input'), colsInput = document.createElement('input');
  for (const [input, label, maximum] of [[rowsInput, ui.t('行数（含表头）', 'Rows (including header)'), 2000], [colsInput, ui.t('列数', 'Columns'), 100]] as const) {
    input.type = 'number'; input.min = '1'; input.max = String(maximum); input.setAttribute('aria-label', label);
    const wrapper = document.createElement('label'); wrapper.textContent = label; wrapper.append(input); footer.append(wrapper);
  }
  ui.button(footer, '调整尺寸', 'Resize table', () => { if (!apply(resizeTable(ui.source(), Number(rowsInput.value), Number(colsInput.value)))) ui.message(ui.t('尺寸超出限制：最多 2000 行、100 列、20000 个单元格。', 'Size limit: 2,000 rows, 100 columns, 20,000 cells.')); });
  ui.button(footer, '上一组行', 'Previous rows', () => { row = Math.max(0, row - 50); draw(); });
  ui.button(footer, '下一组行', 'Next rows', () => { row = Math.min(tableShape(ui.source())!.rows - 1, row + 50); draw(); });
  const columnName = (n: number): string => n < 26 ? String.fromCharCode(65 + n) : columnName(Math.floor(n / 26) - 1) + String.fromCharCode(65 + n % 26);
  function draw() {
    field = undefined; const cells = tableCells(ui.source()), shape = tableShape(ui.source())!;
    rowsInput.value = String(shape.rows); colsInput.value = String(shape.columns);
    const table = document.createElement('table'); table.setAttribute('role', 'grid');
    table.style.minWidth = `${Math.max(360, shape.columns * 110 + 44)}px`;
    const head = table.createTHead().insertRow(); head.insertCell();
    for (let c = 0; c < shape.columns; c++) {
      const cell = head.insertCell(); ui.button(cell, `选择第 ${c + 1} 列`, `Select column ${c + 1}`, () => { column = c; selection = 'column'; draw(); }, columnName(c));
    }
    const start = Math.floor(row / 50) * 50, end = Math.min(shape.rows, start + 50);
    const lines = ui.source().split('\n');
    const rendered = document.createElement('div'); rendered.innerHTML = ui.render([lines[0], lines[1], ...lines.slice(Math.max(2, start + 1), end + 1)].join('\n'));
    const renderedRows = rendered.querySelector('table')?.rows;
    const tbody = table.createTBody();
    for (let r = start; r < end; r++) {
      const tr = tbody.insertRow(), handle = tr.insertCell(); handle.className = 'node-row-handle';
      ui.button(handle, `选择第 ${r + 1} 行`, `Select row ${r + 1}`, () => { row = r; selection = 'row'; draw(); }, r === 0 ? 'H' : String(r));
      for (let c = 0; c < shape.columns; c++) {
        const td = tr.insertCell(); td.dataset.row = String(r); td.dataset.column = String(c); td.tabIndex = 0;
        td.setAttribute('aria-label', `${columnName(c)}${r + 1}`);
        const renderedRow = r === 0 ? 0 : r - Math.max(1, start) + 1;
        td.innerHTML = renderedRows?.[renderedRow]?.cells[c]?.innerHTML || '';
        td.style.textAlign = renderedRows?.[renderedRow]?.cells[c]?.style.textAlign || '';
        if (r === 0) td.classList.add('node-table-header');
        const selected = selection === 'row' ? row === r : selection === 'column' ? column === c : row === r && column === c;
        td.classList.toggle('node-selected', selected); td.setAttribute('aria-selected', String(selected));
        td.onclick = () => { if (field?.parentElement === td) return; row = r; column = c; selection = 'cell'; draw(); editCell(); };
        td.onkeydown = event => { if (['Enter', 'F2'].includes(event.key)) { event.preventDefault(); row = r; column = c; selection = 'cell'; editCell(); } };
        td.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); row = r; column = c; draw(); showMenu(event.clientX, event.clientY); };
      }
    }
    const scroll = { top: viewport.scrollTop, left: viewport.scrollLeft }; viewport.replaceChildren(table); viewport.scrollTop = scroll.top; viewport.scrollLeft = scroll.left;
    ui.message(ui.t(`第 ${start + 1}–${end} 行 / 共 ${cells.length} 行 · Tab 切换单元格 · Shift+Enter 单元格内换行`, `Rows ${start + 1}–${end} of ${cells.length} · Tab to next cell · Shift+Enter for line break`));
  }
  function showMenu(x: number, y: number) {
    ui.panel.querySelector('.node-context-menu')?.remove();
    const menu = document.createElement('div'); menu.className = 'node-context-menu'; menu.setAttribute('role', 'menu');
    for (const [cn, en, action] of operations) { const button = ui.button(menu, cn, en, () => { menu.remove(); action(); }); button.setAttribute('role', 'menuitem'); }
    ui.panel.append(menu); menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 12)}px`; menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 12)}px`;
    menu.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); menu.remove(); } }; menu.querySelector('button')?.focus();
  }
  function editCell() {
    const td = viewport.querySelector<HTMLElement>(`td[data-row="${row}"][data-column="${column}"]`); if (!td) return;
    ui.startEdit(); originalTable = ui.source(); originalCell = tableCells(ui.source())[row][column];
    field = document.createElement('textarea'); field.className = 'node-cell-input'; field.spellcheck = false; field.value = originalCell;
    field.setAttribute('aria-label', ui.t(`单元格 ${columnName(column)}${row + 1}`, `Cell ${columnName(column)}${row + 1}`));
    td.replaceChildren(field); field.focus({ preventScroll: true }); field.select();
    const cellRect = td.getBoundingClientRect(), scrollRect = viewport.getBoundingClientRect();
    const scale = Number(zoom.value) / 100;
    if (cellRect.bottom > scrollRect.bottom) viewport.scrollTop += (cellRect.bottom - scrollRect.bottom + 4) / scale;
    if (cellRect.top < scrollRect.top) viewport.scrollTop -= (scrollRect.top - cellRect.top + 4) / scale;
    if (cellRect.right > scrollRect.right) viewport.scrollLeft += (cellRect.right - scrollRect.right + 4) / scale;
    if (cellRect.left < scrollRect.left) viewport.scrollLeft -= (scrollRect.left - cellRect.left + 4) / scale;
    field.oninput = () => {
      const edit = replaceTableCell(ui.source(), 0, row, column, field!.value);
      if (edit) { const source = ui.source(); ui.change(source.slice(0, edit.from) + edit.insert + source.slice(edit.to)); }
    };
    field.onpaste = event => {
      const text = event.clipboardData?.getData('text/plain');
      if (text?.includes('\t')) { event.preventDefault(); apply(pasteTableCells(ui.source(), row, column, text)); editCell(); }
    };
    field.onkeydown = event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); ui.change(originalTable, true); draw(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); const at = event.shiftKey ? row : row + 1; if (apply(insertTableRow(ui.source(), 0, row, event.shiftKey ? 'before' : 'after'))) { row = Math.max(1, at); draw(); editCell(); } return; }
      if (event.key !== 'Tab' && !(event.key === 'Enter' && !event.shiftKey)) return;
      event.preventDefault(); const shape = tableShape(ui.source())!;
      let next = row * shape.columns + column + (event.key === 'Tab' && event.shiftKey ? -1 : 1);
      if (next < 0) { ui.close(); target.navigate?.('before'); return; }
      if (next >= shape.rows * shape.columns) apply(insertTableRow(ui.source(), 0, shape.rows - 1));
      row = Math.floor(next / shape.columns); column = next % shape.columns; draw(); editCell();
    };
  }
  ui.panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); ui.close(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !(event.target instanceof HTMLTextAreaElement) && selection !== 'cell') {
      event.preventDefault(); const cells = tableCells(ui.source());
      const text = selection === 'row' ? cells[row].join('\t') : cells.map(values => values[column]).join('\n');
      void navigator.clipboard.writeText(text);
    }
  });
  draw(); if (menuPoint) showMenu(menuPoint.x, menuPoint.y); else editCell(); return true;
}
