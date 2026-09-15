import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** A drag starting at a rendered ATX heading's first character includes its prefix. */
export const headingPointerSelection = (sourceMode: (state: EditorState) => boolean) => EditorState.transactionFilter.of(transaction => {
  if (transaction.docChanged || !transaction.selection || sourceMode(transaction.state) || !transaction.isUserEvent('select.pointer')) return transaction;
  const ranges = transaction.newSelection.ranges.map(range => {
    if (range.empty) return range;
    const line = transaction.newDoc.lineAt(range.from);
    const prefix = /^ {0,3}#{1,6}[ \t]+/.exec(line.text)?.[0];
    if (!prefix || range.from > line.from + prefix.length || range.to <= line.from + prefix.length) return range;
    return EditorSelection.range(range.anchor <= range.head ? line.from : range.anchor, range.anchor <= range.head ? range.head : line.from);
  });
  const selection = EditorSelection.create(ranges, transaction.newSelection.mainIndex);
  return selection.eq(transaction.newSelection) ? transaction : [transaction, { selection, sequential: true }];
});

/** Keep the first visible source block anchored when paste changes the layout. */
export function pasteWithoutScroll(view: EditorView, insert: () => Transaction) {
  if (!view.dom.getClientRects().length) { insert(); return; }
  const snapshot = view.scrollSnapshot();
  const transaction = insert();
  // Let CodeMirror restore the mapped source anchor after its height map settles.
  // Direct scrollTop writes race its own anchoring when text is inserted above.
  const mapped = snapshot.map(transaction.changes);
  if (mapped) view.dispatch({ effects: mapped });
}

export const stableTextPaste = EditorView.domEventHandlers({
  paste(event, view) {
    if (view.state.readOnly || event.clipboardData?.files.length || !event.clipboardData?.types.includes('text/plain')) return false;
    const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    event.preventDefault();
    pasteWithoutScroll(view, () => {
      const transaction = view.state.update({ ...view.state.replaceSelection(text), annotations: Transaction.userEvent.of('input.paste'), scrollIntoView: false });
      view.dispatch(transaction); return transaction;
    });
    return true;
  },
});
