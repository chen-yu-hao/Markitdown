import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { defaultSettings, type Settings } from './contracts';
import { emojiNames, smartText } from './markdown-preferences';
import { renderMath, mathCss, equationLayout } from './math-renderer';
import { installMathSyntax } from './math-syntax';
import { buildEquationIndex, equationAnchor, equationLabelPattern, installEquationReferences, type EquationEntry, type EquationIndex } from './equation-references';
import { ExtensionRegistry } from './extensions';
import { citationCss, installAcademicCitations } from './citations';
import type { CitationRenderData } from './academic-contracts';
export type { EquationEntry, EquationIndex, EquationDiagnostic, EquationReference } from './equation-references';

export interface RenderOptions {
  imageURL?: (destination: string) => string;
  allowRemoteImages?: boolean;
  imageLoading?: 'eager' | 'lazy';
  settings?: Partial<Settings>;
  purpose?: 'editor' | 'export' | 'copy' | 'htmlPlain';
  mathStartNumber?: number;
  equationIndex?: EquationIndex;
  sourceOffset?: number;
  citations?: CitationRenderData;
}
const preferences = (env: unknown): Settings => ((env as RenderOptions | undefined)?.settings as Settings) || defaultSettings;

const escaped = (source: string, index: number) => {
  let slashes = 0;
  while (index > 0 && source[--index] === '\\') slashes++;
  return slashes % 2 === 1;
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
  highlight(source, language) {
    if (language && hljs.getLanguage(language)) {
      try { return hljs.highlight(source, { language, ignoreIllegals: true }).value; } catch { /* Plain text is a valid fallback. */ }
    }
    return '';
  },
});
const validateLink = md.validateLink.bind(md);
md.validateLink = destination => validateLink(destination) || /^file:\/\/\/[a-z]:[/\\]/i.test(destination);
// Quote pairing can span emphasis tokens; other substitutions remain opt-in below.
md.core.ruler.disable('replacements');

function mathHTML(source: string, displayMode: boolean, environment: unknown): string {
  const env = (environment || {}) as RenderOptions;
  const settings = preferences(env);
  return renderMath(source, displayMode, settings, env.purpose === 'copy' || env.purpose === 'htmlPlain' ? settings.mathOutput : 'normal');
}

// The only raw line-break tags accepted are attribute-free. Other HTML stays source.
md.inline.ruler.before('html_inline', 'safe_line_break', (state, silent) => {
  const match = /^<br\s*\/?>/i.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) state.push('safe_line_break', 'br', 0);
  state.pos += match[0].length;
  return true;
});
md.renderer.rules.safe_line_break = (_tokens, _index, _options, env) =>
  (!env?.purpose || env.purpose === 'editor') && preferences(env).showLineBreaks ? '<span class="md-line-break" aria-label="Line break">↵</span><br>' : '<br>';

// Only balanced, attribute-free lowercase sup/sub tags become markup.
md.inline.ruler.before('html_inline', 'safe_script', (state, silent) => {
  if (Number(state.env.inlineDepth || 0) >= 20) return false;
  const open = /^<(sup|sub)>/.exec(state.src.slice(state.pos));
  if (!open) return false;
  const stack = [open[1]];
  const pattern = /<\/?(?:sup|sub)>|`+|\n/g;
  pattern.lastIndex = state.pos + open[0].length;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(state.src))) {
    if (escaped(state.src, match.index)) continue;
    const tag = match[0];
    if (tag === '\n') return false;
    if (tag[0] === '`') {
      const tail = state.src.indexOf(tag, pattern.lastIndex);
      if (tail >= 0) pattern.lastIndex = tail + tag.length;
      continue;
    }
    if (tag.startsWith('</')) {
      if (stack.pop() !== tag.slice(2, -1)) return false;
      if (!stack.length) { end = match.index; break; }
    } else stack.push(tag.slice(1, -1));
  }
  if (end < 0) return false;
  if (!silent) {
    const token = state.push('safe_script', open[1], 0);
    token.content = state.src.slice(state.pos + open[0].length, end);
    token.children = [];
    state.md.inline.parse(token.content, state.md, { ...state.env, inlineDepth: Number(state.env.inlineDepth || 0) + 1, equationInlineOffset: Number(state.env.equationInlineOffset || 0) + state.pos + open[0].length }, token.children);
  }
  state.pos = end + open[0].length + 1;
  return true;
});
md.renderer.rules.safe_script = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  return `<${token.tag}>${renderer.renderInline(token.children || [], options, env)}</${token.tag}>`;
};

md.inline.ruler.before('emphasis', 'highlight_mark', (state, silent) => {
  if (!preferences(state.env).highlight) return false;
  if (Number(state.env.inlineDepth || 0) >= 20) return false;
  const start = state.pos;
  if (state.src.slice(start, start + 2) !== '==' || /\s|=/.test(state.src[start + 2] || ' ')) return false;
  let end = start + 2;
  while ((end = state.src.indexOf('==', end)) >= 0) {
    if (!escaped(state.src, end) && !/\s|=/.test(state.src[end - 1]) && state.src[end + 2] !== '=') break;
    end += 2;
  }
  if (end < 0 || state.src.slice(start + 2, end).includes('\n')) return false;
  if (!silent) {
    const token = state.push('highlight_mark', 'mark', 0);
    token.content = state.src.slice(start + 2, end);
    token.children = [];
    state.md.inline.parse(token.content, state.md, { ...state.env, inlineDepth: Number(state.env.inlineDepth || 0) + 1, equationInlineOffset: Number(state.env.equationInlineOffset || 0) + start + 2 }, token.children);
  }
  state.pos = end + 2;
  return true;
});
md.renderer.rules.highlight_mark = (tokens, index, options, env, renderer) =>
  `<mark>${renderer.renderInline(tokens[index].children || [], options, env)}</mark>`;

const mathFencePattern = new RegExp(`^math(?:[ \\t]+\\{#(${equationLabelPattern})\\})?$`, 'iu');
const mathFence = (info: string) => mathFencePattern.exec(info.trim());
installMathSyntax(md);
md.renderer.rules.math_inline = (tokens, index, _options, env) => {
  const equation = tokens[index].meta?.equation as EquationEntry | undefined;
  const html = mathHTML(equation?.source ?? tokens[index].content, Boolean(tokens[index].meta?.display), env);
  if (!equation?.label && !equation?.number && !equation?.numberingError) return html;
  return `<span class="md-equation-inline" id="${equation.id}" data-equation-from="${equation.from}">${equationAliases(equation)}${html}${equation.number ? `<span class="md-equation-inline-number"> ${equationNumber(equation)}</span>` : ''}${equationDiagnostic(equation, env)}</span>`;
};

function equationAliases(equation: EquationEntry, standalone = false): string { return equation.duplicate ? '' : equation.labels.slice(1).map(label => `<span id="${equationAnchor(label)}"${standalone ? ' style="position:absolute;top:0;left:0"' : ''}></span>`).join(''); }
function equationNumber(equation: EquationEntry): string { const number = md.utils.escapeHtml(equation.number || ''); return equation.tagStarred ? number : `(${number})`; }
function equationDiagnostic(equation: EquationEntry | undefined, env: unknown): string {
  if (!equation?.duplicate && !equation?.numberingError) return '';
  const message = equation.numberingError
    ? preferences(env).language === 'en' ? 'Cannot determine a unique equation number from these TeX numbering controls.' : '无法从这些 TeX 编号命令确定唯一公式编号。'
    : preferences(env).language === 'en' ? `Duplicate equation label: ${equation.label}` : `公式标签重复：${equation.label}`;
  return `<span class="md-equation-diagnostic" role="note">${md.utils.escapeHtml(message)}</span>`;
}
function mathBlock(source: string, equation: EquationEntry | undefined, env: unknown): string {
  const standalone = ['copy', 'htmlPlain'].includes(((env || {}) as RenderOptions).purpose || '');
  const number = equation?.number;
  const layout = equationLayout(preferences(env), Boolean(number));
  const style = (value: string) => standalone ? ` style="${value}"` : '';
  const diagnostic = equationDiagnostic(equation, env);
  return `<div class="math-block${number ? ' md-numbered' : ''}" data-math-align="${layout.alignment}" data-number-position="${layout.numberPosition}"${equation ? ` id="${equation.id}" data-equation-from="${equation.from}"` : ''}${style(layout.block)}>${equation ? equationAliases(equation, standalone) : ''}<div class="md-equation-body"${style(layout.body)}><div class="md-equation-content"${style(layout.content)}>${mathHTML(equation?.source ?? source, true, env)}</div></div>${number ? `<span class="md-equation-number"${style(layout.number)}>${equationNumber(equation!)}</span>` : ''}${standalone && diagnostic ? `<div style="grid-column:1/-1;grid-row:2">${diagnostic}</div>` : diagnostic}</div>\n`;
}
md.renderer.rules.math_block = (tokens, index, _options, env) => mathBlock(tokens[index].content, tokens[index].meta?.equation as EquationEntry | undefined, env);

md.core.ruler.after('inline', 'math_numbering', state => {
  const settings = preferences(state.env);
  const offsets = [0];
  for (let position = 0; position < state.src.length; position++) if (state.src[position] === '\n') offsets.push(position + 1);
  for (const token of state.tokens) {
    const fence = token.type === 'fence' && settings.mathCodeBlocks && mathFence(token.info);
    if (fence && token.map) {
      const end = offsets[token.map[1]] ?? state.src.length;
      token.meta = { ...token.meta, equationSource: { from: offsets[token.map[0]], to: state.src[end - 1] === '\n' ? end - 1 : end, source: token.content, trailingLabel: fence[1], display: true, block: true } };
    }
  }
  const local = buildEquationIndex(state.tokens, state.src, settings, (state.env as RenderOptions).mathStartNumber || 0);
  const original = state.env.equationOriginalSource as string | undefined;
  if (original?.includes('\r')) {
    const mapping: number[] = [];
    for (let index = 0; index < original.length; index++) { mapping.push(index); if (original[index] === '\r' && original[index + 1] === '\n') index++; }
    mapping.push(original.length);
    for (const item of [...local.equations, ...local.references, ...local.diagnostics]) { item.from = mapping[item.from] ?? item.from; item.to = mapping[item.to] ?? item.to; }
  }
  const context = state.env.equationIndex as EquationIndex | undefined;
  if (context) {
    const byFrom = new Map(context.equations.map(equation => [equation.from, equation]));
    const bind = (tokens: typeof state.tokens) => { for (const token of tokens) { const equation = token.meta?.equation as EquationEntry | undefined; if (equation && token.meta) token.meta.equation = byFrom.get(equation.from + (Number(state.env.sourceOffset) || 0)) || equation; if (token.children) bind(token.children); } };
    bind(state.tokens);
  } else state.env.equationIndex = local;
});

for (const [marker, tag, setting] of [['~', 'sub', 'subscript'], ['^', 'sup', 'superscript']] as const) {
  md.inline.ruler.before('emphasis', `short_${tag}`, (state, silent) => {
    if (!preferences(state.env)[setting] || state.src[state.pos] !== marker || state.src[state.pos + 1] === marker) return false;
    let end = state.pos + 1;
    while ((end = state.src.indexOf(marker, end)) >= 0 && escaped(state.src, end)) end++;
    if (end <= state.pos + 1 || /\s/.test(state.src.slice(state.pos + 1, end)) || state.src[end + 1] === marker) return false;
    if (!silent) state.push(`short_${tag}`, tag, 0).content = state.src.slice(state.pos + 1, end).replace(/\\([~^])/g, '$1');
    state.pos = end + 1;
    return true;
  });
  md.renderer.rules[`short_${tag}`] = (tokens, index) => `<${tag}>${md.utils.escapeHtml(tokens[index].content)}</${tag}>`;
}

md.inline.ruler.before('text', 'emoji_shortcut', (state, silent) => {
  if (!preferences(state.env).emojiAutocomplete || state.src[state.pos] !== ':') return false;
  const match = /^:([\w+-]+):/.exec(state.src.slice(state.pos));
  if (!match || !emojiNames[match[1]]) return false;
  if (!silent) state.push('text', '', 0).content = emojiNames[match[1]];
  state.pos += match[0].length;
  return true;
});

md.block.ruler.before('heading', 'relaxed_heading', (state, startLine, _endLine, silent) => {
  if (preferences(state.env).strictMarkdown || state.sCount[startLine] - state.blkIndent >= 4) return false;
  const source = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
  const match = /^(#{1,6})([^#\s].*)$/.exec(source);
  if (!match) return false;
  if (silent) return true;
  const open = state.push('heading_open', `h${match[1].length}`, 1);
  open.markup = match[1]; open.map = [startLine, startLine + 1];
  const inline = state.push('inline', '', 0);
  inline.content = match[2].trim(); inline.map = [startLine, startLine + 1]; inline.children = [];
  state.push('heading_close', `h${match[1].length}`, -1).markup = match[1];
  state.line = startLine + 1;
  return true;
}, { alt: ['paragraph', 'reference', 'blockquote'] });

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const settings = preferences(env);
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0].toLowerCase();
  if (settings.mathCodeBlocks && mathFence(token.info)) return mathBlock(token.content, token.meta?.equation as EquationEntry | undefined, env);
  if (settings.diagrams && language === 'mermaid') return `<div class="md-diagram-fallback"><p class="md-diagram-note" role="note">${settings.language === 'en' ? 'Mermaid rendering is unavailable. Diagram source is shown below.' : '暂不支持图表预览，以下显示图表源码。'}</p><pre class="md-diagram" data-diagram="mermaid" data-diagram-theme="${settings.diagramTheme}"><code>${md.utils.escapeHtml(token.content)}</code></pre></div>\n`;
  let html = defaultFence(tokens, index, options, env, renderer);
  html = html.replace('<pre>', `<pre class="md-code${settings.codeWordWrap ? ' md-code-wrap' : ' md-code-nowrap'}${settings.codeLineNumbers ? ' md-code-numbered' : ''}">`);
  if (settings.codeLineNumbers) {
    // A separate visual gutter preserves highlighted spans that cross newlines.
    const count = token.content.replace(/\n$/, '').split('\n').length;
    html = html.replace(/(<pre[^>]*>)/, `$1<span class="md-code-numbers" aria-hidden="true">${Array.from({ length: count }, (_, line) => line + 1).join('\n')}</span>`);
  }
  return html;
};

md.renderer.rules.text = (tokens, index, _options, env) => {
  const settings = preferences(env);
  return md.utils.escapeHtml(settings.smartPunctuation === 'render' ? smartText(tokens[index].content, settings) : tokens[index].content);
};

const whitespace = (environment: unknown) => { const env = (environment || {}) as RenderOptions; return (!env.purpose || env.purpose === 'editor') ? preferences(env).editorWhitespace : preferences(env).exportWhitespace; };
md.renderer.rules.softbreak = (_tokens, _index, _options, env) => whitespace(env) === 'breaks' ? '<br>\n' : '\n';
md.renderer.rules.hardbreak = (_tokens, _index, _options, env) => whitespace(env) === 'preserve' ? '<br>' : '<br>\n';
md.renderer.rules.paragraph_open = (tokens, index, options, env, renderer) => {
  if (tokens[index].hidden) return whitespace(env) === 'preserve' ? '<span style="white-space:pre-wrap">' : '';
  const settings = preferences(env);
  const styles = [whitespace(env) === 'preserve' ? 'white-space:pre-wrap' : '', settings.firstLineIndent ? 'text-indent:2em' : ''].filter(Boolean);
  return `<p${styles.length ? ` style="${styles.join(';')}"` : ''}>`;
};
md.renderer.rules.paragraph_close = (tokens, index, _options, env) => tokens[index].hidden ? whitespace(env) === 'preserve' ? '</span>' : '' : '</p>\n';
for (const name of ['th_open', 'td_open', 'heading_open']) {
  md.renderer.rules[name] = (tokens, index, options, env, renderer) => {
    if (whitespace(env) === 'preserve') tokens[index].attrSet('style', `${tokens[index].attrGet('style') || ''};white-space:pre-wrap`);
    return renderer.renderToken(tokens, index, options);
  };
}

md.core.ruler.after('inline', 'github_alerts', state => {
  if (!preferences(state.env).githubAlerts) return;
  for (let index = 0; index < state.tokens.length - 2; index++) {
    const token = state.tokens[index];
    if (token.type !== 'blockquote_open' || state.tokens[index + 1].type !== 'paragraph_open') continue;
    const inline = state.tokens[index + 2];
    const first = inline.children?.[0];
    if (inline.type !== 'inline' || first?.type !== 'text') continue;
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|$)/.exec(inline.content);
    if (!match || first.content !== `[!${match[1]}]`) continue;
    token.attrJoin('class', `markdown-alert markdown-alert-${match[1].toLowerCase()}`);
    first.type = 'alert_title'; first.content = match[1][0] + match[1].slice(1).toLowerCase();
  }
});
md.renderer.rules.alert_title = (tokens, index) => `<strong class="markdown-alert-title">${md.utils.escapeHtml(tokens[index].content)}</strong>`;

function plainInline(tokens: ReturnType<typeof md.parseInline>): string {
  return tokens.map(token => {
    if (token.type === 'image') return token.content;
    if (token.children) return plainInline(token.children);
    return token.type === 'text' || token.type === 'code_inline' || token.type === 'math_inline' ? token.content : '';
  }).join('');
}

function slug(text: string, used: Map<string, number>): string {
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.set(candidate, 1);
  return candidate;
}

md.core.ruler.after('inline', 'headings_and_tasks', state => {
  const used = new Map<string, number>();
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type === 'heading_open') token.attrSet('id', slug(plainInline(state.tokens[i + 1]?.children || []), used));
    if (token.type !== 'inline' || state.tokens[i - 1]?.type !== 'paragraph_open' || state.tokens[i - 2]?.type !== 'list_item_open') continue;
    const first = token.children?.[0];
    if (!first || first.type !== 'text' || !/^\[[ xX]\](?:\s|$)/.test(token.content) || !/^\[[ xX]\](?:\s|$)/.test(first.content)) continue;
    const checkbox = new state.Token('task_checkbox', 'input', 0);
    checkbox.meta = { checked: first.content[1].toLowerCase() === 'x' };
    first.content = first.content.slice(3).replace(/^ /, '');
    token.children!.unshift(checkbox);
    state.tokens[i - 2].attrJoin('class', 'task-list-item');
  }
});
md.renderer.rules.task_checkbox = (tokens, index) => `<input type="checkbox" disabled${tokens[index].meta?.checked ? ' checked' : ''} aria-label="Task"> `;

export function isSafeLocalImage(destination: string): boolean {
  const text = destination.trim();
  if (!text || /[\u0000-\u001f]/.test(text)) return false;
  return /^[a-z]:[/\\]|^file:\/\/\/[a-z]:[/\\]/i.test(text) || !/^[a-z][a-z\d+.-]*:|^[/\\]{2}/i.test(text);
}

export function getSafeLinkURL(source: string, automatic: boolean | 'autolink' = false): string | undefined {
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) return undefined;
  let destination: string;
  if (automatic === 'autolink') {
    const tokens: ReturnType<typeof md.parseInline> = [];
    md.inline.parse(`<${source}>`, md, {}, tokens);
    if (tokens.length !== 3 || tokens[0].type !== 'link_open' || tokens[0].markup !== 'autolink' || tokens[2].type !== 'link_close') return undefined;
    destination = String(tokens[0].attrGet('href') || '');
  } else if (automatic) {
    const matches = md.linkify.match(source);
    if (matches?.length !== 1 || matches[0].index !== 0 || matches[0].lastIndex !== source.length) return undefined;
    destination = matches[0].url;
  } else {
    const parsed = md.helpers.parseLinkDestination(source, 0, source.length);
    if (!parsed.ok || parsed.pos !== source.length) return undefined;
    destination = parsed.str;
  }
  if (/[\u0000-\u001f\u007f]/.test(destination)) return undefined;
  const normalized = md.normalizeLink(destination);
  if (!/^(?:https?:\/\/|mailto:)/i.test(normalized) || !md.validateLink(normalized)) return undefined;
  try { new URL(normalized); } catch { return undefined; }
  return normalized;
}

md.renderer.rules.image = (tokens, index, _options, environment) => {
  const env = (environment || {}) as RenderOptions;
  const token = tokens[index];
  const destination = String(token.attrGet('src') || '');
  const alt = plainInline(token.children || []) || token.content;
  const escape = md.utils.escapeHtml;
  let src = '';
  if (/^https?:\/\//i.test(destination)) {
    if (env.allowRemoteImages) src = destination;
  } else if (isSafeLocalImage(destination)) {
    src = env.imageURL ? env.imageURL(destination) : (/^[a-z][a-z\d+.-]*:/i.test(destination) ? '' : destination);
  }
  if (!src) return `<span class="image-unavailable" role="img" aria-label="${escape(alt)}">[${escape(alt || destination)}]</span>`;
  const title = String(token.attrGet('title') || '');
  return `<img src="${escape(src)}" alt="${escape(alt)}"${title ? ` title="${escape(title)}"` : ''} loading="${env.imageLoading === 'eager' ? 'eager' : 'lazy'}" decoding="async">`;
};

const defaultLinkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const href = String(token.attrGet('href') || '');
  if (/^(?!https?:|mailto:)[a-z][a-z\d+.-]*:|^[/\\]{2}|[\u0000-\u001f]/i.test(href)) token.attrSet('href', '#');
  token.attrSet('rel', 'noreferrer noopener');
  return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
};

const academicExtensions = new ExtensionRegistry();
academicExtensions.register({ manifest: { id: 'markedown.equations', name: 'Equation References', version: '1.0.0', apiVersion: 1, capabilities: ['markdown'] }, markdown: installEquationReferences });
academicExtensions.register({ manifest: { id: 'markedown.citations', name: 'Academic Citations', version: '1.0.0', apiVersion: 1, capabilities: ['markdown'] }, markdown: installAcademicCitations });
academicExtensions.installMarkdown(md);
export const listMarkdownExtensions = () => academicExtensions.list();

export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const previous = md.options.linkify;
  const previousTypographer = md.options.typographer;
  const previousQuotes = md.options.quotes;
  const settings = { ...defaultSettings, ...options.settings };
  md.options.linkify = settings.autoLinks;
  md.options.typographer = settings.smartPunctuation === 'render' && settings.smartQuotes;
  md.options.quotes = [...(settings.doubleQuoteStyle === 'guillemet' ? ['«', '»'] : ['“', '”']), ...(settings.singleQuoteStyle === 'singleGuillemet' ? ['‹', '›'] : ['‘', '’'])];
  try { return md.render(source, { ...options, settings, equationOriginalSource: source }); }
  finally { md.options.linkify = previous; md.options.typographer = previousTypographer; md.options.quotes = previousQuotes; }
}

export function analyzeMarkdown(source: string, settings: Partial<Settings> = {}) {
  const tokens = md.parse(source, { settings: { ...defaultSettings, ...settings } });
  const lineOffsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineOffsets.push(i + 1);
  const headings: Array<{ level: number; text: string; offset: number; id: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'heading_open') headings.push({
      level: Number(tokens[i].tag.slice(1)), text: plainInline(tokens[i + 1]?.children || []),
      offset: lineOffsets[tokens[i].map?.[0] || 0], id: String(tokens[i].attrGet('id') || ''),
    });
  }
  // Statistics parse HTML tokens only to omit markup; this parser never renders it.
  const statisticsParser = new MarkdownIt({ html: true });
  const visible: string[] = [];
  const collect = (items: ReturnType<typeof md.parse>) => {
    for (const token of items) {
      if (token.type === 'html_block' || token.type === 'html_inline') continue;
      if (token.type === 'image' || token.type === 'code_inline' || token.type === 'code_block' || token.type === 'fence') visible.push(' ', token.content, ' ');
      else if (token.children) collect(token.children);
      else if (token.type === 'text') visible.push(token.content);
      else if (token.block || token.type === 'softbreak' || token.type === 'hardbreak') visible.push(' ');
    }
  };
  collect(statisticsParser.parse(source, {}));
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ebef}\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/u;
  let words = 0;
  let insideWord = false;
  for (const { segment } of segmenter.segment(visible.join(''))) {
    if (cjk.test(segment)) { words++; insideWord = false; }
    else if (/[\p{L}\p{N}]/u.test(segment)) { if (!insideWord) words++; insideWord = true; }
    else if (!((segment === "'" || segment === '’') && insideWord)) insideWord = false;
  }
  let characters = 0;
  for (const _segment of segmenter.segment(source)) characters++;
  return {
    headings, words, characters, lines: source ? lineOffsets.length : 0,
    readingMinutes: words ? Math.max(1, Math.ceil(words / 200)) : 0,
  };
}

/** Shared parser positions let live widgets use exactly the export delimiters and numbering. */
export function getMathBlocks(source: string, settings: Partial<Settings> = {}): Array<{ from: number; to: number; source: string; number: number; numberText?: string; id: string; label?: string }> {
  return getEquationIndex(source, settings).equations.filter(equation => equation.block).map(equation => ({ from: equation.from, to: equation.to, source: equation.source, number: equation.ordinal, numberText: equation.number, id: equation.id, label: equation.label }));
}

export function getEquationIndex(source: string, settings: Partial<Settings> = {}): EquationIndex {
  const environment = { settings: { ...defaultSettings, ...settings }, equationOriginalSource: source, equationIndex: undefined as EquationIndex | undefined };
  md.parse(source, environment);
  return environment.equationIndex || { equations: [], references: [], diagnostics: [] };
}

export const exportCss = `
${mathCss}
${citationCss}
:root{color-scheme:light;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#252927;background:#fff}
*{box-sizing:border-box}body{margin:0;padding:44px 52px;font-size:16px;line-height:1.8;overflow-wrap:anywhere}
main{max-width:850px;margin:0 auto}h1,h2,h3,h4,h5,h6{font-weight:650;line-height:1.4;margin:1.5em 0 .6em;break-after:avoid;letter-spacing:0}
h1{font-size:2em}h2{font-size:1.55em}h3{font-size:1.25em}h4,h5,h6{font-size:1.05em}p{margin:.8em 0}a{color:#1b735e;text-decoration:underline}
blockquote{margin:1em 0;border-left:3px solid #82a89c;padding:0 1em;color:#59625f}code,pre{font-family:Consolas,"Cascadia Mono",monospace}
code{background:#f0f2f1;padding:.13em .3em;border-radius:3px;font-size:.88em}pre{background:#f4f5f4;padding:16px;border:1px solid #e1e6e3;border-radius:6px;overflow:auto;white-space:pre-wrap;break-inside:avoid}
pre code{background:none;padding:0;white-space:inherit}table{border-collapse:collapse;width:100%;margin:1em 0;font-variant-numeric:tabular-nums}
th,td{border:1px solid #d9dfdb;padding:8px 12px;text-align:left}th{background:#f2f4f2;font-weight:600}tr{break-inside:avoid}thead{display:table-header-group}
img{max-width:100%;height:auto;object-fit:contain}hr{border:0;border-top:1px solid #dce2de;margin:1.8em 0}mark{background:#f9e89b;color:inherit}
sup,sub{font-size:.75em;line-height:0}ul,ol{padding-left:1.7em}.task-list-item{list-style:none}.task-list-item input{margin-left:-1.4em;accent-color:#28755f}
.katex{font-size:1.12em}.katex-display{overflow-x:auto;overflow-y:hidden;padding:4px 0}.image-unavailable{color:#7f6960;font-size:.9em}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#835099}.hljs-string,.hljs-regexp,.hljs-addition{color:#367645}.hljs-number,.hljs-symbol{color:#9c633a}
.hljs-comment,.hljs-quote{color:#7a817e}.hljs-title,.hljs-function,.hljs-attr{color:#38678d}.hljs-built_in,.hljs-type{color:#8c5944}
.md-code{position:relative}.md-code-wrap{white-space:pre-wrap}.md-code-nowrap{white-space:pre;overflow-x:auto}.md-code-numbered{display:flex;gap:16px}.md-code-numbered code{display:block;flex:1;min-width:0}.md-code-numbers{white-space:pre;user-select:none;text-align:right;opacity:.45;font-size:.88em}.markdown-alert{border-left:4px solid #3573bf;background:#3573bf09}.markdown-alert-title{color:#3573bf}.markdown-alert-tip{border-color:#268349}.markdown-alert-tip .markdown-alert-title{color:#268349}.markdown-alert-warning{border-color:#9e7100}.markdown-alert-warning .markdown-alert-title{color:#9e7100}.markdown-alert-caution{border-color:#c83d45}.markdown-alert-caution .markdown-alert-title{color:#c83d45}.markdown-alert-important{border-color:#8954bf}.markdown-alert-important .markdown-alert-title{color:#8954bf}.md-diagram{text-align:center;overflow:auto}.md-diagram svg{max-width:100%;height:auto}.md-diagram-error{color:#b44;font:inherit}
@media print{body{padding:0;font-size:11pt}main{max-width:none}a{color:inherit}pre{white-space:pre-wrap}.katex-display{overflow:visible}img{max-height:240mm}h1,h2,h3{break-after:avoid}p{orphans:3;widows:3}}
`;
