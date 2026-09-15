import { describe, expect, it } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { headingPointerSelection } from '../src/renderer/editor-clipboard';

describe('rendered heading drag selection', () => {
  const source = 'Before\n\n### 标题 😀\n\nBody text';
  const start = source.indexOf('###'), text = start + 4;
  function select(anchor: number, head: number, sourceMode = false, event = 'select.pointer') {
    const state = EditorState.create({ doc: source, extensions: headingPointerSelection(() => sourceMode) });
    const next = state.update({ selection: { anchor, head }, annotations: Transaction.userEvent.of(event) }).state;
    return next.selection.main;
  }
  it('includes hidden heading marks in forward and backward drags', () => {
    expect(select(text, source.length).anchor).toBe(start);
    expect(select(source.length, text).head).toBe(start);
  });
  it('leaves partial heading selections, carets, keyboard and source selections exact', () => {
    expect(select(text + 1, source.length).from).toBe(text + 1);
    expect(select(text, text).from).toBe(text);
    expect(select(text, source.length, true).from).toBe(text);
    expect(select(text, source.length, false, 'select').from).toBe(text);
  });
});
