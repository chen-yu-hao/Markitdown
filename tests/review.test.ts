import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acceptReviewHunk, computeReviewState, diffReview, reviewRevision } from '../src/shared/review';
import { ReviewService } from '../src/main/review-service';

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
async function initRepo(directory: string) {
  await git(directory, ['init']);
  await git(directory, ['config', 'user.name', 'Review tests']);
  await git(directory, ['config', 'user.email', 'review-tests@example.test']);
}

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
  it('uses the project HEAD and accepts all changes into that project', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'markit-review-'));
    const data = await mkdtemp(path.join(tmpdir(), 'markit-review-data-'));
    try {
      await initRepo(dir);
      const filename = path.join(dir, 'paper.md');
      await writeFile(filename, '# baseline\n', 'utf8');
      await git(dir, ['add', '--', 'paper.md']); await git(dir, ['commit', '-m', 'initial']);
      const service = new ReviewService(data);
      const current = '# baseline\n新增\n';
      await writeFile(filename, current, 'utf8');
      const enabled = await service.enable(filename, current, '# baseline\n');
      expect(enabled.status).toBe('ok');
      const state = await service.current(filename, current);
      expect(state.status).toBe('ok');
      if (state.status !== 'ok') return;
      expect(state.value.hunks[0].inserted).toBe('新增\n');
      const accepted = await service.acceptAll(filename, current, state.value.revision);
      expect(accepted.status).toBe('ok');
      expect((await git(dir, ['show', 'HEAD:paper.md'])).stdout).toBe(current);
      expect((await git(dir, ['status', '--short'])).stdout).toBe('');
    } finally { await rm(dir, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); }
  });

  it('refreshes the baseline when another tool advances Git HEAD', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'markit-review-'));
    const data = await mkdtemp(path.join(tmpdir(), 'markit-review-data-'));
    try {
      await initRepo(dir);
      const filename = path.join(dir, 'paper.md');
      await writeFile(filename, 'base\n', 'utf8');
      await git(dir, ['add', '--', 'paper.md']); await git(dir, ['commit', '-m', 'initial']);
      const service = new ReviewService(data);
      const enabled = await service.enable(filename, 'base\n', 'base\n');
      expect(enabled.status).toBe('ok');
      await writeFile(filename, 'base\nexternal\n', 'utf8');
      await git(dir, ['add', '--', 'paper.md']); await git(dir, ['commit', '-m', 'external change']);
      const current = await service.current(filename, 'base\nlocal\n');
      expect(current.status).toBe('ok');
      if (current.status !== 'ok') return;
      expect(current.value.baselineSource).toBe('base\nexternal\n');
      expect(current.value.hunks.some(hunk => hunk.inserted.includes('loc'))).toBe(true);
      expect(current.value.hunks.some(hunk => hunk.deleted.includes('extern'))).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); }
  });

  it('does not initialize a non-Git folder until explicitly allowed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'markit-review-'));
    const data = await mkdtemp(path.join(tmpdir(), 'markit-review-data-'));
    try {
      const filename = path.join(dir, 'paper.md'); await writeFile(filename, '# baseline\n', 'utf8');
      const service = new ReviewService(data);
      const denied = await service.enable(filename, '# baseline\n', '# baseline\n');
      expect(denied.status).toBe('conflict');
      const allowed = await service.enable(filename, '# baseline\n', '# baseline\n', { allowInit: true });
      expect(allowed.status).toBe('ok');
      expect((await git(dir, ['rev-parse', '--is-inside-work-tree'])).stdout.trim()).toBe('true');
      expect((await git(dir, ['show', 'HEAD:paper.md'])).stdout).toBe('# baseline\n');
    } finally { await rm(dir, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); }
  });

  it('stages only a selected hunk while keeping the complete worktree text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'markit-review-'));
    const data = await mkdtemp(path.join(tmpdir(), 'markit-review-data-'));
    try {
      await initRepo(dir); const relative = '中文 文件.md'; const filename = path.join(dir, relative);
      const baseline = 'a\n\nb\n'; const current = 'a\none\n\nb\n\ntwo\n';
      await writeFile(filename, baseline, 'utf8'); await git(dir, ['add', '--', relative]); await git(dir, ['commit', '-m', 'initial']);
      await writeFile(filename, current, 'utf8'); const service = new ReviewService(data); const enabled = await service.enable(filename, current, baseline);
      expect(enabled.status).toBe('ok'); const state = await service.current(filename, current); expect(state.status).toBe('ok'); if (state.status !== 'ok') return;
      const selected = state.value.hunks.find(hunk => hunk.inserted.includes('one'));
      expect(selected).toBeDefined(); if (!selected) return;
      const accepted = await service.acceptHunk(filename, current, selected.id, state.value.revision); expect(accepted.status).toBe('ok');
      expect(await readFile(filename, 'utf8')).toBe(current);
      const committed = (await git(dir, ['show', `HEAD:${relative}`])).stdout;
      expect(committed).toContain('one'); expect(committed).not.toContain('two');
      expect((await git(dir, ['status', '--short'])).stdout).toMatch(/^ M /);
    } finally { await rm(dir, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); }
  });
});
