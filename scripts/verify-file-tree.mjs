import assert from 'node:assert/strict';
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const evidence = path.resolve('test-results/file-tree');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const workspace = path.join(run, '\u4e2d\u6587 \u5de5\u4f5c\u533a');
const nested = path.join(workspace, '\u5b50\u6587\u4ef6\u5939');
await mkdir(nested, { recursive: true });
const files = { first: path.join(workspace, '\u9996\u6b21\u6253\u5f00.md'), second: path.join(workspace, 'space in filename.md'), nested: path.join(nested, '\u4e2d\u6587 \u7b14\u8bb0.md'), missing: path.join(workspace, 'deleted-after-listing.md') };
for (const [name, file] of Object.entries(files)) await writeFile(file, `# ${name}\n\nOriginal ${name} content.\n`, 'utf8');
const executable = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const env = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MARKEDOWN_DEV_URL;
const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode'], env, timeout: 30000 });
app.context().setDefaultTimeout(15000);
const errors = [], checks = [];
const track = page => page.on('pageerror', error => errors.push(error.message));
app.on('window', track);
app.windows().forEach(track);
const source = await app.firstWindow();
const row = (page, file) => page.locator('.tree-row').and(page.locator(`[title=${JSON.stringify(file)}]`));
const tab = (page, file) => page.getByTestId('document-tab').and(page.locator(`[title=${JSON.stringify(file)}]`));
const documents = page => page.evaluate(async () => (await window.markedown.bootstrap()).documents);
const documentAt = async (page, file) => (await documents(page)).find(doc => doc.path?.toLowerCase() === file.toLowerCase());
async function waitFor(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  throw new Error(message);
}
async function focused(page) {
  const window = await app.browserWindow(page);
  try { await window.evaluate(window => { window.show(); window.focus(); }); }
  finally { await window.dispose(); }
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus(), undefined, { polling: 100 });
}
async function active(page, file) {
  return waitFor(async () => {
    const current = await documentAt(page, file);
    if (!current) return undefined;
    const visible = await page.evaluate(id => [...document.querySelectorAll('.markedown-editor')].some(element => element.getAttribute('data-document-id') === id && getComputedStyle(element).display !== 'none'), current.id);
    return visible ? current : undefined;
  }, `File did not become the active document: ${file}`);
}
try {
  await source.locator('.cm-content:visible').waitFor();
  await source.evaluate(() => window.markedown.updateSettings({ language: 'zh-CN', autoSave: false, saveOnSwitch: false, spellcheck: 'off' }));
  await app.evaluate(({ dialog }, workspace) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] }); }, workspace);
  await focused(source);
  if (!await source.getByTestId('sidebar').count()) await source.getByRole('button', { name: '\u663e\u793a\u4fa7\u680f', exact: true }).click();
  await source.locator('.sidebar-heading').getByRole('button', { name: '\u6253\u5f00\u6587\u4ef6\u5939', exact: true }).click();
  await row(source, files.first).click();
  const first = await active(source, files.first);
  assert.equal(first.source, '# first\n\nOriginal first content.\n');
  checks.push('single click opens a new Markdown document from a Chinese workspace path');

  await source.locator('.cm-content:visible').focus();
  await source.keyboard.press('Control+End');
  await source.keyboard.insertText('UNSAVED \u672a\u4fdd\u5b58');
  await waitFor(async () => {
    const current = await documentAt(source, files.first);
    return current?.dirty && current.source.endsWith('UNSAVED \u672a\u4fdd\u5b58');
  }, 'Unsaved editor content did not reach the main process');
  await row(source, files.second).click(); await active(source, files.second);
  await row(source, files.first).click();
  const same = await active(source, files.first);
  assert.equal(same.id, first.id); assert(same.source.endsWith('UNSAVED \u672a\u4fdd\u5b58'));
  assert.equal((await documents(source)).filter(doc => doc.path === files.first).length, 1);
  await row(source, files.second).dblclick(); await active(source, files.second);
  assert.equal((await documents(source)).filter(doc => doc.path === files.second).length, 1);
  checks.push('single click reactivates an existing dirty tab without reload; double click never duplicates tabs');

  await row(source, files.first).focus(); await source.keyboard.press('Enter'); await active(source, files.first);
  await row(source, files.second).focus(); await source.keyboard.press('Space'); await active(source, files.second);
  await row(source, nested).click();
  await row(source, files.nested).click(); await active(source, files.nested);
  assert.equal((await documents(source)).some(doc => doc.path === nested), false);
  checks.push('Enter and Space activate files; single-click folders expand and reveal nested Chinese filenames');

  const previous = await documentAt(source, files.second);
  await tab(source, files.second).getByRole('button').click();
  await tab(source, files.second).waitFor({ state: 'detached' });
  await row(source, files.second).click();
  const reopened = await active(source, files.second);
  assert.notEqual(reopened.id, previous.id);
  checks.push('single click reopens a previously closed document with its new session ID');

  const targetReady = app.waitForEvent('window', { timeout: 25000 });
  targetReady.catch(() => {});
  await tab(source, files.first).click({ button: 'right' });
  await source.getByTestId('document-tab-menu').getByRole('menuitem', { name: '\u6253\u5f00\u65b0\u7a97\u53e3', exact: true }).click();
  const target = await targetReady;
  await target.locator('.cm-content[contenteditable="true"]:visible').waitFor();
  await tab(source, files.first).waitFor({ state: 'detached' });
  await focused(source); await row(source, files.first).click();
  await target.waitForFunction(() => document.hasFocus(), undefined, { polling: 100 });
  assert.equal(await documentAt(source, files.first), undefined);
  assert.equal((await active(target, files.first)).id, first.id);
  if (!await target.getByTestId('sidebar').count()) await target.getByRole('button', { name: '\u663e\u793a\u4fa7\u680f', exact: true }).click();
  await row(target, files.first).click(); await active(target, files.first);
  assert.equal((await documents(target)).filter(doc => doc.path === files.first).length, 1);
  checks.push('clicking a moved file focuses its owning window; owner-side clicks reuse the transferred tab');

  await focused(source);
  await unlink(files.missing);
  await row(source, files.missing).click();
  await source.getByRole('alert').filter({ hasText: 'deleted-after-listing.md' }).waitFor();
  assert.equal(await documentAt(source, files.missing), undefined);
  checks.push('a deleted file reports an open error without adding a broken tab');
  assert.deepEqual(errors, []);
  await source.screenshot({ path: path.join(run, 'file-tree.png') });
  await writeFile(path.join(run, 'results.json'), JSON.stringify({ status: 'passed', checks, errors, run }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks, errors, run }));
} catch (error) {
  await source.screenshot({ path: path.join(run, 'failure.png'), timeout: 5000 }).catch(() => {});
  await writeFile(path.join(run, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), checks, errors, run }, null, 2));
  throw error;
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await app.close();
}
