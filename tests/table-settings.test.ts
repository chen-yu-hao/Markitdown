import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, tableStyleNames } from '../src/shared/contracts';
import { loadSettings, saveSettings, validatedSettings } from '../src/main/document-service';
import { renderMarkdown } from '../src/shared/markdown';
import { tableCellSourceRange } from '../src/renderer/table-edit';

describe('Markdown table preferences', () => {
  it('defaults to the scientific three-line style and exposes only supported styles', () => {
    expect(defaultSettings.tableStyle).toBe('three-line');
    expect(tableStyleNames).toEqual(['three-line', 'grid', 'minimal']);
    expect(validatedSettings(null).tableStyle).toBe('three-line');
    for (const tableStyle of tableStyleNames) {
      expect(validatedSettings({ tableStyle })).toMatchObject({ tableStyle });
    }
    expect(validatedSettings({ tableStyle: 'borderless' })).toMatchObject({ tableStyle: 'three-line' });
  });

  it('persists a selected table style without dropping unrelated settings', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-table-settings-'));
    try {
      const saved = await saveSettings(directory, { tableStyle: 'minimal', fontSize: 19 });
      expect(saved).toMatchObject({ tableStyle: 'minimal', fontSize: 19 });
      expect(await loadSettings(directory)).toMatchObject({ tableStyle: 'minimal', fontSize: 19 });
      const updated = await saveSettings(directory, { tableStyle: 'grid' });
      expect(updated).toMatchObject({ tableStyle: 'grid', fontSize: 19 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps table semantics and cell contents independent of the selected visual style', () => {
    const source = '| Name | Value |\n| :--- | ---: |\n| **A** | 42 |';
    for (const tableStyle of tableStyleNames) {
      const html = renderMarkdown(source, { settings: { tableStyle } });
      expect(html).toMatch(/<table>[\s\S]*<thead>[\s\S]*<th[^>]*>Name<\/th>[\s\S]*<\/thead>/);
      expect(html).toContain('<strong>A</strong>');
      expect(html).toContain('text-align:right');
    }
  });
});

describe('Markdown table source ranges (extension API)', () => {
  it('maps header and body cells to source spans', () => {
    const source = '| Name | Value |\n| :--- | ---: |\n| Alice | 42 |';
    expect(tableCellSourceRange(source, 0, 0, 0)).toMatchObject({ value: 'Name' });
    expect(tableCellSourceRange(source, 0, 0, 1)).toMatchObject({ value: 'Value' });
    expect(tableCellSourceRange(source, 0, 1, 0)).toMatchObject({ value: 'Alice' });
    expect(tableCellSourceRange(source, 0, 1, 1)).toMatchObject({ value: '42' });
  });

  it('handles omitted outer pipes, escaped pipes, and CRLF offsets', () => {
    const source = 'A | B\r\n--- | ---\r\nleft \\| right | tail';
    const start = source.indexOf('A');
    const range = tableCellSourceRange(source, start, 1, 0);
    expect(range?.value).toBe('left \\| right');
    expect(range && source.slice(range.from, range.to)).toBe('left \\| right');
    const second = tableCellSourceRange(source, start, 1, 1);
    expect(second?.value).toBe('tail');
  });

  it('returns null for rows or columns outside the table', () => {
    const source = '| A | B |\n|---|---|\n| 1 | 2 |';
    expect(tableCellSourceRange(source, 0, -1, 0)).toBeNull();
    expect(tableCellSourceRange(source, 0, 9, 0)).toBeNull();
    expect(tableCellSourceRange(source, 0, 1, 3)).toBeNull();
  });
});
