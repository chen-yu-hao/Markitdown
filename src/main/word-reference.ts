import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { defaultSettings, type Settings } from '../shared/contracts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const children = (element: Element, name: string): Element[] => Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1 && (node as Element).namespaceURI === W && (node as Element).localName === name);
function ensure(parent: Element, name: string) { return children(parent, name)[0] || parent.appendChild(parent.ownerDocument!.createElementNS(W, `w:${name}`)); }
const elements = (document: Document, name: string) => Array.from(document.getElementsByTagNameNS(W, name));
function attribute(element: Element, name: string, value: string) { element.setAttributeNS(W, `w:${name}`, value); }
const runPropertyOrder = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];
const stylePropertyOrder = ['name', 'aliases', 'basedOn', 'next', 'link', 'autoRedefine', 'hidden', 'uiPriority', 'semiHidden', 'unhideWhenUsed', 'qFormat', 'locked', 'personal', 'personalCompose', 'personalReply', 'rsid', 'pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr'];

/** Word property sequences are schema ordered; keep unknown extensions in their existing slots. */
function orderProperties(parent: Element, order: readonly string[]): void {
  const rank = new Map(order.map((name, index) => [name, index]));
  const nodes = Array.from(parent.childNodes);
  const known = (node: Node): node is Element => node.nodeType === 1 && (node as Element).namespaceURI === W && rank.has((node as Element).localName);
  const sorted = nodes.filter(known).sort((left, right) => rank.get(left.localName)! - rank.get(right.localName)!);
  let cursor = 0;
  const arranged = nodes.map(node => known(node) ? sorted[cursor++] : node);
  if (arranged.every((node, index) => node === nodes[index])) return;
  for (const node of nodes) parent.removeChild(node);
  for (const node of arranged) parent.appendChild(node);
}

/** Apply explicit Word fonts instead of letting Office theme fonts and accents win. */
export function applyWordStyles(bytes: Uint8Array, options: Partial<Settings> = {}): Buffer {
  const settings = { ...defaultSettings, ...options };
  const files = unzipSync(bytes);
  if (!files['word/styles.xml'] || !files['word/document.xml']) throw new Error('The Word document is missing required styles.');
  const color = /^#[a-f\d]{6}$/i.test(settings.wordTextColor) ? settings.wordTextColor.slice(1).toUpperCase() : '000000';
  const chinese = settings.wordChineseFont?.trim() || defaultSettings.wordChineseFont;
  const latin = settings.wordLatinFont?.trim() || defaultSettings.wordLatinFont;
  const size = (value: number) => String(Math.round(Math.min(72, Math.max(6, Number.isFinite(value) ? value : 12)) * 2));
  const bodySize = size(settings.wordBodyFontSize);
  const headingSizes = settings.wordHeadingSizes?.length === 6 ? settings.wordHeadingSizes : defaultSettings.wordHeadingSizes;
  function font(properties: Element) {
    const fonts = ensure(properties, 'rFonts');
    for (const attr of Array.from(fonts.attributes)) fonts.removeAttributeNode(attr);
    attribute(fonts, 'ascii', latin); attribute(fonts, 'hAnsi', latin); attribute(fonts, 'cs', latin); attribute(fonts, 'eastAsia', chinese);
    if (properties.firstChild !== fonts) properties.insertBefore(fonts, properties.firstChild);
    const ink = ensure(properties, 'color');
    for (const attr of Array.from(ink.attributes)) ink.removeAttributeNode(attr);
    attribute(ink, 'val', color);
  }
  function fontSize(properties: Element, value: string) {
    attribute(ensure(properties, 'sz'), 'val', value); attribute(ensure(properties, 'szCs'), 'val', value);
  }
  for (const [name, file] of Object.entries(files)) {
    if (!/^word\/.*\.xml$/.test(name)) continue;
    const document = new DOMParser({ errorHandler: { fatalError(message) { throw new Error(message); } } }).parseFromString(strFromU8(file), 'application/xml');
    if (name === 'word/styles.xml') {
      const defaults = ensure(document.documentElement, 'docDefaults');
      fontSize(ensure(ensure(defaults, 'rPrDefault'), 'rPr'), bodySize);
      for (const style of elements(document, 'style')) {
        const id = style.getAttributeNS(W, 'styleId') || '';
        const heading = /^Heading([1-6])$/.exec(id);
        const properties = ensure(style, 'rPr');
        if (style.getAttributeNS(W, 'type') === 'paragraph') {
          fontSize(properties, heading ? size(headingSizes[Number(heading[1]) - 1]) : id === 'Title' ? size(headingSizes[0]) : bodySize);
        }
        if (heading || id === 'Title') {
          attribute(ensure(properties, 'b'), 'val', settings.wordHeadingBold ? '1' : '0');
          attribute(ensure(properties, 'bCs'), 'val', settings.wordHeadingBold ? '1' : '0');
          attribute(ensure(properties, 'i'), 'val', settings.wordHeadingItalic ? '1' : '0');
          attribute(ensure(properties, 'iCs'), 'val', settings.wordHeadingItalic ? '1' : '0');
          const paragraph = ensure(style, 'pPr');
          for (const border of children(paragraph, 'pBdr')) paragraph.removeChild(border);
        }
      }
    }
    // This includes links, table text, notes, list labels and direct run overrides.
    for (const properties of elements(document, 'rPr')) font(properties);
    for (const ink of elements(document, 'color')) {
      for (const attr of Array.from(ink.attributes)) ink.removeAttributeNode(attr);
      attribute(ink, 'val', color);
    }
    if (name === 'word/numbering.xml') for (const level of elements(document, 'lvl')) {
      font(ensure(level, 'rPr'));
      if (children(level, 'numFmt')[0]?.getAttributeNS(W, 'val') === 'bullet') attribute(ensure(level, 'lvlText'), 'val', '•');
    }
    if (name.startsWith('word/theme/')) {
      for (const tag of ['majorFont', 'minorFont']) for (const scheme of Array.from(document.getElementsByTagNameNS(A, tag))) {
        for (const node of Array.from(scheme.childNodes)) {
          if (node.nodeType !== 1) continue;
          const element = node as Element;
          if (element.localName === 'latin' || element.localName === 'cs') element.setAttribute('typeface', latin);
          if (element.localName === 'ea' || ['Hans', 'Hant'].includes(element.getAttribute('script') || '')) element.setAttribute('typeface', chinese);
        }
      }
    }
    for (const properties of elements(document, 'rPr')) orderProperties(properties, runPropertyOrder);
    if (name === 'word/styles.xml') for (const style of elements(document, 'style')) orderProperties(style, stylePropertyOrder);
    files[name] = strToU8(new XMLSerializer().serializeToString(document));
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}
