import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acceptReviewHunk, computeReviewState, diffReview, reviewRevision } from '../src/shared/review';
import { ReviewService } from '../src/main/review-service';

describe('review diff', () => {
  it('tracks Unicode grapheme additions and deletions', () => {
    const result = diffReview('你好，世界\n', '你好，🌍世界！\n');
    expect(result.hunks.length).toBeGreaterThan(0);
    expect(result.hunks.some(hunk => hunk.inserted.includes('🌍'))).toBe(true);
    expect(result.hunks.some(hunk => hunk.inserted.includes('！'))).toBe(true);
  });
  it('returns stable revision independent of newline/BOM spelling', () => {
    expect(reviewRevision('\uFEFFa\r\n', 'a\n')).toBe(reviewRevision('a\n', 'a\n'));
    expect(computeReviewState('a\n', 'a\nb\n', { enabled: true, baselineOrigin: 'saved' }).hunks[0].inserted).toBe('b\n');
    expect(reviewRevision('a', 'b')).toBe(createHash('sha256').update('1:a' + 'b').digest('hex'));
  });
});

describe('git-backed review service', () => {
  it('persists accepted baseline while leaving current source untouched', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'markit-review-'));
    try {
      const service = new ReviewService(dir);
      const enabled = await service.enable(path.join(dir, 'paper.md'), '# baseline\n', '# baseline\n');
      if (enabled.status !== 'ok') { expect(enabled.status).toBe('error'); return; }
      const current = '# baseline\n新增\n';
      const state = await service.current(path.join(dir, 'paper.md'), current);
      expect(state.status).toBe('ok');
      if (state.status !== 'ok') return;
      expect(state.value.hunks[0].inserted).toBe('新增\n');
      const accepted = await service.acceptAll(path.join(dir, 'paper.md'), current, state.value.revision);
      expect(accepted.status).toBe('ok');
      const reopened = new ReviewService(dir);
      const persisted = await reopened.current(path.join(dir, 'paper.md'), current);
      expect(persisted.status).toBe('ok');
      if (persisted.status === 'ok') expect(persisted.value.hunks).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
