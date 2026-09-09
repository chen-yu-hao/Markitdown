import type MarkdownIt from 'markdown-it';
import type { Settings } from './contracts';

type Parser = ReturnType<typeof MarkdownIt>;
type Token = ReturnType<Parser['parse']>[number];
export interface EquationEntry {
  from: number;
  to: number;
  source: string;
  label?: string;
  labels: string[];
  number?: string;
  manualNumber?: boolean;
  tagStarred?: boolean;
  numberingError?: boolean;
  ordinal: number;
  display: boolean;
  block: boolean;
  id: string;
  duplicate: boolean;
}
export interface EquationReference { from: number; to: number; label: string; kind: 'ref' | 'eqref' }
export interface EquationDiagnostic { from: number; to: number; label: string; code: 'duplicate-label' | 'missing-reference' | 'ambiguous-numbering' }
export interface EquationIndex { equations: EquationEntry[]; references: EquationReference[]; diagnostics: EquationDiagnostic[] }
export interface EquationMetadata { from: number; to: number; display: boolean; block: boolean; trailingLabel?: string; source: string }
export const equationLabelPattern = '[\\p{L}\\p{N}][\\p{L}\\p{N}:._/-]{0,127}';
const labelPattern = new RegExp(`^${equationLabelPattern}$`, 'u');
export const isEquationLabel = (value: string) => labelPattern.test(value);
const isEscaped = (value: string, position: number) => { let slashes = 0; while (position > 0 && value[--position] === '\\') slashes++; return slashes % 2 === 1; };
export function equationAnchor(label: string): string { return `eq-${encodeURIComponent(label).replaceAll('%', '~')}`; }

export function extractEquationLabels(source: string, trailingLabel?: string): { source: string; labels: string[] } {
  const labels: string[] = [];
  let cleaned = '', copied = 0, comment = false;
  for (let position = 0; position < source.length; position++) {
    if (source[position] === '\n') comment = false;
    if (source[position] === '%' && !isEscaped(source, position)) comment = true;
    if (comment || source[position] !== '\\' || isEscaped(source, position)) continue;
    const match = /^\\label\{([^{}\s]+)\}/.exec(source.slice(position));
    if (!match || !isEquationLabel(match[1])) continue;
    labels.push(match[1]);
    cleaned += source.slice(copied, position);
    copied = position + match[0].length;
    position = copied - 1;
  }
  if (trailingLabel) labels.push(trailingLabel);
  return { source: (cleaned + source.slice(copied)).trim(), labels };
}

function texGroup(source: string, from: number): { content: string; to: number } | undefined {
  while (/\s/.test(source[from] || '') && from < source.length) from++;
  if (source[from] !== '{') return;
  const start = ++from;
  let depth = 1, comment = false;
  for (; from < source.length; from++) {
    if (source[from] === '\n') comment = false;
    if (source[from] === '%' && !isEscaped(source, from)) comment = true;
    if (comment || isEscaped(source, from)) continue;
    if (source[from] === '{') depth++;
    if (source[from] === '}' && --depth === 0) return { content: source.slice(start, from), to: from + 1 };
  }
}

/** Common top-level tags are managed by the app; complex TeX remains intact. */
function extractEquationNumbering(source: string): { source: string; number?: string; starred?: boolean; suppressed: boolean; ambiguous: boolean } {
  const controls: Array<{ from: number; to: number }> = [];
  const tags: Array<{ value: string; starred: boolean }> = [];
  const environments: string[] = [];
  let depth = 0, comment = false, suppressed = false, ambiguous = false, nativeNumbering = false;
  for (let position = 0; position < source.length; position++) {
    const character = source[position];
    if (character === '\n') comment = false;
    if (character === '%' && !isEscaped(source, position)) comment = true;
    if (comment || isEscaped(source, position)) continue;
    if (character === '{') depth++;
    else if (character === '}') depth = Math.max(0, depth - 1);
    if (character !== '\\') continue;
    const command = /^\\([A-Za-z]+)/.exec(source.slice(position));
    if (!command) continue;
    const name = command[1];
    if (name === 'begin' || name === 'end') {
      const group = texGroup(source, position + command[0].length);
      if (!group) continue;
      if (name === 'begin') {
        environments.push(group.content);
        if (/^(?:equation|align|alignat|flalign|gather|multline)\*?$/.test(group.content)) nativeNumbering = true;
      } else if (environments.at(-1) === group.content) environments.pop();
      position = group.to - 1;
      continue;
    }
    if (!['tag', 'notag', 'nonumber'].includes(name)) continue;
    if (depth || environments.length) ambiguous = true;
    let to = position + command[0].length;
    if (name === 'tag') {
      const starred = source[to] === '*';
      if (starred) to++;
      const group = texGroup(source, to);
      if (!group) { ambiguous = true; continue; }
      const value = group.content.trim();
      // These characters require TeX interpretation rather than a plain textual tag.
      if (!value || /[\\{}$^_&#%\r\n]/.test(value)) ambiguous = true;
      tags.push({ value, starred });
      to = group.to;
    } else suppressed = true;
    controls.push({ from: position, to });
    position = to - 1;
  }
  ambiguous ||= tags.length > 1 || nativeNumbering && controls.length > 0;
  if (ambiguous) return { source, suppressed: true, ambiguous };
  let cleaned = '', copied = 0;
  for (const control of controls) { cleaned += source.slice(copied, control.from); copied = control.to; }
  return { source: (cleaned + source.slice(copied)).trim(), number: tags[0]?.value, starred: tags[0]?.starred, suppressed: suppressed && !tags.length, ambiguous: false };
}

/** Map inline parser offsets back through list/quote prefixes and table cell trimming. */
function inlinePositions(source: string, content: string, start: number, limit: number): number[] {
  const result: number[] = [];
  let cursor = start;
  for (const [lineIndex, line] of content.split('\n').entries()) {
    if (lineIndex) {
      const newline = source.indexOf('\n', cursor);
      result.push(newline >= 0 && newline < limit ? newline : cursor);
      cursor = newline >= 0 && newline < limit ? newline + 1 : cursor;
    }
    const lineEnd = Math.min(limit, source.indexOf('\n', cursor) < 0 ? source.length : source.indexOf('\n', cursor));
    const exact = source.indexOf(line, cursor);
    if (exact >= cursor && exact + line.length <= lineEnd) {
      for (let i = 0; i < line.length; i++) result.push(exact + i);
      cursor = exact + line.length;
    } else {
      // Table syntax can remove backslashes from escaped pipes before inline parsing.
      for (const character of line) {
        const next = source.indexOf(character, cursor);
        const position = next >= 0 && next < lineEnd ? next : cursor;
        for (let i = 0; i < character.length; i++) result.push(position + i);
        cursor = position + character.length;
      }
    }
  }
  result.push(cursor);
  return result;
}

export function buildEquationIndex(tokens: Token[], source: string, settings: Settings, initialNumber = 0): EquationIndex {
  const equations: EquationEntry[] = [], references: EquationReference[] = [];
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
  let cursor = 0, section = 0, sectionCount = 0, count = initialNumber;
  const add = (token: Token, positions?: number[]) => {
    const metadata = token.meta?.equationSource as EquationMetadata | undefined;
    if (metadata) {
      const { labels, source: labelledSource } = extractEquationLabels(metadata.source, metadata.trailingLabel);
      const numbering = extractEquationNumbering(labelledSource);
      const from = positions?.[metadata.from] ?? metadata.from, to = positions?.[metadata.to] ?? metadata.to;
      const numbered = !numbering.number && !numbering.suppressed && (labels.length > 0 || settings.mathNumbering === 'all' && metadata.block);
      const ordinal = numbered ? ++count : 0;
      if (numbered) sectionCount++;
      // Apply the document prefix only to numbers generated by Markedown. Explicit
      // TeX tags (for example \tag{S1}) remain untouched so authors retain full
      // control over manually numbered equations.
      const generatedNumber = numbered ? settings.mathNumberingStyle === 'section' ? `${section}.${sectionCount}` : String(ordinal) : undefined;
      const number = numbering.number ?? (generatedNumber === undefined ? undefined : `${settings.mathNumberingPrefix || ''}${generatedNumber}`);
      const entry: EquationEntry = { from, to, source: numbering.source, label: labels[0], labels, number, ...(numbering.number ? { manualNumber: true, tagStarred: numbering.starred } : {}), ...(numbering.ambiguous ? { numberingError: true } : {}), ordinal, display: metadata.display, block: metadata.block, id: labels[0] ? equationAnchor(labels[0]) : `eq-at-${from}`, duplicate: false };
      equations.push(entry);
      token.meta = { ...token.meta, equation: entry };
    }
    const reference = token.meta?.equationReference as Omit<EquationReference, 'from' | 'to'> & { from: number; to: number } | undefined;
    if (reference) references.push({ ...reference, from: positions?.[reference.from] ?? reference.from, to: positions?.[reference.to] ?? reference.to });
    if (token.children) for (const child of token.children) add(child, positions);
  };
  let containerStart = 0, containerEnd = source.length;
  const hasTargets = (token: Token): boolean => Boolean(token.meta?.equationSource || token.meta?.equationReference || token.children?.some(hasTargets));
  for (const [index, token] of tokens.entries()) {
    if (token.type === 'heading_open' && token.tag === 'h1') { section++; sectionCount = 0; }
    if (token.map) { containerStart = offsets[token.map[0]] ?? 0; containerEnd = offsets[token.map[1]] ?? source.length; }
    if (token.type === 'inline') {
      // Imported manuscripts often use inline delimiters for an entire body paragraph.
      const children = token.children?.filter(child => child.type !== 'text' || child.content.trim());
      const standalone = settings.mathStandaloneParagraphs && token.level === 1 && tokens[index - 1]?.type === 'paragraph_open' && tokens[index + 1]?.type === 'paragraph_close' && children?.length === 1 && children[0].type === 'math_inline' ? children[0] : undefined;
      if (standalone?.meta?.equationSource) standalone.meta.equationSource = { ...standalone.meta.equationSource, display: true, block: true };
      const start = Math.max(containerStart, Math.min(cursor, containerEnd));
      if (!hasTargets(token)) { const found = source.indexOf(token.content, start); cursor = found >= 0 && found + token.content.length <= containerEnd ? found + token.content.length : containerEnd; continue; }
      const positions = inlinePositions(source, token.content, start, containerEnd);
      add(token, positions);
      cursor = positions.at(-1) ?? cursor;
    } else { add(token); const metadata = token.meta?.equationSource as EquationMetadata | undefined; if (metadata) cursor = metadata.to; }
  }
  const labels = new Map<string, EquationEntry[]>();
  for (const equation of equations) for (const label of equation.labels) labels.set(label, [...(labels.get(label) || []), equation]);
  const diagnostics: EquationDiagnostic[] = [];
  for (const equation of equations) if (equation.numberingError) diagnostics.push({ from: equation.from, to: equation.to, label: equation.label || `formula@${equation.from}`, code: 'ambiguous-numbering' });
  for (const [label, matches] of labels) if (matches.length > 1) {
    for (const [index, equation] of matches.entries()) {
      equation.duplicate = true;
      equation.id = `${equationAnchor(equation.label!)}-duplicate-${index + 1}-${equation.from}`;
      diagnostics.push({ from: equation.from, to: equation.to, label, code: 'duplicate-label' });
    }
  }
  for (const reference of references) {
    const targets = labels.get(reference.label);
    if (!targets || targets.length === 1 && !targets[0].number) diagnostics.push({ ...reference, code: 'missing-reference' });
  }
  return { equations, references, diagnostics };
}

const equationLookup = new WeakMap<EquationIndex, Map<string, EquationEntry[]>>();
export function resolveEquation(index: EquationIndex | undefined, label: string): EquationEntry | undefined {
  if (!index) return undefined;
  let lookup = equationLookup.get(index);
  if (!lookup) { lookup = new Map(); for (const equation of index.equations) for (const target of equation.labels) lookup.set(target, [...(lookup.get(target) || []), equation]); equationLookup.set(index, lookup); }
  const matches = lookup.get(label);
  return matches?.length === 1 && !matches[0].duplicate ? matches[0] : undefined;
}

export function installEquationReferences(parser: Parser): void {
  const refPattern = new RegExp(`^(?:\\\\(eqref|ref)\\{(${equationLabelPattern})\\}|\\[@(eq:[\\p{L}\\p{N}:._/-]{1,124})\\])`, 'u');
  parser.inline.ruler.before('escape', 'equation_reference', (state, silent) => {
    const match = refPattern.exec(state.src.slice(state.pos));
    if (!match || state.linkLevel > 0 || match[3] && (/^(?:\(|\[(?!@eq:))/.test(state.src.slice(state.pos + match[0].length)) || state.env.references?.[match[0].slice(1, -1).trim().replace(/\s+/g, ' ').toUpperCase()])) return false;
    if (!silent) {
      const token = state.push('equation_reference', 'a', 0);
      const offset = Number(state.env.equationInlineOffset || 0);
      token.content = match[0];
      token.meta = { equationReference: { label: match[2] || match[3], kind: match[1] === 'ref' ? 'ref' : 'eqref', from: offset + state.pos, to: offset + state.pos + match[0].length } };
    }
    state.pos += match[0].length;
    return true;
  });
  parser.renderer.rules.equation_reference = (tokens, position, _options, env) => {
    const reference = tokens[position].meta!.equationReference as EquationReference;
    const index = env?.equationIndex as EquationIndex | undefined;
    const target = resolveEquation(index, reference.label);
    const label = parser.utils.escapeHtml(reference.label);
    if (!target?.number) {
      const duplicate = index?.equations.some(equation => equation.labels.includes(reference.label) && equation.duplicate);
      const message = (env?.settings as Partial<Settings> | undefined)?.language === 'en' ? `${duplicate ? 'Duplicate equation label' : 'Unresolved equation reference'}: ${reference.label}` : `${duplicate ? '公式标签重复' : '公式引用未解析'}：${reference.label}`;
      return `<span class="md-equation-unresolved" role="note" data-equation-label="${label}" title="${parser.utils.escapeHtml(message)}">[${duplicate ? '!!' : '??'} ${label}]</span>`;
    }
    const number = parser.utils.escapeHtml(target.number);
    return `<a class="md-equation-reference" href="#${equationAnchor(reference.label)}" data-equation-label="${label}" data-equation-from="${target.from}">${reference.kind === 'eqref' ? `(${number})` : number}</a>`;
  };
}
