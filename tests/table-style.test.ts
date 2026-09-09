import { describe, expect, it } from 'vitest';
import { validatedSettings } from '../src/main/document-service';
import { defaultSettings, type TableStyle } from '../src/shared/contracts';
import { exportCss } from '../src/shared/markdown';

describe('table style preferences', () => {
  it('defaults to the scientific three-line table', () => {
    expect(defaultSettings.tableStyle).toBe('three-line');
    expect(validatedSettings({}).tableStyle).toBe('three-line');
  });

  it('accepts supported styles and rejects unknown values', () => {
    for (const style of ['three-line', 'grid', 'minimal'] as TableStyle[]) {
      expect(validatedSettings({ tableStyle: style }).tableStyle).toBe(style);
    }
    expect(validatedSettings({ tableStyle: 'spreadsheet' }).tableStyle).toBe('three-line');
  });

  it('defines three-line defaults and explicit grid/minimal overrides for exports', () => {
    expect(exportCss).toContain('table{border-collapse:collapse');
    expect(exportCss).toContain('border-top:2px solid currentColor');
    expect(exportCss).toContain('html[data-table-style=grid] table');
    expect(exportCss).toContain('html[data-table-style=minimal] table');
  });
});
