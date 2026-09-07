import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState, Facet, StateEffect, StateField, Transaction, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, drawSelection, dropCursor, keymap, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, selectAll, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { SearchQuery, findNext as searchNext, findPrevious, getSearchQuery, replaceAll, replaceNext, search, setSearchQuery } from '@codemirror/search';
import { GFM } from '@lezer/markdown';
import { defaultSettings, type DocumentPatch, type DocumentSession, type Settings } from '../shared/contracts';
import { getSafeLinkURL, renderMarkdown, type EquationIndex } from '../shared/markdown';
import { emptyCitationData, type CitationRenderData } from '../shared/academic-contracts';
import { BIBLIOGRAPHY_MARKER, scanCitations } from '../shared/citations';
import { headingText } from '../shared/markdown-preferences';
import { codeLanguage, defaultFenceLanguage, droppedMarkdownLink, editorCitationScan, editorCitations, editorEquations, editorPreferences, editorSourceMode, equationIndexForCommand, preferenceExtensions } from './editor-preferences';
import { academicInsertion, bibliographySuffix, bibliographyTypingExtension, equationLabelInsertion } from './editor-academic';
import { preservePointerPosition } from './editor-pointer';
import 'katex/dist/katex.min.css';
import './editor.css';

export interface EditorHandle {
  command(name: string): void;
  find(query: string, options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }): void;
  findNext(previous?: boolean): void;
  replace(value: string, all?: boolean): void;
  scrollTo(offset: number): void;
  focus(): void;
  insertText(text: string, bibliography?: boolean): void;
}

export interface EditorProps {
  document: DocumentSession;
  active: boolean;
  fontSize: number;
  readingWidth: number;
  theme: 'light' | 'dark';
  typewriter: boolean;
  settings?: Settings;
  citations?: CitationRenderData;
  onChange(patch: DocumentPatch): void;
  onImportImages(files?: File[]): Promise<string[]>;
  onFindResult?(result: { current: number; total: number }): void;
}

const sourceLimit = 5 * 1024 * 1024;
const externalChange = Annotation.define<boolean>();
const formatChange = Transaction.userEvent.of('input.format');
const liveMode = Facet.define<boolean, boolean>({ combine: values => values[0] ?? true });
const imageResolver = Facet.define<(destination: string) => string, (destination: string) => string>({ combine: values => values[0] || (() => '') });
const viewportEffect = StateEffect.define<{ from: number; to: number }>();
const trackInsertion = StateEffect.define<{ id: string; from: number; to: number }>();
const untrackInsertion = StateEffect.define<string>();
const insertions = StateField.define<Map<string, { from: number; to: number }>>({
  create: () => new Map(),
  update(value, transaction) {
    const next = new Map<string, { from: number; to: number }>();
    for (const [id, range] of value) next.set(id, { from: transaction.changes.mapPos(range.from, 1), to: transaction.changes.mapPos(range.to, 1) });
    for (const effect of transaction.effects) {
      if (effect.is(trackInsertion)) next.set(effect.value.id, effect.value);
      if (effect.is(untrackInsertion)) next.delete(effect.value);
    }
    return next;
  },
});

function openLink(url: string) {
  if (/^(https?:\/\/|mailto:)/i.test(url)) void window.markedown.openExternal(url);
}

function navigateAcademicReference(view: EditorView, target: Element): boolean {
  const equation = target.closest<HTMLElement>('.md-equation-reference[data-equation-from]');
  if (equation) {
    const position = Number(equation.dataset.equationFrom);
    if (Number.isInteger(position) && position >= 0 && position <= view.state.doc.length) {
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
      view.focus();
      return true;
    }
  }
  const citation = target.closest<HTMLElement>('.md-citation[data-citation-keys]');
  if (!citation) return false;
  const position = view.state.field(editorCitationScan).bibliographies[0]?.from ?? view.state.doc.length;
  view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'start' }) });
  const key = citation.dataset.citationKeys?.split(';')[0];
  setTimeout(() => {
    const entry = key && view.dom.querySelector<HTMLElement>(`#ref-${key}`);
    if (entry) { entry.scrollIntoView({ block: 'center' }); entry.classList.add('md-reference-target'); setTimeout(() => entry.classList.remove('md-reference-target'), 1600); }
  }, 30);
  return true;
}

class RenderedWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number, readonly block: boolean, readonly resolveImage: (destination: string) => string, readonly settings: Settings, readonly equations: EquationIndex, readonly citations: CitationRenderData, readonly virtual = false) { super(); }
  eq(other: RenderedWidget) { return this.source === other.source && this.from === other.from && this.block === other.block && this.resolveImage === other.resolveImage && this.settings === other.settings && this.equations === other.equations && this.citations === other.citations && this.virtual === other.virtual; }
  toDOM(view: EditorView) {
    const dom = document.createElement(this.block ? 'div' : 'span');
    dom.className = `md-rendered ${this.block ? 'md-rendered-block' : 'md-rendered-inline'}`;
    dom.setAttribute('contenteditable', 'false');
    dom.innerHTML = renderMarkdown(this.source, { imageURL: this.resolveImage, settings: this.settings, purpose: 'editor', equationIndex: this.equations, citations: this.citations, sourceOffset: this.from }).trim();
    for (const reference of dom.querySelectorAll<HTMLElement>('.md-equation-reference[data-equation-label]')) {
      const equation = this.equations.equations.find(equation => equation.labels.includes(reference.dataset.equationLabel || ''));
      if (equation) reference.title = `${equation.label || ''}${equation.number ? ' (' + equation.number + ')' : ''}\n${equation.source}`;
    }
    if (!this.block && dom.firstElementChild?.tagName === 'P' && dom.children.length === 1) dom.firstElementChild.replaceWith(...dom.firstElementChild.childNodes);
    dom.addEventListener('mousedown', event => {
      event.preventDefault();
      if (navigateAcademicReference(view, event.target as Element)) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>('a');
      const pointer = event as MouseEvent;
      if (link && (pointer.ctrlKey || pointer.metaKey)) { openLink(link.getAttribute('href') || ''); return; }
      view.dispatch({ selection: { anchor: Math.min(this.from, view.state.doc.length) }, effects: EditorView.scrollIntoView(Math.min(this.from, view.state.doc.length), { y: 'nearest' }) });
      view.focus();
    });
    dom.addEventListener('click', event => event.preventDefault());
    for (const img of dom.querySelectorAll('img')) {
      img.addEventListener('load', () => view.requestMeasure());
      img.addEventListener('error', () => { img.classList.add('md-image-error'); view.requestMeasure(); });
    }
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return this.block ? (this.source.includes('![') ? 260 : Math.min(420, Math.max(64, this.source.split('\n').length * 25))) : -1; }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number) { super(); }
  eq(other: TaskWidget) { return this.checked === other.checked && this.from === other.from; }
  toDOM(view: EditorView) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'md-task-checkbox';
    checkbox.checked = this.checked;
    checkbox.setAttribute('aria-label', 'Task');
    checkbox.addEventListener('mousedown', event => event.preventDefault());
    checkbox.addEventListener('click', event => {
      event.stopPropagation();
      view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? ' ' : 'x' }, annotations: formatChange });
    });
    return checkbox;
  }
  ignoreEvent() { return true; }
}

interface LiveState { decorations: DecorationSet; from: number; to: number }

function buildLiveDecorations(state: EditorState, from: number, to: number): DecorationSet {
  if (!state.facet(liveMode)) return Decoration.none;
  const decorations: Range<Decoration>[] = [];
  const selection = state.selection.main;
  const settings = state.facet(editorPreferences);
  const equationIndex = state.field(editorEquations);
  const equations = equationIndex.equations;
  const citationScan = state.field(editorCitationScan);
  const citations = state.facet(editorCitations);
  let activeFrom = selection.from;
  let activeTo = selection.to;
  if (settings.showActiveBlockSource) {
    activeFrom = state.doc.lineAt(selection.from).from;
    activeTo = state.doc.lineAt(selection.to).to;
    for (const position of [selection.from, selection.to]) {
      for (let node = syntaxTree(state).resolveInner(position, 1); node; node = node.parent!) {
        if (/^(Paragraph|ATXHeading\d|SetextHeading\d|FencedCode|CodeBlock|Table)$/.test(node.name)) { activeFrom = Math.min(activeFrom, node.from); activeTo = Math.max(activeTo, node.to); break; }
      }
    }
  }
  const isActive = (start: number, end: number) => start <= activeTo && end >= activeFrom;
  const resolveImage = state.facet(imageResolver);
  const protectedRanges: Array<{ from: number; to: number }> = [];
  const hide = (start: number, end: number) => {
    if (end > start) decorations.push(Decoration.replace({}).range(start, end));
  };
  const render = (start: number, end: number, block: boolean) => {
    if (end > start) decorations.push(Decoration.replace({ widget: new RenderedWidget(state.sliceDoc(start, end), start, block, resolveImage, settings, equationIndex, citations), block }).range(start, end));
    protectedRanges.push({ from: start, to: end });
  };
  for (const equation of equations) {
    if (equation.to < from || equation.from > to) continue;
    if (!isActive(equation.from, equation.to)) render(equation.from, equation.to, equation.block);
    else protectedRanges.push({ from: equation.from, to: equation.to });
  }
  for (const bibliography of citationScan.bibliographies.slice(0, 1)) {
    if (bibliography.to >= from && bibliography.from <= to && !isActive(bibliography.from, bibliography.to)) render(bibliography.from, bibliography.to, true);
  }
  if (citationScan.keys.length && !citationScan.bibliographies.length) decorations.push(Decoration.widget({ widget: new RenderedWidget(BIBLIOGRAPHY_MARKER, state.doc.length, true, resolveImage, settings, equationIndex, citations, true), block: true, side: 1 }).range(state.doc.length));
  syntaxTree(state).iterate({
    from, to,
    enter(node) {
      const name = node.name;
      const start = node.from;
      const end = node.to;
      const active = isActive(start, end);
      if (protectedRanges.some(range => start >= range.from && end <= range.to)) return false;
      if (equations.some(equation => start >= equation.from && end <= equation.to)) return false;
      if (name === 'FencedCode' || name === 'CodeBlock' || name === 'Table' || name === 'HorizontalRule') {
        if (!active) render(start, end, true);
        else {
          protectedRanges.push({ from: start, to: end });
          if (name === 'FencedCode' || name === 'CodeBlock') {
            const first = state.doc.lineAt(start).number;
            for (let number = Math.max(first, state.doc.lineAt(Math.min(from, state.doc.length)).number); number <= state.doc.lineAt(Math.min(end, to)).number; number++) {
              decorations.push(Decoration.line({ class: `md-code-source${settings.codeWordWrap ? '' : ' md-code-source-nowrap'}`, attributes: { style: `tab-size:${settings.codeIndentWidth}`, ...(settings.codeLineNumbers ? { 'data-code-line': String(number - first + 1) } : {}) } }).range(state.doc.line(number).from));
            }
          }
        }
        return false;
      }
      if (name === 'Blockquote' && !active && settings.githubAlerts && /^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/.test(state.sliceDoc(start, end))) { render(start, end, true); return false; }
      if (name === 'Paragraph' && !active) {
        const source = state.sliceDoc(start, end);
        const overlapsMath = equations.some(equation => start < equation.to && end > equation.from);
        if (!overlapsMath && (/^!\[[^\]]*\]\([^\n]*\)\s*$/.test(source) || /<br\s*\/?>/i.test(source) || (settings.editorWhitespace !== 'preserve' && node.node.parent?.name === 'Document') || settings.smartPunctuation === 'render' || (!settings.strictMarkdown && /^#{1,6}[^#\s]/.test(source)))) {
          render(start, end, true);
          return false;
        }
      }
      if (name === 'Paragraph' && settings.firstLineIndent && node.node.parent?.name === 'Document' && !equations.some(equation => start < equation.to && end > equation.from)) decorations.push(Decoration.line({ class: 'md-paragraph-indent' }).range(state.doc.lineAt(start).from));
      if (/^(ATXHeading|SetextHeading)/.test(name)) {
        const level = Number(name.slice(-1));
        decorations.push(Decoration.line({ class: `md-heading md-heading-${level}` }).range(state.doc.lineAt(start).from));
      }
      if (name === 'Blockquote') {
        for (let number = state.doc.lineAt(Math.max(start, from)).number; number <= state.doc.lineAt(Math.min(end, to)).number; number++) decorations.push(Decoration.line({ class: 'md-blockquote' }).range(state.doc.line(number).from));
      }
      if (name === 'Image') {
        if (!active) render(start, end, false);
        else protectedRanges.push({ from: start, to: end });
        return false;
      }
      if (name === 'InlineCode') protectedRanges.push({ from: start, to: end });
      if (name === 'Link' || name === 'Autolink') {
        const url = node.node.getChild('URL');
        const destination = url && getSafeLinkURL(state.sliceDoc(url.from, url.to), name === 'Autolink' ? 'autolink' : false);
        decorations.push(Decoration.mark({ class: 'md-link', attributes: destination ? { 'data-link': destination } : undefined }).range(start, end));
      }
      if (name === 'URL' && node.node.parent?.name !== 'Link' && node.node.parent?.name !== 'Autolink') {
        const destination = settings.autoLinks && getSafeLinkURL(state.sliceDoc(start, end), true);
        if (destination) decorations.push(Decoration.mark({ class: 'md-link', attributes: { 'data-link': destination } }).range(start, end));
        return;
      }
      const markClass: Record<string, string> = { StrongEmphasis: 'md-strong', Emphasis: 'md-emphasis', Strikethrough: 'md-strike', InlineCode: 'md-inline-code' };
      if (markClass[name] && end > start) decorations.push(Decoration.mark({ class: markClass[name] }).range(start, end));
      if (active) return;
      if (name === 'HeaderMark') {
        hide(start, end + (state.sliceDoc(end, end + 1) === ' ' ? 1 : 0));
      } else if (name === 'URL' && node.node.parent?.name === 'Autolink') return;
      else if (['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'URL', 'LinkTitle', 'QuoteMark'].includes(name)) hide(start, end);
      else if (name === 'TaskMarker') decorations.push(Decoration.replace({ widget: new TaskWidget(/x/i.test(state.sliceDoc(start, end)), start) }).range(start, end));
    },
  });
  const startLine = state.doc.lineAt(Math.min(from, state.doc.length)).number;
  const endLine = state.doc.lineAt(Math.min(to, state.doc.length)).number;
  for (let number = startLine; number <= endLine; number++) {
    const line = state.doc.line(number);
    if (isActive(line.from, line.to)) continue;
    const pattern = /(?<!\\)(\${1,2})([^\n]*?)\1|(?<!\\)\\\([^\n]*?\\\)|(?<!\\)==(?=\S)([^\n]*?\S)==|(?<!\\)<(sup|sub)>[^\n]*?<\/\4>|(?<![\\~])~[^~\s]+~(?!~)|(?<![\\^])\^[^\s^]+\^|(?<![\\\w]):[\w+-]+:/g;
    for (const match of line.text.matchAll(pattern)) {
      const start = line.from + match.index!;
      const end = start + match[0].length;
      if (protectedRanges.some(range => start < range.to && end > range.from)) continue;
      const rendered = renderMarkdown(match[0], { settings, purpose: 'editor', equationIndex, citations, sourceOffset: start });
      if (!/class="(?:katex|md-math)/.test(rendered) && !rendered.includes('<mark>') && !/<(?:sup|sub)>/.test(rendered) && !(settings.emojiAutocomplete && match[0].startsWith(':') && !rendered.includes(match[0]))) continue;
      for (let index = decorations.length - 1; index >= 0; index--) {
        const decoration = decorations[index];
        if (decoration.from >= start && decoration.to <= end && decoration.from !== decoration.to) decorations.splice(index, 1);
      }
      render(start, end, false);
    }
  }
  for (const reference of [...equationIndex.references, ...citationScan.clusters]) {
    const start = reference.from, end = reference.to;
    if (start > to || end < from || isActive(start, end) || protectedRanges.some(range => start < range.to && end > range.from)) continue;
    for (let index = decorations.length - 1; index >= 0; index--) if (decorations[index].from >= start && decorations[index].to <= end && decorations[index].from !== decorations[index].to) decorations.splice(index, 1);
    render(start, end, false);
  }
  return Decoration.set(decorations, true);
}

const liveDecorations = StateField.define<LiveState>({
  create(state) {
    const to = Math.min(state.doc.length, 12000);
    return { from: 0, to, decorations: buildLiveDecorations(state, 0, to) };
  },
  update(value, transaction) {
    let from = transaction.changes.mapPos(value.from, -1);
    let to = transaction.changes.mapPos(value.to, 1);
    let viewportChanged = false;
    for (const effect of transaction.effects) if (effect.is(viewportEffect)) {
      from = effect.value.from;
      to = effect.value.to;
      viewportChanged = true;
    }
    if (transaction.docChanged || transaction.selection || transaction.reconfigured || viewportChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) return { from, to, decorations: buildLiveDecorations(transaction.state, from, to) };
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

const viewportTracker = ViewPlugin.fromClass(class {
  pending = false;
  destroyed = false;
  constructor(readonly view: EditorView) { this.schedule(); }
  update(update: ViewUpdate) { if (update.viewportChanged || update.docChanged) this.schedule(); }
  schedule() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (this.destroyed) return;
      const { from, to } = this.view.viewport;
      const range = { from: Math.max(0, from - 3000), to: Math.min(this.view.state.doc.length, to + 3000) };
      const previous = this.view.state.field(liveDecorations);
      if (range.from !== previous.from || range.to !== previous.to) this.view.dispatch({ effects: viewportEffect.of(range) });
    });
  }
  destroy() { this.destroyed = true; }
});

const searchDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setSearchQuery)))) this.decorations = this.build(update.view);
  }
  build(view: EditorView) {
    const query = getSearchQuery(view.state);
    if (!query.valid) return Decoration.none;
    const ranges: Range<Decoration>[] = [];
    for (const visible of view.visibleRanges) {
      const cursor = query.getCursor(view.state, visible.from, visible.to);
      for (let match = cursor.next(); !match.done; match = cursor.next()) {
        if (match.value.from === match.value.to) continue;
        const selected = view.state.selection.main.from === match.value.from && view.state.selection.main.to === match.value.to;
        ranges.push(Decoration.mark({ class: selected ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch' }).range(match.value.from, match.value.to));
      }
    }
    return Decoration.set(ranges, true);
  }
}, { decorations: plugin => plugin.decorations });

function insertWrapped(view: EditorView, before: string, after = before, fallback = '') {
  const range = view.state.selection.main;
  const content = view.state.sliceDoc(range.from, range.to) || fallback;
  if (range.from >= before.length && view.state.sliceDoc(range.from - before.length, range.from) === before && view.state.sliceDoc(range.to, range.to + after.length) === after) {
    view.dispatch({ changes: [{ from: range.from - before.length, to: range.from, insert: '' }, { from: range.to, to: range.to + after.length, insert: '' }], selection: { anchor: range.from - before.length, head: range.to - before.length }, annotations: formatChange });
  } else view.dispatch({ changes: { from: range.from, to: range.to, insert: before + content + after }, selection: { anchor: range.from + before.length, head: range.from + before.length + content.length }, annotations: formatChange });
  view.focus();
}

function prefixLines(view: EditorView, prefix: string) {
  const selection = view.state.selection.main;
  const first = view.state.doc.lineAt(selection.from).number;
  const last = view.state.doc.lineAt(Math.max(selection.from, selection.to - 1)).number;
  const lines = Array.from({ length: last - first + 1 }, (_, index) => view.state.doc.line(first + index));
  const remove = lines.every(line => line.text.startsWith(prefix));
  view.dispatch({ changes: lines.map(line => ({ from: line.from, to: remove ? line.from + prefix.length : line.from, insert: remove ? '' : prefix })), annotations: formatChange });
  view.focus();
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const versionRef = useRef(props.document.editVersion);
  versionRef.current = Math.max(versionRef.current, props.document.editVersion);
  const configRef = useRef(new Compartment());
  const preferencesRef = useRef(new Compartment());
  const citationsRef = useRef(new Compartment());
  const pendingPreferencesRef = useRef<Settings | null>(null);
  const pendingCitationsRef = useRef<CitationRenderData | null>(null);
  const deferredBibliographyRef = useRef(false);
  const pendingExternalRef = useRef<DocumentSession | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function reportSearch(view: EditorView) {
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      if (viewRef.current !== view) return;
      const query = getSearchQuery(view.state);
      let total = 0;
      let current = 0;
      if (query.valid) {
        const cursor = query.getCursor(view.state);
        const selection = view.state.selection.main;
        for (let match = cursor.next(); !match.done; match = cursor.next()) {
          total++;
          if (match.value.from === selection.from && match.value.to === selection.to) current = total;
        }
      }
      propsRef.current.onFindResult?.({ current, total });
    }, 80);
  }

  function publish(view: EditorView) {
    const current = propsRef.current;
    const source = view.state.doc.toString();
    const mode = new TextEncoder().encode(source).length > sourceLimit ? 'source' : current.document.mode;
    current.onChange({ source, mode, selection: { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }, scrollTop: view.scrollDOM.scrollTop, editVersion: versionRef.current });
  }

  function applyExternal(view: EditorView, document: DocumentSession) {
    if (document.editVersion < versionRef.current) return;
    if (view.state.doc.toString() === document.source) return;
    if (view.composing) { pendingExternalRef.current = document; return; }
    pendingExternalRef.current = null;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: document.source },
      selection: { anchor: Math.min(document.selection.anchor, document.source.length), head: Math.min(document.selection.head, document.source.length) },
      annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
    });
    view.scrollDOM.scrollTop = document.scrollTop;
  }

  async function importImages(files?: File[], position?: number) {
    const view = viewRef.current;
    if (!view) return;
    const selection = view.state.selection.main;
    const id = crypto.randomUUID();
    view.dispatch({ effects: trackInsertion.of({ id, from: position ?? selection.from, to: position ?? selection.to }) });
    try {
      const destinations = await propsRef.current.onImportImages(files);
      if (viewRef.current !== view) return;
      const range = view.state.field(insertions).get(id);
      if (!range || !destinations.length) return;
      const markdown = destinations.map(destination => `![](<${destination.replace(/>/g, '%3E').replace(/</g, '%3C').replace(/\n/g, '%0A')}>)`).join('\n');
      const prefix = range.from > 0 && view.state.sliceDoc(range.from - 1, range.from) !== '\n' ? '\n' : '';
      const suffix = range.to < view.state.doc.length && view.state.sliceDoc(range.to, range.to + 1) !== '\n' ? '\n' : '';
      const insert = prefix + markdown + suffix;
      view.dispatch({ changes: { ...range, insert }, selection: { anchor: range.from + insert.length }, annotations: Transaction.userEvent.of('input.paste') });
      view.focus();
    } finally {
      if (viewRef.current === view) view.dispatch({ effects: untrackInsertion.of(id) });
    }
  }

  function command(name: string) {
    const view = viewRef.current;
    if (!view) return;
    const settings = propsRef.current.settings || defaultSettings;
    if (name === 'bibliography') { insertText('', true); return; }
    if (name === 'equationLabel') {
      if (view.composing || view.compositionStarted) return;
      view.dispatch(equationLabelInsertion(view.state, equationIndexForCommand(view.state)));
      view.focus(); return;
    }
    if (name === 'cut' || name === 'copy' || name === 'paste') {
      view.focus();
      void window.markedown.editCommand(name);
      return;
    }
    const wrapping: Record<string, [string, string?, string?]> = {
      bold: ['**'], italic: ['*'], strike: ['~~'], strikethrough: ['~~'], mark: ['=='], highlight: ['=='], code: ['`'],
      link: ['[', '](https://)', ''], sup: ['<sup>', '</sup>'], sub: ['<sub>', '</sub>'], math: ['$', '$'],
      codeblock: [`\n\`\`\`${defaultFenceLanguage(settings, 'menu')}\n`, '\n```\n'],
    };
    if (wrapping[name]) { insertWrapped(view, ...wrapping[name]); return; }
    if (name === 'orderedList') {
      const selection = view.state.selection.main;
      const first = view.state.doc.lineAt(selection.from).number;
      const last = view.state.doc.lineAt(Math.max(selection.from, selection.to - 1)).number;
      const lines = Array.from({ length: last - first + 1 }, (_, index) => view.state.doc.line(first + index));
      const remove = lines.every(line => /^\d+[.)]\s/.test(line.text));
      view.dispatch({ changes: lines.map((line, index) => ({ from: line.from, to: remove ? line.from + /^\d+[.)]\s+/.exec(line.text)![0].length : line.from, insert: remove ? '' : `${settings.orderedMarker === 'one' ? 1 : index + 1}. ` })), annotations: formatChange });
      view.focus(); return;
    }
    const prefixes: Record<string, string> = { quote: '> ', unorderedList: `${settings.bulletMarker} `, task: `${settings.bulletMarker} [ ] ` };
    if (prefixes[name]) { prefixLines(view, prefixes[name]); return; }
    if (name === 'paragraph') {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const prefix = /^#{1,6}\s+/.exec(line.text)?.[0] || '';
      if (prefix) view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: '' }, annotations: formatChange });
      else if (line.number < view.state.doc.lines) {
        const underline = view.state.doc.line(line.number + 1);
        if (line.text.trim() && /^\s*(?:=+|-+)\s*$/.test(underline.text)) view.dispatch({ changes: { from: line.to, to: underline.to, insert: '' }, annotations: formatChange });
      }
      view.focus();
      return;
    }
    if (/^heading[1-6]$/.test(name)) {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      let end = line.to;
      if (line.number < view.state.doc.lines && /^\s*(?:=+|-+)\s*$/.test(view.state.doc.line(line.number + 1).text)) end = view.state.doc.line(line.number + 1).to;
      const source = view.state.sliceDoc(line.from, end);
      const insert = headingText(source, Number(name.slice(-1)), settings.headingStyle);
      view.dispatch({ changes: { from: line.from, to: end, insert: insert === source ? source.replace(/^#{1,6}\s*/, '').replace(/\n[=-]+\s*$/, '') : insert }, annotations: formatChange });
      view.focus();
      return;
    }
    if (name === 'image') { void importImages(); return; }
    if (name === 'hr') { insertWrapped(view, '\n\n---\n\n', ''); return; }
    if (name === 'undo') undo(view);
    if (name === 'redo') redo(view);
    if (name === 'selectAll') selectAll(view);
    view.focus();
  }

  function insertText(text: string, bibliography = false) {
    const view = viewRef.current;
    if (!view || view.composing || view.compositionStarted) return;
    view.dispatch(academicInsertion(view.state, text, bibliography, view.state.facet(editorPreferences)));
    view.focus();
  }

  useImperativeHandle(ref, () => ({
    command,
    insertText,
    find(query, options) {
      const view = viewRef.current;
      if (!view) return;
      const spec = new SearchQuery({ search: query, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, regexp: options.regex, literal: !options.regex });
      view.dispatch({ effects: setSearchQuery.of(spec) });
      if (spec.valid) searchNext(view);
      reportSearch(view);
    },
    findNext(previous = false) { const view = viewRef.current; if (view) { (previous ? findPrevious : searchNext)(view); reportSearch(view); } },
    replace(value, all = false) {
      const view = viewRef.current;
      if (!view) return;
      const query = getSearchQuery(view.state);
      if (!query.valid) return;
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...query, replace: value })) });
      (all ? replaceAll : replaceNext)(view);
      reportSearch(view);
    },
    scrollTo(offset) {
      const view = viewRef.current;
      if (!view) return;
      const position = Math.max(0, Math.min(offset, view.state.doc.length));
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
      view.focus();
    },
    focus() { viewRef.current?.focus(); },
  }));

  useLayoutEffect(() => {
    if (!host.current) return;
    const initial = propsRef.current;
    const resolver = (destination: string) => window.markedown.imageURL(initial.document.id, destination);
    let scrollFrame = 0;
    let centerPending = false;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.document.source,
        selection: EditorSelection.single(Math.min(initial.document.selection.anchor, initial.document.source.length), Math.min(initial.document.selection.head, initial.document.source.length)),
        extensions: [
          history(), drawSelection(), dropCursor(), EditorView.lineWrapping, insertions,
          EditorState.transactionExtender.of(transaction => ['input.format', 'input.replace', 'input.paste'].some(event => transaction.isUserEvent(event)) ? { annotations: isolateHistory.of('full') } : null),
          markdown({ extensions: GFM, completeHTMLTags: false, pasteURLAsLink: false, addKeymap: false, codeLanguages: codeLanguage }),
          preferencesRef.current.of(preferenceExtensions(initial.settings || defaultSettings)),
          citationsRef.current.of(editorCitations.of(initial.citations || emptyCitationData)),
          bibliographyTypingExtension(() => Boolean(viewRef.current?.composing || viewRef.current?.compositionStarted), () => { deferredBibliographyRef.current = true; }, state => state.facet(editorPreferences)),
          search({ top: true }), searchDecorations,
          imageResolver.of(resolver), configRef.current.of([
            editorSourceMode.of(initial.document.mode === 'source'),
            liveMode.of(initial.document.mode === 'live' && new TextEncoder().encode(initial.document.source).length <= sourceLimit),
            ...(initial.document.mode === 'source' ? [syntaxHighlighting(defaultHighlightStyle)] : []),
          ]),
          editorEquations, editorCitationScan, liveDecorations, viewportTracker,
          preservePointerPosition(view => view.state.facet(liveMode) && !(propsRef.current.typewriter && (propsRef.current.settings || defaultSettings).alwaysCenterCaret)),
          placeholder(''),
          keymap.of([
            { key: 'Mod-b', run: () => { command('bold'); return true; } },
            { key: 'Mod-i', run: () => { command('italic'); return true; } },
            { key: 'Mod-Shift-x', run: () => { command('strike'); return true; } },
            ...historyKeymap, ...defaultKeymap, indentWithTab,
          ]),
          EditorView.domEventHandlers({
            paste(event) {
              const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
              if (!files.length) return false;
              event.preventDefault();
              void importImages(files);
              return true;
            },
            drop(event, editor) {
              const files = Array.from(event.dataTransfer?.files || []);
              if ((propsRef.current.settings || defaultSettings).dropMarkdown === 'insertLink' && files.length && files.every(file => /\.(md|markdown|mdown|mkd)$/i.test(file.name))) {
                const paths = window.markedown.droppedPaths(files);
                if (!paths.length) return false;
                event.preventDefault(); event.stopPropagation();
                const position = editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editor.state.selection.main.head;
                const insert = paths.map(filename => droppedMarkdownLink(filename, propsRef.current.document.path)).join('\n');
                editor.dispatch({ changes: { from: position, insert }, selection: { anchor: position + insert.length }, annotations: Transaction.userEvent.of('input.paste') });
                editor.focus();
                return true;
              }
              const images = files.filter(file => file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name));
              if (!images.length || images.length !== files.length) return false;
              event.preventDefault();
              event.stopPropagation();
              const position = editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editor.state.selection.main.head;
              void importImages(images, position);
              return true;
            },
            dragover(event) { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); return false; },
            click(event, editor) {
              if (navigateAcademicReference(editor, event.target as Element)) { event.preventDefault(); return true; }
              const target = (event.target as Element).closest<HTMLElement>('[data-link],a');
              if (!target) return false;
              if (target.tagName === 'A') event.preventDefault();
              if (event.ctrlKey || event.metaKey) { openLink(target.dataset.link || target.getAttribute('href') || ''); return true; }
              return false;
            },
            compositionend(_event, editor) {
              setTimeout(() => {
                if (viewRef.current !== editor) return;
                if (pendingExternalRef.current) applyExternal(editor, pendingExternalRef.current);
                if (pendingPreferencesRef.current) { const settings = pendingPreferencesRef.current; pendingPreferencesRef.current = null; editor.dispatch({ effects: preferencesRef.current.reconfigure(preferenceExtensions(settings)) }); }
                if (pendingCitationsRef.current) { const citations = pendingCitationsRef.current; pendingCitationsRef.current = null; editor.dispatch({ effects: citationsRef.current.reconfigure(editorCitations.of(citations)) }); }
                if (deferredBibliographyRef.current) {
                  deferredBibliographyRef.current = false;
                  const source = editor.state.doc.toString(), citations = scanCitations(source, editor.state.facet(editorPreferences));
                  if (citations.keys.length && !citations.bibliographies.length) editor.dispatch({ changes: { from: editor.state.doc.length, insert: bibliographySuffix(source) }, selection: editor.state.selection, annotations: Transaction.userEvent.of('input.type.compose') });
                }
              }, 0);
              return false;
            },
            scroll(_event, editor) {
              if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; if (viewRef.current === editor) publish(editor); });
              return false;
            },
          }),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) versionRef.current++;
            if ((update.docChanged || update.selectionSet) && !update.transactions.some(transaction => transaction.annotation(externalChange))) publish(update.view);
            if (update.docChanged || update.selectionSet) reportSearch(update.view);
            if (propsRef.current.typewriter && (update.docChanged || ((propsRef.current.settings || defaultSettings).alwaysCenterCaret && update.selectionSet)) && update.view.hasFocus && !update.view.composing && !centerPending) {
              centerPending = true;
              queueMicrotask(() => {
                centerPending = false;
                if (viewRef.current === update.view) update.view.dispatch({ effects: EditorView.scrollIntoView(update.view.state.selection.main.head, { y: 'center' }) });
              });
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.scrollDOM.scrollTop = initial.document.scrollTop;
    return () => {
      cancelAnimationFrame(scrollFrame);
      clearTimeout(searchTimerRef.current);
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view) applyExternal(view, props.document);
  }, [props.document.source]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: configRef.current.reconfigure([
      editorSourceMode.of(props.document.mode === 'source'),
      liveMode.of(props.document.mode === 'live' && new TextEncoder().encode(props.document.source).length <= sourceLimit),
      ...(props.document.mode === 'source' ? [syntaxHighlighting(defaultHighlightStyle)] : []),
    ]) });
  }, [props.document.mode]);

  useEffect(() => {
    const view = viewRef.current;
    const settings = props.settings || defaultSettings;
    if (!view || view.state.facet(editorPreferences) === settings) return;
    if (view.compositionStarted) { pendingPreferencesRef.current = settings; return; }
    view.dispatch({ effects: preferencesRef.current.reconfigure(preferenceExtensions(settings)) });
  }, [props.settings]);

  useEffect(() => {
    const view = viewRef.current, citations = props.citations || emptyCitationData;
    if (!view || view.state.facet(editorCitations) === citations) return;
    if (view.compositionStarted) { pendingCitationsRef.current = citations; return; }
    view.dispatch({ effects: citationsRef.current.reconfigure(editorCitations.of(citations)) });
  }, [props.citations]);

  useEffect(() => {
    if (!props.active) return;
    const frame = requestAnimationFrame(() => { viewRef.current?.requestMeasure(); viewRef.current?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [props.active]);

  return <div ref={host} className={`markedown-editor ${props.document.mode === 'source' ? 'editor-source' : 'editor-live'} ${props.typewriter ? 'editor-typewriter' : ''}`} data-theme={props.theme} data-document-id={props.document.id} style={{ '--editor-font-size': `${props.fontSize}px`, '--editor-width': `${props.readingWidth}px`, '--editor-code-indent': (props.settings || defaultSettings).codeIndentWidth, display: props.active ? undefined : 'none' } as React.CSSProperties} />;
});

export default Editor;
