import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Result } from '../shared/contracts';
import { acceptReviewHunk, computeReviewState, normalizeReviewSource, reviewRevision, type ReviewState } from '../shared/review';

const exec = promisify(execFile);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const keyOf = (filename: string) => createHash('sha256').update(process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename)).digest('hex');
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };

interface GitWorkspace { root: string; relative: string; tracked: boolean; head?: string }
interface Persisted { version: 2; path: string; root: string; relative: string; commit: string; enabled: boolean; origin: 'git-head' | 'review' }

/** Review metadata points at commits in the user's project repository. */
export class ReviewService {
  private readonly states = new Map<string, Persisted>();
  private readonly root: string;
  private initialized = false;
  constructor(dataDirectory: string) { this.root = path.join(dataDirectory, 'review-state'); }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root)) {
      if (!name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(await readFile(path.join(this.root, name), 'utf8')) as Persisted;
        if (value?.version === 2 && typeof value.path === 'string' && typeof value.root === 'string' && typeof value.relative === 'string' && typeof value.commit === 'string' && typeof value.enabled === 'boolean') this.states.set(keyOf(value.path), value);
      } catch { /* A corrupt record must not prevent other documents from opening. */ }
    }
    this.initialized = true;
  }

  private async runGit(root: string, args: string[], timeout = 15_000) {
    return exec('git', ['-C', root, ...args], { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: gitEnv, encoding: 'utf8' });
  }
  private async runGitDiff(args: string[]) {
    try { return (await exec('git', args, { timeout: 15_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: gitEnv, encoding: 'utf8' })).stdout; }
    catch (error) { const result = error as { code?: number | string; stdout?: string }; if (result.code === 1) return result.stdout || ''; throw error; }
  }
  private async gitAvailable(): Promise<Result<true>> {
    try { await exec('git', ['--version'], { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024, env: gitEnv }); return { status: 'ok', value: true }; }
    catch { return { status: 'error', message: 'Git is required for Review mode. Install Git for Windows and try again.' }; }
  }

  /** Resolve the repository exactly as Git sees it. No init is attempted. */
  async inspect(pathname: string): Promise<Result<GitWorkspace | null>> {
    const available = await this.gitAvailable(); if (available.status !== 'ok') return available;
    let root: string;
    try { root = (await this.runGit(path.dirname(pathname), ['rev-parse', '--show-toplevel'])).stdout.trim(); }
    catch { return { status: 'ok', value: null }; }
    if (!root) return { status: 'ok', value: null };
    const relative = path.relative(root, pathname).split(path.sep).join('/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return { status: 'ok', value: null };
    let head: string | undefined;
    try { head = (await this.runGit(root, ['rev-parse', 'HEAD'])).stdout.trim() || undefined; } catch { /* empty repository */ }
    let tracked = false;
    if (head) { try { await this.runGit(root, ['cat-file', '-e', `${head}:${relative}`]); tracked = true; } catch { /* not present in HEAD */ } }
    return { status: 'ok', value: { root, relative, tracked, head } };
  }
  private async sourceAt(workspace: GitWorkspace, commit: string): Promise<string> { return normalizeReviewSource((await this.runGit(workspace.root, ['show', `${commit}:${workspace.relative}`])).stdout); }
  private async persist(state: Persisted): Promise<void> {
    const destination = path.join(this.root, `${keyOf(state.path)}.json`), temporary = `${destination}.tmp`;
    await writeFile(temporary, JSON.stringify(state), 'utf8'); await rename(temporary, destination);
  }
  private async currentHead(workspace: GitWorkspace): Promise<string | undefined> { try { return (await this.runGit(workspace.root, ['rev-parse', 'HEAD'])).stdout.trim() || undefined; } catch { return undefined; } }
  private async isTracked(workspace: GitWorkspace, relative: string): Promise<boolean> {
    if (!workspace.head) return false;
    try { await this.runGit(workspace.root, ['cat-file', '-e', `${workspace.head}:${relative}`]); return true; } catch { return false; }
  }

  /** Include newly pasted local images without staging unrelated project files. */
  private async assetPaths(workspace: GitWorkspace, pathname: string, source: string, includeTracked = false): Promise<string[]> {
    const result = new Set<string>();
    const pattern = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
    for (const match of source.matchAll(pattern)) {
      const raw = (match[1] || match[2] || '').replace(/[?#].*$/, '');
      if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) continue;
      let destination: string;
      try { destination = path.resolve(path.dirname(pathname), decodeURIComponent(raw)); } catch { continue; }
      const relative = path.relative(workspace.root, destination).split(path.sep).join('/');
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) continue;
      try { if (!(await stat(destination)).isFile()) continue; } catch { continue; }
      if (includeTracked || !(await this.isTracked(workspace, relative))) result.add(relative);
    }
    return [...result];
  }
  private commitArgs(paths: string[], message: string) { return ['-c', 'user.name=Markit', '-c', 'user.email=review@markit.local', 'commit', '--only', '-m', message, '--', ...paths]; }
  private async commitFiles(workspace: GitWorkspace, pathname: string, source: string, message: string): Promise<string> {
    const assets = await this.assetPaths(workspace, pathname, source), paths = [workspace.relative, ...assets];
    await this.runGit(workspace.root, ['add', '--', ...paths]);
    try { await this.runGit(workspace.root, this.commitArgs(paths, message)); } catch (error) { if (!/nothing to commit/i.test(errorText(error))) throw error; }
    return (await this.runGit(workspace.root, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** Add only the selected Markdown hunk to the real project's index. */
  private async applySelectedPatch(workspace: GitWorkspace, baseline: string, accepted: string): Promise<void> {
    const staging = await mkdtemp(path.join(tmpdir(), 'markit-review-')), oldFile = path.join(staging, 'old.md'), newFile = path.join(staging, 'new.md'), patchFile = path.join(staging, 'selected.patch');
    try {
      await writeFile(oldFile, normalizeReviewSource(baseline), 'utf8'); await writeFile(newFile, normalizeReviewSource(accepted), 'utf8');
      let patch = await this.runGitDiff(['diff', '--no-index', '--binary', '--no-ext-diff', '--no-prefix', oldFile, newFile]);
      patch = patch.replace(/^diff --git .*$/m, `diff --git a/${workspace.relative} b/${workspace.relative}`).replace(/^--- .*$/m, `--- a/${workspace.relative}`).replace(/^\+\+\+ .*$/m, `+++ b/${workspace.relative}`);
      if (!patch.trim()) return;
      await writeFile(patchFile, patch, 'utf8');
      await exec('git', ['-C', workspace.root, 'apply', '--cached', patchFile], { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: gitEnv });
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  private async stateFor(pathname: string, currentSource: string, state: Persisted): Promise<Result<ReviewState>> {
    const workspace: GitWorkspace = { root: state.root, relative: state.relative, tracked: true, head: state.commit }, head = await this.currentHead(workspace);
    if (!head) return { status: 'error', message: 'The Git repository no longer has a HEAD commit.' };
    if (head !== state.commit) { state.commit = head; state.origin = 'git-head'; await this.persist(state); }
    return { status: 'ok', value: computeReviewState(await this.sourceAt(workspace, state.commit), currentSource, { enabled: state.enabled, baselineOrigin: state.origin, gitCommit: state.commit }) };
  }
  async current(pathname: string, source: string): Promise<Result<ReviewState>> {
    await this.initialize(); const state = this.states.get(keyOf(pathname));
    if (!state) return { status: 'ok', value: computeReviewState(source, source, { enabled: false, baselineOrigin: 'git-head' }) };
    try { return await this.stateFor(pathname, source, state); } catch (error) { return { status: 'error', message: `Unable to read the Git review baseline: ${errorText(error)}` }; }
  }
  async enable(pathname: string, currentSource: string, savedSource = currentSource, options: { allowInit?: boolean } = {}): Promise<Result<ReviewState>> {
    await this.initialize(); const available = await this.gitAvailable(); if (available.status !== 'ok') return available;
    let inspection = await this.inspect(pathname); if (inspection.status !== 'ok') return inspection;
    let workspace = inspection.value;
    try {
      if (!workspace) {
        if (!options.allowInit) return { status: 'conflict', message: 'This file is not inside a Git repository. Confirm that Markit may create a Git repository in the document folder.' };
        await this.runGit(path.dirname(pathname), ['init']); inspection = await this.inspect(pathname); if (inspection.status !== 'ok' || !inspection.value) return { status: 'error', message: 'Git repository initialization did not produce a usable workspace.' }; workspace = inspection.value;
      }
      const key = keyOf(pathname), existing = this.states.get(key); if (existing) return this.stateFor(pathname, currentSource, existing);
      if (!workspace.head || !workspace.tracked) {
        const commit = await this.commitFiles(workspace, pathname, savedSource, `Markit review: add ${path.basename(pathname)} as baseline`), next: Persisted = { version: 2, path: pathname, root: workspace.root, relative: workspace.relative, commit, enabled: true, origin: 'git-head' };
        this.states.set(key, next); await this.persist(next); return this.stateFor(pathname, currentSource, next);
      }
      const next: Persisted = { version: 2, path: pathname, root: workspace.root, relative: workspace.relative, commit: workspace.head, enabled: true, origin: 'git-head' };
      this.states.set(key, next); await this.persist(next); return this.stateFor(pathname, currentSource, next);
    } catch (error) { return { status: 'error', message: `Unable to start Review mode: ${errorText(error)}` }; }
  }
  async disable(pathname: string, source: string): Promise<Result<ReviewState>> {
    await this.initialize(); const state = this.states.get(keyOf(pathname)); if (!state) return { status: 'ok', value: computeReviewState(source, source, { enabled: false, baselineOrigin: 'git-head' }) };
    state.enabled = false;
    try { const result = await this.stateFor(pathname, source, state); await this.persist(state); return result; } catch (error) { return { status: 'error', message: `Unable to stop Review mode: ${errorText(error)}` }; }
  }
  async acceptAll(pathname: string, source: string, expectedRevision?: string): Promise<Result<ReviewState>> {
    await this.initialize(); const state = this.states.get(keyOf(pathname)); if (!state) return { status: 'error', message: 'Review mode is not initialized for this document.' };
    const before = await this.stateFor(pathname, source, state); if (before.status !== 'ok') return before;
    if (expectedRevision && expectedRevision !== before.value.revision) return { status: 'conflict', message: 'The Git HEAD changed while accepting review changes. The review baseline was refreshed.' };
    try { const workspace: GitWorkspace = { root: state.root, relative: state.relative, tracked: true, head: state.commit }, commit = await this.commitFiles(workspace, pathname, source, `Markit review: accept all changes in ${path.basename(pathname)}`); state.commit = commit; state.origin = 'review'; await this.persist(state); return this.stateFor(pathname, source, state); }
    catch (error) { return { status: 'error', message: `Unable to accept all review changes: ${errorText(error)}` }; }
  }
  async acceptHunk(pathname: string, source: string, hunkId: string, expectedRevision: string): Promise<Result<{ source: string; state: ReviewState }>> {
    await this.initialize(); const state = this.states.get(keyOf(pathname)); if (!state) return { status: 'error', message: 'Review mode is not initialized for this document.' };
    const before = await this.stateFor(pathname, source, state); if (before.status !== 'ok') return before;
    if (before.value.revision !== expectedRevision) return { status: 'conflict', message: 'The Git HEAD or document changed while accepting this review change.' };
    const accepted = acceptReviewHunk(before.value.baselineSource, source, hunkId); if (accepted === null) return { status: 'error', message: 'This review change is no longer available.' };
    try {
      const workspace: GitWorkspace = { root: state.root, relative: state.relative, tracked: true, head: state.commit };
      const stagedPath = (await this.runGit(workspace.root, ['diff', '--cached', '--name-only', '--', workspace.relative])).stdout.trim();
      if (stagedPath) return { status: 'conflict', message: 'The Markdown file already has staged changes. Commit or unstage them before accepting a single review change.' };
      await this.applySelectedPatch(workspace, before.value.baselineSource, accepted);
      const assets = await this.assetPaths(workspace, pathname, accepted), newAssets = assets.filter(asset => !before.value.baselineSource.includes(asset));
      if (newAssets.length) await this.runGit(workspace.root, ['add', '--', ...newAssets]);
      const paths = [workspace.relative, ...newAssets];
      const originalBytes = await readFile(pathname);
      try {
        await writeFile(pathname, normalizeReviewSource(accepted), 'utf8');
        await this.runGit(workspace.root, this.commitArgs(paths, `Markit review: accept change in ${path.basename(pathname)}`));
      } finally { await writeFile(pathname, originalBytes); }
      state.commit = (await this.runGit(workspace.root, ['rev-parse', 'HEAD'])).stdout.trim(); state.origin = 'review'; await this.persist(state);
      const next = await this.stateFor(pathname, source, state); return next.status === 'ok' ? { status: 'ok', value: { source, state: next.value } } : next;
    } catch (error) { return { status: 'error', message: `Unable to accept this review change: ${errorText(error)}` }; }
  }
}

export { normalizeReviewSource, reviewRevision, computeReviewState } from '../shared/review';
