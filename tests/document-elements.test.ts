import { describe, expect, it } from 'vitest';
import { getElementIndex, analyzeMarkdown, renderMarkdown, renderPaperBlocks } from '../src/shared/markdown';
import { metadataSummary } from '../src/shared/markdown-elements';

describe('document elements', () => {
  it('preserves YAML as metadata and excludes its fields from headings and export', () => {
    const source = '---\ntitle: Title\ntags: [one, two]\n---\n\n# Body';
    expect(renderMarkdown(source)).toContain('md-metadata');
    expect(renderMarkdown(source)).toContain('one, two');
    expect(analyzeMarkdown(source).headings.map(h=>h.text)).toEqual(['Body']);
    expect(renderMarkdown(source,{purpose:'export'})).not.toContain('title:');
    expect(getElementIndex(source).ranges[0]).toMatchObject({ from:0, to:37, kind:'document_metadata' });
    expect(metadataSummary('---\nx: [\n---').warnings.length).toBeGreaterThan(0);
  });
  it('derives live TOC anchors from actual headings including duplicates', () => {
    const source = '# One\n\n<!-- toc -->\nold text\n<!-- /toc -->\n\n## One';
    const html = renderMarkdown(source);
    expect(html).toContain('md-document-toc'); expect(html).not.toContain('old text');
    expect(html).toContain('href="#one-2"');
    const toc = getElementIndex(source).ranges.find(r=>r.kind==='document_toc')!;
    expect(renderMarkdown(source.slice(toc.from,toc.to),{sourceOffset:toc.from,elementContext:getElementIndex(source)})).toContain('href="#one-2"');
  });
  it('renders safe inline/block HTML and local images while keeping unsafe markup literal', () => {
    const source = '<u>under</u> <mark>key</mark> <kbd>Ctrl</kbd>\n\n<p align="center"><img src="assets/测试.png" width="160" alt="test"></p>\n\n<section><strong>Text</strong></section>';
    const paths:string[]=[];const html=renderMarkdown(source,{imageURL:src=>{paths.push(src);return 'markedown-image://local';}});
    expect(html).toContain('<u>under</u>');expect(html).toContain('<kbd>Ctrl</kbd>');expect(html).toContain('width:160px');expect(html).toContain('text-align:center');expect(paths).toEqual(['assets/测试.png']);
    expect(renderMarkdown('<p align="center"><img src="figure_1.png" alt="result #1" width="45%"></p>')).toContain('width:45%');
    for(const unsafe of ['<u onclick="alert(1)">bad</u>','<section><script>bad()</script></section>','<p style="background:url(http://evil)">bad</p>','<a href="javascript:alert(1)">bad</a>','<img src="http://evil/image.png">']) {
      const output=renderMarkdown(unsafe);expect(output).not.toMatch(/<script|onclick="|href="javascript:|src="http/);
    }
  });
  it('shows author notes only in the editor and leaves code contents untouched', () => {
    const source='before <!-- hidden --> after\n\n<!-- block -->\n\n```md\n<!-- ordinary code -->\n[^literal]\n```';
    expect(renderMarkdown(source)).toContain('md-author-comment');
    const exported=renderMarkdown(source,{purpose:'export'});expect(exported).not.toContain('md-author-comment');expect(exported).not.toContain('hidden');expect(exported).toContain('&lt;!-- ordinary code --&gt;');
  });
  it('resolves footnotes across full documents, fragments and A4 blocks', () => {
    const source='Text[^note].\n\n[^note]: **Detail**\n    continuation';
    const html=renderMarkdown(source);expect(html).toContain('href="#fn-note"');expect(html).toContain('<strong>Detail</strong>');
    expect(renderMarkdown('Text[^note].',{elementContext:getElementIndex(source)})).toContain('data-source-target="14"');
    expect(renderPaperBlocks(source).map(b=>b.html).join('')).toContain('md-footnote-definition');
    expect(renderMarkdown('`[^note]`')).not.toContain('md-footnote-ref');
    const unicode = renderMarkdown('Text[^注].\n\n[^注]: Detail');
    expect(unicode).toContain('href="#fn-%E6%B3%A8"'); expect(unicode).toContain('id="fn-注"');
  });
  it('retains code titles and exposes offline Mermaid source to the trusted renderer', () => {
    expect(renderMarkdown('```ts title="src/test.ts"\nconst a = 1;\n```')).toContain('md-code-title">src/test.ts');
    const diagram=renderMarkdown('```mermaid\nflowchart TD\nA-->B\n```');expect(diagram).toContain('data-diagram="mermaid"');expect(diagram).not.toContain('unavailable');
  });
});
