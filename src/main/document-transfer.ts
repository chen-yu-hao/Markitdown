import type { Result } from '../shared/contracts';

export interface DocumentTransfer {
  id: string;
  sourceWindow: number;
  targetWindow?: number;
  editorState: unknown;
  result: Promise<Result<boolean>>;
}
interface PendingTransfer extends DocumentTransfer { resolve(result: Result<boolean>): void; timer: ReturnType<typeof setTimeout> }

export function transferEditorState(value: unknown, source: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { doc?: unknown }).doc !== source) throw new Error('The editor state does not match the document snapshot.');
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 64 * 1024 * 1024) throw new Error('The editor history is too large to move into another window.');
  return JSON.parse(json);
}

/** Ownership changes once; the original window remains the rollback destination until acknowledgment. */
export class DocumentTransfers {
  private readonly pending = new Map<string, PendingTransfer>();
  constructor(private readonly owners: Map<string, number>, private readonly settled: (transfer: DocumentTransfer, result: Result<boolean>) => void, private readonly timeout = 20_000) {}
  get(id: string): DocumentTransfer | undefined { return this.pending.get(id); }
  forWindow(windowId: number): DocumentTransfer | undefined { return [...this.pending.values()].find(item => item.sourceWindow === windowId || item.targetWindow === windowId); }
  begin(id: string, sourceWindow: number, editorState: unknown): DocumentTransfer {
    if (this.owners.get(id) !== sourceWindow || this.pending.has(id) || this.forWindow(sourceWindow)) throw new Error('The document or window is already being transferred.');
    let resolve!: (result: Result<boolean>) => void;
    const result = new Promise<Result<boolean>>(complete => { resolve = complete; });
    const timer = setTimeout(() => this.cancel(id, 'The new window did not restore the editor in time. The document remains in its original window.'), this.timeout);
    timer.unref?.();
    const transfer: PendingTransfer = { id, sourceWindow, editorState, result, resolve, timer };
    this.pending.set(id, transfer);
    return transfer;
  }
  attach(id: string, targetWindow: number): void {
    const transfer = this.pending.get(id);
    if (!transfer || transfer.targetWindow !== undefined || this.forWindow(targetWindow)) throw new Error('The transfer target is not available.');
    transfer.targetWindow = targetWindow;
    this.owners.set(id, targetWindow);
  }
  acknowledge(id: string, targetWindow: number, accepted: boolean): void {
    const transfer = this.pending.get(id);
    if (!transfer) return;
    if (transfer.targetWindow !== targetWindow) throw new Error('Only the receiving window can confirm a document transfer.');
    this.finish(transfer, accepted ? { status: 'ok', value: true } : { status: 'error', message: 'The new window could not restore the editor. The document remains in its original window.' });
  }
  cancel(id: string, message = 'The new window closed before the document transfer finished.'): void {
    const transfer = this.pending.get(id);
    if (transfer) this.finish(transfer, { status: 'error', message });
  }
  private finish(transfer: PendingTransfer, result: Result<boolean>): void {
    this.pending.delete(transfer.id);
    clearTimeout(transfer.timer);
    if (result.status !== 'ok') this.owners.set(transfer.id, transfer.sourceWindow);
    try { this.settled(transfer, result); }
    finally { transfer.resolve(result); }
  }
}

export function visibleWindowBounds(area: { x: number; y: number; width: number; height: number }, position?: { x: number; y: number }) {
  const width = Math.min(1280, area.width);
  const height = Math.min(860, area.height);
  const x = position ? position.x : area.x + (area.width - width) / 2;
  const y = position ? position.y : area.y + (area.height - height) / 2;
  return { width, height, minWidth: Math.min(700, width), minHeight: Math.min(480, height), x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, x))), y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, y))) };
}
