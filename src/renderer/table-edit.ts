/** Resolve a rendered Markdown table cell back to its source range. */
export interface TableCellSourceRange { from: number; to: number; value: string }

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
  return { from: tableFrom + lineStart + bounds.from, to: tableFrom + lineStart + bounds.to, value: source.slice(tableFrom + lineStart + bounds.from, tableFrom + lineStart + bounds.to) };
}
