import { type EditorSelection, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

interface PointerAnchor {
  position: number;
  side: -1 | 1;
  center: number;
  x: number;
  y: number;
  doc: Text;
  selection?: EditorSelection;
}

interface PointerMeasurement { delta: number; wanted: number; max: number; viewportHeight: number }

export function preservePointerPosition(enabled: (view: EditorView) => boolean) {
  return ViewPlugin.fromClass(class {
    anchor: PointerAnchor | null = null;
    frame = 0;
    topSpace = 0;
    bottomSpace = 0;
    destroyed = false;
    stopForPointer = (event: Event) => {
      if (event.type === 'wheel' || event.type === 'touchstart' || !this.view.contentDOM.contains(event.target as Node)) {
        this.cancel();
        this.reclaimSpace();
      }
    };
    constructor(readonly view: EditorView) {
      for (const type of ['wheel', 'touchstart', 'pointerdown']) view.scrollDOM.addEventListener(type, this.stopForPointer, { passive: true });
    }

    cancel() {
      this.anchor = null;
      cancelAnimationFrame(this.frame);
    }

    reclaimSpace() {
      const scroller = this.view.scrollDOM;
      const top = Math.min(this.topSpace, scroller.scrollTop);
      const bottom = Math.min(this.bottomSpace, Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop));
      if (!top && !bottom) return;
      const scrollTop = scroller.scrollTop - top;
      this.topSpace -= top;
      this.bottomSpace -= bottom;
      this.view.dom.style.setProperty('--editor-pointer-top', `${this.topSpace}px`);
      this.view.dom.style.setProperty('--editor-pointer-bottom', `${this.bottomSpace}px`);
      scroller.scrollTop = scrollTop;
      this.view.requestMeasure();
    }

    capture(event: MouseEvent) {
      this.cancel();
      if (!enabled(this.view) || this.view.composing || event.button !== 0 || event.detail > 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
      const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return false;
      const selection = this.view.state.selection.main;
      if (!selection.empty && position >= selection.from && position <= selection.to) return false;
      const candidates = ([-1, 1] as const).map(side => ({ side, rect: this.view.coordsAtPos(position, side) })).filter(candidate => candidate.rect !== null);
      candidates.sort((a, b) => Math.abs((a.rect!.top + a.rect!.bottom) / 2 - event.clientY) - Math.abs((b.rect!.top + b.rect!.bottom) / 2 - event.clientY));
      const candidate = candidates[0];
      if (candidate) this.anchor = { position, side: candidate.side, center: (candidate.rect!.top + candidate.rect!.bottom) / 2, x: event.clientX, y: event.clientY, doc: this.view.state.doc };
      return false;
    }

    update(update: ViewUpdate) {
      if (!enabled(this.view)) {
        this.cancel();
        this.topSpace = this.bottomSpace = 0;
        this.view.dom.style.removeProperty('--editor-pointer-top');
        this.view.dom.style.removeProperty('--editor-pointer-bottom');
        return;
      }
      if (!this.anchor) return;
      if (update.docChanged || this.view.composing) { this.cancel(); return; }
      if (!update.selectionSet) return;
      const selection = update.state.selection;
      if (this.anchor.selection || !selection.main.empty || selection.main.head !== this.anchor.position || !update.transactions.some(transaction => transaction.isUserEvent('select.pointer'))) { this.cancel(); return; }
      this.anchor.selection = selection;
      this.measure(this.anchor, 4);
    }

    valid(anchor: PointerAnchor) {
      return !this.destroyed && this.anchor === anchor && enabled(this.view) && !this.view.composing && this.view.dom.getBoundingClientRect().height > 0 && this.view.state.doc === anchor.doc && !!anchor.selection?.eq(this.view.state.selection);
    }

    readAnchor(anchor: PointerAnchor): PointerMeasurement | null {
      const view = this.view;
      const assoc = view.state.selection.main.assoc;
      const rect = view.coordsAtPos(anchor.position, assoc < 0 ? -1 : assoc > 0 ? 1 : anchor.side);
      if (!rect) return null;
      const delta = ((rect.top + rect.bottom) / 2 - anchor.center) / view.scaleY;
      return { delta, wanted: view.scrollDOM.scrollTop + delta, max: view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight, viewportHeight: view.scrollDOM.clientHeight };
    }

    applyAnchor({ delta, wanted, max, viewportHeight }: PointerMeasurement) {
      if (Math.abs(delta) <= 0.5) return;
      // Short documents need room to scroll when source markers reflow a paragraph.
      if (wanted < 0) {
        this.topSpace = Math.min(viewportHeight, this.topSpace - wanted);
        this.view.dom.style.setProperty('--editor-pointer-top', `${this.topSpace}px`);
      } else if (wanted > max) {
        this.bottomSpace = Math.min(viewportHeight, this.bottomSpace + wanted - max + 1);
        this.view.dom.style.setProperty('--editor-pointer-bottom', `${this.bottomSpace}px`);
      }
      this.view.scrollDOM.scrollTop = Math.max(0, wanted);
    }

    finishBeforeInput() {
      const anchor = this.anchor;
      const valid = anchor && this.valid(anchor);
      this.cancel();
      if (!valid) return;
      // Input can arrive before the next animation frame. Finish the pending click first.
      for (let pass = 0; pass < 4; pass++) {
        const measurement = this.readAnchor(anchor);
        if (!measurement || Math.abs(measurement.delta) <= 0.5) break;
        this.applyAnchor(measurement);
        this.view.requestMeasure();
      }
    }

    measure(anchor: PointerAnchor, remaining: number) {
      this.view.requestMeasure({
        key: this,
        read: () => {
          if (!this.valid(anchor)) return null;
          return this.readAnchor(anchor);
        },
        write: measurement => {
          if (!measurement || this.anchor !== anchor) return;
          this.applyAnchor(measurement);
          // CodeMirror also anchors scrolling during its measure pass; check the residual next frame.
          if (remaining > 1) this.frame = requestAnimationFrame(() => { if (this.anchor === anchor) this.measure(anchor, remaining - 1); });
        },
      });
    }

    destroy() {
      this.destroyed = true;
      this.cancel();
      for (const type of ['wheel', 'touchstart', 'pointerdown']) this.view.scrollDOM.removeEventListener(type, this.stopForPointer);
    }
  }, {
    eventHandlers: {
      mousedown(event) { return this.capture(event); },
      mousemove(event) { if (this.anchor && event.buttons && Math.hypot(event.clientX - this.anchor.x, event.clientY - this.anchor.y) > 3) this.cancel(); return false; },
      keydown(event) {
        this.finishBeforeInput();
        if (event.key === 'Home' && (event.ctrlKey || event.metaKey)) {
          this.topSpace = this.bottomSpace = 0;
          this.view.dom.style.removeProperty('--editor-pointer-top');
          this.view.dom.style.removeProperty('--editor-pointer-bottom');
          this.view.requestMeasure();
        }
        return false;
      },
      wheel() { this.cancel(); return false; },
      touchstart() { this.cancel(); return false; },
      beforeinput() { this.finishBeforeInput(); return false; },
      compositionstart() { this.finishBeforeInput(); return false; },
    },
  });
}
