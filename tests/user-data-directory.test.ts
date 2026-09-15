import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installedDataDirectory } from '../src/main/user-data-directory';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'markit-profile-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('profile compatibility after the Markit rename', () => {
  it('uses the new profile for a fresh installation', () => {
    expect(installedDataDirectory(path.join(root, 'Markit'))).toBe(path.join(root, 'Markit'));
  });

  it.each([false, true])('keeps old recovery files in place with an empty current directory: %s', async emptyCurrent => {
    const legacy = path.join(root, 'Markedown');
    const current = path.join(root, 'Markit');
    await mkdir(path.join(legacy, 'recovery'), { recursive: true });
    await writeFile(path.join(legacy, 'recovery', 'draft.json'), '{"text":"未保存文稿"}');
    if (emptyCurrent) await mkdir(current);
    expect(installedDataDirectory(current)).toBe(legacy);
    expect(await readFile(path.join(legacy, 'recovery', 'draft.json'), 'utf8')).toContain('未保存文稿');
    expect(await readdir(root)).toEqual(emptyCurrent ? ['Markedown', 'Markit'] : ['Markedown']);
  });

  it('preserves an already populated Markit profile without merging older settings', async () => {
    const current = path.join(root, 'Markit');
    await mkdir(current);
    await mkdir(path.join(root, 'Markedown'));
    await writeFile(path.join(current, 'settings.json'), '{"theme":"night"}');
    expect(installedDataDirectory(current)).toBe(current);
    expect(await readFile(path.join(current, 'settings.json'), 'utf8')).toBe('{"theme":"night"}');
  });
});
