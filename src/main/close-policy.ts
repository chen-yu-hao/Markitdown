import type { DocumentSession, Result } from '../shared/contracts';

export interface CloseApproval { id: string; editVersion: number; source: string }
export interface ClosePolicy {
  read(id: string): DocumentSession | undefined;
  decide(document: DocumentSession): Promise<'save' | 'discard' | 'cancel'>;
  save(id: string): Promise<Result<DocumentSession>>;
}

export async function prepareClose(ids: string[], policy: ClosePolicy): Promise<Result<CloseApproval[]>> {
  const approvals: CloseApproval[] = [];
  const changed = (): Result<never> => ({ status: 'conflict', message: 'A document changed while closing. Your documents remain open.' });
  for (const id of ids) {
    const document = policy.read(id);
    if (!document) return changed();
    let approval: CloseApproval = { id, editVersion: document.editVersion, source: document.source };
    if (document.dirty || document.recovered) {
      const decision = await policy.decide({ ...document, selection: { ...document.selection } });
      if (decision === 'cancel') return { status: 'cancelled' };
      if (decision === 'save') {
        const result = await policy.save(id);
        if (result.status !== 'ok') return result;
        const current = policy.read(id);
        if (!current || current.dirty || current.recovered) return changed();
        approval = { id, editVersion: current.editVersion, source: current.source };
      }
    }
    approvals.push(approval);
  }
  for (const approval of approvals) {
    const current = policy.read(approval.id);
    if (!current || current.editVersion !== approval.editVersion || current.source !== approval.source) return changed();
  }
  return { status: 'ok', value: approvals };
}
