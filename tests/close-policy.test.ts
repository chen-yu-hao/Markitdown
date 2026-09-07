import { describe, expect, it } from 'vitest';
import { prepareClose, type ClosePolicy } from '../src/main/close-policy';
import type { DocumentSession } from '../src/shared/contracts';

function document(id: string, dirty = true): DocumentSession {
  return { id, title: id, path: null, source: 'current text', savedSource: dirty ? '' : 'current text', dirty, recovered: false, bom: false, lineEnding: 'LF', revision: null, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 1 };
}

describe('close approval policy', () => {
  it('returns no approvals when a later document cancels, keeping earlier discarded documents available', async () => {
    const documents = new Map(['first', 'second'].map(id => [id, document(id)]));
    const result = await prepareClose([...documents.keys()], {
      read: id => documents.get(id),
      decide: async doc => doc.id === 'first' ? 'discard' : 'cancel',
      save: async () => { throw new Error('Save must not run for discard or cancel.'); },
    });
    expect(result.status).toBe('cancelled');
    expect(documents.get('first')?.source).toBe('current text');
    expect(documents.size).toBe(2);
  });

  it('stops closing when editing continues while the approved snapshot is being saved', async () => {
    const current = document('first');
    const result = await prepareClose([current.id], {
      read: () => current,
      decide: async () => 'save',
      save: async () => {
        current.savedSource = current.source;
        current.source += ' continued';
        current.editVersion++;
        return { status: 'ok', value: { ...current } };
      },
    });
    expect(result.status).toBe('conflict');
    expect(current.source).toBe('current text continued');
  });

  it('rechecks a formerly clean document after the user handles later prompts', async () => {
    const first = document('first', false);
    const second = document('second');
    const policy: ClosePolicy = {
      read: id => id === first.id ? first : second,
      decide: async () => { first.source = 'new edit'; first.editVersion++; first.dirty = true; return 'discard'; },
      save: async () => { throw new Error('Unexpected save.'); },
    };
    expect((await prepareClose([first.id, second.id], policy)).status).toBe('conflict');
  });

  it('approves successfully saved, discarded and clean documents together', async () => {
    const documents = new Map([document('saved'), document('discarded'), document('clean', false)].map(doc => [doc.id, doc]));
    const result = await prepareClose([...documents.keys()], {
      read: id => documents.get(id),
      decide: async doc => doc.id === 'saved' ? 'save' : 'discard',
      save: async id => {
        const doc = documents.get(id)!;
        doc.savedSource = doc.source;
        doc.dirty = false;
        return { status: 'ok', value: { ...doc } };
      },
    });
    expect(result).toEqual({ status: 'ok', value: [...documents.values()].map(doc => ({ id: doc.id, editVersion: doc.editVersion, source: doc.source })) });
  });
});
