import { describe, expect, it, vi } from 'vitest';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { history, redo, undo } from '@codemirror/commands';
import { BIBLIOGRAPHY_MARKER, scanCitations } from '../src/shared/citations';
import { defaultSettings } from '../src/shared/contracts';
import { getEquationIndex, renderMarkdown } from '../src/shared/markdown';
import { academicInsertion, bibliographyForTypedCitation, bibliographyTypingExtension, displayEquationInsertion, equationLabelInsertion } from '../src/renderer/editor-academic';
import { editorCitationScan, editorEquations, editorPreferences, editorSourceMode } from '../src/renderer/editor-preferences';

const stateFor = (source: string, from = source.length, to = from) => EditorState.create({ doc: source, selection: { anchor: from, head: to }, extensions: [history(), bibliographyTypingExtension(() => false, () => {})] });
const applyHistory = (state: EditorState, command: typeof undo) => {
  let result = state;
  command({ state, dispatch: transaction => { result = transaction.state; } });
  return result;
};

describe('academic insertion and recovery of source', () => {
  it('inserts a numbered display equation at the selection and restores the paragraph with one undo', () => {
    const source = 'Before x^2 + y^2 after';
    const state = stateFor(source, 7, 16);
    const next = state.update(displayEquationInsertion(state)).state;
    expect(next.doc.toString()).toBe('Before \n\n$$\nx^2 + y^2\n$$\n\n after');
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('x^2 + y^2');
    expect(getEquationIndex(next.doc.toString()).equations.map(equation => [equation.block, equation.number])).toEqual([[true, '1']]);
    const restored = applyHistory(next, undo);
    expect(restored.doc.toString()).toBe(source);
    expect(restored.selection.eq(state.selection)).toBe(true);
    expect(applyHistory(restored, redo).doc.toString()).toBe(next.doc.toString());
  });
  it('places the cursor inside an empty display equation without adding redundant paragraph gaps', () => {
    for (const source of ['', 'Before\n\n', 'Before\n']) {
      const state = stateFor(source);
      const next = state.update(displayEquationInsertion(state)).state;
      const expected = source ? 'Before\n\n$$\n\n$$\n' : '$$\n\n$$\n';
      expect(next.doc.toString()).toBe(expected);
      expect(next.selection.main.empty).toBe(true);
      const typed = next.update({ changes: { from: next.selection.main.head, insert: 'E=mc^2' } }).newDoc.toString();
      expect(getEquationIndex(typed).equations.map(equation => equation.number)).toEqual(['1']);
    }
  });
  it('appends a bibliography without replacing selected text and preserves the selection', () => {
    const source = 'Selected text\n\nLast paragraph';
    const state = stateFor(source, 0, 8);
    const next = state.update(academicInsertion(state, '', true)).state;
    expect(next.doc.toString()).toBe(source + '\n\n' + BIBLIOGRAPHY_MARKER + '\n');
    expect(next.selection.eq(state.selection)).toBe(true);
    expect(applyHistory(next, undo).doc.toString()).toBe(source);
    expect(next.update(academicInsertion(next, '', true)).newDoc.toString()).toBe(next.doc.toString());
  });
  it('inserts at the retained selection and appends a single bibliography marker in one undo', () => {
    const source = 'Before selected after\n\nLast paragraph';
    const state = stateFor(source, 7, 15);
    const next = state.update(academicInsertion(state, '[@ABCDEFGH; @IJKLMNOP]', true)).state;
    expect(next.doc.toString()).toBe('Before [@ABCDEFGH; @IJKLMNOP] after\n\nLast paragraph\n\n' + BIBLIOGRAPHY_MARKER + '\n');
    expect(next.selection.main.head).toBe(7 + '[@ABCDEFGH; @IJKLMNOP]'.length);
    const restored = applyHistory(next, undo);
    expect(restored.doc.toString()).toBe(source);
    expect(applyHistory(restored, redo).doc.toString()).toBe(next.doc.toString());
  });
  it('does not duplicate a real bibliography and ignores literal markers inside code', () => {
    const existing = stateFor('Text\n\n' + BIBLIOGRAPHY_MARKER + '\n', 4);
    expect(scanCitations(existing.update(academicInsertion(existing, '[@ABCDEFGH]', true)).newDoc.toString()).bibliographies).toHaveLength(1);
    const code = stateFor('```html\n' + BIBLIOGRAPHY_MARKER + '\n```\n\nText');
    const inserted = code.update(academicInsertion(code, ' [@ABCDEFGH]', true)).newDoc.toString();
    expect(inserted.match(/markedown:bibliography/g)).toHaveLength(2);
    expect(scanCitations(inserted).bibliographies).toHaveLength(1);
  });
  it('treats a completed typed group and its marker as one undoable change', () => {
    const state = stateFor('Evidence [@ABCDEFGH');
    expect(scanCitations('Evidence [@ABCDEFGH]').keys).toEqual(['ABCDEFGH']);
    const completed = state.update({ changes: { from: state.doc.length, insert: ']' }, annotations: Transaction.userEvent.of('input.type') }).state;
    expect(completed.doc.toString()).toBe('Evidence [@ABCDEFGH]\n\n' + BIBLIOGRAPHY_MARKER + '\n');
    expect(applyHistory(completed, undo).doc.toString()).toBe(state.doc.toString());
  });
  it('never appends a marker merely for opening a document, external reload or unrelated typing', () => {
    const source = 'Existing [@ABCDEFGH]\n\nText';
    const state = stateFor(source);
    expect(state.doc.toString()).toBe(source);
    expect(state.update({ changes: { from: state.doc.length, insert: ' x' }, annotations: Transaction.userEvent.of('input.type') }).newDoc.toString()).toBe(source + ' x');
    expect(state.update({ changes: { from: 0, to: state.doc.length, insert: 'Reloaded [@ABCDEFGH]' } }).newDoc.toString()).toBe('Reloaded [@ABCDEFGH]');
  });
  it('keeps code and escaped citations literal and defers changes during composition', () => {
    for (const source of ['`[@ABCDEFGH]`', '```md\n[@ABCDEFGH]\n```', '\\[@ABCDEFGH]']) {
      const state = stateFor('');
      const next = state.update({ changes: { from: 0, insert: source }, annotations: Transaction.userEvent.of('input.paste') }).newDoc.toString();
      expect(next).toBe(source);
    }
    const deferred = vi.fn();
    const state = EditorState.create({ doc: '[@ABCDEFGH', extensions: [bibliographyTypingExtension(() => true, deferred)] });
    const next = state.update({ changes: { from: state.doc.length, insert: ']' }, annotations: Transaction.userEvent.of('input.type.compose') });
    expect(next.newDoc.toString()).toBe('[@ABCDEFGH]');
    expect(deferred).toHaveBeenCalledOnce();
    expect(bibliographyForTypedCitation(next)?.sequential).toBe(true);
  });
  it('rechecks citations when math settings change without mutating source', () => {
    const source = '$[@ABCDEFGH]$';
    const compartment = new Compartment();
    const state = EditorState.create({ doc: source, extensions: [compartment.of(editorPreferences.of(defaultSettings)), editorCitationScan] });
    expect(state.field(editorCitationScan).keys).toEqual([]);
    const next = state.update({ effects: compartment.reconfigure(editorPreferences.of({ ...defaultSettings, inlineMath: false })) }).state;
    expect(next.field(editorCitationScan).keys).toEqual(['ABCDEFGH']);
    expect(next.doc.toString()).toBe(source);
    const typed = EditorState.create({ extensions: [bibliographyTypingExtension(() => false, () => {}, () => ({ inlineMath: false }))] });
    expect(typed.update({ changes: { from: 0, insert: source }, annotations: Transaction.userEvent.of('input.type') }).newDoc.toString()).toContain(BIBLIOGRAPHY_MARKER);
  });
});

describe('equation label commands and full-document reference context', () => {
  it('adds an editable unique label to the active inline equation without changing its expression', () => {
    const source = '$a\\label{eq:equation-1}$ and $x^2$';
    const state = stateFor(source, source.lastIndexOf('x'));
    const next = state.update(equationLabelInsertion(state, getEquationIndex(source))).state;
    expect(next.doc.toString()).toBe('$a\\label{eq:equation-1}$ and $\\label{eq:equation-2}x^2$');
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('eq:equation-2');
    expect(applyHistory(next, undo).doc.toString()).toBe(source);
  });
  it('selects an existing label and inserts labels inside display and math fences', () => {
    for (const source of ['$$\nx=1\n$$', '```math\nx=1\n```', '\\[\nx=1\n\\]']) {
      const state = stateFor(source, source.indexOf('x=1'));
      const next = state.update(equationLabelInsertion(state, getEquationIndex(source))).state;
      const index = getEquationIndex(next.doc.toString());
      expect(index.equations).toHaveLength(1);
      expect(index.equations[0].label).toBe('eq:equation-1');
      expect(index.equations[0].source).toBe('x=1');
      const selected = next.update(equationLabelInsertion(next, index)).state;
      expect(selected.doc.toString()).toBe(next.doc.toString());
      expect(selected.sliceDoc(selected.selection.main.from, selected.selection.main.to)).toBe('eq:equation-1');
    }
  });
  it('creates a labelled display equation outside existing math and keeps the label selected', () => {
    const state = stateFor('Paragraph');
    const next = state.update(equationLabelInsertion(state, getEquationIndex(state.doc.toString()))).state;
    expect(next.doc.toString()).toBe('Paragraph\n\n$$\n\\label{eq:equation-1}\n\n$$\n');
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('eq:equation-1');
  });
  it('adds labels inside quoted and listed math without changing any container prefix', () => {
    for (const source of ['> $$\n> x=1\n> $$', '- $$\n  x=1\n  $$', '> ```math\n> x=1\n> ```', '- ```math\n  x=1\n  ```', '> - ```math\n>   x=1\n>   ```']) {
      const state = stateFor(source, source.indexOf('x=1'));
      const initialIndex = getEquationIndex(source);
      expect(initialIndex.equations).toHaveLength(1);
      const next = state.update(equationLabelInsertion(state, initialIndex)).state;
      const index = getEquationIndex(next.doc.toString());
      expect(index.equations, next.doc.toString()).toHaveLength(1);
      expect(index.equations[0].label).toBe('eq:equation-1');
      expect(index.equations[0].source).toBe('x=1');
      expect(next.doc.toString().replace('\\label{eq:equation-1}', '')).toBe(source);
      expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('eq:equation-1');
      expect(applyHistory(next, undo).doc.toString()).toBe(source);
    }
  });
  it('labels empty math fences and selects actual labels rather than matching equation variables', () => {
    const source = '> ```math\n> ```';
    const state = stateFor(source, 5);
    const next = state.update(equationLabelInsertion(state, getEquationIndex(source))).state;
    expect(getEquationIndex(next.doc.toString()).equations[0].label).toBe('eq:equation-1');
    expect(next.doc.toString().replace(' {#eq:equation-1}', '')).toBe(source);
    for (const expression of ['$x\\label{x}$', '$x$ {#x}', '$$\n% \\label{x}\nx\\label{x}\n$$']) {
      const state = stateFor(expression, expression.indexOf('x'));
      const selected = state.update(equationLabelInsertion(state, getEquationIndex(expression))).state;
      expect(selected.selection.main.from).toBe(expression.lastIndexOf('x'));
      expect(selected.sliceDoc(selected.selection.main.from, selected.selection.main.to)).toBe('x');
      expect(selected.doc.toString()).toBe(expression);
    }
  });
  it('uses the full index for a rendered snippet after earlier equations', () => {
    const source = '$$\na\\label{eq:first}\n$$\n\n$$\nb\\label{eq:second}\n$$\n\nSee \\eqref{eq:second}.';
    const settings = { ...defaultSettings, mathNumbering: 'all' as const };
    const equationIndex = getEquationIndex(source, settings);
    const from = source.indexOf('See');
    const html = renderMarkdown(source.slice(from), { settings, equationIndex, sourceOffset: from, purpose: 'editor' });
    expect(html).toContain('(2)');
    expect(html).toContain('data-equation-from=');
  });
});

describe('academic indexing limits', () => {
  it('keeps no-math text and large source typing off the full parser path', () => {
    const plain = EditorState.create({ doc: 'Plain text '.repeat(110000), extensions: [editorEquations, editorCitationScan] });
    const first = plain.field(editorEquations);
    const next = plain.update({ changes: { from: plain.doc.length, insert: 'x' } }).state;
    expect(next.field(editorEquations)).toBe(first);
    const source = ('Paragraph [@ABCDEFGH] $x=1$\n\n').repeat(50000);
    const large = EditorState.create({ doc: source, extensions: [editorSourceMode.of(true), editorEquations, editorCitationScan, bibliographyTypingExtension(() => false, () => {})] });
    expect(large.field(editorEquations).equations).toEqual([]);
    expect(large.field(editorCitationScan).keys).toEqual([]);
    const largeNext = large.update({ changes: { from: source.length, insert: 'plain typing' }, annotations: Transaction.userEvent.of('input.type') }).state;
    expect(largeNext.field(editorEquations)).toBe(large.field(editorEquations));
    expect(largeNext.doc.toString()).toBe(source + 'plain typing');
  });
  it('resumes normal academic indexing when a source document becomes small', () => {
    const source = '$x\\label{eq:x}$ [@ABCDEFGH]\n';
    const state = EditorState.create({ doc: source.repeat(50000), extensions: [editorSourceMode.of(true), editorEquations, editorCitationScan] });
    expect(state.field(editorEquations).equations).toEqual([]);
    const next = state.update({ changes: { from: 0, to: state.doc.length, insert: source } }).state;
    expect(next.field(editorEquations).equations).toHaveLength(1);
    expect(next.field(editorCitationScan).keys).toEqual(['ABCDEFGH']);
  });
});
