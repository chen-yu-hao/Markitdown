import { describe, expect, it } from 'vitest';
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  replaceTableCell,
  insertTableRow,
  tableCellSourceRange,
} from '../src/renderer/table-edit';

const applyEdit = (source: string, edit: { from: number; to: number; insert: string } | null) =>
  edit ? source.slice(0, edit.from) + edit.insert + source.slice(edit.to) : source;

describe('Markdown table source range helpers', () => {
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

// These source transforms are retained as an extension-facing API. The built-in
// live renderer is read-only; users edit table structure in source mode.
describe('Markdown table source transforms (extension API)', () => {
  const source = '| Name | Value |\n| --- | ---: |\n| One | 1 |\n| Two | 2 |';

  it('inserts rows around body rows while retaining the header delimiter', () => {
    const before = applyEdit(source, insertTableRow(source, 0, 1, 'before'));
    expect(before).toBe('| Name | Value |\n| --- | ---: |\n|  |  |\n| One | 1 |\n| Two | 2 |');
    const after = applyEdit(source, insertTableRow(source, 0, 1, 'after'));
    expect(after).toBe('| Name | Value |\n| --- | ---: |\n| One | 1 |\n|  |  |\n| Two | 2 |');
    for (const result of [before, after]) {
      expect(result.split(/\r?\n/)[1]).toMatch(/^\| --- \| ---: \|$/);
    }
  });

  it('inserts after the header when the header row is selected', () => {
    const result = applyEdit(source, insertTableRow(source, 0, 0, 'after'));
    expect(result).toBe('| Name | Value |\n| --- | ---: |\n|  |  |\n| One | 1 |\n| Two | 2 |');
  });

  it('supports Word-style header insertion and deletion semantics', () => {
    const beforeHeader = applyEdit(source, insertTableRow(source, 0, 0, 'before'));
    expect(beforeHeader).toBe('|  |  |\n| --- | ---: |\n| Name | Value |\n| One | 1 |\n| Two | 2 |');
    const promoted = applyEdit(source, deleteTableRow(source, 0, 0));
    expect(promoted).toBe('| One | 1 |\n| --- | ---: |\n| Two | 2 |');
    const oneBody = '| Name | Value |\n| --- | --- |\n| One | 1 |';
    expect(applyEdit(oneBody, deleteTableRow(oneBody, 0, 1))).toBe('| Name | Value |\n| --- | --- |');
  });

  it('deletes a body row and preserves CRLF line endings', () => {
    const crlf = source.replaceAll('\n', '\r\n');
    const result = applyEdit(crlf, deleteTableRow(crlf, 0, 1));
    expect(result).toBe('| Name | Value |\r\n| --- | ---: |\r\n| Two | 2 |');
    expect(result.replaceAll('\r\n', '')).not.toContain('\n');
    expect(result.match(/\r\n/g)).toHaveLength(2);
  });

  it('inserts and deletes columns across header, delimiter and body', () => {
    const inserted = applyEdit(source, insertTableColumn(source, 0, 1));
    expect(inserted).toBe('| Name |  | Value |\n| --- | --- | ---: |\n| One |  | 1 |\n| Two |  | 2 |');
    const removed = applyEdit(inserted, deleteTableColumn(inserted, 0, 1));
    expect(removed).toBe(source);
    expect(deleteTableColumn(source, 0, 0)).not.toBeNull();
    expect(applyEdit('| Only |\n| --- |\n| value |', deleteTableColumn('| Only |\n| --- |\n| value |', 0, 0))).toBe('');
  });

  it('keeps escaped pipes when inserting a column', () => {
    const markdown = '| A | B \\| C |\n| --- | --- |\n| left \\| right | tail |';
    const result = applyEdit(markdown, insertTableColumn(markdown, 0, 1));
    expect(result).toContain('| left \\| right |  | tail |');
    expect(result.split(/\r?\n/)[1]).toBe('| --- | --- | --- |');
  });

  it('retains inline Markdown formatting in untouched cells', () => {
    const markdown = '| **Bold** | [Link](https://example.com) |\n| --- | --- |\n| `code` | $x^2$ |';
    const result = applyEdit(markdown, insertTableColumn(markdown, 0, 1));
    expect(result).toContain('**Bold**');
    expect(result).toContain('[Link](https://example.com)');
    expect(result).toContain('`code`');
    expect(result).toContain('$x^2$');
  });

  it('returns replacement offsets relative to a table embedded in a document', () => {
    const prefix = '# Heading\n\n';
    const document = prefix + source + '\n\nAfter';
    const edit = insertTableColumn(source, prefix.length, 2);
    expect(edit?.from).toBe(prefix.length);
    expect(edit?.to).toBe(prefix.length + source.length);
    expect(applyEdit(document, edit)).toContain('| Name | Value |  |');
  });

  it('keeps cell values correct when the table widget starts at a nonzero document offset', () => {
    const tableOffset = 42;
    const cell = tableCellSourceRange(source, tableOffset, 1, 0);
    expect(cell?.value).toBe('One');
    expect(cell?.from).toBe(tableOffset + source.indexOf('One'));
  });

  it('escapes literal pipes when replacing a cell', () => {
    const edit = replaceTableCell(source, 10, 1, 0, 'left | right');
    expect(edit?.insert).toBe('left \\| right');
    expect(edit?.from).toBe(10 + source.indexOf('One'));
  });
});
