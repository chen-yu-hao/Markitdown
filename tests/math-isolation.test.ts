import { describe, expect, it } from 'vitest';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { getMathBlocks, renderMarkdown } from '../src/shared/markdown';

describe('math renderer isolation and block boundaries', () => {
  it.each(['svg', 'mathml'] as const)('blocks raw MathML token links and active styles in %s output', mathOutput => {
    for (const formula of [String.raw`\mmlToken{mi}[href="javascript:alert(1)"]{x}`, String.raw`\mmlToken{mi}[style="background-image:url(https://example.org/track)"]{x}`, String.raw`\mmlToken{mi}[style="position:fixed;inset:0;background:red;z-index:99999"]{x}`, String.raw`\mmlToken{mi}[mathcolor="url(https://example.org/track)"]{x}`]) {
      const html = renderMarkdown(`$${formula}$`, { purpose: 'htmlPlain', settings: { mathOutput } });
      const document = new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html');
      const math = document.getElementsByTagName(mathOutput === 'svg' ? 'svg' : 'math')[0];
      expect(math).toBeDefined();
      expect(new XMLSerializer().serializeToString(math)).not.toMatch(/\bhref="javascript:|\b(?:style|fill|stroke|mathcolor|mathbackground)="[^"]*(?:url\(|position\s*:)/i);
    }
  });

  it('keeps formula macro definitions from changing a later document', () => {
    const options = { purpose: 'htmlPlain', settings: { mathOutput: 'mathml' } } as const;
    const definition = renderMarkdown(String.raw`$\newcommand{\markedownreviewlocal}{x}\markedownreviewlocal$`, options);
    expect(definition).toContain('<mi>x</mi>');
    const anotherDocument = renderMarkdown(String.raw`$\markedownreviewlocal+1$`, options);
    expect(anotherDocument).toContain('Undefined control sequence');
  });

  it('does not consume text outside an unterminated math block in a list', () => {
    const source = '- $$\n  x\n\nOUTSIDE\n$$\nAFTER';
    expect(getMathBlocks(source)).toHaveLength(0);
    const html = renderMarkdown(source);
    expect(html).toContain('OUTSIDE');
    expect(html).not.toContain('math-block');
  });

  it('does not match a subsequent opener after a same-line close followed by prose', () => {
    const source = '$$x$$ tail\n\n$$\nz\n$$';
    expect(getMathBlocks(source, { mathNumbering: 'all' }).map(block => ({ source: block.source, number: block.number }))).toEqual([{ source: 'z', number: 1 }]);
    const html = renderMarkdown(source, { settings: { mathNumbering: 'all' } });
    expect(html).toContain('tail</p>');
    expect(html.match(/md-equation-number/g)).toHaveLength(1);
  });
});
