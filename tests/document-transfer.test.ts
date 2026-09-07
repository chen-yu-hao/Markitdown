import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentTransfers, transferEditorState, visibleWindowBounds } from '../src/main/document-transfer';

afterEach(() => vi.useRealTimers());

describe('document window transfer', () => {
  it('retains exactly one owner and waits for the receiving editor before completing', async () => {
    const owners = new Map([['document', 1]]);
    const completed = vi.fn();
    const transfers = new DocumentTransfers(owners, completed);
    const transfer = transfers.begin('document', 1, { doc: 'unsaved', history: { done: [] } });
    let resolved = false;
    void transfer.result.then(() => { resolved = true; });
    expect(owners.get('document')).toBe(1);
    transfers.attach('document', 2);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(completed).not.toHaveBeenCalled();
    expect([...owners]).toEqual([['document', 2]]);
    expect(transfers.forWindow(1)).toBe(transfer);
    expect(transfers.forWindow(2)).toBe(transfer);
    transfers.acknowledge('document', 2, true);
    expect(transfers.get('document')).toBeUndefined();
    expect(owners.get('document')).toBe(2);
    await expect(transfer.result).resolves.toEqual({ status: 'ok', value: true });
    transfers.acknowledge('document', 2, true);
    transfers.cancel('document');
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it.each(['reject', 'close', 'timeout'])('restores the source owner on %s and accepts a later retry', async failure => {
    vi.useFakeTimers();
    const owners = new Map([['document', 1]]);
    const completed = vi.fn(() => expect(owners.get('document')).toBe(1));
    const transfers = new DocumentTransfers(owners, completed, 100);
    const transfer = transfers.begin('document', 1, { doc: 'unsaved' });
    transfers.attach('document', 2);
    if (failure === 'reject') transfers.acknowledge('document', 2, false);
    else if (failure === 'close') transfers.cancel('document');
    else await vi.advanceTimersByTimeAsync(100);
    await expect(transfer.result).resolves.toMatchObject({ status: 'error' });
    expect(owners.get('document')).toBe(1);
    expect(transfers.forWindow(1)).toBeUndefined();
    expect(transfers.forWindow(2)).toBeUndefined();
    expect(completed).toHaveBeenCalledTimes(1);
    const retry = transfers.begin('document', 1, { doc: 'unsaved' });
    transfers.cancel('document');
    await retry.result;
  });

  it('rejects a foreign acknowledgement and concurrent transfers involving either window', async () => {
    const owners = new Map([['first', 1], ['second', 1], ['third', 3]]);
    const transfers = new DocumentTransfers(owners, () => undefined);
    expect(() => transfers.begin('first', 9, {})).toThrow();
    const transfer = transfers.begin('first', 1, {});
    expect(() => transfers.begin('second', 1, {})).toThrow();
    expect(() => transfers.attach('first', 1)).toThrow();
    transfers.attach('first', 2);
    expect(() => transfers.attach('first', 4)).toThrow();
    expect(() => transfers.acknowledge('first', 1, true)).toThrow();
    expect(() => transfers.acknowledge('first', 3, false)).toThrow();
    const other = transfers.begin('third', 3, {});
    expect(() => transfers.attach('third', 2)).toThrow();
    expect(owners.get('first')).toBe(2);
    transfers.cancel('first');
    transfers.cancel('third');
    await Promise.all([transfer.result, other.result]);
  });

  it('can roll back creation failure before a new window was attached', async () => {
    const owners = new Map([['document', 1]]);
    const transfers = new DocumentTransfers(owners, () => undefined);
    const transfer = transfers.begin('document', 1, {});
    transfers.cancel('document', 'Window creation failed.');
    await expect(transfer.result).resolves.toEqual({ status: 'error', message: 'Window creation failed.' });
    expect(owners.get('document')).toBe(1);
  });
});

describe('transfer payload validation', () => {
  it('clones the complete state without changing history, Unicode or selection', () => {
    const state = { doc: '\u4e2d\u6587 e\u0301 \ud83d\ude00', selection: { ranges: [{ anchor: 2, head: 6 }], main: 0 }, history: { done: [{ changes: [[2], [0, 'old']] }], undone: [] } };
    const cloned = transferEditorState(state, state.doc);
    expect(cloned).toEqual(state);
    expect(cloned).not.toBe(state);
    state.history.done.length = 0;
    expect((cloned as typeof state).history.done).toHaveLength(1);
  });

  it('rejects stale snapshots and nonserializable state', () => {
    for (const value of [null, [], 'text', { doc: 'old text' }]) expect(() => transferEditorState(value, 'new text')).toThrow();
    const cyclic: { doc: string; cycle?: unknown } = { doc: 'text' };
    cyclic.cycle = cyclic;
    expect(() => transferEditorState(cyclic, 'text')).toThrow();
    expect(() => transferEditorState({ doc: 'text', history: 1n }, 'text')).toThrow();
  });
});

describe('detached window placement', () => {
  it('keeps the complete window in a monitor with negative desktop coordinates', () => {
    const bounds = visibleWindowBounds({ x: -1920, y: -200, width: 1920, height: 1040 }, { x: -5, y: 950 });
    expect(bounds).toEqual({ x: -1280, y: -20, width: 1280, height: 860, minWidth: 700, minHeight: 480 });
  });

  it('fits a small work area and centers a default placement', () => {
    expect(visibleWindowBounds({ x: 200, y: 300, width: 640, height: 400 }, { x: -900, y: 9000 })).toEqual({ x: 200, y: 300, width: 640, height: 400, minWidth: 640, minHeight: 400 });
    expect(visibleWindowBounds({ x: 0, y: 0, width: 1920, height: 1080 })).toMatchObject({ x: 320, y: 110 });
  });
});
