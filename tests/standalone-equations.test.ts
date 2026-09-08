import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getEquationIndex, renderMarkdown } from '../src/shared/markdown';
import { getMathSourceRanges } from '../src/shared/math-syntax';
import { loadSettings, saveSettings } from '../src/main/document-service';

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    const relative = path.relative(tmpdir(), directory);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('markedown-standalone-')) throw new Error('Unsafe standalone settings cleanup.');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('standalone body-paragraph equations', () => {
  it.each(['$E=mc^2$', String.raw`\(E=mc^2\)`])('numbers a complete %s paragraph without changing inline prose', formula => {
    const source = `Before $x$ and $y$.\n\n${formula}\n\nAfter $z$.`;
    const index = getEquationIndex(source);
    expect(index.equations.map(equation => [equation.block, equation.display, equation.number])).toEqual([
      [false, false, undefined], [false, false, undefined], [true, true, '1'], [false, false, undefined],
    ]);
    const equation = index.equations[2];
    expect(source.slice(equation.from, equation.to)).toBe(formula);
    for (const purpose of ['editor', 'export', 'htmlPlain'] as const) {
      const html = renderMarkdown(source, { purpose });
      expect(html.match(/class="math-block md-numbered"/g)).toHaveLength(1);
      expect(html).toMatch(/class="md-equation-number"[^>]*>\(1\)<\/span>/);
      expect(html).not.toMatch(/<p[^>]*>\s*<div class="math-block/);
    }
    expect(getMathSourceRanges(source)).toEqual(index.equations.map(({ from, to }) => ({ from, to })));
  });

  it.each(['Text $x$.', '$x$ suffix', '$x$ $y$', '# $x$', '- $x$', '> $x$', '**$x$**', '| $x$ |\n| --- |', '`$x$`', '```text\n$x$\n```'])('keeps contextual inline and code syntax unchanged: %s', source => {
    const index = getEquationIndex(source);
    expect(index.equations.every(equation => !equation.block && equation.number === undefined)).toBe(true);
    expect(renderMarkdown(source)).not.toContain('class="math-block');
  });

  it('uses full-document context when rendering an isolated editor widget', () => {
    const source = 'Text $z$.\n\n$a$\n\n$b$';
    const equationIndex = getEquationIndex(source);
    const inline = renderMarkdown('$z$', { purpose: 'editor', equationIndex, sourceOffset: source.indexOf('$z$') });
    expect(inline).not.toContain('math-block');
    expect(inline).not.toContain('md-equation-number');
    const second = renderMarkdown('$b$', { purpose: 'editor', equationIndex, sourceOffset: source.indexOf('$b$') });
    expect(second).toContain('class="math-block md-numbered"');
    expect(second).toContain('class="md-equation-number">(2)</span>');
  });

  it('keeps section numbering, explicit tags, suppression and CRLF source positions', () => {
    const source = '# First\r\n\r\n$x$ {#eq:x}\r\n\r\n$y\\notag$\r\n\r\n$z\\tag{S1}$\r\n\r\n# Second\r\n\r\n$a$\r\n\r\nSee \\eqref{eq:x}.';
    const index = getEquationIndex(source, { mathNumberingStyle: 'section' });
    expect(index.equations.map(equation => equation.number)).toEqual(['1.1', undefined, 'S1', '2.1']);
    expect(index.equations.map(equation => source.slice(equation.from, equation.to))).toEqual(['$x$ {#eq:x}', '$y\\notag$', '$z\\tag{S1}$', '$a$']);
    expect(index.diagnostics).toEqual([]);
    expect(renderMarkdown(source, { settings: { mathNumberingStyle: 'section' } })).toContain('>(1.1)</a>');
  });

  it('honors disabled promotion and automatic numbering preferences', () => {
    expect(getEquationIndex('$x$', { mathStandaloneParagraphs: false }).equations[0]).toMatchObject({ block: false, display: false, number: undefined });
    for (const mathNumbering of ['none', 'labelled'] as const) expect(getEquationIndex('$x$', { mathNumbering }).equations[0]).toMatchObject({ block: true, display: true, number: undefined });
    expect(getEquationIndex('$x$', { inlineMath: false }).equations).toHaveLength(0);
    expect(getEquationIndex(String.raw`\(x\)`, { latexDelimiters: false }).equations).toHaveLength(0);
  });

  it('defaults existing installations to promotion and persists an explicit opt-out', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'markedown-standalone-'));
    temporary.push(directory);
    expect((await loadSettings(directory)).mathStandaloneParagraphs).toBe(true);
    await saveSettings(directory, { mathStandaloneParagraphs: false, mathNumbering: 'labelled' });
    expect(await loadSettings(directory)).toMatchObject({ mathStandaloneParagraphs: false, mathNumbering: 'labelled' });
    expect(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')).mathStandaloneParagraphs).toBe(false);
  });
});
