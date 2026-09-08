import MarkdownIt from 'markdown-it';
import { defaultSettings, type Settings } from './contracts';
import { buildEquationIndex, equationLabelPattern } from './equation-references';

const preferences = (env: unknown): Settings => (env as { settings?: Settings })?.settings || defaultSettings;
const escaped = (source: string, position: number) => { let slashes = 0; while (position > 0 && source[--position] === '\\') slashes++; return slashes % 2 === 1; };
const trailingLabelPattern = new RegExp(`^[ \\t]*\\{#(${equationLabelPattern})\\}`, 'u');

/** Both citation scanning and rendering use these exact math delimiters. */
export function installMathSyntax(md: ReturnType<typeof MarkdownIt>) {
  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const settings = preferences(state.env);
    const start = state.pos;
    const latex = settings.latexDelimiters && state.src.slice(start, start + 2) === '\\(';
    if (!latex && (!settings.inlineMath || state.src[start] !== '$')) return false;
    const delimiter = latex ? '\\(' : state.src[start + 1] === '$' ? '$$' : '$';
    const closer = latex ? '\\)' : delimiter;
    const contentStart = start + delimiter.length;
    if (!latex && !settings.legacyInlineMath && /\s|\$/.test(state.src[contentStart] || ' ')) return false;
    let end = contentStart;
    while ((end = state.src.indexOf(closer, end)) >= 0) {
      if (!escaped(state.src, end)) break;
      end += closer.length;
    }
    if (end <= contentStart || state.src.slice(contentStart, end).includes('\n') || (!latex && !settings.legacyInlineMath && (/\s/.test(state.src[end - 1]) || /\d/.test(state.src[end + closer.length] || '')))) return false;
    const trailing = trailingLabelPattern.exec(state.src.slice(end + delimiter.length));
    const finish = end + delimiter.length + (trailing?.[0].length || 0);
    if (!silent) {
      const token = state.push('math_inline', 'span', 0);
      token.content = state.src.slice(contentStart, end);
      const offset = Number(state.env.equationInlineOffset || 0);
      token.meta = { display: !latex && delimiter.length === 2, equationSource: { from: offset + start, to: offset + finish, source: token.content, trailingLabel: trailing?.[1], display: !latex && delimiter.length === 2, block: false } };
    }
    state.pos = finish;
    return true;
  });
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    let first = state.src.slice(start, state.eMarks[startLine]).trimEnd();
    let trailingLabel: string | undefined;
    const firstLabel = new RegExp(`[ \\t]*\\{#(${equationLabelPattern})\\}$`, 'u').exec(first);
    if (firstLabel && /(?:\$\$|\\\])$/.test(first.slice(0, firstLabel.index).trimEnd())) { trailingLabel = firstLabel[1]; first = first.slice(0, firstLabel.index).trimEnd(); }
    const delimiter = first.startsWith('$$') ? '$$' : preferences(state.env).latexDelimiters && first.startsWith('\\[') ? '\\]' : null;
    if (!delimiter) return false;
    let content = first.slice(2);
    let nextLine = startLine + 1;
    if (content.endsWith(delimiter) && !escaped(content, content.length - 2)) content = content.slice(0, -2);
    else {
      for (let close = content.indexOf(delimiter); close >= 0; close = content.indexOf(delimiter, close + 2)) if (!escaped(content, close)) return false;
      const lines = [content];
      let found = false;
      for (; nextLine < endLine; nextLine++) {
        if (!state.isEmpty(nextLine) && state.sCount[nextLine] < state.blkIndent) return false;
        const line = state.src.slice(state.bMarks[nextLine] + state.tShift[nextLine], state.eMarks[nextLine]);
        const trimmed = line.trim();
        const closingLabel = trailingLabelPattern.exec(trimmed.slice(delimiter.length));
        if (trimmed === delimiter || trimmed.startsWith(delimiter) && closingLabel && delimiter.length + closingLabel[0].length === trimmed.length) { trailingLabel = closingLabel?.[1] || trailingLabel; found = true; nextLine++; break; }
        lines.push(line);
      }
      if (!found) return false;
      content = lines.join('\n');
    }
    if (silent) return true;
    const token = state.push('math_block', 'div', 0);
    token.block = true; token.content = content.trim(); token.map = [startLine, nextLine];
    token.meta = { equationSource: { from: state.bMarks[startLine], to: state.eMarks[nextLine - 1], source: token.content, trailingLabel, display: true, block: true } };
    state.line = nextLine;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}

const sourceParser = new MarkdownIt({ html: true });
installMathSyntax(sourceParser);
export function getMathSourceRanges(source: string, preferences?: Partial<Settings>): Array<{ from: number; to: number }> {
  if (!source.includes('$') && !source.includes('\\(') && !source.includes('\\[')) return [];
  const settings = { ...defaultSettings, ...preferences };
  const normalized = source.replace(/\r\n?/g, '\n');
  const tokens = sourceParser.parse(normalized, { settings });
  const ranges = buildEquationIndex(tokens, normalized, settings).equations.map(({ from, to }) => ({ from, to }));
  if (normalized.length === source.length) return ranges;
  // Remap only range endpoints, avoiding a character-sized map for large Windows files.
  const offsets = new Map<number, number>();
  let originalOffset = 0, normalizedOffset = 0;
  for (const offset of [...new Set(ranges.flatMap(({ from, to }) => [from, to]))].sort((a, b) => a - b)) {
    while (normalizedOffset < offset && originalOffset < source.length) {
      if (source[originalOffset] === '\r' && source[originalOffset + 1] === '\n') originalOffset++;
      originalOffset++; normalizedOffset++;
    }
    offsets.set(offset, originalOffset);
  }
  return ranges.map(({ from, to }) => ({ from: offsets.get(from)!, to: offsets.get(to)! }));
}
