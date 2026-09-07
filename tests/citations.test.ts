import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { BIBLIOGRAPHY_MARKER, scanCitations } from '../src/shared/citations';
import { formatCitations, CitationService } from '../src/main/citation-service';
import { renderMarkdown } from '../src/shared/markdown';
import { ExtensionRegistry } from '../src/shared/extensions';
import type { ReferenceItem, ReferenceProvider } from '../src/shared/academic-contracts';

const items: ReferenceItem[] = [
  { key: 'AAAAAAAA', title: 'First article', authors: 'Alpha', year: '2023', csl: { id: 'AAAAAAAA', type: 'article-journal', title: 'First article', author: [{ family: 'Alpha', given: 'Jane' }], issued: { 'date-parts': [[2023]] }, 'container-title': 'Journal A', volume: '12', page: '10-15', DOI: '10.1234/a' } },
  { key: 'BBBBBBBB', title: 'Second article', authors: 'Beta', year: '2024', csl: { id: 'BBBBBBBB', type: 'article-journal', title: 'Second article', author: [{ family: 'Beta', given: 'John' }], issued: { 'date-parts': [[2024]] }, 'container-title': 'Journal B' } },
];
const resolved = { items, missing: [], warnings: [], offline: false };

describe('academic citations', () => {
  it('scans semicolon groups in source order and preserves offsets without interpreting code, links or comments', () => {
    const source = '`[@AAAAAAAA]`\n\n```md\n[@AAAAAAAA]\n```\n\n\\[@AAAAAAAA] [@AAAAAAAA](https://example.org) ![@AAAAAAAA](image.png)\n\n<!-- [@AAAAAAAA] -->\n\nText [@BBBBBBBB; @AAAAAAAA; @BBBBBBBB].\n\n' + BIBLIOGRAPHY_MARKER;
    const scan = scanCitations(source);
    expect(scan.keys).toEqual(['BBBBBBBB', 'AAAAAAAA']);
    expect(scan.clusters).toHaveLength(1);
    expect(source.slice(scan.clusters[0].from, scan.clusters[0].to)).toBe('[@BBBBBBBB; @AAAAAAAA; @BBBBBBBB]');
    expect(scan.bibliographies).toHaveLength(1);
    expect(scanCitations('```\n'+BIBLIOGRAPHY_MARKER+'\n```').bibliographies).toHaveLength(0);
  });

  it('uses first occurrence order, deduplicates bibliography and updates after reordering', () => {
    const source = 'First [@BBBBBBBB; @AAAAAAAA], repeat [@AAAAAAAA].';
    const data = formatCitations(source, resolved, { citationStyle: 'numeric' });
    expect(data.entries.map(item => [item.key, item.number])).toEqual([['BBBBBBBB', 1], ['AAAAAAAA', 2]]);
    expect(data.clusters['[@AAAAAAAA]']).toBe('[2]');
    expect(data.bibliography.match(/id="ref-/g)).toHaveLength(2);
    expect(formatCitations('First [@AAAAAAAA], then [@BBBBBBBB].', resolved, { citationStyle: 'numeric' }).clusters['[@AAAAAAAA]']).toBe('[1]');
  });

  it('keeps reference links, comments and mathematical content literal', () => {
    expect(scanCitations('[@AAAAAAAA]\n\n[@AAAAAAAA]: https://example.org').keys).toEqual([]);
    expect(scanCitations('[@AAAAAAAA][ref]\n\n[ref]: https://example.org').keys).toEqual([]);
    expect(scanCitations('<!-- [@AAAAAAAA] -->').keys).toEqual([]);
    for (const math of ['$[@AAAAAAAA]$', '$$\n[@AAAAAAAA]\n$$', '\\([@AAAAAAAA]\\)', '\\[\n[@AAAAAAAA]\n\\]']) {
      expect(scanCitations(math, { latexDelimiters: true }).keys).toEqual([]);
    }
    expect(scanCitations('$[@AAAAAAAA]$', { inlineMath: false }).keys).toEqual(['AAAAAAAA']);
    expect(renderMarkdown('[@AAAAAAAA]\n\n[@AAAAAAAA]: https://example.org')).not.toContain('citation-unresolved');
  });

  it('handles adjacent citations and parenthetical prose without confusing links', () => {
    for (const source of ['[@AAAAAAAA] [@BBBBBBBB]', '[@AAAAAAAA][@BBBBBBBB]', '[@AAAAAAAA] (see text), [@BBBBBBBB]']) {
      expect(scanCitations(source).keys).toEqual(['AAAAAAAA', 'BBBBBBBB']);
      expect(renderMarkdown(source).match(/citation-unresolved/g)).toHaveLength(2);
    }
    expect(renderMarkdown('> ' + BIBLIOGRAPHY_MARKER)).not.toContain('class="md-bibliography"');
  });

  it('formats author-date style with the same CSL metadata', () => {
    const data = formatCitations('[@AAAAAAAA; @BBBBBBBB]', resolved, { citationStyle: 'author-date' });
    expect(data.clusters['[@AAAAAAAA; @BBBBBBBB]']).toContain('Alpha, 2023');
    expect(data.clusters['[@AAAAAAAA; @BBBBBBBB]']).toContain('Beta, 2024');
    expect(data.bibliography).toContain('doi: 10.1234/a');
  });

  it('renders hyperlinks at the movable bibliography placeholder and distinguishes equation references', () => {
    const source = 'Text [@AAAAAAAA].\n\n' + BIBLIOGRAPHY_MARKER + '\n\n## Appendix\n\n\\eqref{eq:energy}';
    const html = renderMarkdown(source, { citations: formatCitations(source, resolved, { citationStyle: 'numeric' }) });
    expect(html).toContain('href="#ref-AAAAAAAA"');
    expect(html).not.toContain('&lt;!-- markedown:bibliography');
    expect(html.indexOf('id="ref-AAAAAAAA"')).toBeLessThan(html.indexOf('id="appendix"'));
    expect(scanCitations('[@eq:energy] and \\eqref{eq:energy}').keys).toEqual([]);
  });

  it('does not invent missing records and retains cached offline metadata', () => {
    const data = formatCitations('[@AAAAAAAA; @CCCCCCCC]', { ...resolved, offline: true }, { citationStyle: 'numeric' });
    expect(data.missing).toEqual(['CCCCCCCC']); expect(data.offline).toBe(true);
    expect(data.clusters).toEqual({}); expect(data.bibliography).not.toContain('ref-CCCCCCCC');
    expect(renderMarkdown('[@AAAAAAAA; @CCCCCCCC]', { citations: data })).toContain('citation-unresolved');
  });

  it('sanitizes citation metadata without allowing active markup', () => {
    const item = { ...items[0], csl: { ...items[0].csl, title: '<script>bad()</script><img src="https://example.org/track"><i>Safe</i>' } };
    const data = formatCitations('[@AAAAAAAA]', { ...resolved, items: [item] }, { citationStyle: 'numeric' });
    expect(data.bibliography).not.toMatch(/<(?:script|img)\b|<[^>]+\s(?:src|onclick)=/);
    expect(data.bibliography).toContain('Safe');
  });

  it('supports another reference provider without modifying citation formatting', async () => {
    const provider: ReferenceProvider = { id: 'fixture', name: 'Fixture', status: async () => ({ available: true }), search: async () => ({ items, hasMore: false }), resolve: async keys => ({ ...resolved, items: items.filter(item => keys.includes(item.key)) }) };
    const registry = new ExtensionRegistry();
    registry.register({ manifest: { id: 'example.references', name: 'Fixture', version: '1.0.0', apiVersion: 1, capabilities: ['references'] }, references: provider });
    registry.seal();
    const data = await new CitationService(registry.referenceProvider('fixture')!).resolve('[@AAAAAAAA]', { citationStyle: 'numeric' });
    expect(data.clusters['[@AAAAAAAA]']).toBe('[1]');
    expect(() => registry.register({ manifest: { id: 'example.other', name: 'Other', version: '1.0.0', apiVersion: 1, capabilities: [] } })).toThrow('sealed');
  });

  it('validates plugin capabilities, versions, duplicate providers and parser lifecycle', () => {
    const registry = new ExtensionRegistry();
    const extension = { manifest: { id: 'example.markdown', name: 'Example', version: '1.0.0', apiVersion: 1, capabilities: ['markdown'] }, markdown: (parser: ReturnType<typeof MarkdownIt>) => { parser.renderer.rules.hr = () => '<hr data-example="true">'; } } as const;
    registry.register(extension);
    expect(() => registry.register(extension)).toThrow('Duplicate');
    const parser = new MarkdownIt(); registry.installMarkdown(parser);
    expect(parser.render('---')).toContain('data-example="true"');
    const other = new ExtensionRegistry();
    const remove = other.register(extension);
    remove();
    other.register(extension);
    remove();
    expect(other.list()).toHaveLength(1);
    expect(() => other.register({ ...extension, manifest: { ...extension.manifest, apiVersion: 2 as 1 } })).toThrow('Unsupported extension API');
    expect(() => new ExtensionRegistry().register({ ...extension, markdown: undefined })).toThrow('capabilities');
  });
});
