import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings, validatedSettings } from '../src/main/document-service';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-math-layout-settings-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('equation layout preferences', () => {
  it('defaults to numbering display equations with equations left and numbers right', async () => {
    const expected = { mathNumbering: 'all', mathNumberingStyle: 'document', mathAlignment: 'left', mathNumberPosition: 'right' };
    expect(validatedSettings(null)).toMatchObject(expected);
    expect(await loadSettings(directory)).toMatchObject(expected);
  });

  it.each(['none', 'labelled'] as const)('fills missing layout preferences without replacing saved %s numbering', async mathNumbering => {
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ theme: 'night', mathNumbering, mathNumberingStyle: 'section' }));
    expect(await loadSettings(directory)).toMatchObject({ theme: 'night', mathNumbering, mathNumberingStyle: 'section', mathAlignment: 'left', mathNumberPosition: 'right' });
    await saveSettings(directory, { mathAlignment: 'right', mathNumberPosition: 'left' });
    expect(await loadSettings(directory)).toMatchObject({ mathNumbering, mathNumberingStyle: 'section', mathAlignment: 'right', mathNumberPosition: 'left' });
  });

  it('accepts all independent alignment and number-position combinations', () => {
    for (const mathAlignment of ['left', 'center', 'right'] as const) {
      for (const mathNumberPosition of ['left', 'right'] as const) expect(validatedSettings({ mathAlignment, mathNumberPosition })).toMatchObject({ mathAlignment, mathNumberPosition });
    }
  });

  it('persists layout choices through reload and unrelated settings changes', async () => {
    const layout = { mathAlignment: 'center', mathNumberPosition: 'left', mathNumbering: 'all', mathNumberingStyle: 'section' } as const;
    expect(await saveSettings(directory, layout)).toMatchObject(layout);
    await saveSettings(directory, { fontSize: 20 });
    expect(await loadSettings(directory)).toMatchObject({ ...layout, fontSize: 20 });
    expect(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'))).toMatchObject(layout);
  });

  it('restores malformed layout fields to defaults without replacing valid choices', async () => {
    for (const invalid of [
      { mathAlignment: 'justify', mathNumberPosition: 'center' },
      { mathAlignment: ['right'], mathNumberPosition: ['left'] },
      { mathAlignment: null, mathNumberPosition: true },
      { mathAlignment: 0, mathNumberPosition: { value: 'left' } },
    ]) expect(validatedSettings({ ...invalid, mathNumbering: 'none', mathNumberingStyle: 'section' })).toMatchObject({ mathAlignment: 'left', mathNumberPosition: 'right', mathNumbering: 'none', mathNumberingStyle: 'section' });
    expect(validatedSettings({ mathAlignment: 'right', mathNumberPosition: 'middle' })).toMatchObject({ mathAlignment: 'right', mathNumberPosition: 'right' });
    expect(validatedSettings({ mathAlignment: 'middle', mathNumberPosition: 'left' })).toMatchObject({ mathAlignment: 'left', mathNumberPosition: 'left' });
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ mathAlignment: 'justify', mathNumberPosition: 'center', mathNumbering: 'labelled' }));
    expect(await loadSettings(directory)).toMatchObject({ mathAlignment: 'left', mathNumberPosition: 'right', mathNumbering: 'labelled' });
  });
});
