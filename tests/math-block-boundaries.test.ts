import { describe, expect, it } from 'vitest';
import { getEquationIndex, getMathBlocks, renderMarkdown } from '../src/shared/markdown';
import { getMathSourceRanges } from '../src/shared/math-syntax';
import { scanCitations } from '../src/shared/citations';

describe('display math without preceding blank lines', () => {
  it.each([
    '$$x=1$$',
    '$$\nx=1\n$$',
    '\\[x=1\\]',
    '\\[\nx=1\n\\]',
  ])('recognizes and numbers the complete block in %s', expression => {
    const source = `Before\n${expression}\nAfter`;
    const index = getEquationIndex(source, { mathNumbering: 'all' });
    expect(index.equations).toHaveLength(1);
    const equation = index.equations[0];
    expect(equation).toMatchObject({ source: 'x=1', display: true, block: true, number: '1' });
    expect(source.slice(equation.from, equation.to)).toBe(expression);
    const html = renderMarkdown(source, { settings: { mathNumbering: 'all' } });
    expect(html).toMatch(/<p[^>]*>Before<\/p>/);
    expect(html).toMatch(/<p[^>]*>After<\/p>/);
    expect(html).toContain('class="md-equation-number">(1)</span>');
  });

  it('counts adjacent delimiter blocks and math fences in the same document', () => {
    const source = 'Before\n$$x$$\n\\[y\\]\n```math\nz\n```\nAfter';
    expect(getMathBlocks(source).map(block => [block.source, block.numberText])).toEqual([['x', '1'], ['y', '2'], ['z', '3']]);
    const html = renderMarkdown(source);
    expect(html.match(/class="md-equation-number">\(\d\)<\/span>/g)).toHaveLength(3);
    expect(html).toMatch(/<p[^>]*>After<\/p>/);
  });

  it.each([
    '> Before\n> $$x$$\n> After',
    '- Before\n  $$x$$\n  After',
    '> Before\n> \\[\n> x\n> \\]\n> After',
    '- Before\n  \\[\n  x\n  \\]\n  After',
  ])('retains list and quote boundaries in %s', source => {
    const [equation] = getEquationIndex(source).equations;
    expect(equation).toMatchObject({ source: 'x', display: true, block: true, number: '1' });
    const html = renderMarkdown(source);
    expect(html).toContain('Before');
    expect(html).toContain('After');
    expect(html).toContain(source.startsWith('>') ? '<blockquote>' : '<ul>');
    expect(html.match(/class="md-equation-number">\(1\)<\/span>/g)).toHaveLength(1);
  });

  it('keeps labels, forward references and Windows source offsets intact', () => {
    const expression = '$$x=1$$ {#eq:x}';
    const source = `See \\eqref{eq:x}.\r\n${expression}\r\nAfter`;
    const [equation] = getEquationIndex(source).equations;
    expect(equation).toMatchObject({ label: 'eq:x', number: '1', block: true });
    expect(source.slice(equation.from, equation.to)).toBe(expression);
    expect(renderMarkdown(source)).toMatch(/class="md-equation-reference"[^>]*>\(1\)<\/a>/);
  });

  it.each(['$$', '\\['])('shares %s boundaries with citation scanning', opener => {
    const closer = opener === '$$' ? '$$' : '\\]';
    const expression = `${opener}\r\n[@AAAAAAAA]\r\n${closer}`;
    const source = `Before\r\n${expression}\r\n[@BBBBBBBB]`;
    const ranges = getMathSourceRanges(source);
    expect(ranges).toHaveLength(1);
    expect(source.slice(ranges[0].from, ranges[0].to)).toBe(expression);
    expect(scanCitations(source).keys).toEqual(['BBBBBBBB']);
  });

  it('preserves the explicit numbering and delimiter preferences', () => {
    const source = 'Before\n$$x$$\n\\[y\\]\nAfter';
    for (const mathNumbering of ['none', 'labelled'] as const) {
      const equations = getEquationIndex(source, { mathNumbering }).equations;
      expect(equations.map(equation => equation.block)).toEqual([true, true]);
      expect(equations.map(equation => equation.number)).toEqual([undefined, undefined]);
    }
    expect(getEquationIndex(source, { latexDelimiters: false }).equations.map(equation => equation.source)).toEqual(['x']);
  });

  it('keeps inline display delimiters inside surrounding prose inline', () => {
    const source = 'Before $$x$$ after\n$$y$$ trailing text\n\n$$z$$';
    expect(getEquationIndex(source).equations.map(equation => [equation.source, equation.block, equation.number])).toEqual([
      ['x', false, undefined], ['y', false, undefined], ['z', true, '1'],
    ]);
  });

  it.each([
    'Before\n$$\nx\nAfter',
    'Before\n\\[\nx\nAfter',
    '- Before\n  $$\n  x\n\nOUTSIDE\n$$\nAfter',
    'Before\n\\$$x$$\nAfter',
    'Before\n`$$x$$`\nAfter',
    'Before\n```text\n$$x$$\n\\[y\\]\n```\nAfter',
    'Before\n\n    $$x$$\n\nAfter',
  ])('does not invent display blocks or consume other containers in %s', source => {
    expect(getMathBlocks(source)).toEqual([]);
    const html = renderMarkdown(source);
    expect(html).not.toContain('class="math-block');
    expect(html).toContain('After');
  });
});
