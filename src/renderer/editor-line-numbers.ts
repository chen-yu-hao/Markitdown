import { GutterMarker, highlightActiveLineGutter, lineNumbers, lineNumberWidgetMarker } from '@codemirror/view';

class SourceLineMarker extends GutterMarker {
  constructor(readonly number: number) { super(); }
  eq(other: SourceLineMarker) { return this.number === other.number; }
  toDOM() { return document.createTextNode(String(this.number)); }
}

// Native gutters follow CodeMirror's measured block heights and viewport. No
// document-wide DOM measurement or independent scroll synchronisation is needed.
export const documentLineNumbers = [
  lineNumbers(),
  highlightActiveLineGutter(),
  lineNumberWidgetMarker.of((view, _widget, block) =>
    // Synthetic bibliography widgets have no source lines of their own.
    block.length > 0 ? new SourceLineMarker(view.state.doc.lineAt(block.from).number) : null),
];
