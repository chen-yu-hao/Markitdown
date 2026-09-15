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
  apply(previous: string, next: string, event: string): boolean;
  close?(): void;
  navigate?(side: 'before' | 'after'): void;
}
interface ActiveNode { owner: object; panel: HTMLElement; close(): void; command(name: string): boolean }
let active: ActiveNode | undefined;
export const hasNodeEditor = (owner: object) => active?.owner === owner;
export function closeNodeEditor(owner?: object) { if (!owner || active?.owner === owner) active?.close(); }
export function nodeEditorCommand(name: string) { return active?.command(name) || false; }

function panelFor(target: NodeEditorTarget, type: 'table' | 'math') {
  closeNodeEditor();
  const zh = target.settings.language === 'zh-CN' || target.settings.language === 'system' && document.documentElement.lang.startsWith('zh');
  const t = (cn: string, en: string) => zh ? cn : en;
  const panel = document.createElement('section');
  panel.className = `md-node-editor md-node-${type}`; panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', type === 'table' ? t('表格编辑', 'Table editor') : t('公式编辑', 'Equation editor'));
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
    document.removeEventListener('pointerdown', outside, true);
    if (active?.panel === panel) active = undefined;
    target.close?.();
  };
  const outside = (event: PointerEvent) => {
    if (event.composedPath().includes(panel)) return;
    if (event.composedPath().some(node => node instanceof HTMLElement && (node.matches('.top-menus,.menu-popup') || node.getAttribute('role') === 'menuitem'))) return;
    // Consume a click on the old paper layout; it will be repaginated on close.
    if (hasNodeEditor(target.owner) && event.composedPath().some(node => node instanceof HTMLElement && node.classList.contains('article-preview'))) { event.preventDefault(); event.stopPropagation(); }
    close();
  };
  document.addEventListener('pointerdown', outside, true);
  done.onclick = close;
  active = { owner: target.owner, panel, close, command(name) {
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
    return renderMarkdown(markdown, { settings: target.settings, purpose: 'editor', equationIndex: getEquationIndex(full, target.settings), citations: target.citations, sourceOffset: target.from });
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

export function openTableNode(target: NodeEditorTarget, initialRow = 0, initialColumn = 0, menuPoint?: { x: number; y: number }) {
  const shape = tableShape(target.source); if (!shape || target.source.length > 512 * 1024) return false;
  const ui = panelFor(target, 'table');
  let row = Math.min(initialRow, shape.rows - 1), column = Math.min(initialColumn, shape.columns - 1), selection: 'cell' | 'row' | 'column' = 'cell';
  const tools = document.createElement('div'); tools.className = 'node-table-tools';
  const viewport = document.createElement('div'); viewport.className = 'node-table-viewport';
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
    const rendered = document.createElement('div'); rendered.innerHTML = ui.render(ui.source());
    const renderedRows = rendered.querySelector('table')?.rows;
    const tbody = table.createTBody();
    for (let r = start; r < end; r++) {
      const tr = tbody.insertRow(), handle = tr.insertCell(); handle.className = 'node-row-handle';
      ui.button(handle, `选择第 ${r + 1} 行`, `Select row ${r + 1}`, () => { row = r; selection = 'row'; draw(); }, r === 0 ? 'H' : String(r));
      for (let c = 0; c < shape.columns; c++) {
        const td = tr.insertCell(); td.dataset.row = String(r); td.dataset.column = String(c); td.tabIndex = 0;
        td.setAttribute('aria-label', `${columnName(c)}${r + 1}`);
        td.innerHTML = renderedRows?.[r]?.cells[c]?.innerHTML || '';
        td.style.textAlign = renderedRows?.[r]?.cells[c]?.style.textAlign || '';
        if (r === 0) td.classList.add('node-table-header');
        const selected = selection === 'row' ? row === r : selection === 'column' ? column === c : row === r && column === c;
        td.classList.toggle('node-selected', selected); td.setAttribute('aria-selected', String(selected));
        td.onclick = () => { if (field?.parentElement === td) return; row = r; column = c; selection = 'cell'; draw(); editCell(); };
        td.onkeydown = event => { if (['Enter', 'F2'].includes(event.key)) { event.preventDefault(); row = r; column = c; selection = 'cell'; editCell(); } };
        td.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); row = r; column = c; draw(); showMenu(event.clientX, event.clientY); };
      }
    }
    viewport.replaceChildren(table); ui.message(ui.t(`第 ${start + 1}–${end} 行 / 共 ${cells.length} 行 · Tab 切换单元格 · Shift+Enter 单元格内换行`, `Rows ${start + 1}–${end} of ${cells.length} · Tab to next cell · Shift+Enter for line break`));
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
    if (cellRect.bottom > scrollRect.bottom) viewport.scrollTop += cellRect.bottom - scrollRect.bottom + 4;
    if (cellRect.top < scrollRect.top) viewport.scrollTop -= scrollRect.top - cellRect.top + 4;
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
