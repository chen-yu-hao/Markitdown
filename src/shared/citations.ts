import MarkdownIt from 'markdown-it';
import { parser, GFM } from '@lezer/markdown';
import type { CitationRenderData } from './academic-contracts';
import { getMathSourceRanges } from './math-syntax';
import type { Settings } from './contracts';

export const BIBLIOGRAPHY_MARKER = '<!-- markedown:bibliography -->';
export interface CitationCluster { from: number; to: number; raw: string; keys: string[] }
const clusterPattern = /^\[\s*@[A-Z0-9]{8}(?:\s*;\s*@[A-Z0-9]{8})*\s*\]/;
const linkSuffix = /^(?:\(|\[(?!\s*@[A-Z0-9]{8}))/;
const sourceParser = parser.configure(GFM);
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const isEscaped = (source: string, position: number) => { let slashes = 0; while (position > 0 && source[--position] === '\\') slashes++; return slashes % 2 === 1; };

export function parseCitationCluster(raw: string): string[] | null {
  const match = clusterPattern.exec(raw);
  return match && match[0].length === raw.length ? [...new Set(raw.match(/[A-Z0-9]{8}/g)!)] : null;
}

/** Source positions are provided by Lezer; code, links and comments remain literal. */
export function scanCitations(source: string, settings?: Partial<Settings>): { keys: string[]; clusters: CitationCluster[]; bibliographies: Array<{ from: number; to: number }> } {
  if (!source.includes('@') && !source.includes('markedown:bibliography')) return { keys: [], clusters: [], bibliographies: [] };
  const protectedRanges: Array<{ from: number; to: number }> = [];
  const tree = sourceParser.parse(source);
  const linkLabels = new Set<string>();
  const normalizeLabel = (label: string) => label.slice(1, -1).trim().replace(/\s+/g, ' ').toUpperCase();
  tree.iterate({ enter(node) {
    if (node.name === 'LinkReference') {
      const label = node.node.getChild('LinkLabel');
      if (label) linkLabels.add(normalizeLabel(source.slice(label.from, label.to)));
      return false;
    }
  } });
  tree.iterate({ enter(node) {
    const text = source.slice(node.from, node.to);
    const cluster = node.name === 'Link' && clusterPattern.exec(text);
    if (cluster && (cluster[0].length === text.length || clusterPattern.test(text.slice(cluster[0].length))) && !linkLabels.has(normalizeLabel(cluster[0]))) return;
    if (/^(FencedCode|CodeBlock|InlineCode|Link|LinkReference|Image|Autolink|HTMLBlock|HTMLTag|Comment|CommentBlock)$/.test(node.name)) {
      if (source.slice(node.from, node.to).trim() !== BIBLIOGRAPHY_MARKER) protectedRanges.push({ from: node.from, to: node.to });
      return false;
    }
  } });
  protectedRanges.push(...getMathSourceRanges(source, settings));
  protectedRanges.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: typeof protectedRanges = [];
  for (const range of protectedRanges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  const clusters: CitationCluster[] = [];
  const bibliographies: Array<{ from: number; to: number }> = [];
  let rangeIndex = 0;
  for (const match of source.matchAll(/\[\s*@[A-Z0-9]{8}(?:\s*;\s*@[A-Z0-9]{8})*\s*\]|<!-- markedown:bibliography -->/g)) {
    const from = match.index;
    const to = from + match[0].length;
    while (rangeIndex < merged.length && merged[rangeIndex].to <= from) rangeIndex++;
    if (isEscaped(source, from) || merged[rangeIndex] && merged[rangeIndex].from < to && merged[rangeIndex].to > from) continue;
    if (match[0] === BIBLIOGRAPHY_MARKER) {
      const lineStart = source.lastIndexOf('\n', from - 1) + 1;
      const lineEnd = source.indexOf('\n', to);
      if (!source.slice(lineStart, from).trim() && !source.slice(to, lineEnd < 0 ? source.length : lineEnd).trim()) bibliographies.push({ from, to });
    } else if (!linkSuffix.test(source.slice(to))) clusters.push({ from, to, raw: match[0], keys: parseCitationCluster(match[0])! });
  }
  return { clusters, keys: [...new Set(clusters.flatMap(cluster => cluster.keys))], bibliographies };
}

export function renderBibliography(data: CitationRenderData | undefined, language = 'zh-CN'): string {
  if (!data?.entries.length && !data?.missing.length) return `<section class="md-bibliography" id="markedown-references"><h2>${language === 'en' ? 'References' : '参考文献'}</h2></section>`;
  const missing = data.missing.length ? `<p class="citation-unresolved" role="status">${language === 'en' ? 'Unresolved references' : '未解析的文献'}: ${data.missing.map(escape).join(', ')}</p>` : '';
  return `<section class="md-bibliography" id="markedown-references"><h2>${language === 'en' ? 'References' : '参考文献'}</h2>${data.bibliography}${missing}</section>`;
}

export function installAcademicCitations(md: ReturnType<typeof MarkdownIt>) {
  md.inline.ruler.before('link', 'academic_citation', (state, silent) => {
    const match = clusterPattern.exec(state.src.slice(state.pos));
    if (!match || state.linkLevel > 0 || linkSuffix.test(state.src.slice(state.pos + match[0].length)) || state.env.references?.[match[0].slice(1, -1).trim().replace(/\s+/g, ' ').toUpperCase()]) return false;
    if (!silent) { const token = state.push('academic_citation', 'span', 0); token.content = match[0]; }
    state.pos += match[0].length;
    return true;
  });
  md.renderer.rules.academic_citation = (tokens, index, _options, environment) => {
    const data = environment?.citations as CitationRenderData | undefined;
    const raw = tokens[index].content;
    const keys = parseCitationCluster(raw)!;
    const resolved = data?.clusters[raw];
    if (!resolved) return `<span class="citation-unresolved" data-citation-keys="${keys.join(';')}" title="${escape(raw)}">${escape(raw)}</span>`;
    const titles = keys.map(key => data.entries.find(entry => entry.key === key)?.title || key).join('\n');
    return `<a class="md-citation" href="#ref-${keys[0]}" data-citation-keys="${keys.join(';')}" title="${escape(titles)}">${resolved}</a>`;
  };
  md.block.ruler.before('html_block', 'academic_bibliography', (state, startLine, _endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4 || state.blkIndent > 0) return false;
    const from = state.bMarks[startLine] + state.tShift[startLine];
    if (state.src.slice(state.src.lastIndexOf('\n', from - 1) + 1, from).trim()) return false;
    const source = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
    if (source !== BIBLIOGRAPHY_MARKER) return false;
    if (silent) return true;
    const token = state.push('academic_bibliography', 'section', 0);
    token.block = true; token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }, { alt: ['paragraph'] });
  md.renderer.rules.academic_bibliography = (_tokens, _index, _options, env) => {
    if (env?.bibliographyRendered) return '<span class="citation-unresolved">Duplicate bibliography placeholder</span>';
    if (env) env.bibliographyRendered = true;
    return renderBibliography(env?.citations as CitationRenderData | undefined, (env?.settings as { language?: string })?.language);
  };
}

export const citationCss = `.md-citation{font-variant-numeric:lining-nums tabular-nums;text-decoration:none;color:inherit}.md-citation:hover{text-decoration:underline}.citation-unresolved{color:#b45309;text-decoration:underline dotted}.md-bibliography{white-space:normal;text-indent:0;margin-top:2em}.md-bibliography h2{font-size:1.3em}.md-bibliography .csl-entry{margin:.7em 0;break-inside:avoid;overflow-wrap:anywhere}.md-bibliography .csl-left-margin{float:left;min-width:2em}.md-bibliography .csl-right-inline{margin-left:2.3em}.md-bibliography a{color:inherit}.md-bibliography .csl-entry:target{outline:2px solid #6c91ad;outline-offset:4px}`;
