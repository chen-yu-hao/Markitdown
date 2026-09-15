import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Result } from '../shared/contracts';
import { acceptReviewHunk, computeReviewState, normalizeReviewSource, reviewRevision, type ReviewState } from '../shared/review';

const exec = promisify(execFile);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const keyOf = (filename: string) => createHash('sha256').update(process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename)).digest('hex');

interface Persisted { version: 1; path: string; baseline: string; enabled: boolean; origin: ReviewState['baselineOrigin']; commit?: string }

/** Git-backed review state. The user's document repository is never staged or modified. */
export class ReviewService {
  private readonly states = new Map<string, Persisted>();
  private readonly root: string;
  private initialized = false;
  constructor(dataDirectory: string) { this.root = path.join(dataDirectory, 'review'); }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true });
    for (const name of await import('node:fs/promises').then(fs => fs.readdir(this.root))) {
      if (!name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(await readFile(path.join(this.root, name), 'utf8')) as Persisted;
        if (value?.version === 1 && typeof value.path === 'string' && typeof value.baseline === 'string' && typeof value.enabled === 'boolean') this.states.set(keyOf(value.path), value);
      } catch { /* corrupted review records are ignored; other documents remain recoverable */ }
    }
    this.initialized = true;
  }

  private async gitAvailable(): Promise<Result<true>> {
    try { await exec('git', ['--version'], { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 }); return { status: 'ok', value: true }; }
    catch { return { status: 'error', message: 'Git is required for Review mode. Install Git for Windows and try again.' }; }
  }
  private repoFor(pathname: string) { return path.join(this.root, keyOf(pathname)); }
  private async runGit(repo: string, args: string[], timeout = 12_000) {
    return exec('git', ['-C', repo, ...args], { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  }
  private async commitBaseline(repo: string, baseline: string, message: string): Promise<string> {
    await writeFile(path.join(repo, 'baseline.md'), normalizeReviewSource(baseline), 'utf8');
    await this.runGit(repo, ['add', '--', 'baseline.md']);
    try { await this.runGit(repo, ['-c', 'user.name=Markit Review', '-c', 'user.email=review@markit.local', 'commit', '-m', message, '--no-gpg-sign']); } catch (e) {
      if (!/nothing to commit/i.test(errorText(e))) throw e;
    }
    const { stdout } = await this.runGit(repo, ['rev-parse', 'HEAD']);
    return stdout.trim();
  }
  private async persist(state: Persisted): Promise<void> {
    const target = path.join(this.root, `${keyOf(state.path)}.json`), temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(state), 'utf8');
    await rename(temp, target);
  }

  async current(pathname: string, source: string): Promise<Result<ReviewState>> {
    await this.initialize();
    const state = this.states.get(keyOf(pathname));
    if (!state) return { status: 'ok', value: computeReviewState(source, source, { enabled: false, baselineOrigin: 'saved' }) };
    return { status: 'ok', value: computeReviewState(state.baseline, source, { enabled: state.enabled, baselineOrigin: state.origin, gitCommit: state.commit }) };
  }

  async enable(pathname: string, currentSource: string, savedSource = currentSource): Promise<Result<ReviewState>> {
    await this.initialize();
    const available = await this.gitAvailable(); if (available.status !== 'ok') return available;
    const key = keyOf(pathname), existing = this.states.get(key), repo = this.repoFor(pathname);
    try {
      await mkdir(repo, { recursive: true });
      try { await this.runGit(repo, ['rev-parse', '--is-inside-work-tree']); } catch { await this.runGit(repo, ['init']); }
      let baseline = existing?.baseline ?? normalizeReviewSource(savedSource);
      let origin: ReviewState['baselineOrigin'] = existing?.origin ?? 'saved';
      let commit = existing?.commit;
      if (!existing) commit = await this.commitBaseline(repo, baseline, 'Review baseline');
      const next: Persisted = { version: 1, path: pathname, baseline, enabled: true, origin, commit };
      this.states.set(key, next); await this.persist(next);
      return { status: 'ok', value: computeReviewState(baseline, currentSource, { enabled: true, baselineOrigin: origin, gitCommit: commit }) };
    } catch (e) { return { status: 'error', message: `Unable to start Review mode: ${errorText(e)}` }; }
  }

  async disable(pathname: string, source: string): Promise<Result<ReviewState>> {
    await this.initialize(); const state = this.states.get(keyOf(pathname));
    if (!state) return { status: 'ok', value: computeReviewState(source, source, { enabled: false, baselineOrigin: 'saved' }) };
    state.enabled = false; await this.persist(state);
    return { status: 'ok', value: computeReviewState(state.baseline, source, { enabled: false, baselineOrigin: state.origin, gitCommit: state.commit }) };
  }

  async acceptAll(pathname: string, source: string, expectedRevision?: string): Promise<Result<ReviewState>> {
    await this.initialize(); const state = this.states.get(keyOf(pathname)); if (!state) return { status: 'error', message: 'Review mode is not initialized for this document.' };
    const revision = reviewRevision(state.baseline, source); if (expectedRevision && expectedRevision !== revision) return { status: 'conflict', message: 'The document changed while accepting review changes. Reload the review state.' };
    try { const commit = await this.commitBaseline(this.repoFor(pathname), source, 'Accept all review changes'); state.baseline = normalizeReviewSource(source); state.commit = commit; await this.persist(state); return { status: 'ok', value: computeReviewState(state.baseline, source, { enabled: state.enabled, baselineOrigin: 'review', gitCommit: commit }) }; }
    catch (e) { return { status: 'error', message: `Unable to accept review changes: ${errorText(e)}` }; }
  }

  async acceptHunk(pathname: string, source: string, hunkId: string, expectedRevision: string): Promise<Result<{ source: string; state: ReviewState }>> {
    await this.initialize(); const state = this.states.get(keyOf(pathname)); if (!state) return { status: 'error', message: 'Review mode is not initialized for this document.' };
    const revision = reviewRevision(state.baseline, source); if (revision !== expectedRevision) return { status: 'conflict', message: 'The document changed while accepting this change.' };
    const nextBaseline = acceptReviewHunk(state.baseline, source, hunkId); if (nextBaseline === null) return { status: 'error', message: 'This review change is no longer available.' };
    try { const commit = await this.commitBaseline(this.repoFor(pathname), nextBaseline, 'Accept review change'); state.baseline = nextBaseline; state.commit = commit; await this.persist(state); return { status: 'ok', value: { source, state: computeReviewState(nextBaseline, source, { enabled: state.enabled, baselineOrigin: 'review', gitCommit: commit }) } }; }
    catch (e) { return { status: 'error', message: `Unable to accept review change: ${errorText(e)}` }; }
  }
}

export { normalizeReviewSource, reviewRevision, computeReviewState } from '../shared/review';
