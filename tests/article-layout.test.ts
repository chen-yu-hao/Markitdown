import { describe, expect, it } from 'vitest';
import { articleColumns } from '../src/shared/article-layout';
import { renderMarkdown } from '../src/shared/markdown';
import { buildExportHtml } from '../src/main/export-service';
import { validatedSettings } from '../src/main/document-service';
import { defaultSettings, type DocumentSession } from '../src/shared/contracts';

describe('article columns', () => {
  it('splits top-level article sections without breaking nested headings or code', () => {
    const html = renderMarkdown('# Paper\n\nAbstract.\n\n## Results\n\n> ## Nested\n> Quotation\n\n```html\n<h2>literal</h2>\n```\n\n## Methods\n\nEnd.');
    const result = articleColumns(html);
    expect(result.match(/<section class="article-section">/g)).toHaveLength(3);
    expect(result.replaceAll('<section class="article-section">', '').replaceAll('</section>', '').replace(/\s/g, '')).toBe(html.replace(/\s/g, ''));
    expect(result).toContain('<blockquote>');
    expect(result.replace(/<[^>]*>/g, '')).toContain('&lt;h2&gt;literal&lt;/h2&gt;');
  });

  it('preserves backward-compatible settings and rejects unknown layouts', () => {
    expect(validatedSettings({}).readingLayout).toBe('single');
    expect(validatedSettings({ readingLayout: 'double' }).readingLayout).toBe('double');
    expect(validatedSettings({ readingLayout: 'invalid' }).readingLayout).toBe('single');
  });

  it('uses shared columns in styled HTML/PDF/PNG and leaves plain HTML unwrapped', async () => {
    const doc: DocumentSession = { id: 'layout', path: null, title: 'Paper', source: '# Paper\n\nUnsaved abstract.\n\n## Results\n\n$$\nx^2\n$$\n\n| A | B |\n|---|---|\n|1|2|', savedSource: '', dirty: true, recovered: false, bom: false, lineEnding: 'LF', revision: null, mode: 'source', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 1 };
    for (const format of ['html', 'pdf', 'png'] as const) {
      const html = await buildExportHtml(doc, { ...defaultSettings, readingLayout: 'double' }, format);
      expect(html).toContain('class="markdown-body article-columns"');
      expect(html).toContain('column-count:2');
      expect(html).toContain('data-table-style="three-line"');
      expect(html).toContain('Unsaved abstract.');
      expect(html).toContain('md-equation');
    }
    const plain = await buildExportHtml(doc, { ...defaultSettings, readingLayout: 'double' }, 'htmlPlain');
    expect(plain).not.toContain('article-columns');
    const single = await buildExportHtml(doc, defaultSettings);
    expect(single).not.toContain('article-columns');
  });
});
