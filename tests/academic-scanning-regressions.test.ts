import { describe, expect, it, vi } from 'vitest';
import CSL from 'citeproc';
import { scanCitations } from '../src/shared/citations';
import { getMathSourceRanges } from '../src/shared/math-syntax';
import { formatCitations } from '../src/main/citation-service';
import type { ReferenceItem } from '../src/shared/academic-contracts';

describe('academic source scanning regressions', () => {
  it('maps inline and block math ranges to original Windows and mixed line endings', () => {
    for (const lineEnding of ['\n', '\r\n', '\r']) {
      const formulas = ['$$\n[@AAAAAAAA]\n$$', '\\[\n[@AAAAAAAA]\n\\]', 'Inline $[@AAAAAAAA]$ and \\([@AAAAAAAA]\\)'];
      for (const formula of formulas) {
        const expression = formula.replace(/\n/g, lineEnding);
        const source = ('Paragraph' + lineEnding).repeat(20) + lineEnding + expression + lineEnding + lineEnding + '[@BBBBBBBB]';
        const ranges = getMathSourceRanges(source, { latexDelimiters: true });
        expect(ranges).toHaveLength(formula.startsWith('Inline') ? 2 : 1);
        for (const range of ranges) expect(source.slice(range.from, range.to)).toContain('[@AAAAAAAA]');
        const scan = scanCitations(source, { latexDelimiters: true });
        expect(scan.keys).toEqual(['BBBBBBBB']);
        expect(source.slice(scan.clusters[0].from, scan.clusters[0].to)).toBe('[@BBBBBBBB]');
      }
    }
    const mixed = 'Paragraph\r\n\r\n$$\n[@AAAAAAAA]\r\n$$\r\n\n[@BBBBBBBB]';
    expect(scanCitations(mixed).keys).toEqual(['BBBBBBBB']);
    const range = getMathSourceRanges(mixed)[0];
    expect(mixed.slice(range.from, range.to)).toBe('$$\n[@AAAAAAAA]\r\n$$');
  });

  it('formats each distinct raw cluster once while preserving repeated citation numbers', () => {
    const items: ReferenceItem[] = ['AAAAAAAA', 'BBBBBBBB'].map((key, index) => ({
      key, title: `Article ${index + 1}`, authors: `Author ${index + 1}`, year: '2024',
      csl: { id: key, type: 'article-journal', title: `Article ${index + 1}`, author: [{ family: `Author ${index + 1}` }], issued: { 'date-parts': [[2024]] } },
    }));
    const spy = vi.spyOn(CSL.Engine.prototype, 'makeCitationCluster');
    try {
      const source = '[@AAAAAAAA] [@BBBBBBBB] [@AAAAAAAA; @BBBBBBBB].\n\n'.repeat(100);
      const data = formatCitations(source, { items, missing: [], warnings: [], offline: false }, { citationStyle: 'numeric' });
      expect(spy).toHaveBeenCalledTimes(3);
      expect(data.clusters['[@AAAAAAAA]']).toBe('[1]');
      expect(data.clusters['[@BBBBBBBB]']).toBe('[2]');
      expect(data.entries.map(item => [item.key, item.number])).toEqual([['AAAAAAAA', 1], ['BBBBBBBB', 2]]);
      expect(data.bibliography.match(/id="ref-/g)).toHaveLength(2);
    } finally { spy.mockRestore(); }
  });
});
