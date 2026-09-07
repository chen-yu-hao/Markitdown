import { describe, expect, it } from 'vitest';
import { getMathBlocks, renderMarkdown } from '../src/shared/markdown';
import { validatedSettings } from '../src/main/document-service';

describe('advanced Markdown preferences', () => {
  it('parses LaTeX delimiters and math fences, while protecting code and escaped delimiters', () => {
    const source = String.raw`inline \(x^2\)

\[
\frac{a}{b}
\]

` + '```math\ny = x + 1\n```';
    const rendered = renderMarkdown(source);
    expect(rendered.match(/class="katex"/g)).toHaveLength(3);
    expect(getMathBlocks(source)).toHaveLength(2);
    const off = renderMarkdown(source, { settings: { latexDelimiters: false, mathCodeBlocks: false } });
    expect(off).not.toContain('class="katex"');
    expect(renderMarkdown('`\\(x\\)` \\\\(x\\)')).not.toContain('class="katex"');
    expect(renderMarkdown('```latex\nx^2\n```')).not.toContain('math-block');
  });

  it('keeps legacy dollar parsing opt-in and currency safe by default', () => {
    expect(renderMarkdown('$ x $')).not.toContain('class="katex"');
    expect(renderMarkdown('$ x $', { settings: { legacyInlineMath: true } })).toContain('class="katex"');
    expect(renderMarkdown('$20 and $30')).not.toContain('class="katex"');
  });

  it('numbers display math across fences and delimiters and resets for every document', () => {
    const source = '$$x$$\n\n```math\ny\n```\n\n\\[z\\]';
    const settings = { mathNumbering: 'all' } as const;
    expect(getMathBlocks(source, settings).map(block => block.number)).toEqual([1, 2, 3]);
    expect(renderMarkdown(source, { settings }).match(/md-equation-number">\(\d\)/g)).toEqual(['md-equation-number">(1)', 'md-equation-number">(2)', 'md-equation-number">(3)']);
    expect(renderMarkdown('$$z$$', { settings, mathStartNumber: 2 })).toContain('md-equation-number">(3)');
    expect(renderMarkdown('$$z$$', { settings })).toContain('md-equation-number">(1)');
  });

  it('generates self-contained path SVG or editable MathML and supports physics', () => {
    const source = String.raw`$\dv{x}{t} + \qty(\frac{a}{b})$`;
    const svg = renderMarkdown(source, { purpose: 'copy', settings: { mathPhysics: true, mathOutput: 'svg' } });
    expect(svg).toContain('<svg'); expect(svg).toContain('<path');
    expect(svg).not.toMatch(/math-error|data-mjx-error|<use|<script|<foreignObject/);
    const mathml = renderMarkdown(source, { purpose: 'htmlPlain', settings: { mathPhysics: true, mathOutput: 'mathml' } });
    expect(mathml).toContain('<math'); expect(mathml).toContain('<mfrac');
    expect(mathml).not.toMatch(/math-error|<svg|data-mjx-error/);
    const disabled = renderMarkdown(source, { purpose: 'copy', settings: { mathPhysics: false } });
    expect(disabled).toContain('data-mjx-error');
  });

  it('blocks TeX resource loading and HTML even in SVG mode', () => {
    for (const formula of [String.raw`\href{javascript:alert(1)}{x}`, String.raw`\htmlClass{evil}{x}`, String.raw`\require{html}`, String.raw`\includegraphics{https://example.org/track}`]) {
      const html = renderMarkdown(`$${formula}$`, { purpose: 'copy' });
      expect(html).not.toMatch(/<(?:script|image|img|a)\b|(?:href|src)="(?:javascript:|https:)/);
    }
    const html = renderMarkdown('a<br/>b<br onclick="alert(1)">c<script>bad</script>');
    expect(html).toContain('<br>'); expect(html).not.toMatch(/<br onclick|<script>/);
  });

  it('separates editing and export whitespace and renders explicit breaks safely', () => {
    const source = 'one  two\nthree<br/>four';
    const settings = { editorWhitespace: 'preserve', exportWhitespace: 'collapse', firstLineIndent: true, showLineBreaks: true } as const;
    const editor = renderMarkdown(source, { settings });
    expect(editor).toContain('white-space:pre-wrap;text-indent:2em'); expect(editor).toContain('md-line-break');
    const exported = renderMarkdown(source, { settings, purpose: 'export' });
    expect(exported).not.toContain('white-space:pre-wrap'); expect(exported).not.toContain('md-line-break'); expect(exported).toContain('<br>');
    expect(renderMarkdown('a  b\nc', { settings: { exportWhitespace: 'breaks' }, purpose: 'export' })).toContain('a  b<br>\nc');
  });

  it('validates persisted fields and rejects malformed code language', () => {
    const settings = validatedSettings({ codeIndentWidth: 99, defaultCodeLanguage: 'js\n<script>', mathOutput: 'remote', editorWhitespace: 'collapse', mathPhysics: true });
    expect(settings.codeIndentWidth).toBe(8); expect(settings.defaultCodeLanguage).toBe(''); expect(settings.mathOutput).toBe('svg'); expect(settings.editorWhitespace).toBe('collapse'); expect(settings.mathPhysics).toBe(true);
    expect(validatedSettings({ defaultCodeLanguage: 'c++', codeLanguageTrigger: 'always' }).defaultCodeLanguage).toBe('c++');
  });

  it('preserves whitespace in tight lists and aligned cells without breaking table alignment', () => {
    const html = renderMarkdown('- one  two\n  three\n\n| x | y |\n| --- | ---: |\n| a  b | 1 |', { purpose: 'export' });
    expect(html).toContain('<span style="white-space:pre-wrap">one  two\nthree</span>');
    expect(html).toContain('text-align:right;white-space:pre-wrap');
  });
});
