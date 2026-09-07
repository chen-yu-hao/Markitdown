import { EditorState, Transaction, type ChangeSpec, type TransactionSpec } from '@codemirror/state';
import { BIBLIOGRAPHY_MARKER, scanCitations } from '../shared/citations';
import { extractEquationLabels, type EquationIndex } from '../shared/equation-references';
import type { Settings } from '../shared/contracts';
import { GFM, parser } from '@lezer/markdown';

export function bibliographySuffix(source: string): string {
  const separator = !source || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return separator + BIBLIOGRAPHY_MARKER + '\n';
}

export function displayEquationInsertion(state: EditorState): TransactionSpec {
  const { from, to } = state.selection.main;
  const before = state.sliceDoc(Math.max(0, from - 2), from);
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + 2));
  const prefix = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const suffix = !after ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const content = state.sliceDoc(from, to);
  const anchor = from + prefix.length + 3;
  return {
    changes: { from, to, insert: `${prefix}$$\n${content}\n$$${suffix}` },
    selection: { anchor, head: anchor + content.length },
    annotations: Transaction.userEvent.of('input.format'),
  };
}

export function academicInsertion(state: EditorState, text: string, bibliography = false, settings?: Partial<Settings>): TransactionSpec {
  const selection = state.selection.main;
  if (bibliography && !text) {
    const source = state.doc.toString();
    if (scanCitations(source, settings).bibliographies.length) return {};
    return { changes: { from: state.doc.length, insert: bibliographySuffix(source) }, selection: state.selection, annotations: Transaction.userEvent.of('input.format') };
  }
  const replace = { from: selection.from, to: selection.to, insert: text };
  const result = state.changes(replace).apply(state.doc).toString();
  const changes: ChangeSpec[] = [replace];
  if (bibliography && !scanCitations(result, settings).bibliographies.length) {
    const suffix = bibliographySuffix(result);
    if (selection.to === state.doc.length) replace.insert += suffix;
    else changes.push({ from: state.doc.length, insert: suffix });
  }
  return { changes, selection: { anchor: selection.from + text.length }, annotations: Transaction.userEvent.of('input.format') };
}

/** Only a newly completed citation cluster triggers a source change. */
export function bibliographyForTypedCitation(transaction: Transaction, settings?: Partial<Settings>): TransactionSpec | null {
  if (!transaction.docChanged || !transaction.isUserEvent('input')) return null;
  const source = transaction.newDoc.toString();
  let candidate = false;
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB <= fromB) return;
    const before = source.lastIndexOf('[', fromB), after = source.indexOf(']', toB);
    const start = before < 0 ? fromB : before;
    const end = after < 0 ? toB : after + 1;
    for (const match of source.slice(start, end).matchAll(/\[\s*@[A-Z0-9]{8}(?:\s*;\s*@[A-Z0-9]{8})*\s*\]/g)) {
      if (start + match.index < toB && start + match.index + match[0].length > fromB) candidate = true;
    }
  });
  if (!candidate) return null;
  const scan = scanCitations(source, settings);
  if (!scan.keys.length || scan.bibliographies.length) return null;
  let completed = false;
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB && scan.clusters.some(cluster => cluster.from < toB && cluster.to > fromB)) completed = true;
  });
  if (!completed) return null;
  return { changes: { from: transaction.newDoc.length, insert: bibliographySuffix(source) }, selection: transaction.newSelection, sequential: true };
}

export function bibliographyTypingExtension(isComposing: () => boolean, onDeferred: () => void, settingsFor: (state: EditorState) => Partial<Settings> | undefined = () => undefined) {
  return EditorState.transactionFilter.of(transaction => {
    const addition = bibliographyForTypedCitation(transaction, settingsFor(transaction.startState));
    if (!addition) return transaction;
    if (isComposing()) { onDeferred(); return transaction; }
    return [transaction, addition];
  });
}

export function equationLabelInsertion(state: EditorState, index: EquationIndex): TransactionSpec {
  const selection = state.selection.main;
  const equation = index.equations.find(equation => equation.from <= selection.head && equation.to >= selection.head);
  if (equation?.label) {
    const raw = state.sliceDoc(equation.from, equation.to);
    const command = [...raw.matchAll(/\\label\{([^{}\s]+)\}/g)].find(match => match[1] === equation.label && extractEquationLabels(raw.slice(0, match.index + match[0].length)).labels.includes(equation.label!));
    const trailing = raw.lastIndexOf(`{#${equation.label}}`);
    const offset = command ? command.index + '\\label{'.length : trailing < 0 ? -1 : trailing + 2;
    if (offset >= 0) return { selection: { anchor: equation.from + offset, head: equation.from + offset + equation.label.length } };
  }
  const used = new Set(index.equations.flatMap(equation => equation.labels));
  let number = 1;
  while (used.has(`eq:equation-${number}`)) number++;
  const label = `eq:equation-${number}`;
  const markup = `\\label{${label}}`;
  if (!equation) {
    const content = state.sliceDoc(selection.from, selection.to);
    const prefix = selection.from > 0 && state.sliceDoc(selection.from - 1, selection.from) !== '\n' ? '\n\n' : '';
    const insert = `${prefix}$$\n${markup}\n${content}\n$$\n`;
    const anchor = selection.from + prefix.length + 3 + '\\label{'.length;
    return { changes: { from: selection.from, to: selection.to, insert }, selection: { anchor, head: anchor + label.length }, annotations: Transaction.userEvent.of('input.format') };
  }
  const raw = state.sliceDoc(equation.from, equation.to);
  let position = -1, insert = markup, labelOffset = '\\label{'.length;
  if (equation.block) {
    // Lezer supplies body positions after list/quote prefixes, preserving every container byte.
    parser.configure(GFM).parse(state.doc.toString()).iterate({ enter(node) {
      if (node.name !== 'FencedCode' || node.to < equation.from || node.from > equation.to) return;
      const info = node.node.getChild('CodeInfo');
      if (!info || !/^math(?:\s|$)/.test(state.sliceDoc(info.from, info.to))) return;
      const body = node.node.getChild('CodeText');
      if (body) position = body.from;
      else { position = info.to; insert = ` {#${label}}`; labelOffset = 3; }
      return false;
    } });
  }
  if (position < 0) {
    const opening = /\$\$|\\\[|\\\(|\$/.exec(raw);
    position = equation.from + (opening ? opening.index + opening[0].length : 0);
  }
  const anchor = position + labelOffset;
  return { changes: { from: position, insert }, selection: { anchor, head: anchor + label.length }, annotations: Transaction.userEvent.of('input.format') };
}
