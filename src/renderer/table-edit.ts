import MarkdownIt from 'markdown-it';

/** Resolve a rendered Markdown table cell back to its source range. */
export interface TableCellSourceRange { from: number; to: number; value: string }

/** A complete replacement that can be dispatched against the editor document. */
export interface TableSourceEdit { from: number; to: number; insert: string }

export interface TableShape { rows: number; columns: number }

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

function pipePositions(line: string): number[] {
  const result: number[] = [];
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== '|') continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor--) slashes++;
    if (slashes % 2 === 0) result.push(index);
  }
  return result;
}

function cellBounds(line: string, column: number): { from: number; to: number } | null {
  const pipes = pipePositions(line);
  const startBoundary = pipes.length && pipes[0] === 0 ? 0 : -1;
  const endBoundary = pipes.length && pipes[pipes.length - 1] === line.length - 1 ? line.length - 1 : line.length;
  const boundaries = [startBoundary, ...pipes.filter(position => position > 0 && position < line.length - 1), endBoundary];
  const start = boundaries[column] ?? null;
  const end = boundaries[column + 1] ?? null;
  if (start === null || end === null || end <= start) return null;
  const contentStart = start === -1 ? 0 : start + 1;
  const contentEnd = end === line.length ? line.length : end;
  let from = contentStart;
  let to = contentEnd;
  while (from < to && /\s/.test(line[from])) from++;
  while (to > from && /\s/.test(line[to - 1])) to--;
  return { from, to };
}

export function tableCellSourceRange(source: string, tableFrom: number, row: number, column: number): TableCellSourceRange | null {
  if (!Number.isInteger(row) || row < 0 || !Number.isInteger(column) || column < 0) return null;
  const lines = source.split(/\r?\n/);
  const lineIndex = row === 0 ? 0 : row + 1; // Markdown tables have a delimiter line after the header.
  if (lineIndex < 0 || lineIndex >= lines.length) return null;
  let lineStart = 0;
  for (let index = 0; index < lineIndex; index++) lineStart += lines[index].length + (source.slice(lineStart + lines[index].length, lineStart + lines[index].length + 2) === '\r\n' ? 2 : 1);
  const bounds = cellBounds(lines[lineIndex], column);
  if (!bounds) return null;
  // `source` is the table widget's local slice while `tableFrom` is its
  // absolute document offset. Keep value extraction local and only offset
  // the returned positions for the editor transaction.
  return {
    from: tableFrom + lineStart + bounds.from,
    to: tableFrom + lineStart + bounds.to,
    value: source.slice(lineStart + bounds.from, lineStart + bounds.to),
  };
}

function splitLines(source: string): { lines: string[]; newline: string; trailingNewline: boolean } {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(source);
  const lines = source.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  return { lines, newline, trailingNewline };
}

function cellsInLine(line: string): string[] {
  const pipes = pipePositions(line);
  const leading = pipes[0] === 0;
  const trailing = pipes.length > 0 && pipes[pipes.length - 1] === line.length - 1;
  const boundaries = [leading ? 0 : -1, ...pipes.filter(position => position > 0 && position < line.length - 1), trailing ? line.length - 1 : line.length];
  const cells: string[] = [];
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const start = boundaries[index] < 0 ? 0 : boundaries[index] + 1;
    const end = boundaries[index + 1] === line.length ? line.length : boundaries[index + 1];
    cells.push(line.slice(start, end).trim());
  }
  return cells;
}

function formatRow(cells: string[], template: string): string {
  const leading = template.trimStart().startsWith('|');
  const trailing = template.trimEnd().endsWith('|');
  const body = cells.join(' | ');
  return `${leading ? '| ' : ''}${body}${trailing ? ' |' : ''}`;
}

function escapeCell(value: string): string {
  let result = '';
  let backslashes = 0;
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (character === '|') {
      if (backslashes % 2 === 0) result += '\\|';
      else result += character;
      backslashes = 0;
    } else {
      result += character;
      backslashes = character === '\\' ? backslashes + 1 : 0;
    }
  }
  return result;
}

export function tableShape(source: string): TableShape | null {
  const { lines } = splitLines(source);
  if (lines.length < 2) return null;
  const columns = cellsInLine(lines[0]).length;
  if (!columns || !/^\s*\|?\s*:?-{3,}:?/.test(lines[1])) return null;
  const tokens = markdown.parse(source, {});
  if (!tokens.some(token => token.type === 'table_open')) return null;
  return { rows: Math.max(1, lines.length - 2), columns };
}

function tableEdit(source: string, tableFrom: number, lines: string[], newline: string, trailingNewline = false): TableSourceEdit {
  return { from: tableFrom, to: tableFrom + source.length, insert: lines.join(newline) + (trailingNewline ? newline : '') };
}

/** Insert an empty row. `row` is the rendered row index (header is 0); defaults to after. */
export function insertTableRow(source: string, tableFrom: number, row: number, position: 'before' | 'after' = 'after'): TableSourceEdit | null {
  if (!tableShape(source)) return null;
  const { lines, newline, trailingNewline } = splitLines(source);
  if (lines.length < 2 || !Number.isInteger(row) || row < 0 || row >= lines.length - 1) return null;
  const targetLine = row === 0 ? 0 : row + 1;
  const columnCount = Math.max(1, cellsInLine(lines[0]).length, ...lines.slice(2).map(cellsInLine).map(cells => cells.length));
  const empty = formatRow(Array.from({ length: columnCount }, () => ''), lines[0]);
  if (row === 0 && position === 'before') {
    // Preserve existing alignment markers when the original header moves into the body.
    lines.splice(0, 2, empty, lines[1], lines[0]);
  } else {
    const insertAt = row === 0 ? 2 : targetLine + (position === 'after' ? 1 : 0);
    lines.splice(insertAt, 0, empty);
  }
  return tableEdit(source, tableFrom, lines, newline, trailingNewline);
}

/** Delete a rendered row. Deleting the header promotes the first body row. */
export function deleteTableRow(source: string, tableFrom: number, row: number): TableSourceEdit | null {
  if (!tableShape(source)) return null;
  const { lines, newline, trailingNewline } = splitLines(source);
  if (lines.length < 2 || !Number.isInteger(row) || row < 0 || row >= lines.length - 1) return null;
  if (row === 0) {
    if (lines.length <= 2) return tableEdit(source, tableFrom, [], newline, false);
    lines[0] = lines[2];
    lines.splice(2, 1);
  } else {
    lines.splice(row + 1, 1);
  }
  return tableEdit(source, tableFrom, lines, newline, trailingNewline);
}

/** Insert an empty column at `column` (zero based) across header, delimiter and body rows. */
export function insertTableColumn(source: string, tableFrom: number, column: number): TableSourceEdit | null {
  if (!tableShape(source)) return null;
  const { lines, newline, trailingNewline } = splitLines(source);
  if (lines.length < 2 || !Number.isInteger(column) || column < 0) return null;
  const width = Math.max(1, cellsInLine(lines[0]).length);
  if (column > width) return null;
  for (let index = 0; index < lines.length; index++) {
    const cells = cellsInLine(lines[index]);
    const target = index === 1 ? '---' : '';
    while (cells.length < width) cells.push(index === 1 ? '---' : '');
    cells.splice(column, 0, target);
    lines[index] = formatRow(cells, lines[index]);
  }
  return tableEdit(source, tableFrom, lines, newline, trailingNewline);
}

/** Delete a column across all rows; deleting the last column clears the table. */
export function deleteTableColumn(source: string, tableFrom: number, column: number): TableSourceEdit | null {
  if (!tableShape(source)) return null;
  const { lines, newline, trailingNewline } = splitLines(source);
  const width = lines.length >= 1 ? cellsInLine(lines[0]).length : 0;
  if (lines.length < 2 || !Number.isInteger(column) || column < 0 || column >= width) return null;
  if (width <= 1) return tableEdit(source, tableFrom, [], newline, false);
  for (let index = 0; index < lines.length; index++) {
    const cells = cellsInLine(lines[index]);
    while (cells.length < width) cells.push(index === 1 ? '---' : '');
    cells.splice(column, 1);
    lines[index] = formatRow(cells, lines[index]);
  }
  return tableEdit(source, tableFrom, lines, newline, trailingNewline);
}

/** Replace a cell while escaping literal pipes so Markdown structure is preserved. */
export function replaceTableCell(source: string, tableFrom: number, row: number, column: number, value: string): TableSourceEdit | null {
  const range = tableCellSourceRange(source, tableFrom, row, column);
  if (!range) return null;
  return { from: range.from, to: range.to, insert: escapeCell(value) };
}
