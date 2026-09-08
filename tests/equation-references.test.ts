import { describe, expect, it } from 'vitest';
import { getEquationIndex, getMathBlocks, renderMarkdown } from '../src/shared/markdown';
import { equationAnchor, extractEquationLabels } from '../src/shared/equation-references';

describe('academic equation labels and references', () => {
  it('preserves adjacent equation references and following parenthetical prose', () => {
    for (const refs of ['[@eq:a][@eq:a]', '[@eq:a] [@eq:a]', '[@eq:a] (see text) [@eq:a]']) {
      const source = '$$x\\label{eq:a}$$\n\n' + refs;
      expect(getEquationIndex(source).references).toHaveLength(2);
      expect(renderMarkdown(source).match(/class="md-equation-reference"/g)).toHaveLength(2);
    }
  });
  it('resolves forward references across block delimiters and math fences', () => {
    const source = String.raw`See \eqref{eq:energy}, \ref{eq:force}, and [@eq:mass].

$$E=mc^2\label{eq:energy}$$

\[
F=ma\label{eq:force}
\]

` + '```math\nm=1\\label{eq:mass}\n```';
    const index = getEquationIndex(source, { mathNumbering: 'all' });
    expect(index.equations.map(equation => [equation.label, equation.number])).toEqual([['eq:energy', '1'], ['eq:force', '2'], ['eq:mass', '3']]);
    expect(index.references.map(reference => reference.label)).toEqual(['eq:energy', 'eq:force', 'eq:mass']);
    expect(index.diagnostics).toEqual([]);
    const html = renderMarkdown(source, { settings: { mathNumbering: 'all' } });
    expect(html).toContain(`href="#${equationAnchor('eq:energy')}"`);
    expect(html).toMatch(/data-equation-from="\d+">\(1\)<\/a>/);
    expect(html).toMatch(/data-equation-from="\d+">2<\/a>/);
    expect(html).not.toContain('Undefined control sequence');
    expect(html).not.toContain('\\label');
  });

  it('numbers labelled inline equations and supports trailing labels on all block forms', () => {
    const source = String.raw`Inline $x=1\label{eq:inline}$ and \(y=2\){#eq:paren}.

$$z=3$$ {#eq:block}

\[
w=4
\] {#eq:multiline}

` + '```math {#eq:fence}\nv=5\n```';
    const index = getEquationIndex(source, { mathNumbering: 'labelled' });
    expect(index.equations.map(equation => equation.label)).toEqual(['eq:inline', 'eq:paren', 'eq:block', 'eq:multiline', 'eq:fence']);
    expect(index.equations.map(equation => equation.number)).toEqual(['1', '2', '3', '4', '5']);
    expect(index.equations.map(equation => equation.block)).toEqual([false, false, true, true, true]);
    expect(renderMarkdown(source)).not.toMatch(/\{#eq:|\\label/);
    for (const equation of index.equations) expect(source.slice(equation.from, equation.to)).toContain(equation.label);
  });

  it('keeps explicit labels referrable with automatic numbering disabled', () => {
    const source = '$$a$$\n\n$$b\\label{eq:b}$$\n\n$c\\label{eq:c}$\n\n\\eqref{eq:b}';
    for (const mathNumbering of ['none', 'labelled'] as const) {
      const index = getEquationIndex(source, { mathNumbering });
      expect(index.equations.map(equation => equation.number)).toEqual([undefined, '1', '2']);
      expect(renderMarkdown(source, { settings: { mathNumbering } })).toContain('>(1)</a>');
    }
    expect(getEquationIndex(source, { mathNumbering: 'all' }).equations.map(equation => equation.number)).toEqual(['1', '2', '3']);
  });

  it('uses section counters and stable label anchors after inserting preceding equations', () => {
    const source = '$$a\\label{eq:front}$$\n\n# First\n\n$$b\\label{eq:b}$$\n\n## Detail\n\nInline $c\\label{eq:c}$.\n\n# Second\n\n$$d\\label{eq:d}$$';
    const settings = { mathNumbering: 'all', mathNumberingStyle: 'section' } as const;
    const index = getEquationIndex(source, settings);
    expect(index.equations.map(equation => equation.number)).toEqual(['0.1', '1.1', '1.2', '2.1']);
    const inserted = getEquationIndex('$$extra$$\n\n' + source, settings);
    expect(inserted.equations.find(equation => equation.label === 'eq:b')?.id).toBe(index.equations[1].id);
    expect(getMathBlocks(source, settings).map(equation => equation.numberText)).toEqual(['0.1', '1.1', '2.1']);
  });

  it('shows missing and duplicate label diagnostics instead of selecting an ambiguous target', () => {
    const source = '$$a\\label{eq:same}$$\n\n$$b\\label{eq:same}$$\n\n\\eqref{eq:same} and [@eq:missing]';
    const index = getEquationIndex(source);
    expect(index.equations.every(equation => equation.duplicate)).toBe(true);
    expect(new Set(index.equations.map(equation => equation.id)).size).toBe(2);
    expect(index.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['duplicate-label', 'duplicate-label', 'missing-reference']);
    const html = renderMarkdown(source);
    expect(html).toContain('[!! eq:same]');
    expect(html).toContain('[?? eq:missing]');
    expect(html).not.toContain(`href="#${equationAnchor('eq:same')}"`);
    expect(html).toContain('md-equation-diagnostic');
  });

  it('binds snippets and forward references to the entire document context', () => {
    const source = '# First\n\n$$a\\label{eq:first}$$\n\n# Second\n\nSee [@eq:first].\n\n$$b\\label{eq:second}$$';
    const settings = { mathNumbering: 'all', mathNumberingStyle: 'section' } as const;
    const equationIndex = getEquationIndex(source, settings);
    const second = equationIndex.equations[1];
    const snippet = renderMarkdown(source.slice(second.from, second.to), { settings, equationIndex, sourceOffset: second.from });
    expect(snippet).toContain('(2.1)');
    expect(snippet).toContain(`id="${second.id}"`);
    const reference = renderMarkdown('See [@eq:first].', { settings, equationIndex, sourceOffset: source.indexOf('See ') });
    expect(reference).toContain('>(1.1)</a>');
    expect(reference).toContain(`data-equation-from="${equationIndex.equations[0].from}"`);
  });

  it('keeps code, escaped delimiters and commented labels literal', () => {
    const source = '`$x\\label{eq:code}$` and `\\eqref{eq:code}`\n\n```js\n$$x\\label{eq:fence}$$\n```\n\n\\\\eqref{eq:escaped}\n\n$$\nx % \\label{eq:comment}\n+1\\label{eq:real}\n$$';
    const index = getEquationIndex(source);
    expect(index.equations.map(equation => equation.label)).toEqual(['eq:real']);
    expect(index.references).toHaveLength(0);
    expect(extractEquationLabels(String.raw`x\\label{eq:escaped}`).labels).toEqual([]);
  });

  it('keeps reference syntax inside ordinary links literal and does not nest anchors', () => {
    const source = '[$x$ and \\eqref{eq:a}](https://example.org) [@eq:a](https://example.org)\n\n$$a\\label{eq:a}$$';
    const html = renderMarkdown(source);
    expect(html.match(/<a\b/g)).toHaveLength(2);
    expect(getEquationIndex(source).references).toEqual([]);
  });

  it('maps inline labels in emphasis, highlights, lists, quotes and table cells back to source', () => {
    const source = '**$x\\label{eq:bold}$**\n\n==See $x\\label{eq:mark}$==\n\n- $x\\label{eq:list}$\n\n> $x\\label{eq:quote}$\n\nA | B\n--- | ---\n$x\\label{eq:table}$ | $y\\label{eq:cell}$';
    const index = getEquationIndex(source);
    expect(index.equations).toHaveLength(6);
    for (const equation of index.equations) expect(source.slice(equation.from, equation.to)).toBe(`$${equation.source}\\label{${equation.label}}$`);
  });

  it('maps CRLF offsets and supports Unicode labels without unsafe HTML attributes', () => {
    const source = 'Intro\r\n\r\n$x\\label{eq:能量}$\r\n\r\n$$y\\label{eq:two}$$\r\n\r\n\\eqref{eq:能量}';
    const index = getEquationIndex(source);
    expect(index.equations.map(equation => source.slice(equation.from, equation.to))).toEqual(['$x\\label{eq:能量}$', '$$y\\label{eq:two}$$']);
    expect(source.slice(index.references[0].from, index.references[0].to)).toBe('\\eqref{eq:能量}');
    const html = renderMarkdown(source);
    expect(html).toContain(`href="#${equationAnchor('eq:能量')}"`);
    expect(renderMarkdown('$x\\label{eq:"bad}$')).not.toContain('id="eq:');
  });
});
