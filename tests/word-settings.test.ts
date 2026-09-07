import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings } from '../src/shared/contracts';
import { loadSettings, saveSettings, validatedSettings } from '../src/main/document-service';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-word-settings-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('Word style preferences', () => {
  it('migrates existing preferences to black Songti and Times New Roman defaults', async () => {
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ theme: 'night', fontSize: 20, pandocPath: 'C:\\Tools\\pandoc.exe' }));
    const settings = await loadSettings(directory);
    expect(settings).toMatchObject({ theme: 'night', fontSize: 20, pandocPath: 'C:\\Tools\\pandoc.exe', wordChineseFont: '宋体', wordLatinFont: 'Times New Roman', wordTextColor: '#000000', wordBodyFontSize: 12, wordHeadingSizes: [18, 16, 14, 12, 12, 12], wordHeadingBold: true, wordHeadingItalic: false });
  });

  it('persists all Word choices through reload and independent settings updates', async () => {
    const custom = { wordChineseFont: '楷体', wordLatinFont: 'Georgia', wordTextColor: '#123456', wordBodyFontSize: 13.5, wordHeadingSizes: [26, 24, 20, 18, 16, 14], wordHeadingBold: false, wordHeadingItalic: true };
    expect(await saveSettings(directory, custom)).toMatchObject(custom);
    await saveSettings(directory, { theme: 'newsprint' });
    expect(await loadSettings(directory)).toMatchObject({ ...custom, theme: 'newsprint' });
    expect(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'))).toMatchObject(custom);
  });

  it('normalizes case and spacing, retains half-point sizes and bounds unreasonable sizes', () => {
    const settings = validatedSettings({ wordChineseFont: '  宋体  ', wordLatinFont: ' Times New Roman ', wordTextColor: '#abcdef', wordBodyFontSize: 12.6, wordHeadingSizes: [100, -10, 14.24, 14.26, 13.5, 12] });
    expect(settings).toMatchObject({ wordChineseFont: '宋体', wordLatinFont: 'Times New Roman', wordTextColor: '#ABCDEF', wordBodyFontSize: 12.5, wordHeadingSizes: [72, 6, 14, 14.5, 13.5, 12] });
  });

  it.each([
    { wordChineseFont: '', wordLatinFont: 42, wordTextColor: 'red', wordBodyFontSize: '14', wordHeadingSizes: [20, 18], wordHeadingBold: 'false', wordHeadingItalic: 'true' },
    { wordChineseFont: 'bad\nfont', wordLatinFont: 'bad\u0000font', wordTextColor: '#FFF', wordBodyFontSize: Number.NaN, wordHeadingSizes: [20, 18, 16, 14, 12, Number.NaN] },
    { wordChineseFont: 'x'.repeat(101), wordLatinFont: ' ', wordTextColor: '#000000<script>', wordBodyFontSize: Number.POSITIVE_INFINITY, wordHeadingSizes: [20, 18, 16, 14, 12, '10'] },
  ])('restores invalid Word preferences to defaults (%j)', invalid => {
    const settings = validatedSettings(invalid);
    for (const key of ['wordChineseFont', 'wordLatinFont', 'wordTextColor', 'wordBodyFontSize', 'wordHeadingSizes', 'wordHeadingBold', 'wordHeadingItalic'] as const) expect(settings[key]).toEqual(defaultSettings[key]);
  });

  it('isolates heading arrays from the shared defaults and caller input', () => {
    const first = validatedSettings(null);
    first.wordHeadingSizes[0] = 72;
    expect(validatedSettings(null).wordHeadingSizes[0]).toBe(18);
    const input = { wordHeadingSizes: [26, 24, 20, 18, 16, 14] };
    const custom = validatedSettings(input);
    custom.wordHeadingSizes[0] = 72;
    expect(input.wordHeadingSizes[0]).toBe(26);
  });
});
