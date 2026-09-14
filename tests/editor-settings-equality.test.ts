import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/shared/contracts';
import { sameEditorSettings } from '../src/renderer/editor-settings-equality';

describe('editor settings updates', () => {
  it('ignores cloned preferences and recent path updates published by Save', () => {
    const next = structuredClone(defaultSettings);
    next.recentFiles = ['C:\\paper.md'];
    next.recentWorkspaces = ['C:\\papers'];
    expect(sameEditorSettings(defaultSettings, next)).toBe(true);
  });

  it('still updates every changed editor preference', () => {
    expect(sameEditorSettings(defaultSettings, { ...defaultSettings, tableStyle: 'grid' })).toBe(false);
    expect(sameEditorSettings(defaultSettings, { ...defaultSettings, mathNumberingPrefix: 'S' })).toBe(false);
    expect(sameEditorSettings(defaultSettings, { ...defaultSettings, fontSize: defaultSettings.fontSize + 1 })).toBe(false);
  });
});
