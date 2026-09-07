import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { defaultSettings, type DocumentSession, type Settings } from '../src/shared/contracts';
import { exportDocument, findPandoc } from '../src/main/export-service';
import { applyWordStyles } from '../src/main/word-reference';

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const defaults = { chinese: '宋体', latin: 'Times New Roman', color: '000000' };
type Typography = typeof defaults;
const execFileAsync = promisify(execFile);
let reference: Promise<Buffer | null> | undefined;
function originalReference(): Promise<Buffer | null> {
  reference ??= (async () => {
    const pandoc = await findPandoc();
    if (!pandoc) return null;
    const { stdout } = await execFileAsync(pandoc, ['--print-default-data-file=reference.docx'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return stdout;
  })();
  return reference;
}

/** Check real OOXML parts rather than the code that assembles the export command. */
function xmlParts(bytes: Uint8Array): Map<string, Document> {
  const parts = new Map<string, Document>();
  const fail = (message: string) => { throw new Error(message); };
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    if (name.endsWith('.xml')) parts.set(name, new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } }).parseFromString(Buffer.from(data).toString('utf8'), 'application/xml'));
  }
  return parts;
}

function elements(node: Document | Element, localName: string, namespace = WORD): Element[] {
  return Array.from(node.getElementsByTagNameNS(namespace, localName));
}

const attribute = (node: Element | undefined, name: string) => node?.getAttributeNS(WORD, name) ?? '';

function assertNoFontOrColorOverride(xml: Document, typography = defaults): void {
  for (const fonts of elements(xml, 'rFonts')) {
    expect(Array.from(fonts.attributes).some(attr => /Theme$/i.test(attr.localName)), fonts.toString()).toBe(false);
    for (const name of ['ascii', 'hAnsi', 'cs']) {
      if (attribute(fonts, name)) expect(attribute(fonts, name), fonts.toString()).toBe(typography.latin);
    }
    if (attribute(fonts, 'eastAsia')) expect(attribute(fonts, 'eastAsia'), fonts.toString()).toBe(typography.chinese);
  }
  for (const color of elements(xml, 'color')) {
    expect(attribute(color, 'val'), color.toString()).toBe(typography.color);
    expect(Array.from(color.attributes).some(attr => /theme/i.test(attr.localName)), color.toString()).toBe(false);
  }
  for (const properties of elements(xml, 'rPr')) {
    const names = Array.from(properties.childNodes).filter(node => node.nodeType === 1).map(node => (node as Element).localName);
    for (const [before, after] of [['rStyle', 'rFonts'], ['rFonts', 'b'], ['b', 'color'], ['bCs', 'color'], ['color', 'sz'], ['sz', 'szCs'], ['sz', 'u']]) {
      if (names.includes(before) && names.includes(after)) expect(names.indexOf(before), properties.toString()).toBeLessThan(names.indexOf(after));
    }
  }
}

function assertWordDefaults(parts: Map<string, Document>, typography = defaults): void {
  const styles = parts.get('word/styles.xml')!;
  expect(styles).toBeTruthy();
  const docDefaults = elements(styles, 'docDefaults')[0];
  const fonts = elements(docDefaults, 'rFonts')[0];
  expect(attribute(fonts, 'ascii')).toBe(typography.latin);
  expect(attribute(fonts, 'hAnsi')).toBe(typography.latin);
  expect(attribute(fonts, 'eastAsia')).toBe(typography.chinese);
  expect(attribute(elements(docDefaults, 'color')[0], 'val')).toBe(typography.color);
  assertNoFontOrColorOverride(styles, typography);
  // These cover paragraph, list, table, inline code, link and footnote inheritance.
  const ids = new Set(elements(styles, 'style').map(style => attribute(style, 'styleId')));
  for (const id of ['Normal', 'BodyText', 'FirstParagraph', 'Compact', 'Title', 'Subtitle', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', 'Hyperlink', 'Table', 'VerbatimChar', 'FootnoteText', 'FootnoteReference', 'TOCHeading']) {
    expect(ids.has(id), `Missing Word style ${id}`).toBe(true);
  }
  for (const style of elements(styles, 'style')) {
    const names = Array.from(style.childNodes).filter(node => node.nodeType === 1).map(node => (node as Element).localName);
    if (names.includes('pPr') && names.includes('rPr')) expect(names.indexOf('pPr'), style.toString()).toBeLessThan(names.indexOf('rPr'));
  }
}

function assertThemeFonts(parts: Map<string, Document>, typography: Typography): void {
  const theme = parts.get('word/theme/theme1.xml')!;
  expect(theme).toBeTruthy();
  for (const family of ['majorFont', 'minorFont']) {
    const block = elements(theme, family, DRAWING)[0];
    expect(elements(block, 'latin', DRAWING)[0]?.getAttribute('typeface')).toBe(typography.latin);
    expect(elements(block, 'ea', DRAWING)[0]?.getAttribute('typeface')).toBe(typography.chinese);
    for (const font of elements(block, 'font', DRAWING)) {
      if (['Hans', 'Hant'].includes(font.getAttribute('script') ?? '')) expect(font.getAttribute('typeface')).toBe(typography.chinese);
    }
  }
}

function assertHeadingSizes(parts: Map<string, Document>, points: number[]): void {
  const styles = elements(parts.get('word/styles.xml')!, 'style');
  points.forEach((size, index) => {
    const style = styles.find(item => attribute(item, 'styleId') === `Heading${index + 1}`)!;
    expect(attribute(elements(style, 'sz')[0], 'val')).toBe(String(size * 2));
  });
}

function assertHeadingItalic(parts: Map<string, Document>, italic: boolean): void {
  const styles = elements(parts.get('word/styles.xml')!, 'style').filter(style => /^(Heading[1-6]|Title)$/.test(attribute(style, 'styleId')));
  for (const style of styles) {
    expect(attribute(elements(style, 'i')[0], 'val')).toBe(italic ? '1' : '0');
    expect(attribute(elements(style, 'iCs')[0], 'val')).toBe(italic ? '1' : '0');
  }
}

let directory: string | undefined;
afterEach(async () => { if (directory) { await rm(directory, { recursive: true, force: true }); directory = undefined; } });

describe('Word export typography', () => {
  it('replaces real Word defaults and styles with Songti and Times New Roman in black', async context => {
    const original = await originalReference();
    if (!original) { context.skip(); return; }
    const parts = xmlParts(applyWordStyles(original));
    assertWordDefaults(parts);
    assertHeadingItalic(parts, false);
    for (const [name, xml] of parts) if (name.startsWith('word/')) assertNoFontOrColorOverride(xml);
  });

  it('prevents Office major/minor theme fonts from replacing the document fonts', async context => {
    const original = await originalReference();
    if (!original) { context.skip(); return; }
    const parts = xmlParts(applyWordStyles(original));
    assertThemeFonts(parts, defaults);
  });

  it('applies configurable fonts, color, body size, heading sizes and bold without altering the input', async context => {
    const template = await originalReference();
    if (!template) { context.skip(); return; }
    const original = Buffer.from(template);
    const settings: Settings = { ...defaultSettings, wordChineseFont: '楷体', wordLatinFont: 'Georgia', wordTextColor: '#123456', wordBodyFontSize: 13, wordHeadingSizes: [26, 24, 20, 18, 16, 14], wordHeadingBold: false, wordHeadingItalic: true };
    const parts = xmlParts(applyWordStyles(template, settings));
    const typography = { chinese: '楷体', latin: 'Georgia', color: '123456' };
    assertWordDefaults(parts, typography);
    assertThemeFonts(parts, typography);
    assertHeadingSizes(parts, settings.wordHeadingSizes);
    assertHeadingItalic(parts, true);
    const styles = parts.get('word/styles.xml')!;
    expect(attribute(elements(elements(styles, 'docDefaults')[0], 'sz')[0], 'val')).toBe('26');
    for (const style of elements(styles, 'style').filter(item => /^Heading[1-6]$/.test(attribute(item, 'styleId')))) {
      const bold = elements(style, 'b')[0];
      expect(['0', 'false', 'off']).toContain(attribute(bold, 'val'));
    }
    for (const [name, xml] of parts) if (name.startsWith('word/')) assertNoFontOrColorOverride(xml, typography);
    expect(template).toEqual(original);
  });

  it('removes direct font and theme color overrides from body and footnote runs', async context => {
    const original = await originalReference();
    if (!original) { context.skip(); return; }
    const parts = unzipSync(original);
    const run = '<w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:rFonts w:ascii="Arial" w:eastAsia="黑体" w:asciiTheme="majorHAnsi"/><w:i/><w:color w:val="FF0000" w:themeColor="accent1" w:themeTint="99"/><w:sz w:val="24"/><w:u w:val="single"/></w:rPr><w:t>中英 Body and note</w:t></w:r>';
    parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${WORD}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr>${run}</w:p></w:body></w:document>`);
    parts['word/footnotes.xml'] = strToU8(`<w:footnotes xmlns:w="${WORD}"><w:footnote w:id="1"><w:p>${run}</w:p></w:footnote></w:footnotes>`);
    const normalized = xmlParts(applyWordStyles(zipSync(parts)));
    for (const name of ['word/document.xml', 'word/footnotes.xml']) {
      const xml = normalized.get(name)!;
      assertNoFontOrColorOverride(xml);
      expect(xml.documentElement.textContent).toBe('中英 Body and note');
      expect(elements(xml, 'i')).toHaveLength(1);
      expect(attribute(elements(xml, 'i')[0], 'val')).toBe('');
    }
  });

  it('keeps list labels readable after removing the Symbol font', async context => {
    const original = await originalReference();
    if (!original) { context.skip(); return; }
    const parts = unzipSync(original);
    parts['word/numbering.xml'] = strToU8(`<w:numbering xmlns:w="${WORD}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="\uf0b7"/><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/><w:color w:val="0000FF"/></w:rPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum></w:numbering>`);
    const numbering = xmlParts(applyWordStyles(zipSync(parts))).get('word/numbering.xml')!;
    assertNoFontOrColorOverride(numbering);
    const levels = elements(numbering, 'lvl');
    expect(attribute(elements(levels[0], 'lvlText')[0], 'val')).toBe('•');
    expect(attribute(elements(levels[1], 'lvlText')[0], 'val')).toBe('%1.');
    expect(elements(numbering, 'rFonts')).toHaveLength(2);
  });

  it('rejects an incomplete Word archive', () => {
    expect(() => applyWordStyles(zipSync({ 'word/document.xml': strToU8(`<w:document xmlns:w="${WORD}"/>`) }))).toThrow('missing required styles');
  });

  it('uses the bundled defaults for an actual DOCX, including code, tables, lists and hyperlinks', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-word-style-'));
    const source = '# 一级标题 Heading one\n\n## 二级标题 Heading two\n\n### 三级标题 Heading three\n\n#### 四级标题 Heading four\n\n##### 五级标题 Heading five\n\n###### 六级标题 Heading six\n\n正文 Chinese and English, **粗体 Bold**, *斜体 Italic*, [链接 Link](https://example.com).\n\n- 列表 Item\n\n1. 编号 Numbered\n\n| 中文 Column | 值 Value |\n|---|---|\n| 单元格 Cell | 123 |\n\n行内代码 `const value = 42;`\n\n```javascript\nconst 中文 = "black text";\n// code comment\n```';
    const current: DocumentSession = {
      id: 'word-fonts', path: path.join(directory, '中英 test.md'), title: '字体 Font verification', source,
      savedSource: 'Old saved text', dirty: true, recovered: false, bom: false, lineEnding: 'LF', revision: null,
      mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 1,
    };
    const output = path.join(directory, '中英 Word.docx');
    await exportDocument(current, 'docx', output, { ...defaultSettings, theme: 'night', separateDarkTheme: false, exportTheme: true, pandocPath });
    const parts = xmlParts(await readFile(output));
    assertWordDefaults(parts);
    assertHeadingSizes(parts, defaultSettings.wordHeadingSizes);
    assertHeadingItalic(parts, false);
    const body = parts.get('word/document.xml')!;
    for (const content of ['一级标题', '六级标题', 'Chinese and English', 'black text', '单元格', '编号']) expect(body.documentElement.textContent).toContain(content);
    expect(body.documentElement.textContent).not.toContain('Old saved text');
    expect(elements(body, 'hyperlink').length).toBeGreaterThan(0);
    expect(elements(body, 'tbl').length).toBeGreaterThan(0);
    expect(elements(body, 'numPr').length).toBeGreaterThan(0);
    for (const [name, xml] of parts) if (name.startsWith('word/')) assertNoFontOrColorOverride(xml);
    // Syntax highlighting must not reintroduce token colors or its generated token styles.
    expect(elements(body, 'rStyle').some(style => /^(Keyword|Comment|String|DecVal|Function)$/.test(attribute(style, 'val')))).toBe(false);

    const customSettings: Settings = { ...defaultSettings, pandocPath, wordChineseFont: '楷体', wordLatinFont: 'Georgia', wordTextColor: '#123456', wordBodyFontSize: 13, wordHeadingSizes: [26, 24, 20, 18, 16, 14], wordHeadingBold: false, wordHeadingItalic: true };
    const customOutput = path.join(directory, '自定义 Word.docx');
    await exportDocument(current, 'docx', customOutput, customSettings);
    const customized = xmlParts(await readFile(customOutput));
    const typography = { chinese: '楷体', latin: 'Georgia', color: '123456' };
    assertWordDefaults(customized, typography);
    assertHeadingSizes(customized, customSettings.wordHeadingSizes);
    assertHeadingItalic(customized, true);
    for (const [name, xml] of customized) if (name.startsWith('word/')) assertNoFontOrColorOverride(xml, typography);
  }, 30_000);
});
