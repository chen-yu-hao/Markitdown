import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings, validatedSettings } from '../src/main/document-service';
import { renderMarkdown } from '../src/shared/markdown';

describe('document line numbers', () => {
  it('keeps old settings compatible and validates the new boolean preference', () => {
    expect(validatedSettings({ codeLineNumbers: true }).showLineNumbers).toBe(false);
    expect(validatedSettings({ showLineNumbers: 'true' }).showLineNumbers).toBe(false);
    expect(validatedSettings({ showLineNumbers: true, codeLineNumbers: false })).toMatchObject({ showLineNumbers: true, codeLineNumbers: false });
  });

  it('persists independently of code-block numbering and other preferences', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-line-numbers-'));
    try {
      await saveSettings(directory, { showLineNumbers: true, codeLineNumbers: false, theme: 'night' });
      expect(await loadSettings(directory)).toMatchObject({ showLineNumbers: true, codeLineNumbers: false, theme: 'night' });
      await saveSettings(directory, { codeLineNumbers: true });
      expect(await loadSettings(directory)).toMatchObject({ showLineNumbers: true, codeLineNumbers: true });
      await saveSettings(directory, { showLineNumbers: false });
      expect(await loadSettings(directory)).toMatchObject({ showLineNumbers: false, codeLineNumbers: true, theme: 'night' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not add editor line numbers to rendered or exported Markdown', () => {
    const source = '# Paper\n\nParagraph.\n\n```js\nconst a = 1;\n```';
    for (const codeLineNumbers of [false, true]) {
      expect(renderMarkdown(source, { settings: { showLineNumbers: true, codeLineNumbers } }))
        .toBe(renderMarkdown(source, { settings: { showLineNumbers: false, codeLineNumbers } }));
    }
  });
});
