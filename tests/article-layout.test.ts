import { describe, expect, it } from 'vitest';
import { articleColumns } from '../src/shared/article-layout';
import { renderMarkdown, renderPaperBlocks } from '../src/shared/markdown';
import { buildExportHtml } from '../src/main/export-service';
import { validatedSettings } from '../src/main/document-service';
import { defaultSettings, type DocumentSession } from '../src/shared/contracts';

describe('article columns', () => {
  it('maps blocks to source and shares complete document numbering, links and Unicode', () => {
    const source = '# Paper 😀\n\nText [link][ref].\n\n- one\n- two\n\n$$\nx^2\n$$\n\n| A | B |\n|---|---|\n|1|2|\n\n$$\ny^2\n$$\n\n[ref]: https://example.com\n';
    const blocks = renderPaperBlocks(source);
    expect(blocks.map(block => block.html).join('')).toBe(renderMarkdown(source));
    expect(blocks.map(block => source.slice(block.from, block.to))).toEqual(['# Paper 😀\n', 'Text [link][ref].\n', '- one\n- two\n\n', '$$\nx^2\n$$\n', '| A | B |\n|---|---|\n|1|2|\n', '$$\ny^2\n$$\n']);
    expect(blocks.at(-1)!.html).toContain('(2)');
    const block = blocks[1];
    const edited = source.slice(0, block.from) + 'Replaced.\n' + source.slice(block.to);
    expect(edited).toContain('[ref]: https://example.com');
    expect(edited).toContain('- one\n- two');
  });
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
      expect(html).toContain('height:297mm');
      expect(html).toContain('data-paper="true"');
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
