import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { defaultSettings, type DocumentSession, type Settings } from '../src/shared/contracts';
import type { ReferenceResolution } from '../src/shared/academic-contracts';
import { BIBLIOGRAPHY_MARKER } from '../src/shared/citations';
import { formatCitations } from '../src/main/citation-service';
import { buildExportHtml, exportDocument, findPandoc } from '../src/main/export-service';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const keys = ['D9PGQUM4', 'T4IQZGRM', 'MRHTZ5CI'];
const references: ReferenceResolution = { items: keys.map((key, index) => ({ key, title: `Verified reference ${index + 1}`, authors: 'Example, Ada', year: String(2020 + index), csl: { id: key, type: 'article-journal', title: `Verified reference ${index + 1}`, author: [{ family: 'Example', given: 'Ada' }], issued: { 'date-parts': [[2020 + index]] }, 'container-title': 'Journal of Testing', volume: '10', page: '20-30', DOI: `10.1234/verified.${index + 1}` } })), missing: [], offline: false, warnings: [] };
let directory: string;
const document = (source: string): DocumentSession => ({ id: 'academic-export', path: path.join(directory, '稿件 draft.md'), title: 'Current manuscript', source, savedSource: 'Old content on disk', dirty: true, recovered: false, bom: false, lineEnding: 'LF', revision: null, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 4 });
const settings = (extra: Partial<Settings> = {}): Settings => ({ ...structuredClone(defaultSettings), language: 'en', exportOutline: false, ...extra });
const xml = (source: Uint8Array) => new DOMParser({ errorHandler: { warning: message => { throw new Error(message); }, error: message => { throw new Error(message); }, fatalError: message => { throw new Error(message); } } }).parseFromString(strFromU8(source), 'application/xml');
const elements = (value: Document | Element, name: string, namespace = W) => Array.from(value.getElementsByTagNameNS(namespace, name));

beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-academic-export-')); });
afterEach(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('markedown-academic-export-')) throw new Error('Unsafe academic export cleanup.');
  await rm(directory, { recursive: true, force: true });
});

describe('academic export integrity', () => {
  it('keeps the bibliography at its marker and appends it only when no marker exists', async () => {
    const source = `Before references [@${keys[0]}; @${keys[1]}].\n\n${BIBLIOGRAPHY_MARKER}\n\n# Appendix\n\nAfter references.`;
    const citations = formatCitations(source, references, settings());
    for (const format of ['html', 'htmlPlain'] as const) {
      const html = await buildExportHtml(document(source), settings(), format, citations);
      expect(html.indexOf('Before references')).toBeLessThan(html.indexOf('id="markedown-references"'));
      expect(html.indexOf('id="markedown-references"')).toBeLessThan(html.indexOf('id="appendix"'));
      expect(html.match(/id="markedown-references"/g)).toHaveLength(1);
      expect(html).toContain(`href="#ref-${keys[0]}"`);
      expect(html).toContain('Verified reference 1');
      expect(html).not.toContain(`[@${keys[0]}`);
    }
    const noMarker = source.replace(BIBLIOGRAPHY_MARKER, '');
    const html = await buildExportHtml(document(noMarker), settings(), 'htmlPlain', formatCitations(noMarker, references, settings()));
    expect(html.indexOf('After references.')).toBeLessThan(html.indexOf('id="markedown-references"'));
    expect(document(noMarker).source).not.toContain(BIBLIOGRAPHY_MARKER);
  });

  it('blocks unresolved or stale citations and duplicate bibliography placeholders', async () => {
    const source = `Cited [@${keys[0]}].`;
    const complete = formatCitations(source, references, settings());
    for (const citations of [undefined, { ...complete, clusters: {} }, { ...complete, bibliography: '' }, { ...complete, missing: [keys[0]] }]) await expect(buildExportHtml(document(source), settings(), 'html', citations)).rejects.toThrow('Resolve all cited');
    const duplicate = `${source}\n\n${BIBLIOGRAPHY_MARKER}\n\n${BIBLIOGRAPHY_MARKER}`;
    await expect(buildExportHtml(document(duplicate), settings(), 'html', complete)).rejects.toThrow('one bibliography');
  });

  it('blocks duplicate and unresolved equation references before any output is overwritten', async () => {
    const broken = ['See \\eqref{eq:missing}.', '$$x=1\\label{eq:dup}$$\n\n$$y=2\\label{eq:dup}$$'];
    for (const source of broken) {
      for (const format of ['html', 'htmlPlain', 'pdf', 'png', 'docx'] as const) {
        const target = path.join(directory, `preserved.${format}`);
        await writeFile(target, 'Original export');
        await expect(exportDocument(document(source), format, target, settings())).rejects.toThrow('Resolve equation references');
        expect(await readFile(target, 'utf8')).toBe('Original export');
      }
    }
    const literal = '`\\eqref{eq:missing}`\n\n```math\nnot an enabled formula\n```';
    await expect(buildExportHtml(document(literal), settings({ mathCodeBlocks: false }), 'htmlPlain')).resolves.toContain('eq:missing');
  });

  it('exports real DOCX with current citations, native math, Chinese-path media and bibliography paragraphs', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const assetDirectory = path.join(directory, '中文 assets');
    await mkdir(assetDirectory);
    const image = path.join(assetDirectory, '本地 图 #1.png');
    await writeFile(image, await sharp({ create: { width: 48, height: 32, channels: 4, background: '#278564' } }).png().toBuffer());
    const imageDestination = '中文 assets/本地 图 #1.png'.split('/').map(encodeURIComponent).join('/');
    const source = `# Manuscript\n\nBefore references [@${keys[0]}; @${keys[1]}; @${keys[2]}]. Inline \\(x_i\\).\n\n$$\n\\frac{a}{b}\\label{eq:fraction}\n$$\n\nSee \\eqref{eq:fraction}.\n\n$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\\label{eq:matrix}\n$$\n\nMatrix [@eq:matrix].\n\n![Local image](${imageDestination})\n\n\`\`\`js\nfirst();\nsecond();\n\`\`\`\n\n${BIBLIOGRAPHY_MARKER}\n\n# Appendix\n\nAfter references.`;
    const options = settings({ pandocPath, codeLineNumbers: true, wordChineseFont: 'Microsoft YaHei', wordLatinFont: 'Arial', wordTextColor: '#123456', wordBodyFontSize: 11, wordHeadingSizes: [20, 18, 16, 14, 12, 11], wordHeadingBold: false, wordHeadingItalic: true });
    const target = path.join(directory, '学术稿件 export.docx');
    await exportDocument(document(source), 'docx', target, options, formatCitations(source, references, options));
    const parts = unzipSync(await readFile(target));
    const body = xml(parts['word/document.xml']);
    const paragraphs = elements(body, 'p').map(node => node.textContent || '');
    expect(elements(body, 'oMath', M)).toHaveLength(3);
    expect(elements(body, 'f', M)).toHaveLength(1);
    expect(elements(body, 'm', M)).toHaveLength(1);
    expect(elements(body, 'drawing')).toHaveLength(1);
    const media = Object.entries(parts).filter(([name]) => name.startsWith('word/media/'));
    expect(media).toHaveLength(1);
    expect(await sharp(media[0][1]).metadata()).toMatchObject({ width: 48, height: 32 });
    const firstReference = paragraphs.findIndex(text => text.includes('Verified reference 1'));
    expect(firstReference).toBeGreaterThan(paragraphs.findIndex(text => text.includes('Before references')));
    expect(firstReference).toBeLessThan(paragraphs.findIndex(text => text.includes('After references.')));
    expect(paragraphs[firstReference]).toMatch(/^1\.\s+.*Verified reference 1/);
    expect(paragraphs.filter(text => /^\d+\.\s*$/.test(text))).toHaveLength(0);
    expect(paragraphs.join('\n')).toContain('See (1).');
    expect(paragraphs.join('\n')).toContain('Matrix (2).');
    const bookmarks = new Set(elements(body, 'bookmarkStart').map(node => node.getAttributeNS(W, 'name')));
    const anchors = elements(body, 'hyperlink').map(node => node.getAttributeNS(W, 'anchor')).filter(Boolean);
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    expect(anchors.every(anchor => bookmarks.has(anchor))).toBe(true);
    const numberedTables = elements(body, 'tbl').filter(node => elements(node, 'oMath', M).length);
    expect(numberedTables).toHaveLength(2);
    const page = elements(body, 'pgSz')[0];
    const margins = elements(body, 'pgMar')[0];
    expect(page).toBeDefined();
    expect(margins).toBeDefined();
    const availableWidth = Number(page.getAttributeNS(W, 'w')) - Number(margins.getAttributeNS(W, 'left')) - Number(margins.getAttributeNS(W, 'right'));
    expect(availableWidth).toBeGreaterThan(0);
    for (const table of numberedTables) {
      const cells = elements(table, 'tc');
      expect(cells).toHaveLength(2);
      expect(elements(cells[0], 'oMath', M)).toHaveLength(1);
      expect(elements(cells[0], 'jc', M)[0]?.getAttributeNS(M, 'val')).toBe('left');
      expect(cells[1].textContent).toMatch(/^\([12]\)$/);
      expect(elements(cells[1], 'vAlign')[0]?.getAttributeNS(W, 'val')).toBe('center');
      expect(elements(table, 'cantSplit')).toHaveLength(1);
      expect(elements(table, 'gridCol').reduce((sum, node) => sum + Number(node.getAttributeNS(W, 'w')), 0)).toBe(availableWidth);
    }
    expect(paragraphs.join('\n')).not.toContain('Old content on disk');
    expect(paragraphs.join('\n')).not.toContain('[@');
    expect(paragraphs.join('\n')).not.toContain('↵');
    const styles = xml(parts['word/styles.xml']);
    const defaults = elements(styles, 'docDefaults')[0];
    const fonts = elements(defaults, 'rFonts')[0];
    expect(fonts.getAttributeNS(W, 'eastAsia')).toBe('Microsoft YaHei');
    expect(fonts.getAttributeNS(W, 'ascii')).toBe('Arial');
    expect(elements(defaults, 'color')[0].getAttributeNS(W, 'val')).toBe('123456');
    expect(elements(defaults, 'sz')[0].getAttributeNS(W, 'val')).toBe('22');
    const heading = elements(styles, 'style').find(node => node.getAttributeNS(W, 'styleId') === 'Heading1')!;
    expect(elements(heading, 'sz')[0].getAttributeNS(W, 'val')).toBe('40');
    expect(elements(heading, 'b')[0].getAttributeNS(W, 'val')).toBe('0');
    expect(elements(heading, 'i')[0].getAttributeNS(W, 'val')).toBe('1');
  }, 30_000);

  it('preserves unnumbered TeX delimiter and math-code formulas as native DOCX equations', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const source = 'Inline \\(x^2\\).\n\n\\[\\frac{x}{y}\\]\n\n```math\n\\sqrt{x}\n```';
    const options = settings({ pandocPath, mathNumbering: 'none' });
    const target = path.join(directory, 'unnumbered.docx');
    await exportDocument(document(source), 'docx', target, options);
    const body = xml(unzipSync(await readFile(target))['word/document.xml']);
    expect(elements(body, 'oMath', M)).toHaveLength(3);
    expect(elements(body, 'f', M)).toHaveLength(1);
    expect(elements(body, 'rad', M)).toHaveLength(1);
    expect(elements(body, 't').map(node => node.textContent).join('')).not.toContain('(1)');
    expect(elements(body, 'jc', M).map(node => node.getAttributeNS(M, 'val'))).toEqual(['left', 'left']);
  }, 30_000);

  it('exports manual tags once with adjoining Word numbers and matching reference links', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const source = '\\eqref{eq:a}, \\ref{eq:a}, \\eqref{eq:s}.\n\n$$x\\tag{A}\\label{eq:a}$$\n\n$$y\\tag*{S1}\\label{eq:s}$$\n\n$$z\\notag$$\n\n$$q$$';
    const options = settings({ pandocPath, mathNumbering: 'all' });
    const target = path.join(directory, 'manual-tags.docx');
    await exportDocument(document(source), 'docx', target, options);
    const body = xml(unzipSync(await readFile(target))['word/document.xml']);
    const paragraphs = elements(body, 'p');
    expect(paragraphs.map(item => item.textContent).join('\n')).toContain('(A), A, (S1).');
    const formulas = paragraphs.filter(item => elements(item, 'oMath', M).length);
    expect(formulas.map(item => item.textContent)).toEqual(['x', 'y', 'z', 'q']);
    expect(elements(body, 'oMath', M)).toHaveLength(4);
    expect(elements(body, 'tbl').map(item => item.textContent)).toEqual(['x(A)', 'yS1', 'q(1)']);
    const anchors = new Set(elements(body, 'bookmarkStart').map(item => item.getAttributeNS(W, 'name')));
    expect(elements(body, 'hyperlink').every(item => anchors.has(item.getAttributeNS(W, 'anchor')))).toBe(true);
    await expect(buildExportHtml(document('$$x\\tag{A}\\tag{B}$$'), options, 'htmlPlain')).rejects.toThrow('Ambiguous equation numbering');
  }, 30_000);

  for (const mathAlignment of ['left', 'center', 'right'] as const) it(`keeps ${mathAlignment}-aligned multiline Word equations editable with numbers on either side`, async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const source = 'Inline $x_i$ stays inline. See \\eqref{eq:multi} and \\eqref{eq:manual}.\n\n$$\n\\begin{aligned}a &= b+c\\\\d &= e+f\\end{aligned}\\label{eq:multi}\n$$\n\n$$u=v\\tag*{S1}\\label{eq:manual}$$\n\n$$z=0\\notag$$';
    for (const mathNumberPosition of ['left', 'right'] as const) {
      const options = settings({ pandocPath, mathAlignment, mathNumberPosition });
      const target = path.join(directory, `layout-${mathAlignment}-${mathNumberPosition}.docx`);
      await exportDocument(document(source), 'docx', target, options);
      const body = xml(unzipSync(await readFile(target))['word/document.xml']);
      const tables = elements(body, 'tbl');
      expect(tables).toHaveLength(2);
      expect(elements(body, 'oMath', M)).toHaveLength(4);
      expect(elements(body, 'oMathPara', M)).toHaveLength(3);
      expect(elements(body, 'jc', M).map(node => node.getAttributeNS(M, 'val'))).toEqual([mathAlignment, mathAlignment, mathAlignment]);
      expect(elements(body, 'drawing')).toHaveLength(0);
      const inline = elements(body, 'p').find(node => node.textContent?.startsWith('Inline'))!;
      expect(elements(inline, 'oMath', M)).toHaveLength(1);
      expect(elements(inline, 'oMathPara', M)).toHaveLength(0);
      expect(inline.textContent).toContain('See (1) and (S1).');
      tables.forEach((table, index) => {
        const cells = elements(table, 'tc');
        const numberColumn = mathNumberPosition === 'left' ? 0 : cells.length - 1;
        const formulaColumn = mathNumberPosition === 'left' ? 1 : 0;
        expect(cells).toHaveLength(2);
        expect(cells[numberColumn].textContent).toBe(index === 0 ? '(1)' : 'S1');
        expect(elements(cells[numberColumn], 'vAlign')[0].getAttributeNS(W, 'val')).toBe('center');
        expect(elements(cells[formulaColumn], 'oMathPara', M)).toHaveLength(1);
        expect(elements(cells[formulaColumn], 'jc')[0].getAttributeNS(W, 'val')).toBe('left');
        expect(elements(cells[formulaColumn], 'jc', M)[0].getAttributeNS(M, 'val')).toBe(mathAlignment);
        expect(elements(table, 'cantSplit')).toHaveLength(1);
        expect(elements(table, 'tblBorders')[0].childNodes.length).toBe(6);
        expect(elements(cells[formulaColumn], 'tcBorders')[0].childNodes.length).toBe(6);
        expect(table.nextSibling?.nodeName).toBe('w:p');
      });
      const multiline = elements(tables[0], 'oMath', M)[0];
      expect(multiline.textContent).toContain('a=b+c');
      expect(multiline.textContent).toContain('d=e+f');
      const bookmarks = elements(body, 'bookmarkStart');
      const ids = bookmarks.map(node => node.getAttributeNS(W, 'id'));
      expect(new Set(ids).size).toBe(ids.length);
      const anchors = new Set(bookmarks.map(node => node.getAttributeNS(W, 'name')));
      expect(elements(body, 'hyperlink').every(node => anchors.has(node.getAttributeNS(W, 'anchor')))).toBe(true);
    }
  }, 30_000);

  it('never fetches remote image references during academic Pandoc export', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const remote = `http://127.0.0.1:${(server.address() as { port: number }).port}/image.png`;
      const source = `[@${keys[0]}]\n\n![Remote](${remote})`;
      await expect(exportDocument(document(source), 'docx', path.join(directory, 'network.docx'), settings({ pandocPath }), formatCitations(source, references, settings()))).rejects.toThrow('cannot resolve a local image');
      expect(requests).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 30_000);

  it('maps equation alignment and manual numbers into standalone LaTeX while preserving reference targets', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const source = 'See \\eqref{eq:sum} and \\eqref{eq:manual}.\n\n$$\\begin{aligned}x&=a+b\\\\y&=c+d\\end{aligned}\\label{eq:sum}$$\n\n$$q\\tag*{S1}\\label{eq:manual}$$';
    for (const mathAlignment of ['left', 'center', 'right'] as const) for (const mathNumberPosition of ['left', 'right'] as const) {
      const target = path.join(directory, `layout-${mathAlignment}-${mathNumberPosition}.tex`);
      await exportDocument(document(source), 'tex', target, settings({ pandocPath, mathAlignment, mathNumberPosition }));
      const content = await readFile(target, 'utf8');
      expect(content).toContain('\\displaystyle');
      expect(content).toContain(`\\parbox[c]{0.88\\linewidth}{\\${mathAlignment === 'center' ? 'centering' : mathAlignment === 'right' ? 'raggedleft' : 'raggedright'}`);
      expect(content).toContain(`\\parbox[c]{0.12\\linewidth}{\\${mathNumberPosition === 'left' ? 'raggedright' : 'raggedleft'} S1}`);
      expect(content).not.toContain('\\tag');
      const targets = new Set([...content.matchAll(/\\hypertarget\{([^}]+)\}/g)].map(match => match[1]));
      const links = [...content.matchAll(/\\hyperlink\{([^}]+)\}/g)].map(match => match[1]);
      expect(links.length).toBeGreaterThanOrEqual(2);
      expect(links.every(target => targets.has(target))).toBe(true);
    }
  }, 30_000);

  it('embeds equation layout styles and semantic MathML in EPUB', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const target = path.join(directory, 'layout.epub');
    await exportDocument(document('See \\eqref{eq:x}.\n\n$$x=1\\label{eq:x}$$'), 'epub', target, settings({ pandocPath, mathAlignment: 'right', mathNumberPosition: 'left' }));
    const files = Object.entries(unzipSync(await readFile(target)));
    const styles = files.filter(([name]) => name.endsWith('.css')).map(([, content]) => strFromU8(content)).join('\n');
    const pages = files.filter(([name]) => name.endsWith('.xhtml')).map(([, content]) => strFromU8(content)).join('\n');
    expect(styles).toContain('.md-equation-number');
    expect(styles).toContain('.math-block');
    expect(pages).toMatch(/<math\b/);
    expect(pages).toContain('md-equation-number');
    expect(pages).toContain('data-math-align="right"');
    expect(pages).toContain('data-number-position="left"');
    expect(pages).toContain('(1)');
  }, 30_000);

  it('keeps durable image resources for text formats and removes them if export cannot finish', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    await writeFile(path.join(directory, 'figure.png'), await sharp({ create: { width: 36, height: 24, channels: 4, background: '#527299' } }).png().toBuffer());
    const source = `# Heading\n\n[@${keys[0]}]\n\n![Image](figure.png)\n\n$$x^2$$`;
    const citations = formatCitations(source, references, settings());
    for (const format of ['tex', 'rst', 'textile', 'mediawiki'] as const) {
      const output = path.join(directory, `source.${format}`);
      await exportDocument(document(source), format, output, settings({ pandocPath }), citations);
      const text = await readFile(output, 'utf8');
      const asset = /markedown-assets-[a-z\d-]+\/image-1\.png/.exec(text)?.[0];
      expect(asset, format).toBeTruthy();
      expect(await sharp(await readFile(path.join(directory, asset!))).metadata()).toMatchObject({ width: 36, height: 24 });
      expect(text).toContain('Verified reference 1');
    }
    const before = (await readdir(directory)).filter(name => name.startsWith('markedown-assets-')).sort();
    const blocked = path.join(directory, 'directory-instead-of-file.tex');
    await mkdir(blocked);
    await expect(exportDocument(document(source), 'tex', blocked, settings({ pandocPath }), citations)).rejects.toThrow();
    expect((await readdir(directory)).filter(name => name.startsWith('markedown-assets-')).sort()).toEqual(before);
  }, 30_000);
});
