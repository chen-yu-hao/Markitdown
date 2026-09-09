import { describe, expect, it } from 'vitest';
import { tableCellSourceRange } from '../src/renderer/table-edit';

describe('Markdown table cell editing', () => {
  it('maps header and body cells to trimmed source ranges', () => {
    const source = '| Name | Value |\r\n| --- | ---: |\r\n| One | 1 |';
    const table = tableCellSourceRange(source, 0, 0, 1);
    const body = tableCellSourceRange(source, 0, 1, 0);
    expect(table && source.slice(table.from, table.to)).toBe('Value');
    expect(body && source.slice(body.from, body.to)).toBe('One');
  });

  it('keeps escaped pipes inside a cell', () => {
    const source = '| A | B |\n|---|---|\n| left \\| right | ok |';
    const cell = tableCellSourceRange(source, 0, 1, 0);
    expect(cell && source.slice(cell.from, cell.to)).toBe('left \\| right');
  });

  it('supports tables without outer pipe characters', () => {
    const source = 'A | B\n--- | ---\n1 | 2';
    const cell = tableCellSourceRange(source, 0, 1, 1);
    expect(cell && source.slice(cell.from, cell.to)).toBe('2');
  });
});
