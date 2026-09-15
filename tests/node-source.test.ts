import { describe, expect, it } from 'vitest';
import { alignTableColumn, pasteTableCells, replaceTableCell, resizeTable, tableCells, tableShape } from '../src/renderer/table-edit';
import { mathNodeParts } from '../src/renderer/math-node-source';
import { renderMarkdown } from '../src/shared/markdown';
const apply = (source: string, edit: {from: number; to: number; insert: string} | null) => edit ? source.slice(0, edit.from) + edit.insert + source.slice(edit.to) : source;
describe('editable table nodes', () => {
  const source = '| **Sample** | $E$ |\r\n| --- | ---: |\r\n| 中文 | 1 |\r\n| C | 2 |\r\n';
  it('counts the header and preserves inline Markdown, CRLF and alignment on resize', () => {
    expect(tableShape(source)).toEqual({rows: 3, columns: 2});
    const next = apply(source, resizeTable(source, 4, 3));
    expect(tableCells(next).slice(0, 3)).toEqual([['**Sample**', '$E$', ''], ['中文', '1', ''], ['C', '2', '']]);
    expect(next).toContain('| --- | ---: | --- |\r\n');
    expect(next.replaceAll('\r\n', '')).not.toContain('\n');
    expect(tableShape(apply(next, resizeTable(next, 2, 1)))).toEqual({rows: 2, columns: 1});
  });
  it('expands spreadsheet paste and escapes pipes without corrupting row structure', () => {
    const next = apply(source, pasteTableCells(source, 2, 1, 'A|B\t😀\r\n3\t4\r\n'));
    expect(tableShape(next)).toEqual({rows: 4, columns: 3});
    expect(tableCells(next).slice(2)).toEqual([['C', 'A\\|B', '😀'], ['', '3', '4']]);
  });
  it('supports missing cells, outer whitespace, line breaks and Markdown column alignment', () => {
    const short = '  | A | B |  \n  | --- | --- |  \n  | value |  ';
    const next = apply(short, replaceTableCell(short, 0, 1, 1, 'first\nsecond'));
    expect(tableCells(next)[1]).toEqual(['value', 'first<br>second']);
    expect(apply(source, alignTableColumn(source, 0, 'center'))).toContain('| :---: | ---: |');
    expect(resizeTable(source, 500000, 8)).toBeNull();
  });
});
describe('formula node source roundtrip', () => {
  it('maps unlabelled inline formulas in the editor without adding controls to exports', () => {
    const source = 'Before $x+y$ after.';
    expect(renderMarkdown(source, {purpose:'editor'})).toContain('data-equation-from="7"');
    expect(renderMarkdown(source, {purpose:'export'})).not.toContain('md-equation-inline');
  });
  it.each(['$$\nE=mc^2 \\label{eq:e}\n$$ {#energy}\n', '$x^2$ {#inline}', '\\(x + y\\)', '\\[\nx+y\n\\]', '```math\nx^2\n```\n', '$$\n\n$$'])('retains delimiters and external labels: %s', source => {
    const parts = mathNodeParts(source)!;
    expect(parts).not.toBeNull();
    expect(parts.prefix + parts.tex + parts.suffix).toBe(source);
    const changed = parts.prefix + 'z' + parts.suffix;
    expect(mathNodeParts(changed)?.tex).toBe('z');
  });
  it('rejects plain text', () => expect(mathNodeParts('not a formula')).toBeNull());
});
