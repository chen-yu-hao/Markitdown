import { EditorSelection, EditorState, Facet, Prec, StateField, Transaction, countColumn, type ChangeSpec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { insertNewline, insertNewlineKeepIndent } from '@codemirror/commands';
import { ensureSyntaxTree, getIndentation, indentRange, indentUnit, syntaxTree, type Language } from '@codemirror/language';
import { javascriptLanguage, jsxLanguage, typescriptLanguage, tsxLanguage } from '@codemirror/lang-javascript';
import { cssLanguage } from '@codemirror/lang-css';
import { htmlLanguage } from '@codemirror/lang-html';
import { defaultSettings, type Settings } from '../shared/contracts';
import { emojiNames, smartTypedInput } from '../shared/markdown-preferences';
import { getEquationIndex, renderMarkdown } from '../shared/markdown';
import { emptyCitationData, type CitationRenderData } from '../shared/academic-contracts';
import { scanCitations } from '../shared/citations';

export const editorPreferences = Facet.define<Settings, Settings>({ combine: values => values[0] || defaultSettings });
export const editorCitations = Facet.define<CitationRenderData, CitationRenderData>({ combine: values => values[0] || emptyCitationData });
export const editorSourceMode = Facet.define<boolean, boolean>({ combine: values => values[0] || false });
const emptyEquations: ReturnType<typeof getEquationIndex> = { equations: [], references: [], diagnostics: [] };
const emptyCitationScan: ReturnType<typeof scanCitations> = { keys: [], clusters: [], bibliographies: [] };
function deferAcademicIndex(state: EditorState, source: string): boolean {
  return state.facet(editorSourceMode) && source.length > 1024 * 1024 / 3 && new TextEncoder().encode(source).length > 1024 * 1024;
}
const equationsFor = (state: EditorState) => {
  const source = state.doc.toString();
  if (!/[$\\]|\[@eq:|(?:`{3,}|~{3,})math\b/.test(source) || deferAcademicIndex(state, source)) return emptyEquations;
  return getEquationIndex(source, state.facet(editorPreferences));
};
const citationsFor = (state: EditorState) => {
  const source = state.doc.toString();
  if (!/\[\s*@[A-Z0-9]{8}|<!-- markedown:bibliography -->/.test(source) || deferAcademicIndex(state, source)) return emptyCitationScan;
  return scanCitations(source, state.facet(editorPreferences));
};
const academicSettingsChanged = (transaction: Transaction) => transaction.startState.facet(editorPreferences) !== transaction.state.facet(editorPreferences) || transaction.startState.facet(editorSourceMode) !== transaction.state.facet(editorSourceMode);
export const editorEquations = StateField.define<ReturnType<typeof getEquationIndex>>({
  create: equationsFor,
  update: (value, transaction) => transaction.docChanged || academicSettingsChanged(transaction) ? equationsFor(transaction.state) : value,
});
export const editorCitationScan = StateField.define<ReturnType<typeof scanCitations>>({
  create: citationsFor,
  update: (value, transaction) => transaction.docChanged || academicSettingsChanged(transaction) ? citationsFor(transaction.state) : value,
});
export function equationIndexForCommand(state: EditorState) {
  const source = state.doc.toString();
  return deferAcademicIndex(state, source) ? getEquationIndex(source, state.facet(editorPreferences)) : state.field(editorEquations, false) || getEquationIndex(source, state.facet(editorPreferences));
}

export function isCode(state: EditorState, position: number): boolean {
  for (const inner of [false, true]) for (let node = inner ? syntaxTree(state).resolveInner(position, -1) : syntaxTree(state).resolve(position, -1); node; node = node.parent!) if (/^(FencedCode|CodeBlock|InlineCode|CodeText|CodeInfo)$/.test(node.name)) return true;
  return false;
}

export function codeLanguage(info: string): Language | null {
  const name = info.trim().split(/\s+/)[0].toLowerCase();
  return ({ js: javascriptLanguage, javascript: javascriptLanguage, mjs: javascriptLanguage, cjs: javascriptLanguage,
    jsx: jsxLanguage, ts: typescriptLanguage, typescript: typescriptLanguage, tsx: tsxLanguage,
    css: cssLanguage, html: htmlLanguage, htm: htmlLanguage } as Record<string, Language>)[name] || null;
}

export function defaultFenceLanguage(settings: Settings, origin: 'typed' | 'menu'): string {
  if (settings.codeLanguageTrigger !== 'always' && settings.codeLanguageTrigger !== origin) return '';
  const language = settings.defaultCodeLanguage.trim();
  return /^[\w#+.-]{1,50}$/.test(language) ? language : '';
}

function codeBlockAt(state: EditorState, position: number) {
  for (const side of [-1, 1] as const) for (let node = syntaxTree(state).resolve(position, side); node; node = node.parent!) if (node.name === 'FencedCode') return node;
  return null;
}

export function indentWidthAt(state: EditorState, position: number): number {
  const settings = state.facet(editorPreferences);
  return Math.max(1, Math.min(8, isCode(state, position) ? settings.codeIndentWidth : settings.indentWidth));
}

function adjustSelectedIndent(view: EditorView, direction: 1 | -1): boolean {
  const range = view.state.selection.main;
  const first = view.state.doc.lineAt(range.from).number;
  const last = view.state.doc.lineAt(Math.max(range.from, range.to - 1)).number;
  const changes: ChangeSpec[] = [];
  for (let number = first; number <= last; number++) {
    const line = view.state.doc.line(number);
    const prefix = /^\s*/.exec(line.text)![0];
    const width = indentWidthAt(view.state, line.from + prefix.length);
    if (direction === 1) changes.push({ from: line.from, insert: ' '.repeat(width) });
    else if (prefix) {
      const columns = countColumn(prefix, width);
      changes.push({ from: line.from, to: line.from + prefix.length, insert: ' '.repeat(Math.max(0, columns - width)) });
    }
  }
  view.dispatch({ changes, annotations: Transaction.userEvent.of('input.indent') });
  return true;
}

/** The parser determines indentation; strings, comments and unselected text stay intact. */
export function formatCodeSelection(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (view.composing || view.compositionStarted || range.empty) return false;
  const settings = state.facet(editorPreferences);
  const changes: ChangeSpec[] = [];
  let supported = false;
  syntaxTree(state).iterate({ from: range.from, to: range.to, enter(node) {
    if (node.name !== 'FencedCode') return;
    const content = node.node.getChild('CodeText');
    const info = node.node.getChild('CodeInfo');
    const language = info && codeLanguage(state.sliceDoc(info.from, info.to));
    if (!content || !language || range.from >= content.to || range.to <= content.from) return false;
    const source = state.sliceDoc(content.from, content.to);
    const code = EditorState.create({ doc: source, extensions: [language, indentUnit.of(' '.repeat(settings.codeIndentWidth)), EditorState.tabSize.of(settings.codeIndentWidth)] });
    if (!ensureSyntaxTree(code, code.doc.length, 100)) return false;
    const from = Math.max(0, range.from - content.from);
    const to = Math.min(source.length, range.to - content.from);
    supported = true;
    indentRange(code, from, to).iterChanges((start, end, _newFrom, _newTo, insert) => changes.push({ from: content.from + start, to: content.from + end, insert }));
    return false;
  } });
  if (!supported) return false;
  if (changes.length) view.dispatch({ changes, annotations: Transaction.userEvent.of('input.format') });
  return true;
}

export function preferenceShiftTab(view: EditorView): boolean {
  if (view.composing || view.compositionStarted) return false;
  if (view.state.facet(editorPreferences).codeAutoIndentOnTab && formatCodeSelection(view)) return true;
  return adjustSelectedIndent(view, -1);
}

export function listContinuation(text: string, settings: Settings): string | null {
  const match = /^(\s*(?:>\s*)*)(?:(\d+)([.)])|([-+*]))\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(text);
  if (!match || !match[6].trim()) return null;
  const marker = match[2] ? `${settings.orderedMarker === 'one' ? 1 : Number(match[2]) + 1}${match[3]}` : settings.bulletMarker;
  return `${match[1]}${marker} ${match[5] !== undefined ? '[ ] ' : ''}`;
}

/** Windows drop paths are data, never commands; encode every URL component. */
export function droppedMarkdownLink(filename: string, documentPath: string | null): string {
  const target = filename.replace(/\\/g, '/');
  const current = documentPath?.replace(/\\/g, '/');
  let destination: string;
  if (current && /^[a-z]:\//i.test(target) && target.slice(0, 2).toLowerCase() === current.slice(0, 2).toLowerCase()) {
    const base = current.split('/').slice(0, -1);
    const parts = target.split('/');
    let common = 0;
    while (common < base.length && common < parts.length && base[common].toLowerCase() === parts[common].toLowerCase()) common++;
    destination = [...base.slice(common).map(() => '..'), ...parts.slice(common)].map(encodeURIComponent).join('/');
  } else destination = /^[a-z]:\//i.test(target) ? `file:///${target.slice(0, 2)}/${target.slice(3).split('/').map(encodeURIComponent).join('/')}` : target.split('/').map(encodeURIComponent).join('/');
  const title = (target.split('/').pop() || target).replace(/([\\[\]])/g, '\\$1');
  return `[${title}](<${destination}>)`;
}

export function preferenceEnter(view: EditorView): boolean {
  if (view.composing || view.compositionStarted) return false;
  const settings = view.state.facet(editorPreferences);
  const selection = view.state.selection.main;
  if (isCode(view.state, selection.head)) {
    const line = view.state.doc.lineAt(selection.from);
    const block = codeBlockAt(view.state, selection.from);
    const language = defaultFenceLanguage(settings, 'typed');
    if (language && selection.empty && selection.from === line.to && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line.text) && block && view.state.doc.lineAt(block.from).number === line.number && !block.getChild('CodeInfo')) {
      const trailing = /\s*$/.exec(line.text)![0].length;
      const insert = language + '\n';
      view.dispatch({ changes: { from: line.to - trailing, to: line.to, insert }, selection: { anchor: line.to - trailing + insert.length }, annotations: Transaction.userEvent.of('input') });
      return true;
    }
    if (!settings.codeAutoIndent) return insertNewline(view);
    const before = view.state.sliceDoc(view.state.doc.lineAt(selection.from).from, selection.from);
    const content = block?.getChild('CodeText');
    const info = block?.getChild('CodeInfo');
    const parser = info && codeLanguage(view.state.sliceDoc(info.from, info.to));
    if (content && parser && selection.from >= content.from && selection.to <= content.to) {
      const source = view.state.sliceDoc(content.from, selection.from) + '\n' + view.state.sliceDoc(selection.to, content.to);
      const code = EditorState.create({ doc: source, extensions: [parser, indentUnit.of(' '.repeat(settings.codeIndentWidth)), EditorState.tabSize.of(settings.codeIndentWidth)] });
      const offset = selection.from - content.from + 1;
      if (ensureSyntaxTree(code, offset, 50)) {
        const indentation = getIndentation(code, offset);
        if (indentation !== null) {
          const insert = '\n' + ' '.repeat(indentation);
          view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length }, annotations: Transaction.userEvent.of('input') });
          return true;
        }
      }
    }
    if (/[{[(]\s*$/.test(before)) {
      const insert = '\n' + (/^\s*/.exec(before)?.[0] || '') + ' '.repeat(Math.max(1, Math.min(8, settings.codeIndentWidth)));
      view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length }, annotations: Transaction.userEvent.of('input') });
      return true;
    }
    return insertNewlineKeepIndent(view);
  }
  const line = view.state.doc.lineAt(selection.from);
  const before = view.state.sliceDoc(line.from, selection.from);
  const continuation = listContinuation(before, settings);
  if (continuation !== null) {
    const insert = '\n' + continuation;
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length }, annotations: Transaction.userEvent.of('input') });
    return true;
  }
  if (/^\s*(?:>\s*)*(?:(?:\d+[.)]|[-+*])\s+(?:\[[ xX]\]\s*)?|>)\s*$/.test(before) && selection.to === line.to) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, selection: { anchor: line.from }, annotations: Transaction.userEvent.of('input') });
    return true;
  }
  const quote = /^(\s*(?:>\s*)+)/.exec(before)?.[0];
  if (quote && before.trim() !== '>') {
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert: '\n' + quote }, selection: { anchor: selection.from + quote.length + 1 }, annotations: Transaction.userEvent.of('input') });
    return true;
  }
  return insertNewlineKeepIndent(view);
}

export function preferenceTab(view: EditorView): boolean {
  if (view.composing || view.compositionStarted) return false;
  const settings = view.state.facet(editorPreferences);
  const selection = view.state.selection.main;
  if (!selection.empty) return adjustSelectedIndent(view, 1);
  const width = indentWidthAt(view.state, selection.head);
  const column = countColumn(view.state.sliceDoc(view.state.doc.lineAt(selection.head).from, selection.head), width);
  view.dispatch(view.state.replaceSelection(' '.repeat(settings.alignIndent ? width - column % width : width)), { annotations: Transaction.userEvent.of('input') });
  return true;
}

function emojiCompletion(context: CompletionContext) {
  if (isCode(context.state, context.pos)) return null;
  const match = context.matchBefore(/:[\w+-]*/);
  if (!match || match.from > 0 && /[\w:/]/.test(context.state.sliceDoc(match.from - 1, match.from))) return null;
  return { from: match.from, options: Object.entries(emojiNames).map(([name, emoji]) => ({ label: `:${name}:`, displayLabel: `${emoji}  :${name}:`, apply: emoji, type: 'text' })), validFor: /^:[\w+-]*$/ };
}

function academicCompletion(context: CompletionContext) {
  if (isCode(context.state, context.pos)) return null;
  const line = context.state.sliceDoc(context.state.doc.lineAt(context.pos).from, context.pos);
  const reference = /(?:\\(?:eqref|ref)\{|\[@)([\p{L}\p{N}:._/-]*)$/u.exec(line);
  if (reference && (reference[0].startsWith('\\') || reference[1].startsWith('eq:'))) {
    const index = context.state.field(editorEquations, false);
    const labels = [...new Set((index?.equations || []).filter(equation => !equation.duplicate).flatMap(equation => equation.labels))];
    return { from: context.pos - reference[1].length, options: labels.map(label => ({ label, detail: index?.equations.find(equation => equation.labels.includes(label))?.number, type: 'variable' })), validFor: /^[\p{L}\p{N}:._/-]*$/u };
  }
  const citation = /\[[^\]\n]*@([A-Z0-9]{0,8})$/.exec(line);
  if (!citation) return null;
  return { from: context.pos - citation[1].length, options: context.state.facet(editorCitations).entries.map(item => ({ label: item.key, displayLabel: `${item.key}  ${item.title}`, detail: [item.authors, item.year].filter(Boolean).join(', '), type: 'text' })), validFor: /^[A-Z0-9]{0,8}$/ };
}

function clipboard(event: ClipboardEvent, view: EditorView): boolean {
  const settings = view.state.facet(editorPreferences);
  const selection = view.state.selection.main;
  if (!settings.copyWholeLine && selection.empty) { event.preventDefault(); return true; }
  if (!event.clipboardData) return false;
  const line = view.state.doc.lineAt(selection.head);
  const from = selection.empty ? line.from : selection.from;
  const to = selection.empty ? Math.min(view.state.doc.length, line.to + 1) : selection.to;
  const source = view.state.sliceDoc(from, to);
  const html = renderMarkdown(source, { settings, purpose: 'copy', citations: view.state.facet(editorCitations), equationIndex: equationIndexForCommand(view.state), sourceOffset: from });
  // Preserve native plain-text copying unless rich text or a formula is present.
  if (settings.copyMarkdown && !/class="(?:md-math|katex|md-citation|md-equation-reference)|<math\b|<svg\b/.test(html)) return false;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const node of parsed.querySelectorAll('.md-code-numbers,.md-line-break')) node.remove();
  const plain = parsed.body.cloneNode(true) as HTMLElement;
  for (const node of plain.querySelectorAll('[data-latex]')) node.replaceWith(node.getAttribute('data-latex') || '');
  for (const node of plain.querySelectorAll('.katex-html,annotation')) node.remove();
  for (const node of plain.querySelectorAll('br')) node.replaceWith('\n');
  for (const node of plain.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr')) node.append('\n');
  event.clipboardData.setData('text/plain', settings.copyMarkdown ? source : plain.textContent?.replace(/\n+$/, selection.empty ? '\n' : '') || '');
  event.clipboardData.setData('text/html', parsed.body.innerHTML);
  event.preventDefault();
  if (event.type === 'cut') view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, annotations: Transaction.userEvent.of('delete.cut') });
  return true;
}

export function preferenceExtensions(settings: Settings): Extension[] {
  const width = Math.max(1, Math.min(8, settings.indentWidth));
  const brackets = [...(settings.pairBrackets ? ['(', '[', '{', '"', "'"] : []), ...(settings.pairMarkdown ? ['`', '*', '_', '~'] : [])];
  return [
    editorPreferences.of(settings), EditorState.tabSize.of(width), indentUnit.of(' '.repeat(width)),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown editor', spellcheck: String(settings.spellcheck !== 'off'), autocapitalize: 'off', ...(settings.spellcheck.startsWith('en-') ? { lang: settings.spellcheck } : {}) }),
    EditorState.languageData.of((state, position) => [{ closeBrackets: { brackets: isCode(state, position) ? (settings.pairBrackets ? ['(', '[', '{', '"', "'"] : []) : brackets, before: ')]}:;> ', explode: '[]{}' } }]),
    ...(brackets.length ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : []),
    autocompletion({ override: [academicCompletion, ...(settings.emojiAutocomplete ? [emojiCompletion] : [])], icons: false }), keymap.of(completionKeymap),
    Prec.high(keymap.of([{ key: 'Enter', run: preferenceEnter }, { key: 'Tab', run: preferenceTab }, { key: 'Shift-Tab', run: preferenceShiftTab }])),
    Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
      if (view.composing || view.compositionStarted || isCode(view.state, from) || from !== to) return false;
      const before = view.state.sliceDoc(Math.max(view.state.doc.lineAt(from).from, from - 100), from);
      const transformed = smartTypedInput(before, text, settings);
      if (!transformed) return false;
      view.dispatch({ changes: { from: from - transformed.remove, to, insert: transformed.insert }, selection: EditorSelection.cursor(from - transformed.remove + transformed.insert.length), annotations: Transaction.userEvent.of('input.type') });
      return true;
    })),
    EditorView.domEventHandlers({ copy: clipboard, cut: clipboard }),
  ];
}
