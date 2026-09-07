import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '../src/shared/contracts';
import { equationAnchor } from '../src/shared/equation-references';
import { getEquationIndex, renderMarkdown } from '../src/shared/markdown';
import { equationLayout } from '../src/shared/math-renderer';

const parse = (html: string) => new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html');
const nodes = (document: Document | Element, name: string) => Array.from(document.getElementsByTagName('*')).filter(element => element.getAttribute('class')?.split(/\s+/).includes(name));
const aligned = String.raw`$$
\begin{aligned}
E &= mc^2 \\
F &= ma
\end{aligned}
\label{eq:aligned}
$$`;

describe('display equation layout', () => {
  it('defaults to one right-hand number beside a left-aligned multiline formula', () => {
    const document = parse(renderMarkdown(aligned));
    const [block] = nodes(document, 'math-block');
    expect(nodes(document, 'math-block')).toHaveLength(1);
    expect(block.getAttribute('data-math-align')).toBe('left');
    expect(block.getAttribute('data-number-position')).toBe('right');
    expect(nodes(block, 'md-equation-number').map(number => number.textContent)).toEqual(['(1)']);
    expect(nodes(block, 'md-equation-body')).toHaveLength(1);
    expect(nodes(block, 'md-equation-content')).toHaveLength(1);
    expect(nodes(block, 'md-equation-number')[0].parentNode).toBe(block);
    expect(nodes(block, 'md-equation-content')[0].parentNode).toBe(nodes(block, 'md-equation-body')[0]);
    expect(getEquationIndex(aligned).equations).toHaveLength(1);
  });

  it.each(['left', 'center', 'right'] as const)('preserves %s alignment and either number position in editor and export markup', mathAlignment => {
    for (const mathNumberPosition of ['left', 'right'] as const) {
      for (const purpose of ['editor', 'export'] as const) {
        const [block] = nodes(parse(renderMarkdown(aligned, { purpose, settings: { mathAlignment, mathNumberPosition } })), 'math-block');
        expect(block.getAttribute('data-math-align')).toBe(mathAlignment);
        expect(block.getAttribute('data-number-position')).toBe(mathNumberPosition);
        expect(nodes(block, 'md-equation-number').map(number => number.textContent)).toEqual(['(1)']);
        expect(block.getAttribute('id')).toBe(equationAnchor('eq:aligned'));
      }
    }
  });

  it.each(['svg', 'mathml'] as const)('makes %s copied and plain HTML formula layout independent of external CSS', mathOutput => {
    for (const mathAlignment of ['left', 'center', 'right'] as const) {
      for (const mathNumberPosition of ['left', 'right'] as const) {
        for (const purpose of ['copy', 'htmlPlain'] as const) {
          const [block] = nodes(parse(renderMarkdown(aligned, { purpose, settings: { mathAlignment, mathNumberPosition, mathOutput } })), 'math-block');
          const [body] = nodes(block, 'md-equation-body'), [content] = nodes(block, 'md-equation-content'), [number] = nodes(block, 'md-equation-number');
          expect(block.getAttribute('style')).toContain('display:grid');
          expect(body.getAttribute('style')).toContain('overflow-x:auto');
          expect(body.getAttribute('style')).toContain(`grid-column:${mathNumberPosition === 'left' ? 2 : 1}`);
          expect(content.getAttribute('style')).toContain(`margin:0 ${mathAlignment === 'right' ? 0 : 'auto'} 0 ${mathAlignment === 'left' ? 0 : 'auto'}`);
          expect(number.getAttribute('style')).toContain('align-self:center');
          expect(number.getAttribute('style')).toContain(`grid-column:${mathNumberPosition === 'left' ? 1 : 2}`);
          expect(content.getElementsByTagName(mathOutput === 'svg' ? 'svg' : 'math').length).toBe(1);
        }
      }
    }
  });

  it('keeps unnumbered formulas in one full-width column without an empty number cell', () => {
    const document = parse(renderMarkdown('$$x\\notag$$\n\n$$y\\nonumber$$\n\n$$z$$', { purpose: 'copy', settings: { mathNumbering: 'none', mathNumberPosition: 'left' } }));
    expect(nodes(document, 'math-block')).toHaveLength(3);
    expect(nodes(document, 'md-equation-number')).toHaveLength(0);
    for (const block of nodes(document, 'math-block')) {
      expect(block.getAttribute('style')).toContain('grid-template-columns:minmax(0,1fr);');
      expect(nodes(block, 'md-equation-body')[0].getAttribute('style')).toContain('grid-column:1;');
    }
  });

  it('keeps tags, aliases, references and original source intact when changing layout', () => {
    const source = String.raw`$$x\tag{S12.123456789}\label{eq:first}\label{eq:alias}$$

$$y\tag*{B}$$

See \eqref{eq:alias}.`;
    const before = getEquationIndex(source);
    const settings = { mathAlignment: 'right', mathNumberPosition: 'left' } as const;
    const document = parse(renderMarkdown(source, { purpose: 'copy', settings }));
    expect(nodes(document, 'md-equation-number').map(number => number.textContent)).toEqual(['(S12.123456789)', 'B']);
    expect(nodes(document, 'md-equation-reference')[0].getAttribute('href')).toBe(`#${equationAnchor('eq:alias')}`);
    const alias = Array.from(document.getElementsByTagName('span')).find(element => element.getAttribute('id') === equationAnchor('eq:alias'));
    expect(alias?.getAttribute('style')).toContain('position:absolute');
    expect(getEquationIndex(source, settings)).toEqual(before);
  });

  it('constrains layout values before adding standalone styles or HTML attributes', () => {
    const hostile = 'left;position:fixed;" onclick="alert(1)';
    const settings = { ...defaultSettings, mathAlignment: hostile, mathNumberPosition: hostile } as unknown as Settings;
    const layout = equationLayout(settings, true);
    expect(layout.alignment).toBe('left');
    expect(layout.numberPosition).toBe('right');
    expect(renderMarkdown('$$x$$', { purpose: 'copy', settings })).not.toContain(hostile);
  });
});
