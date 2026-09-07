import { describe, expect, it } from 'vitest';
import { getEquationIndex, renderMarkdown } from '../src/shared/markdown';

describe('manual LaTeX equation numbering', () => {
  it('renders plain manual tags once and uses them for forward references in all outputs', () => {
    const source = '\\eqref{eq:a}, \\ref{eq:a}, \\eqref{eq:s}.\n\n$$x=1\\tag{A}\\label{eq:a}$$\n\n$$y=2\\tag*{S1}\\label{eq:s}$$\n\n$$z=3$$';
    const index = getEquationIndex(source);
    expect(index.equations.map(item => [item.source, item.number, item.ordinal])).toEqual([['x=1', 'A', 0], ['y=2', 'S1', 0], ['z=3', '1', 1]]);
    expect(index.diagnostics).toEqual([]);
    for (const options of [{}, { settings: { mathPhysics: true } }, { settings: { mathOutput: 'mathml' as const }, purpose: 'htmlPlain' as const }, { settings: { mathOutput: 'svg' as const }, purpose: 'copy' as const }]) {
      const html = renderMarkdown(source, options);
      expect(html.match(/class="md-equation-number"[^>]*>[^<]*/g)).toEqual([
        expect.stringMatching(/>\(A\)$/), expect.stringMatching(/>S1$/), expect.stringMatching(/>\(1\)$/),
      ]);
      expect(html).not.toContain('class="tag"');
      expect(html).not.toContain('\\tag');
      expect(html).toMatch(/class="md-equation-reference"[^>]*>\(A\)<\/a>/);
      expect(html).toMatch(/class="md-equation-reference"[^>]*>A<\/a>/);
      expect(html).toMatch(/class="md-equation-reference"[^>]*>\(S1\)<\/a>/);
    }
  });

  it('honors suppression without consuming document or section counters', () => {
    const source = '# Section\n\n$$a\\notag$$\n\n$$b\\nonumber\\label{eq:b}$$\n\n$$c\\tag{S1}$$\n\n$$d$$';
    expect(getEquationIndex(source).equations.map(item => item.number)).toEqual([undefined, undefined, 'S1', '1']);
    expect(getEquationIndex(source, { mathNumberingStyle: 'section' }).equations.map(item => item.number)).toEqual([undefined, undefined, 'S1', '1.1']);
    const unresolved = getEquationIndex(source + '\n\n\\eqref{eq:b}');
    expect(unresolved.diagnostics).toEqual([expect.objectContaining({ code: 'missing-reference', label: 'eq:b' })]);
    expect(renderMarkdown(source)).not.toMatch(/\\(?:notag|nonumber)/);
  });

  it('keeps explicit tags when automatic numbering is disabled and across snippets', () => {
    const source = '$$a$$\n\n$$x\\tag{S2}\\label{eq:x}$$';
    const settings = { mathNumbering: 'none' as const };
    const index = getEquationIndex(source, settings);
    const equation = index.equations[1];
    expect(index.equations.map(item => item.number)).toEqual([undefined, 'S2']);
    expect(renderMarkdown(source.slice(equation.from, equation.to), { settings, equationIndex: index, sourceOffset: equation.from })).toContain('class="md-equation-number">(S2)</span>');
  });

  it('ignores commented and escaped commands and requires whole control words', () => {
    const sources = ['x % \\tag{A}', 'x % \\notag', 'x\\\\tag{A}', 'x\\notagged', 'x\\tagged{A}'];
    for (const expression of sources) {
      const equation = getEquationIndex('$$\n' + expression + '\n$$').equations[0];
      expect(equation.number).toBe('1');
      expect(equation.source).toBe(expression);
    }
  });

  it('preserves ambiguous and complex tags with a visible export-blocking diagnostic', () => {
    for (const expression of ['x\\tag{A}\\tag{B}', '\\begin{align}x&=1\\tag{A}\\\\y&=2\\tag{B}\\end{align}', 'x\\tag{\\textbf{S1}}']) {
      const source = '$$\n' + expression + '\n$$';
      const index = getEquationIndex(source);
      expect(index.equations[0].source).toBe(expression);
      expect(index.equations[0].number).toBeUndefined();
      expect(index.diagnostics).toContainEqual(expect.objectContaining({ code: 'ambiguous-numbering' }));
      const html = renderMarkdown(source);
      expect(html).toContain('class="md-equation-diagnostic"');
      expect(html).not.toContain('class="md-equation-number"');
    }
  });

  it('escapes textual tags in both number and reference HTML', () => {
    const source = '$$x\\tag{<img src=x onerror=alert(1)>}\\label{eq:x}$$\n\n\\eqref{eq:x}';
    const html = renderMarkdown(source);
    expect(html).not.toContain('<img');
    expect(html).toContain('(&lt;img src=x onerror=alert(1)&gt;)');
    expect(html.match(/&lt;img/g)).toHaveLength(2);
  });
});
