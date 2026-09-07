import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import MarkdownIt from 'markdown-it';
import sharp from 'sharp';
import type { DocumentSession, ExportFormat, Settings } from '../shared/contracts';
import { analyzeMarkdown, exportCss, renderMarkdown } from '../shared/markdown';
import { exportThemeCss, themeTokens } from '../shared/themes';
import { atomicWrite } from './document-service';
import { imageResponse, importImages, resolveImage } from './image-service';
import { applyWordStyles } from './word-reference';
import sanitizeHtml from 'sanitize-html';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import type { CitationRenderData } from '../shared/academic-contracts';
import { BIBLIOGRAPHY_MARKER, citationCss, scanCitations } from '../shared/citations';
import { getEquationIndex } from '../shared/markdown';
import { mathCss } from '../shared/math-renderer';

const execFileAsync = promisify(execFile);
const RENDER_TIMEOUT = 45_000;
const MAX_DOCUMENT_DIMENSION = 1_000_000;
let cachedFontCss: Promise<string> | undefined;

function allImageDestinations(source: string): Set<string> {
  const parser = new MarkdownIt({ html: false });
  parser.validateLink = () => true;
  const destinations = new Set<string>();
  const visit = (tokens: ReturnType<InstanceType<typeof MarkdownIt>['parse']>): void => {
    for (const token of tokens) {
      if (token.type === 'image') destinations.add(String(token.attrGet('src') ?? ''));
      if (token.children) visit(token.children);
    }
  };
  visit(parser.parse(source, {}));
  return destinations;
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

async function offlineKatexCss(): Promise<string> {
  cachedFontCss ??= (async () => {
    const candidates = [
      ...(typeof __dirname === 'string' ? [path.join(__dirname, 'katex.min.css')] : []),
      path.join(process.cwd(), 'node_modules', 'katex', 'dist', 'katex.min.css'),
    ];
    let cssPath: string | undefined;
    for (const candidate of candidates) {
      try { await access(candidate); cssPath = candidate; break; } catch { /* Try the packaged or development asset location. */ }
    }
    if (!cssPath) throw new Error('The bundled KaTeX stylesheet is missing. Rebuild the application.');
    let css = await readFile(cssPath, 'utf8');
    const matches = [...css.matchAll(/url\(([^)]+)\)/g)];
    for (const match of matches) {
      const relative = match[1].replace(/^["']|["']$/g, '');
      const fontPath = path.resolve(path.dirname(cssPath), relative);
      if (!fontPath.startsWith(path.dirname(cssPath) + path.sep)) throw new Error('Invalid bundled font path.');
      const font = await readFile(fontPath);
      const extension = path.extname(fontPath).slice(1);
      css = css.replace(match[0], `url(data:font/${extension};base64,${font.toString('base64')})`);
    }
    return css;
  })();
  return cachedFontCss;
}

/** Keep the semantic MathML branch when an HTML document intentionally has no styles. */
function unstyledContent(html: string): string {
  const tags = /<span\b[^>]*>|<\/span>/g;
  let depth = 0;
  let copiedThrough = 0;
  let output = '';
  for (const match of html.matchAll(tags)) {
    if (depth) {
      depth += match[0].startsWith('</') ? -1 : 1;
      if (!depth) copiedThrough = match.index + match[0].length;
    } else if (/class="katex-html"/.test(match[0])) {
      output += html.slice(copiedThrough, match.index);
      depth = 1;
    }
  }
  // Preserve formula geometry and paragraph whitespace without imposing a theme.
  return output + html.slice(copiedThrough);
}

export async function buildExportHtml(document: DocumentSession, settings: Settings, format: 'html' | 'htmlPlain' | 'pdf' | 'png' = 'html', citations?: CitationRenderData): Promise<string> {
  document = academicDocument(document, settings, citations);
  const references = new Set<string>();
  renderMarkdown(document.source, { imageURL: destination => { references.add(destination); return ''; }, allowRemoteImages: false, settings });
  const embedded = new Map<string, string>();
  let imageBytes = 0;
  for (const destination of references) {
    const response = await imageResponse(document.path, destination, { thumbnails: false });
    if (!response) continue;
    imageBytes += response.data.byteLength;
    if (imageBytes > 96 * 1024 * 1024) throw new Error('Embedded images exceed 96 MiB. Reduce the image sizes before exporting.');
    embedded.set(destination, `data:${response.mime};base64,${response.data.toString('base64')}`);
  }
  const plain = format === 'htmlPlain';
  const theme = settings.exportTheme === false ? 'github' : settings.theme;
  const remoteAllowed = (format === 'html' || plain) && settings.htmlRemoteImages;
  const content = renderMarkdown(document.source, { imageURL: destination => embedded.get(destination) ?? '', allowRemoteImages: remoteAllowed, imageLoading: 'eager', settings, purpose: plain ? 'htmlPlain' : 'export', citations });
  const headings = settings.exportOutline ? analyzeMarkdown(document.source, settings).headings : [];
  const renderedHeadingIds = [...content.matchAll(/<h[1-6]\b[^>]*\bid="([^"]*)"/g)].map(match => match[1]);
  headings.forEach((heading, index) => { if (renderedHeadingIds[index]) heading.id = renderedHeadingIds[index]; });
  const outline = headings.length ? `<nav class="export-outline" aria-label="${settings.language === 'en' ? 'Contents' : '\u76ee\u5f55'}"><ol>${headings.map(heading => `<li${plain ? '' : ` style="padding-left:${(heading.level - 1) * 12}px"`}><a href="#${escapeHTML(heading.id)}">${escapeHTML(heading.text)}</a></li>`).join('')}</ol></nav>` : '';
  const width = Number.isFinite(settings.readingWidth) ? Math.min(1400, Math.max(480, settings.readingWidth)) : 800;
  const fontSize = settings.fontSizeMode === 'auto' ? 17 : Number.isFinite(settings.fontSize) ? Math.min(32, Math.max(12, settings.fontSize)) : 17;
  const css = plain ? '' : `${await offlineKatexCss()}\n${exportCss}\n:root{color-scheme:light}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#242629}body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;font-size:${fontSize}px;line-height:1.7;letter-spacing:0}.export-layout{max-width:${width}px;margin:0 auto;padding:40px 24px 64px}.markdown-body{min-width:0;overflow-wrap:anywhere}.markdown-body img{max-width:100%;height:auto}.markdown-body pre{white-space:${settings.codeWordWrap === false ? 'pre' : 'pre-wrap'};overflow-wrap:anywhere}.markdown-body table{max-width:100%;table-layout:auto}.export-outline{font-size:14px;border-bottom:1px solid #d8dadd;margin-bottom:30px;padding-bottom:22px}.export-outline ol{list-style:none;padding:0;margin:0}.export-outline li{margin:4px 0}.export-outline a{color:#555d65;text-decoration:none}.katex-display{overflow-wrap:normal;overflow-x:auto;overflow-y:hidden}@page{size:${settings.pageSize === 'Letter' ? 'Letter' : 'A4'};margin:16mm}@media print{.export-layout{max-width:none;padding:0}.export-outline{break-after:page}h1,h2,h3,h4,h5,h6{break-after:avoid}pre,blockquote,img,tr{break-inside:avoid}a{color:inherit}.katex-display{overflow:visible}}`;
  const csp = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${remoteAllowed ? ' https: http:' : ''}; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>\n<html lang="${settings.language === 'en' ? 'en' : 'zh-CN'}"${plain ? '' : ` data-theme="${theme}"`}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(document.title)}</title>${plain ? '' : `<style>${css}\n${exportThemeCss(theme)}\n${citationCss}</style>`}</head><body><div class="export-layout">${outline}<main class="markdown-body">${plain ? unstyledContent(content) : content}</main></div></body></html>`;
}

function academicDocument(document: DocumentSession, settings: Settings, citations?: CitationRenderData): DocumentSession {
  const scan = scanCitations(document.source, settings);
  if (scan.keys.length && (!citations || scan.keys.some(key => citations.missing.includes(key) || !citations.entries.some(entry => entry.key === key)) || scan.clusters.some(cluster => !citations.clusters[cluster.raw]?.trim()) || !citations.bibliography.trim())) throw new Error('Resolve all cited Zotero item keys before exporting.');
  if (scan.bibliographies.length > 1) throw new Error('Keep one bibliography placeholder before exporting.');
  const equations = getEquationIndex(document.source, settings);
  if (equations.diagnostics.length) {
    const issues = [...new Set(equations.diagnostics.map(item => `${item.code === 'duplicate-label' ? 'Duplicate equation label' : item.code === 'ambiguous-numbering' ? 'Ambiguous equation numbering' : 'Unresolved equation reference'}: ${item.label}`))];
    throw new Error(`Resolve equation references before exporting. ${issues.slice(0, 10).join('; ')}${issues.length > 10 ? '; ...' : ''}`);
  }
  return scan.keys.length && !scan.bibliographies.length ? { ...document, source: `${document.source.trimEnd()}\n\n${BIBLIOGRAPHY_MARKER}\n` } : document;
}

/** Keep display OMML editable and vertically center its number beside the entire formula. */
function attachWordEquationNumbers(bytes: Uint8Array, count: number, settings: Settings): Uint8Array {
  const files = unzipSync(bytes);
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
  const source = files['word/document.xml'];
  if (!source) throw new Error('The Word document is missing its equation content.');
  const document = new DOMParser({ errorHandler: { fatalError: message => { throw new Error(message); } } }).parseFromString(strFromU8(source), 'application/xml');
  const nodes = (node: Document | Element, name: string, namespace = W) => Array.from(node.getElementsByTagNameNS(namespace, name));
  const direct = (node: Element, name: string, namespace = W) => Array.from(node.childNodes).find((child): child is Element => child.nodeType === 1 && (child as Element).namespaceURI === namespace && (child as Element).localName === name);
  const create = (name: string, attributes: Record<string, string> = {}) => {
    const node = document.createElementNS(W, `w:${name}`);
    for (const [key, value] of Object.entries(attributes)) node.setAttributeNS(W, `w:${key}`, value);
    return node;
  };
  const body = nodes(document, 'body')[0];
  if (!body) throw new Error('The Word document is missing its body.');
  const alignment = settings.mathAlignment === 'center' || settings.mathAlignment === 'right' ? settings.mathAlignment : 'left';
  const numberPosition = settings.mathNumberPosition === 'left' ? 'left' : 'right';
  for (const block of nodes(document, 'oMathPara', M)) {
    let properties = direct(block, 'oMathParaPr', M);
    if (!properties) { properties = document.createElementNS(M, 'm:oMathParaPr'); block.insertBefore(properties, block.firstChild); }
    let justify = direct(properties, 'jc', M);
    if (!justify) { justify = document.createElementNS(M, 'm:jc'); properties.appendChild(justify); }
    justify.setAttributeNS(M, 'm:val', alignment);
  }
  if (!count) {
    files['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(document));
    return zipSync(files, { level: 6 });
  }
  const section = nodes(document, 'sectPr')[0] || body.appendChild(create('sectPr'));
  const sectionOrder = ['headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange'];
  const pageProperty = (name: string, defaults: Record<string, string>) => {
    let property = direct(section, name);
    if (!property) {
      property = create(name);
      const next = Array.from(section.childNodes).find(node => node.nodeType === 1 && (node as Element).namespaceURI === W && sectionOrder.indexOf((node as Element).localName) > sectionOrder.indexOf(name));
      section.insertBefore(property, next || null);
    }
    for (const [attribute, value] of Object.entries(defaults)) if (!property.hasAttributeNS(W, attribute)) property.setAttributeNS(W, `w:${attribute}`, value);
    return property;
  };
  // Older Pandoc emits an empty section. Word then uses Letter with 1.25-inch side margins.
  const page = pageProperty('pgSz', { w: '12240', h: '15840' });
  const margins = pageProperty('pgMar', { top: '1440', right: '1800', bottom: '1440', left: '1800', header: '720', footer: '720', gutter: '0' });
  const width = Number(page.getAttributeNS(W, 'w')) - Number(margins.getAttributeNS(W, 'left')) - Number(margins.getAttributeNS(W, 'right'));
  if (!Number.isFinite(width) || width <= 0) throw new Error('The Word page width cannot accommodate equation numbering.');
  const order = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
  for (let index = 1; index <= count; index++) {
    const marker = nodes(document, 'bookmarkStart').find(node => node.getAttributeNS(W, 'name') === `md_export_eq_${index}`);
    let label = marker?.parentNode;
    while (label && !(label.nodeType === 1 && (label as Element).namespaceURI === W && (label as Element).localName === 'p')) label = label.parentNode;
    let formula = label?.previousSibling;
    while (formula && formula.nodeType !== 1) formula = formula.previousSibling;
    if (!label || !formula || (formula as Element).namespaceURI !== W || (formula as Element).localName !== 'p' || !nodes(formula as Element, 'oMath', M).length) throw new Error('The Word exporter could not keep an equation with its number.');
    const paragraph = formula as Element;
    const number = label as Element;
    const configureParagraph = (node: Element, justify: string) => {
      let properties = direct(node, 'pPr');
      if (!properties) { properties = create('pPr'); node.insertBefore(properties, node.firstChild); }
      for (const name of ['tabs', 'ind', 'jc', 'keepNext', 'keepLines', 'spacing']) { const old = direct(properties, name); if (old) properties.removeChild(old); }
      properties.appendChild(create('keepNext', { val: '0' }));
      properties.appendChild(create('keepLines'));
      properties.appendChild(create('spacing', { before: '0', after: '0' }));
      properties.appendChild(create('ind', { left: '0', right: '0', firstLine: '0' }));
      properties.appendChild(create('jc', { val: justify }));
      const ordered = Array.from(properties.childNodes).sort((left, right) => {
        const rank = (child: Node) => child.nodeType === 1 ? order.indexOf((child as Element).localName) : -1;
        return rank(left) - rank(right);
      });
      for (const child of ordered) properties.appendChild(child);
    };
    configureParagraph(paragraph, 'left');
    configureParagraph(number, numberPosition);
    const fontSize = Number.isFinite(settings.wordBodyFontSize) ? settings.wordBodyFontSize : 12;
    const numberWidth = Math.min(Math.floor(width / 3), Math.max(720, Math.round(((number.textContent?.length || 0) + 2) * fontSize * 12)));
    const widths = numberPosition === 'left' ? [numberWidth, width - numberWidth] : [width - numberWidth, numberWidth];
    const formulaColumn = numberPosition === 'left' ? 1 : 0;
    const numberColumn = numberPosition === 'left' ? 0 : widths.length - 1;
    const table = create('tbl');
    const properties = table.appendChild(create('tblPr'));
    properties.appendChild(create('tblW', { w: String(width), type: 'dxa' }));
    properties.appendChild(create('jc', { val: 'left' }));
    const borders = properties.appendChild(create('tblBorders'));
    for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) borders.appendChild(create(side, { val: 'nil' }));
    properties.appendChild(create('tblLayout', { type: 'fixed' }));
    const cellMargins = properties.appendChild(create('tblCellMar'));
    for (const side of ['top', 'left', 'bottom', 'right']) cellMargins.appendChild(create(side, { w: side === 'top' || side === 'bottom' ? '80' : '0', type: 'dxa' }));
    properties.appendChild(create('tblLook', { val: '0000', firstRow: '0', lastRow: '0', firstColumn: '0', lastColumn: '0', noHBand: '1', noVBand: '1' }));
    const grid = table.appendChild(create('tblGrid'));
    for (const cellWidth of widths) grid.appendChild(create('gridCol', { w: String(cellWidth) }));
    const row = table.appendChild(create('tr'));
    row.appendChild(create('trPr')).appendChild(create('cantSplit'));
    paragraph.parentNode!.insertBefore(table, paragraph);
    widths.forEach((cellWidth, column) => {
      const cell = row.appendChild(create('tc'));
      const cellProperties = cell.appendChild(create('tcPr'));
      cellProperties.appendChild(create('tcW', { w: String(cellWidth), type: 'dxa' }));
      const cellBorders = cellProperties.appendChild(create('tcBorders'));
      for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) cellBorders.appendChild(create(side, { val: 'nil' }));
      cellProperties.appendChild(create('vAlign', { val: 'center' }));
      cell.appendChild(column === formulaColumn ? paragraph : column === numberColumn ? number : create('p'));
    });
    // Word otherwise merges adjacent layout tables and reapplies first-row styling.
    const separator = create('p');
    separator.appendChild(create('pPr')).appendChild(create('spacing', { before: '0', after: '0', line: '20', lineRule: 'exact' }));
    table.parentNode!.insertBefore(separator, table.nextSibling);
  }
  files['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(document));
  return zipSync(files, { level: 6 });
}

export function constrainedImageSize(width: number, height: number): { width: number; height: number; scale: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > MAX_DOCUMENT_DIMENSION || height > MAX_DOCUMENT_DIMENSION) throw new Error('The document dimensions exceed the rendering limit.');
  const scale = Math.min(1, 16384 / Math.max(width, height), Math.sqrt(40_000_000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

async function renderDocument(html: string, format: 'pdf' | 'png', settings: Settings): Promise<Buffer> {
  const { BrowserWindow, session } = await import('electron');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-render-'));
  const input = path.join(directory, 'document.html');
  const renderSession = session.fromPartition(`markedown-export-${randomUUID()}`);
  const inputURL = pathToFileURL(input).href;
  renderSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.url !== inputURL && !details.url.startsWith('data:') && details.url !== 'about:blank' });
  });
  renderSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  renderSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    width: Math.max(1200, Math.min(1400, settings.readingWidth) + 48), height: 900, show: false, frame: false, backgroundColor: themeTokens[settings.exportTheme === false ? 'github' : settings.theme].background,
    webPreferences: { session: renderSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== inputURL) event.preventDefault(); });
  // The document CSP blocks all page scripts; only our isolated measurement world executes code.
  const evaluate = (code: string) => window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }], true);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stage = 'loading';
  let rendererError = '';
  window.webContents.on('console-message', details => { if (details.level === 'error') rendererError = details.message.slice(0, 400); });
  try {
    await writeFile(input, html, 'utf8');
    const job = async (): Promise<Buffer> => {
      await window.loadFile(input);
      stage = 'waiting for fonts and images';
      await evaluate(`(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images,image=>image.complete?Promise.resolve():new Promise(resolve=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',resolve,{once:true})})));return true})()`);
      if (format === 'pdf') {
        const printableWidth = settings.pageSize === 'Letter' ? '183.9mm' : '178mm';
        await evaluate(`(()=>{const layout=document.querySelector('.export-layout');layout.style.width='${printableWidth}';layout.style.maxWidth='none';layout.style.padding='0'})()`);
      }
      stage = 'fitting display equations';
      await evaluate(`(()=>{for(const body of document.querySelectorAll('.md-equation-body')){const content=body.querySelector('.md-equation-content');if(!content)continue;const available=body.clientWidth;const natural=Math.max(content.scrollWidth,content.getBoundingClientRect().width);if(available>0&&natural>available){content.style.zoom=String((available-1)/natural);content.dataset.exportMathScale=content.style.zoom}body.style.overflow='visible';body.scrollLeft=0}return true})()`);
      stage = 'measuring the document';
      const dimensions = await evaluate('({width:Math.max(1200,document.documentElement.scrollWidth),height:Math.ceil(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight))})') as { width: number; height: number };
      const size = constrainedImageSize(dimensions.width, dimensions.height);
      if (format === 'pdf') {
        stage = 'printing the PDF';
        if (dimensions.height / 900 > 2000) throw new Error('The document exceeds the 2,000 page PDF limit.');
        return window.webContents.printToPDF({ pageSize: settings.pageSize, printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, generateTaggedPDF: true });
      }
      stage = 'preparing the image capture';
      await evaluate(`document.documentElement.style.width='${dimensions.width}px';document.documentElement.style.overflow='hidden';document.body.style.width='${dimensions.width}px';document.body.style.transformOrigin='top left';document.body.style.transform='scale(${size.scale})';true`);
      // Small captures avoid Windows window-size and GPU texture limits on long documents.
      const tiles: sharp.OverlayOptions[] = [];
      for (let top = 0; top < size.height; top += 1024) {
        const height = Math.min(1024, size.height - top);
        window.setContentSize(size.width, height);
        await evaluate(`window.scrollTo(0,${top});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
        stage = `capturing the image at row ${top}`;
        const image = await window.webContents.capturePage({ x: 0, y: 0, width: size.width, height }, { stayHidden: true, stayAwake: true });
        if (image.isEmpty()) throw new Error('The image renderer returned an empty capture.');
        tiles.push({ input: image.resize({ width: size.width, height, quality: 'best' }).toPNG(), left: 0, top });
      }
      return sharp({ create: { width: size.width, height: size.height, channels: 4, background: themeTokens[settings.exportTheme === false ? 'github' : settings.theme].background } }).composite(tiles).png().toBuffer();
    };
    return await Promise.race([job(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Export rendering timed out after 45 seconds.')), RENDER_TIMEOUT); })]);
  } catch (error) {
    throw new Error(`Export failed while ${stage}: ${rendererError || (error instanceof Error ? error.message : String(error))}`);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!window.isDestroyed()) window.destroy();
    renderSession.webRequest.onBeforeRequest(null);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function findPandoc(configuredPath?: string): Promise<string | null> {
  const executable = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';
  const candidates = configuredPath?.trim() ? [configuredPath.trim()] : [
    ...((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/g, ''), executable))),
    ...[process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((directory): directory is string => Boolean(directory)).map(directory => path.join(directory, 'Pandoc', executable)),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!path.isAbsolute(candidate) || /[\x00-\x1f]/.test(candidate) || /^[\\/]{2}/.test(candidate)) continue;
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
      if (/^pandoc(?:\.exe)?\s+\d/i.test(stdout)) return candidate;
    } catch { /* Ignore absent or invalid installations. */ }
  }
  return null;
}

function latexEquationLayout(settings: Settings): string {
  const alignment = settings.mathAlignment === 'center' ? 'c' : settings.mathAlignment === 'right' ? 'r' : 'l';
  const leftNumber = settings.mathNumberPosition === 'left';
  return `local align = '${alignment}'
local left_number = ${leftNumber}
function Div(block)
  if FORMAT ~= 'latex' or not block.classes:includes('math-block') then return nil end
  local formula, number
  local aliases = pandoc.List()
  pandoc.walk_block(block, {
    Math = function(value) if value.mathtype == 'DisplayMath' and not formula then formula = value.text end end,
    Span = function(value)
      if value.classes:includes('md-equation-number') then number = value.content
      elseif value.identifier ~= '' then aliases:insert(pandoc.Span({}, value.attr)) end
    end
  })
  if not formula then return nil end
  local slash = string.char(92)
  local function raw(value) return pandoc.RawInline('latex', value) end
  local function append(target, values) for _, value in ipairs(values) do target:insert(value) end end
  local math = {raw(slash .. '(' .. slash .. 'displaystyle ' .. formula .. slash .. ')')}
  local function box(width, alignment, content)
    local justification = alignment == 'c' and 'centering' or alignment == 'r' and 'raggedleft' or 'raggedright'
    local result = pandoc.List({raw(slash .. 'parbox[c]{' .. width .. slash .. 'linewidth}{' .. slash .. justification .. ' ')})
    append(result, content)
    result:insert(raw('}'))
    return result
  end
  local content = pandoc.List()
  if not number then
    content:insert(raw(slash .. 'makebox[' .. slash .. 'linewidth][' .. align .. ']{'))
    append(content, math)
    content:insert(raw('}'))
  elseif left_number then append(content, box('0.12', 'l', number)); append(content, box('0.88', align, math))
  else append(content, box('0.88', align, math)); append(content, box('0.12', 'r', number)) end
  content:insert(1, raw(slash .. 'par' .. slash .. 'addvspace{.5' .. slash .. 'baselineskip}' .. slash .. 'noindent'))
  content:insert(raw(slash .. 'par' .. slash .. 'addvspace{.5' .. slash .. 'baselineskip}'))
  block.content = {pandoc.Plain(aliases), pandoc.Plain(content)}
  return block
end
`;
}

async function exportWithPandoc(document: DocumentSession, format: Exclude<ExportFormat, 'html' | 'htmlPlain' | 'pdf' | 'png'>, targetPath: string, settings: Settings, citations?: CitationRenderData): Promise<void> {
  document = academicDocument(document, settings, citations);
  const executable = await findPandoc(settings.pandocPath);
  if (!executable) throw new Error('Pandoc was not found. Install Pandoc or select pandoc.exe in Settings.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-pandoc-'));
  const input = path.join(directory, 'document.md');
  const output = path.join(directory, `document.${format}`);
  const externalImages = ['tex', 'mediawiki', 'rst', 'textile', 'opml'].includes(format);
  const assetFolder = `markedown-assets-${randomUUID().slice(0, 12)}`;
  const assetDirectory = path.join(path.dirname(path.resolve(targetPath)), assetFolder);
  const assetFiles: string[] = [];
  let assetDirectoryCreated = false;
  let complete = false;
  try {
    const equations = getEquationIndex(document.source, settings);
    const academic = !!citations?.entries.length || equations.equations.length > 0 || equations.references.length > 0 || scanCitations(document.source, settings).bibliographies.length > 0;
    // Pandoc resolves resources itself. Preflight destinations to avoid network image fetching.
    const images = allImageDestinations(document.source);
    const imagePaths = new Map<string, string>();
    let imageBytes = 0;
    for (const destination of images) {
      const resolved = await resolveImage(document.path, destination);
      if (!resolved) throw new Error(`Pandoc export cannot resolve a local image: ${destination}`);
      if (academic) {
        const image = await imageResponse(document.path, destination, { thumbnails: false });
        if (!image) throw new Error(`Pandoc export cannot decode a local image: ${destination}`);
        imageBytes += image.data.byteLength;
        if (imageBytes > 96 * 1024 * 1024) throw new Error('Embedded images exceed 96 MiB. Reduce the image sizes before exporting.');
        // Older Pandoc versions do not decode Unicode file: URLs. Relative ASCII resources work on all supported versions.
        const filename = `image-${imagePaths.size + 1}.${image.mime === 'image/gif' ? 'gif' : image.mime === 'image/webp' ? 'webp' : 'png'}`;
        if (externalImages) {
          if (!assetDirectoryCreated) { await mkdir(assetDirectory); assetDirectoryCreated = true; }
          const asset = path.join(assetDirectory, filename);
          const handle = await open(asset, 'wx');
          assetFiles.push(asset);
          try { await handle.writeFile(image.data); await handle.sync(); } finally { await handle.close(); }
          imagePaths.set(destination, `${assetFolder}/${filename}`);
        } else {
          await writeFile(path.join(directory, filename), image.data);
          imagePaths.set(destination, filename);
        }
      }
    }
    const html = academic ? renderMarkdown(document.source, { settings: { ...settings, mathOutput: 'mathml' }, purpose: 'htmlPlain', citations, imageURL: destination => imagePaths.get(destination) || '' }) : '';
    const approvedImages = new Set(imagePaths.values());
    let wordEquationNumbers = 0;
    const inputSource = academic ? '<!doctype html><html><head><meta charset="utf-8"></head><body>' + sanitizeHtml(html, {
      allowedTags: false, allowedAttributes: false, allowVulnerableTags: true,
      allowedSchemesByTag: { img: [] },
      transformTags: {
        div: (tagName, attribs) => ({ tagName: (attribs.class || '').split(/\s+/).some(value => ['csl-left-margin', 'csl-right-inline'].includes(value)) ? 'span' : tagName, attribs }),
        span: (tagName, attribs) => ({ tagName, attribs: format === 'docx' && (attribs.class || '').split(/\s+/).includes('md-equation-number') ? { ...attribs, id: `md_export_eq_${++wordEquationNumbers}` } : attribs }),
      },
      exclusiveFilter: frame => {
        if (frame.tag === 'img' && !approvedImages.has(frame.attribs.src)) throw new Error('Pandoc encountered an image outside the preflighted local resources.');
        return (frame.attribs.class || '').split(/\s+/).some(value => ['md-code-numbers', 'md-line-break'].includes(value));
      },
    }) + '</body></html>' : document.source;
    await writeFile(input, inputSource, 'utf8');
    const formatName = { docx: 'docx', epub: 'epub3', tex: 'latex', rtf: 'rtf', odt: 'odt', mediawiki: 'mediawiki', rst: 'rst', textile: 'textile', opml: 'opml' }[format];
    const resources = academic ? externalImages ? path.dirname(path.resolve(targetPath)) : directory : document.path ? path.dirname(document.path) : directory;
    const args = [academic ? '--from=html' : '--from=gfm+tex_math_dollars-raw_html', `--to=${formatName}`, '--standalone', '--output', output, '--resource-path', resources];
    if (settings.exportOutline) args.push('--toc');
    if (format === 'docx') args.push('--no-highlight');
    if (academic && format === 'epub') {
      const stylesheet = path.join(directory, 'equation-layout.css');
      await writeFile(stylesheet, `${mathCss}\n.math-block .math.display{display:inline-block;max-width:100%;margin:0;text-align:inherit}.math-block math{max-width:100%}`, 'utf8');
      args.push('--mathml', '--css', stylesheet);
    }
    if (academic && format === 'tex') {
      const filter = path.join(directory, 'equation-layout.lua');
      await writeFile(filter, latexEquationLayout(settings), 'utf8');
      args.push('--lua-filter', filter);
    }
    args.push(input);
    try {
      await execFileAsync(executable, args, { windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, cwd: document.path ? path.dirname(document.path) : directory });
    } catch (error) {
      const failure = error as Error & { stderr?: string; killed?: boolean };
      throw new Error(failure.killed ? 'Pandoc export timed out after 120 seconds.' : `Pandoc export failed: ${(failure.stderr || failure.message).trim().slice(0, 4000)}`);
    }
    const bytes = await readFile(output);
    await atomicWrite(targetPath, format === 'docx' ? applyWordStyles(attachWordEquationNumbers(bytes, wordEquationNumbers, settings), settings) : bytes);
    complete = true;
  } finally {
    if (!complete && assetDirectoryCreated) {
      await Promise.allSettled(assetFiles.map(asset => unlink(asset)));
      await rmdir(assetDirectory).catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

export async function exportDocument(document: DocumentSession, format: ExportFormat, targetPath: string, settings: Settings, citations?: CitationRenderData): Promise<void> {
  if (settings.exportTheme && settings.separateDarkTheme) {
    const { nativeTheme } = await import('electron');
    if (nativeTheme?.shouldUseDarkColors) settings = { ...settings, theme: settings.darkTheme };
  }
  if (format === 'html' || format === 'htmlPlain' || format === 'pdf' || format === 'png') {
    const html = await buildExportHtml(document, settings, format, citations);
    const bytes = format === 'html' || format === 'htmlPlain' ? Buffer.from(html, 'utf8') : await renderDocument(html, format, settings);
    await atomicWrite(targetPath, bytes);
  } else await exportWithPandoc(document, format, targetPath, settings, citations);
}

interface ArchiveEntry { name: string; method: number; compressed: number; size: number; offset: number }

/** Inspect ZIP metadata before Pandoc opens an Office/EPUB archive; never extract archive paths to disk. */
function archiveEntries(bytes: Buffer): ArchiveEntry[] {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('The document is not a supported ZIP archive.');
  const count = bytes.readUInt16LE(end + 10);
  if (count > 10_000 || count !== bytes.readUInt16LE(end + 8)) throw new Error('The document archive has too many entries.');
  const entries: ArchiveEntry[] = [];
  let position = bytes.readUInt32LE(end + 16);
  let totalSize = 0;
  const centralEnd = position + bytes.readUInt32LE(end + 12);
  if (centralEnd > end) throw new Error('The document archive directory is invalid.');
  for (let index = 0; index < count; index++) {
    if (position + 46 > centralEnd || bytes.readUInt32LE(position) !== 0x02014b50) throw new Error('The document archive directory is invalid.');
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const compressed = bytes.readUInt32LE(position + 20);
    const size = bytes.readUInt32LE(position + 24);
    const nameSize = bytes.readUInt16LE(position + 28);
    const extraSize = bytes.readUInt16LE(position + 30);
    const commentSize = bytes.readUInt16LE(position + 32);
    const offset = bytes.readUInt32LE(position + 42);
    const next = position + 46 + nameSize + extraSize + commentSize;
    if (next > centralEnd || offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50 || (flags & 1) || ![0, 8].includes(method)) throw new Error('Encrypted or unsupported document archive.');
    const name = bytes.toString('utf8', position + 46, position + 46 + nameSize).replace(/\\/g, '/');
    if (!name || name.startsWith('/') || /[\x00-\x1f\x7f:]/.test(name) || name.split('/').includes('..')) throw new Error('The document archive contains an unsafe path.');
    totalSize += size;
    if (size > 64 * 1024 * 1024 || totalSize > 256 * 1024 * 1024) throw new Error('The expanded document archive exceeds the size limit.');
    const dataOffset = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    if (dataOffset + compressed > bytes.length) throw new Error('The document archive entry is truncated.');
    entries.push({ name, method, compressed, size, offset: dataOffset });
    position = next;
  }
  return entries;
}

function embeddedImage(bytes: Buffer, entries: ArchiveEntry[], destination: string): Buffer | null {
  let name = destination.replace(/\\/g, '/').replace(/^\.\//, '');
  try { name = decodeURIComponent(name); } catch { /* Keep a literal filename if it is not URL encoded. */ }
  if (/^[a-z][a-z\d+.-]*:|^\//i.test(name) || name.split('/').includes('..')) return null;
  const candidates = entries.filter(entry => entry.name === name || entry.name.endsWith(`/${name}`));
  if (candidates.length > 1) throw new Error(`The document contains ambiguous image paths: ${destination}`);
  const entry = candidates[0];
  if (!entry) return null;
  const compressed = bytes.subarray(entry.offset, entry.offset + entry.compressed);
  const data = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
  if (data.length !== entry.size) throw new Error('The embedded image size does not match its archive record.');
  return data;
}

const importReaders: Record<string, string> = { docx: 'docx', odt: 'odt', epub: 'epub', html: 'html', htm: 'html', rtf: 'rtf', rst: 'rst', textile: 'textile', mediawiki: 'mediawiki', wiki: 'mediawiki', opml: 'opml' };

/** Convert to source only; the caller creates/saves its session at targetMarkdownPath. Assets are durable beside that target. */
export async function importDocumentToMarkdown(filename: string, targetMarkdownPath: string, settings: Settings): Promise<string> {
  const reader = importReaders[path.extname(filename).slice(1).toLowerCase()];
  if (!reader) throw new Error('This document format cannot be imported.');
  const localInput = await resolveImage(null, pathToFileURL(path.resolve(filename)).href);
  if (!localInput) throw new Error('Choose an existing local document no larger than 64 MiB.');
  const executable = await findPandoc(settings.pandocPath);
  if (!executable) throw new Error('Pandoc was not found. Install Pandoc or select pandoc.exe in Settings.');
  const [{ stdout: formats }, { stdout: help }] = await Promise.all([
    execFileAsync(executable, ['--list-input-formats'], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }),
    execFileAsync(executable, ['--help'], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }),
  ]);
  if (!formats.split(/\s+/).includes(reader)) throw new Error(`This Pandoc version cannot import ${reader.toUpperCase()}. Install a newer Pandoc version.`);
  const bytes = await readFile(localInput);
  const entries = ['docx', 'odt', 'epub'].includes(reader) ? archiveEntries(bytes) : [];
  const sandbox = /--sandbox\b/.test(help);
  // Old Pandoc readers may resolve RST include directives. Keep them out of a non-sandboxed invocation.
  if (!sandbox && reader === 'rst' && /^\s*\.\.\s+(?:include|csv-table|raw)::/im.test(bytes.toString('utf8'))) throw new Error('Importing RST includes requires a newer Pandoc with sandbox support.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-import-'));
  const astPath = path.join(directory, 'document.json');
  const created: string[] = [];
  let complete = false;
  try {
    const flags = sandbox ? ['--sandbox'] : [];
    const { stdout } = await execFileAsync(executable, [`--from=${reader}`, '--to=json', ...flags, localInput], { windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, cwd: directory });
    const ast: unknown = JSON.parse(stdout);
    if (!ast || typeof ast !== 'object' || !Array.isArray((ast as { blocks?: unknown }).blocks)) throw new Error('Pandoc returned an invalid document.');
    const pending: unknown[] = [ast];
    const images: Array<{ destination: string; content: unknown[] }> = [];
    let inspected = 0;
    while (pending.length) {
      if (++inspected > 2_000_000) throw new Error('The imported document has too many elements.');
      const current = pending.pop();
      if (!current || typeof current !== 'object') continue;
      if (Array.isArray(current)) { for (const child of current) pending.push(child); continue; }
      const node = current as { t?: string; c?: unknown };
      if (node.t === 'Image' && Array.isArray(node.c) && Array.isArray(node.c[2]) && typeof node.c[2][0] === 'string') images.push({ destination: node.c[2][0], content: node.c[2] });
      for (const child of Object.values(current)) pending.push(child);
    }
    const imported = new Map<string, string>();
    const imageSettings: Partial<Settings> = { ...settings, imageFolder: path.join(settings.imageFolder.trim() || 'assets', `import-${randomUUID().slice(0, 12)}`) };
    const target = { path: targetMarkdownPath } as DocumentSession;
    let imageBytes = 0;
    for (const image of images) {
      if (/^https?:\/\//i.test(image.destination)) continue; // Preserve the reference; the editor's normal remote-image policy applies.
      if (imported.has(image.destination)) { image.content[0] = imported.get(image.destination)!; continue; }
      const dataImage = /^data:image\/(png|jpeg|gif|webp|tiff|avif);base64,([a-z\d+/=\s]+)$/i.exec(image.destination);
      let imageData = dataImage ? Buffer.from(dataImage[2].replace(/\s/g, ''), 'base64') : entries.length ? embeddedImage(bytes, entries, image.destination) : null;
      if (!imageData) {
        const localImage = await resolveImage(localInput, image.destination);
        if (!localImage) continue; // Missing images remain visible as unavailable references in the document.
        imageData = await readFile(localImage);
      }
      imageBytes += imageData.length;
      if (imageBytes > 256 * 1024 * 1024 || imported.size >= 100) throw new Error('The imported image batch exceeds the size limit.');
      const [destination] = await importImages(target, [{ name: dataImage ? `embedded.${dataImage[1].toLowerCase()}` : path.basename(image.destination), bytes: imageData }], imageSettings);
      const asset = await resolveImage(targetMarkdownPath, destination);
      if (asset) created.push(asset);
      imported.set(image.destination, destination);
      image.content[0] = destination;
    }
    await writeFile(astPath, JSON.stringify(ast), 'utf8');
    const { stdout: source } = await execFileAsync(executable, ['--from=json', '--to=gfm-raw_html', '--wrap=none', ...flags, astPath], { windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, cwd: directory });
    complete = true;
    return source.replace(/\r\n/g, '\n');
  } catch (error) {
    const failure = error as Error & { stderr?: string; killed?: boolean };
    throw new Error(failure.killed ? 'Pandoc import timed out after 120 seconds.' : `Document import failed: ${(failure.stderr || failure.message).trim().slice(0, 4000)}`);
  } finally {
    if (!complete) await Promise.allSettled(created.map(asset => unlink(asset)));
    await rm(directory, { recursive: true, force: true });
  }
}
