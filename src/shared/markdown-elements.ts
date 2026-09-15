import type MarkdownIt from 'markdown-it';
import { parseDocument } from 'yaml';
import { parseDocument as parseHtml } from 'htmlparser2';
import type { AnyNode } from 'domhandler';

interface ElementEnvironment { purpose?: string; settings?: { language?: string }; elementContext?: { headings: Heading[]; footnotes: Record<string, Note> }; elementHeadings?: Heading[]; elementFootnotes?: Record<string, Note> }
interface Heading { level: number; id: string; text: string; from: number }
interface Note { from: number; number: number }
const context = (env: unknown) => (env || {}) as ElementEnvironment;

export const elementTypes = new Set(['document_metadata', 'document_toc', 'safe_html_block', 'author_comment', 'footnote_definition', 'safe_html_inline', 'footnote_reference']);
export interface ElementRange { from: number; to: number; kind: string; block: boolean }
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function metadataSummary(source: string) {
  const raw = source.replace(/^---[^\S\n]*\n/, '').replace(/\n(?:---|\.\.\.)\s*$/, '');
  try {
    const parsed = parseDocument(raw, { schema: 'core', uniqueKeys: true });
    const value: unknown = parsed.toJS({ maxAliasCount: 50 });
    const warnings = parsed.errors.map(error => error.message);
    if (!value || typeof value !== 'object' || Array.isArray(value)) warnings.push('Metadata must be a YAML mapping.');
    const entries = Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(([key]) => ['title', 'author', 'status', 'created', 'updated', 'tags', 'description'].includes(key));
    return { entries: entries.map(([key, value]) => [key, Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)]), warnings };
  } catch (error) { return { entries: [], warnings: [String(error)] }; }
}

const inlineTags = new Set(['strong', 'em', 'u', 's', 'del', 'code', 'a', 'mark', 'kbd', 'br', 'img']);
const blockTags = new Set(['section', 'div', 'p']);
export function htmlFragment(source: string, block = false): string | undefined {
  const initial = /^<([a-z]+)(?:\s[^<>]*?)?\s*\/?>/i.exec(source);
  if (!initial || !(block ? blockTags : inlineTags).has(initial[1].toLowerCase())) return;
  if (['img', 'br'].includes(initial[1].toLowerCase())) return initial[0];
  const stack: string[] = [];
  for (const tag of source.matchAll(/<\/?([a-z]+)(?:\s[^<>]*?)?\s*\/?>/gi)) {
    const name = tag[1].toLowerCase();
    if (['img', 'br'].includes(name)) continue;
    if (tag[0].startsWith('</')) { if (stack.pop() !== name) return; }
    else stack.push(name);
    if (!stack.length) return source.slice(0, tag.index! + tag[0].length);
    if (stack.length > 30) return;
  }
}
export function safeHtml(source: string, image: (src: string, alt: string, title: string) => string): string {
  if (source.length > 256 * 1024) return escape(source);
  let invalid = false;
  const render = (node: AnyNode): string => {
    if (node.type === 'text') return escape(node.data);
    if (!('name' in node) || !('attribs' in node) || ![...inlineTags, ...blockTags, 'sup', 'sub'].includes(node.name)) { invalid = true; return ''; }
    const tag = node.name, attrs = node.attribs;
    if (Object.keys(attrs).some(key => !['title', 'alt', 'src', 'href', 'width', 'align', 'class', 'id'].includes(key))) { invalid = true; return ''; }
    const title = attrs.title ? ` title="${escape(attrs.title)}"` : '';
    if (tag === 'img') {
      const width = /^(?:\d{1,5}|(?:\d{1,2}|100)%)$/.test(attrs.width || '') ? attrs.width + (attrs.width.endsWith('%') ? '' : 'px') : '';
      return `<span class="md-image-layout"${width ? ` style="width:${width};max-width:100%"` : ''}>${image(attrs.src || '', attrs.alt || '', attrs.title || '')}</span>`;
    }
    const content = node.children.map(render).join('');
    if (tag === 'br') return '<br>';
    if (tag === 'a') {
      const href = attrs.href || '';
      if (/[\u0000-\u001f]|^(?!(?:https?|mailto):)[a-z][\w+.-]*:|^[/\\]{2}/i.test(href)) { invalid = true; return ''; }
      return `<a href="${escape(href)}" rel="noreferrer noopener"${title}>${content}</a>`;
    }
    const align = ['left', 'center', 'right'].includes(attrs.align) ? ` style="text-align:${attrs.align}"` : '';
    return `<${tag}${align}${title}>${content}</${tag}>`;
  };
  const html = parseHtml(source, { decodeEntities: true }).children.map(render).join('');
  return invalid ? escape(source) : html;
}

/** Bounded source-preserving nodes; unknown HTML always remains literal text. */
export function installDocumentElements(md: InstanceType<typeof MarkdownIt>) {
  const Token = (new md.core.State('', md, {})).Token;
  const rawLine = (state: Parameters<Parameters<typeof md.block.ruler.before>[2]>[0], line: number) => line >= state.lineMax ? '' : state.src.slice(state.bMarks[line], state.eMarks[line]);
  md.block.ruler.before('hr', 'document_elements', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const line = rawLine(state, start), rest = state.src.slice(state.bMarks[start]);
    let type = '', finish = start + 1, content = '';
    if (start === 0 && !state.env.sourceOffset && /^---\s*$/.test(line)) {
      for (let i = start + 1; i < end; i++) if (/^(?:---|\.\.\.)\s*$/.test(rawLine(state, i))) { type = 'document_metadata'; finish = i + 1; break; }
    } else if (/^\s*<!--\s*toc\s*-->\s*$/i.test(line)) {
      for (let i = start + 1; i < end; i++) if (/^\s*<!--\s*\/toc\s*-->\s*$/i.test(rawLine(state, i))) { type = 'document_toc'; finish = i + 1; break; }
    } else if (/^\s*<!--/.test(line) && !/^\s*<!--\s*(?:markedown:|\/?toc\b)/.test(line)) {
      const at = rest.indexOf('-->');
      if (at >= 0 && !rest.slice(at + 3, rest.indexOf('\n', at) < 0 ? undefined : rest.indexOf('\n', at)).trim()) { type = 'author_comment'; finish = start + rest.slice(0, at + 3).split('\n').length; }
    } else if (/^\[\^[^\]\s]+\]:/.test(line)) {
      type = 'footnote_definition';
      while (finish < end && (/^(?: {4}|\t)/.test(rawLine(state, finish)) || !rawLine(state, finish).trim() && /^(?: {4}|\t)/.test(rawLine(state, finish + 1) || ''))) finish++;
    } else {
      const html = htmlFragment(rest.trimStart(), true);
      if (html && safeHtml(html, () => '<img>') !== escape(html)) { type = 'safe_html_block'; finish = start + html.split('\n').length; }
    }
    if (!type) return false;
    if (silent) return true;
    content = state.src.slice(state.bMarks[start], state.eMarks[finish - 1]);
    const token = state.push(type, type === 'author_comment' ? 'aside' : 'section', 0);
    token.block = true; token.map = [start, finish]; token.content = content;
    state.line = finish; return true;
  }, { alt: ['paragraph', 'reference', 'blockquote'] });
  md.inline.ruler.before('html_inline', 'document_inline', (state, silent) => {
    const rest = state.src.slice(state.pos);
    const comment = /^<!--[\s\S]*?-->/.exec(rest);
    const footnote = /^\[\^([^\]\s]+)\]/.exec(rest);
    const html = htmlFragment(rest);
    const value = comment?.[0] || footnote?.[0] || html;
    if (!value || comment && /^<!--\s*markedown:/.test(value)) return false;
    if (!silent) {
      const token = state.push(comment ? 'author_comment' : footnote ? 'footnote_reference' : 'safe_html_inline', '', 0);
      token.content = value; token.meta = { elementOffset: state.pos };
    }
    state.pos += value.length; return true;
  });
  md.renderer.rules.document_metadata = (tokens, index, _options, env) => {
    if (context(env).purpose && context(env).purpose !== 'editor') return '';
    const data = metadataSummary(tokens[index].content);
    return `<aside class="md-metadata" data-element="metadata"><strong>YAML</strong><dl>${data.entries.map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>${data.warnings.length ? `<p class="md-element-warning">${data.warnings.map(escape).join('<br>')}</p>` : ''}</aside>`;
  };
  md.renderer.rules.author_comment = (tokens, index, _options, env) => {
    if (context(env).purpose && context(env).purpose !== 'editor') return '';
    const token = tokens[index], tag = token.block ? 'aside' : 'span';
    return `<${tag} class="md-author-comment" data-element="comment" title="${escape(token.content.slice(4, -3).trim())}">${escape(token.content.slice(4, -3).trim()) || '…'}</${tag}>`;
  };
  const htmlRule: NonNullable<typeof md.renderer.rules.safe_html_inline> = (tokens, index, options, env, renderer) => safeHtml(tokens[index].content, (src, alt, title) => {
    const token = new Token('image', 'img', 0); token.content = alt; token.children = []; token.attrSet('src', src); token.attrSet('alt', alt); token.attrSet('title', title);
    return md.renderer.rules.image!([token], 0, options, env, renderer);
  });
  md.renderer.rules.safe_html_block = (tokens, index, options, env, renderer) => `<div class="md-safe-html" data-element="html">${htmlRule(tokens, index, options, env, renderer)}</div>`;
  md.renderer.rules.safe_html_inline = htmlRule;
  md.renderer.rules.document_toc = (_tokens, _index, _options, env) => `<nav class="md-document-toc" data-element="toc" aria-label="${context(env).settings?.language === 'en' ? 'Contents' : '目录'}"><strong>${context(env).settings?.language === 'en' ? 'Contents' : '目录'}</strong><ol>${(context(env).elementHeadings || []).map((h: { level: number; id: string; text: string; from: number }) => `<li style="margin-left:${(h.level - 1) * 16}px"><a href="#${escape(h.id)}" data-source-target="${h.from}">${escape(h.text)}</a></li>`).join('')}</ol></nav>`;
  md.renderer.rules.footnote_reference = (tokens, index, _options, env) => {
    const id = tokens[index].content.slice(2, -1), note = context(env).elementFootnotes?.[id];
    return note ? `<sup class="md-footnote-ref"><a href="#fn-${encodeURIComponent(id)}" data-source-target="${note.from}">[${note.number}]</a></sup>` : escape(tokens[index].content);
  };
  md.renderer.rules.footnote_definition = (tokens, index, _options, env) => {
    const match = /^\[\^([^\]\s]+)\]:\s*([\s\S]*)$/.exec(tokens[index].content)!;
    const note = context(env).elementFootnotes?.[match[1]];
    return `<aside class="md-footnote-definition" id="fn-${escape(match[1])}" data-element="footnote"><b>[${note?.number || escape(match[1])}]</b> ${md.renderInline(match[2].replace(/\n(?: {4}|\t)/g, '\n'), env)}</aside>`;
  };
  md.core.ruler.push('document_element_context', state => {
    if (state.inlineMode) return;
    const offsets = [0]; for (let i = 0; i < state.src.length; i++) if (state.src[i] === '\n') offsets.push(i + 1);
    const env = context(state.env);
    const supplied = env.elementContext;
    env.elementHeadings = supplied?.headings || [];
    env.elementFootnotes = supplied?.footnotes || Object.create(null);
    if (supplied) return;
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i], from = offsets[token.map?.[0] || 0];
      if (token.type === 'heading_open') env.elementHeadings!.push({ level: Number(token.tag.slice(1)), id: String(token.attrGet('id') || ''), text: state.tokens[i + 1]?.content.replace(/[*`~]/g, ''), from });
      if (token.type === 'footnote_definition') { const id = /^\[\^([^\]]+)\]/.exec(token.content)![1]; if (!Object.hasOwn(env.elementFootnotes!, id)) env.elementFootnotes![id] = { from, number: Object.keys(env.elementFootnotes!).length + 1 }; }
    }
  });
}

export const documentElementCss = `
.md-metadata{border:1px solid #8996a355;border-radius:6px;padding:12px 16px;background:#8996a310;font-size:.85em}.md-metadata dl{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;margin:6px 0}.md-metadata dt{opacity:.65}.md-metadata dd{margin:0;overflow-wrap:anywhere}.md-element-warning{color:#a45628}
.md-author-comment{color:#7a8290;background:#8996a315;border:1px dashed #8996a355;border-radius:4px;padding:2px 6px;font-size:.8em;white-space:normal}aside.md-author-comment{padding:8px 12px;margin:8px 0}
.md-document-toc{border:1px solid #8996a344;border-radius:5px;padding:14px 18px}.md-document-toc ol{list-style:none;padding:0;margin:8px 0}.md-document-toc li{margin-top:3px}.md-document-toc a{text-decoration:none}
.md-footnote-definition{font-size:.88em;border-top:1px solid #8996a344;padding:8px 0}.md-footnote-ref{vertical-align:super;font-size:.75em}.md-image-layout{display:inline-block}.md-image-layout img{width:100%;height:auto;max-height:none}.md-safe-html{display:flow-root}.md-safe-html>p{margin:0}.md-safe-html .md-image-layout{text-indent:0}kbd{border:1px solid #8996a355;border-radius:3px;padding:0 4px;font:.85em monospace}
.md-code-title{font:12px/1.5 Consolas,monospace;opacity:.7;padding:6px 10px;border-bottom:1px solid #8996a344}.md-code-node{position:relative}.md-code-node pre{margin-top:0}
`;
