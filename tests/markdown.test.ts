import { describe, expect, it, vi } from 'vitest';
import { analyzeMarkdown, isSafeLocalImage, renderMarkdown } from '../src/shared/markdown';

describe('Markdown rendering', () => {
  it('renders CommonMark, GFM tables, checked tasks and explicit code highlighting', () => {
    const html = renderMarkdown('# Heading\n\n**bold** *italic* ~~gone~~\n\n- [x] Done\n- [ ] Next\n\n| Name | Value |\n| --- | ---: |\n| One | 1 |\n\n```javascript\nconst n = 1;\n```');
    expect(html).toMatch(/<h1 id="heading"[^>]*>Heading<\/h1>/);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<s>gone</s>');
    expect(html).toContain('<table>');
    expect(html).toContain('disabled checked');
    expect(html).toContain('hljs-keyword');
  });

  it('renders matched safe sup/sub with nested Markdown and preserves escaped markers', () => {
    const html = renderMarkdown('H<sub>2</sub>O x<sup>**two** and <sub>j</sub></sup> ==marked *words*==');
    expect(html).toContain('H<sub>2</sub>O');
    expect(html).toContain('<sup><strong>two</strong> and <sub>j</sub></sup>');
    expect(html).toContain('<mark>marked <em>words</em></mark>');
    expect(renderMarkdown('\\<sup>x</sup>')).not.toContain('<sup>');
    expect(renderMarkdown('<sup>x\\</sup>')).not.toContain('<sup>');
    expect(renderMarkdown('\\==plain==')).not.toContain('<mark>');
    expect(renderMarkdown('- \\[x] escaped')).not.toContain('type="checkbox"');
  });

  it('keeps unbalanced, uppercase, attribute-bearing tags and other HTML literal', () => {
    for (const source of ['<sup>x</sub>', '<SUP>x</SUP>', '<sup class="x">x</sup>', '<sub>x\ny</sub>', '<script>alert(1)</script>', '<img src="x" onerror="alert(1)">']) {
      const html = renderMarkdown(source);
      expect(html).not.toMatch(/<(?:sup|sub|script|img)(?:\s|>)/);
      expect(html).toContain('&lt;');
    }
    expect(renderMarkdown('<sup>`</sup>`</sup>')).toContain('<sup><code>&lt;/sup&gt;</code></sup>');
  });

  it('limits nested extensions without throwing', () => {
    const source = '<sup>'.repeat(80) + 'x' + '</sup>'.repeat(80);
    expect(() => renderMarkdown(source)).not.toThrow();
    expect(renderMarkdown(source)).toContain('&lt;sup&gt;');
  });

  it('renders math consistently and keeps code, currency and escaped dollars literal', () => {
    expect(renderMarkdown('$x^2$')).toContain('class="katex"');
    expect(renderMarkdown('$$\nx^2 + y^2 = 1\n$$')).toContain('class="math-block md-numbered"');
    expect(renderMarkdown('$$x^2$$')).toContain('katex-display');
    expect(renderMarkdown('`$x$` \\$y$')).not.toContain('class="katex"');
    expect(renderMarkdown('$20 and $30')).not.toContain('class="katex"');
    const html = renderMarkdown('$\\href{javascript:alert(1)}{click}$');
    expect(html).not.toMatch(/href="javascript:/);
  });

  it('blocks untrusted active links and remote images by default', () => {
    const resolver = vi.fn(() => 'markedown-image://document/id?src=local');
    const html = renderMarkdown('[bad](javascript:alert(1)) [file](file:///C:/secret.txt)\n\n![remote](https://example.com/a.png) ![network](//example.com/a.png) ![data](data:image/png;base64,YQ==)', { imageURL: resolver });
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/href="(?:javascript|file):/);
    expect(resolver).not.toHaveBeenCalled();
    expect(renderMarkdown('![remote](https://example.com/a.png)', { allowRemoteImages: true })).toContain('src="https://example.com/a.png"');
  });

  it('resolves local images, safely escapes attributes, and accepts trusted embedded image data', () => {
    const html = renderMarkdown('![a"b](assets/a.png)', { imageURL: () => 'data:image/png;base64,YQ==', imageLoading: 'eager' });
    expect(html).toContain('src="data:image/png;base64,YQ=="');
    expect(html).toContain('alt="a&quot;b"');
    expect(html).toContain('loading="eager"');
    const resolver = vi.fn(() => 'markedown-image://local');
    expect(renderMarkdown('![local](file:///C:/images/a.png)', { imageURL: resolver })).toContain('<img');
    expect(resolver).toHaveBeenCalledWith('file:///C:/images/a.png');
    expect(renderMarkdown('![local](file:///C:/images/a.png)')).not.toContain('<img');
    expect(isSafeLocalImage('C:\\images\\a.png')).toBe(true);
    expect(isSafeLocalImage('\\\\host\\share\\a.png')).toBe(false);
    expect(isSafeLocalImage('file://host/share/a.png')).toBe(false);
  });
});

describe('outline and statistics', () => {
  it('uses actual parsed headings, exact source offsets and unique Unicode ids', () => {
    const source = '# A\r\n\r\n# A\r\n# A-2\r\n\r\n## \u4e2d\u6587 **\u6807\u9898**\r\n\r\n```md\r\n# Not a heading\r\n```\r\n\r\nSetext\r\n------\r\n';
    const result = analyzeMarkdown(source);
    expect(result.headings.map(heading => heading.id)).toEqual(['a', 'a-2', 'a-2-2', '\u4e2d\u6587-\u6807\u9898', 'setext']);
    expect(result.headings[3]).toMatchObject({ level: 2, text: '\u4e2d\u6587 \u6807\u9898', offset: source.indexOf('##') });
    expect(result.headings[4].offset).toBe(source.indexOf('Setext'));
    for (const heading of result.headings) expect(renderMarkdown(source)).toContain(`id="${heading.id}"`);
  });

  it('counts Unicode graphemes, words and lines without splitting combined characters', () => {
    const source = 'Hello world\n\u4e2d\u6587 \ud83d\ude00 e\u0301';
    const result = analyzeMarkdown(source);
    expect(result.characters).toBe(18);
    expect(result.words).toBeGreaterThanOrEqual(4);
    expect(result.lines).toBe(2);
    expect(result.readingMinutes).toBe(1);
    expect(analyzeMarkdown('')).toMatchObject({ headings: [], words: 0, characters: 0, lines: 0, readingMinutes: 0 });
  });
});
