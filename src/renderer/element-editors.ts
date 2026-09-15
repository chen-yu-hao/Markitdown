import MarkdownIt from 'markdown-it';
import { parseDocument as parseHtml } from 'htmlparser2';
import { getElementIndex, renderMarkdown } from '../shared/markdown';
import { metadataSummary } from '../shared/markdown-elements';
import { panelFor, type NodeEditorTarget } from './node-editors';
import { renderDiagrams } from './diagram-runtime';

export const diagramTemplates: Record<string, string> = {
  flowchart: 'flowchart TD\n  A[Start] --> B{Continue?}\n  B --> C[Done]',
  sequence: 'sequenceDiagram\n  participant User\n  participant App\n  User->>App: Request\n  App-->>User: Result',
  class: 'classDiagram\n  class Document {\n    +string title\n    +save()\n  }\n  class Editor\n  Document --> Editor',
  state: 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Review\n  Review --> Published\n  Published --> [*]',
  pie: 'pie title Content\n  "Writing" : 45\n  "Editing" : 30\n  "Reading" : 25',
  gantt: 'gantt\n  title Project\n  dateFormat YYYY-MM-DD\n  section Work\n  Design :a1, 2026-09-01, 3d\n  Build :after a1, 5d',
  er: 'erDiagram\n  USER ||--o{ DOCUMENT : owns\n  USER {\n    string id\n  }\n  DOCUMENT {\n    string title\n  }',
};
export function tocSource(source: string) {
  return '<!-- toc -->\n' + getElementIndex(source).headings.map(h => `${'  '.repeat(h.level - 1)}- [${h.text.replace(/([\[\]\\])/g, '\\$1')}](#${h.id})`).join('\n') + '\n<!-- /toc -->';
}
export function openElementNode(target: NodeEditorTarget) {
  const source = target.source.trimEnd(), fence = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1\2\s*$/.exec(source);
  const metadata = target.from === 0 && /^---\s*\n/.test(source), toc = /^\s*<!--\s*toc\s*-->/.test(source);
  const comment = /^\s*<!--(?!\s*markedown:)[\s\S]*-->\s*$/.test(source), html = /^\s*<(?:section|div|p|u|mark|strong|em|kbd|code|a)\b/i.test(source);
  const footnote = /^\[\^[^\]]+\]:/.test(source), diagram = fence && /^mermaid\b/.test(fence[3].trim());
  if (!fence && !metadata && !toc && !comment && !html && !footnote) return false;
  const label: [string, string] = metadata ? ['文档元数据', 'Document metadata'] : toc ? ['正文目录', 'Document contents'] : comment ? ['注释编辑', 'Comment editor'] : diagram ? ['图表编辑', 'Diagram editor'] : fence ? ['代码块编辑', 'Code block editor'] : footnote ? ['脚注编辑', 'Footnote editor'] : ['HTML 编辑', 'HTML editor'];
  const ui = panelFor(target, 'element', label), input = document.createElement('textarea');
  input.className = 'node-element-input'; input.spellcheck = false; input.rows = 10; input.setAttribute('aria-label', ui.t('节点源码', 'Node source'));
  input.value = fence ? fence[4] : source;
  const tools = document.createElement('div'); tools.className = 'node-table-tools'; ui.body.append(tools);
  let info = fence?.[3] || '';
  if (fence && !diagram) {
    const language = document.createElement('input'); language.setAttribute('aria-label', ui.t('代码语言与标题', 'Code language and title')); language.value = info; language.onchange = () => { info = language.value.replace(/[\n\r<>]/g, ''); update(); }; tools.append(language);
    ui.button(tools, '复制代码', 'Copy code', () => { void navigator.clipboard.writeText(input.value); });
  }
  let confirmed = false;
  ui.button(tools, '删除节点', 'Delete node', () => { if (!confirmed) { confirmed = true; ui.message(ui.t('再次点击“删除节点”确认。', 'Click Delete node again to confirm.')); return; } ui.change('', true); ui.close(); });
  if (toc) { input.readOnly = true; ui.button(tools, '更新目录', 'Refresh contents', () => { input.value = tocSource(target.documentSource); update(); }); }
  const preview = document.createElement('div'); preview.className = 'node-element-preview md-rendered'; preview.setAttribute('aria-label', ui.t('节点预览', 'Node preview')); ui.body.append(input, preview);
  const value = () => {
    if (!fence) return input.value + target.source.slice(source.length);
    const marker = fence[2][0];
    const longest = Math.max(0, ...Array.from(input.value.matchAll(marker === '`' ? /`+/g : /~+/g), match => match[0].length));
    const delimiter = marker.repeat(Math.max(fence[2].length, longest + 1));
    return `${fence[1]}${delimiter}${info}\n${input.value}\n${fence[1]}${delimiter}${target.source.slice(source.length)}`;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  function paint() {
    if (!preview.isConnected) return;
    const full = target.documentSource.slice(0, target.from) + value() + target.documentSource.slice(target.from + target.source.length);
    preview.innerHTML = renderMarkdown(value(), { settings: target.settings, purpose: 'editor', imageURL: target.imageURL, elementContext: getElementIndex(full, target.settings), sourceOffset: target.from });
    void renderDiagrams(preview);
    if (metadata) ui.message(metadataSummary(value()).warnings.join('\n'));
  }
  function update() { if (ui.change(value())) { clearTimeout(timer); timer = setTimeout(paint, diagram ? 300 : 100); } }
  input.oninput = update; paint();
  if (diagram) ui.button(tools, '查看大图', 'View full diagram', () => {
    const svg = preview.querySelector('svg');
    if (svg) showImageViewer('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg)), ui.t('图表预览', 'Diagram preview'));
  });
  input.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearTimeout(timer); ui.change(target.source, true); ui.close(); }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); ui.close(); target.navigate?.(event.shiftKey ? 'before' : 'after'); }
    if (event.key === 'Tab') { event.preventDefault(); input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end'); update(); }
  };
  input.focus({ preventScroll: true }); return true;
}

export function showImageViewer(src: string, alt = '') {
  const overlay = document.createElement('div'); overlay.className = 'md-image-viewer'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'Image viewer'); overlay.tabIndex = -1;
  const image = document.createElement('img'); image.src = src; image.alt = alt;
  const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', 'Close image viewer'); close.onclick = () => overlay.remove();
  overlay.append(image, close); document.body.append(overlay); overlay.focus();
  let scale = 1, x = 0, y = 0;
  const transform = () => image.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
  overlay.onwheel = event => { if (!event.ctrlKey) return; event.preventDefault(); event.stopPropagation(); scale = Math.max(.1, Math.min(10, scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1))); transform(); };
  image.onpointerdown = event => { const start = { x: event.clientX, y: event.clientY, left: x, top: y }; event.preventDefault(); image.setPointerCapture(event.pointerId); image.onpointermove = move => { x = start.left + move.clientX - start.x; y = start.top + move.clientY - start.y; transform(); }; image.onpointerup = () => { image.onpointermove = null; }; };
  overlay.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); overlay.remove(); } };
}
export function openImageNode(target: NodeEditorTarget) {
  const parser = new MarkdownIt(); const tokens = parser.parseInline(target.source.trim(), {})[0]?.children || [];
  const token = tokens.find(token => token.type === 'image');
  const html = /^\s*<(?:p|img)\b/i.test(target.source);
  const markup = html ? parseHtml(target.source).children : [];
  const paragraph = markup.find(node => 'name' in node && node.name === 'p');
  const img = (paragraph && 'children' in paragraph ? paragraph.children : markup).find(node => 'name' in node && node.name === 'img');
  const attr = (name: string) => {
    const node = name === 'align' ? paragraph : img;
    return node && 'attribs' in node ? node.attribs[name] || '' : '';
  };
  if (!token && !html) return false;
  const src = String(token?.attrGet('src') || attr('src')); if (!src) return false;
  const ui = panelFor(target, 'element', ['图片设置', 'Image settings']);
  const fields: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  for (const [key, cn, en, value] of [['src','路径','Path',src],['alt','替代文本','Alt text',token?.content || attr('alt')],['title','标题','Title',String(token?.attrGet('title') || attr('title'))],['width','宽度（像素或百分比）','Width (pixels or percent)',attr('width')],['align','对齐','Alignment',attr('align') || 'left']]) {
    const label = document.createElement('label'); label.className = 'node-image-field'; label.textContent = ui.t(cn,en);
    const field = key === 'align' ? document.createElement('select') : document.createElement('input');
    if (field instanceof HTMLSelectElement) for (const name of ['left','center','right']) field.add(new Option(ui.t(({left:'左',center:'中',right:'右'})[name as 'left'],name),name));
    field.value = value; field.setAttribute('aria-label', en); fields[key] = field; label.append(field); ui.body.append(label);
  }
  const escape = (value: string) => value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  ui.button(ui.body, '应用图片设置', 'Apply image settings', () => {
    if (fields.width.value && !/^(?:[1-9]\d{0,4}|(?:[1-9]\d?|100)%)$/.test(fields.width.value)) { ui.message(ui.t('宽度请输入正整数或 1%–100%。','Use a positive pixel width or 1%–100%.')); return; }
    ui.change(`<p align="${fields.align.value}"><img src="${escape(fields.src.value)}" alt="${escape(fields.alt.value)}" title="${escape(fields.title.value)}"${fields.width.value ? ` width="${fields.width.value}"` : ''}></p>`,true);
  });
  ui.button(ui.body, '复制路径', 'Copy image path', () => { void navigator.clipboard.writeText(fields.src.value); });
  ui.button(ui.body, '查看大图', 'View full image', () => { const url = target.imageURL?.(fields.src.value); if (url) showImageViewer(url, fields.alt.value); });
  ui.button(ui.body, '删除图片', 'Delete image', () => { ui.change('',true); ui.close(); });
  return true;
}
