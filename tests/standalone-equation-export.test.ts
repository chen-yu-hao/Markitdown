import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { exportDocument, findPandoc } from '../src/main/export-service';
import { defaultSettings, type DocumentSession, type Settings } from '../src/shared/contracts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const MML = 'http://www.w3.org/1998/Math/MathML';
const XHTML = 'http://www.w3.org/1999/xhtml';
const source = 'In text $u$.\n\n$E=\\frac{a}{b}\\label{eq:e}$\n\n\\(F=ma\\){#eq:f}\n\n$$v=c\\label{eq:v}$$\n\nSee \\eqref{eq:e}, \\eqref{eq:f} and \\eqref{eq:v}.';
let directory: string;
const document = (text = source): DocumentSession => ({ id: 'standalone-equation-export', path: path.join(directory, 'draft.md'), title: 'Current equations', source: text, savedSource: 'Old content on disk', dirty: true, recovered: false, bom: false, lineEnding: 'LF', revision: null, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 1 });
const settings = (extra: Partial<Settings> = {}): Settings => ({ ...structuredClone(defaultSettings), language: 'en', exportOutline: false, ...extra });
const xml = (bytes: Uint8Array) => new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
const elements = (node: Document | Element, name: string, namespace = W) => Array.from(node.getElementsByTagNameNS(namespace, name));
const hasClass = (node: Element, value: string) => (node.getAttribute('class') || '').split(/\s+/).includes(value);

beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-standalone-export-')); });
afterEach(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('markedown-standalone-export-')) throw new Error('Unsafe standalone export cleanup.');
  await rm(directory, { recursive: true, force: true });
});

describe('standalone paragraph equation export', () => {
  it('exports promoted paragraphs as native Word display equations with continuous numbers and links', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const target = path.join(directory, 'standalone.docx');
    const current = document();
    await exportDocument(current, 'docx', target, settings({ pandocPath, mathAlignment: 'right', mathNumberPosition: 'left' }));
    const body = xml(unzipSync(await readFile(target))['word/document.xml']);
    expect(elements(body, 'oMath', M)).toHaveLength(4);
    expect(elements(body, 'oMathPara', M)).toHaveLength(3);
    expect(elements(body, 'f', M)).toHaveLength(1);
    const tables = elements(body, 'tbl').filter(table => elements(table, 'oMath', M).length);
    expect(tables).toHaveLength(3);
    for (const [index, table] of tables.entries()) {
      const cells = elements(table, 'tc');
      expect(cells).toHaveLength(2);
      expect(cells[0].textContent).toBe(`(${index + 1})`);
      expect(elements(cells[1], 'oMathPara', M)).toHaveLength(1);
      expect(elements(cells[1], 'jc', M)[0].getAttributeNS(M, 'val')).toBe('right');
    }
    expect(body.documentElement.textContent).toContain('See (1), (2) and (3).');
    const bookmarks = new Set(elements(body, 'bookmarkStart').map(node => node.getAttributeNS(W, 'name')));
    const links = elements(body, 'hyperlink').map(node => node.getAttributeNS(W, 'anchor')).filter(Boolean);
    expect(links).toHaveLength(3);
    expect(links.every(link => bookmarks.has(link))).toBe(true);
    expect(body.documentElement.textContent).not.toContain('Old content on disk');
    expect(current.source).toBe(source);
    expect(current.dirty).toBe(true);
  }, 30_000);

  for (const [preferences, displayCount] of [
    [{ mathStandaloneParagraphs: false }, 0],
    [{ mathNumbering: 'none' }, 2],
  ] as const) {
    it(`keeps opt-out and numbering choices independent in native Word output: ${JSON.stringify(preferences)}`, async context => {
      const pandocPath = await findPandoc();
      if (!pandocPath) { context.skip(); return; }
      const target = path.join(directory, 'preferences.docx');
      await exportDocument(document('In text $u$.\n\n$E=mc^2$\n\n\\(F=ma\\)'), 'docx', target, settings({ pandocPath, ...preferences }));
      const body = xml(unzipSync(await readFile(target))['word/document.xml']);
      expect(elements(body, 'oMath', M)).toHaveLength(3);
      expect(elements(body, 'oMathPara', M)).toHaveLength(displayCount);
      expect(elements(body, 'tbl')).toHaveLength(0);
    }, 30_000);
  }

  it('exports promoted formulas through the LaTeX display-layout filter and retains all reference targets', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const target = path.join(directory, 'standalone.tex');
    await exportDocument(document(), 'tex', target, settings({ pandocPath }));
    const text = await readFile(target, 'utf8');
    expect(text.match(/\\displaystyle /g)).toHaveLength(3);
    expect(text.match(/\\parbox\[c\]\{0\.88\\linewidth\}/g)).toHaveLength(3);
    for (const number of [1, 2, 3]) expect(text).toContain(`\\parbox[c]{0.12\\linewidth}{\\raggedleft (${number})}`);
    const targets = new Set([...text.matchAll(/\\hypertarget\{([^}]+)\}/g)].map(match => match[1]));
    const links = [...text.matchAll(/\\hyperlink\{([^}]+)\}/g)].map(match => match[1]);
    expect(links).toHaveLength(3);
    expect(links.every(link => targets.has(link))).toBe(true);
    expect(text).not.toContain('Old content on disk');
  }, 30_000);

  it('exports EPUB display MathML and equation numbers while preserving inline prose math', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const target = path.join(directory, 'standalone.epub');
    await exportDocument(document(), 'epub', target, settings({ pandocPath }));
    const files = Object.entries(unzipSync(await readFile(target)));
    const pages = files.filter(([name]) => name.endsWith('.xhtml')).map(([, bytes]) => xml(bytes));
    const formulas = pages.flatMap(page => elements(page, 'math', MML));
    expect(formulas).toHaveLength(4);
    expect(formulas.filter(node => node.getAttribute('display') === 'block')).toHaveLength(3);
    const blocks = pages.flatMap(page => elements(page, 'div', XHTML)).filter(node => hasClass(node, 'math-block'));
    expect(blocks).toHaveLength(3);
    expect(blocks.map(block => elements(block, 'span', XHTML).find(node => hasClass(node, 'md-equation-number'))?.textContent)).toEqual(['(1)', '(2)', '(3)']);
    expect(pages.map(page => page.documentElement.textContent).join('\n')).toContain('See (1), (2) and (3).');
    const styles = files.filter(([name]) => name.endsWith('.css')).map(([, bytes]) => strFromU8(bytes)).join('\n');
    expect(styles).toContain('.math-block.md-numbered');
  }, 30_000);
});
