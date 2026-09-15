import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const evidence = path.resolve('test-results/line-numbers');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const data = path.join(run, 'data');
await mkdir(data);
const filename = path.join(run, '行号 测试.md');
const source = [
  '# 全文行号', '', '中文、Emoji 😀、组合字符 e\u0301 与 **粗体**。'.repeat(12), '',
  '| 项目 | 数值 |', '| --- | --- |', '| A | 42 |', '',
  '$$', 'E = mc^2', '$$', '', '```js', 'const x = 1;', 'const y = 2;', '```', '',
  '![local](pixel.png)', '', 'Last paragraph.', '',
].join('\n');
await writeFile(filename, source);
await writeFile(path.join(run, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBqkAAAAASUVORK5CYII=', 'base64'));
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ language: 'zh-CN', spellcheck: 'off', autoSave: false, saveOnSwitch: false, showLineNumbers: false, fontSizeMode: 'custom', fontSize: 17, readingWidth: 650, zoom: 100 }));
const env = { ...process.env, MARKEDOWN_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable) } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode', '--force-device-scale-factor=1', filename], env, timeout: 30000 });
const watchdog = setTimeout(() => { app.process().kill(); process.exitCode = 1; }, 120000);
const checks = [], errors = [];
let page, failure;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content:visible').waitFor();
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.show(); win.focus(); });
  const editor = () => page.locator('.cm-content:visible');
  const settle = () => page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 6; i++) await new Promise(resolve => requestAnimationFrame(resolve)); });
  const snapshot = () => editor().evaluate(root => { const view = root.cmTile.root.view; return { source: view.state.doc.toString(), selection: view.state.selection.toJSON() }; });
  const toggle = async expected => {
    await page.getByRole('menuitem', { name: '视图', exact: true }).click();
    const item = page.getByRole('menuitemcheckbox', { name: '显示行号', exact: true });
    assert.equal(await item.getAttribute('aria-checked'), String(!expected));
    await item.click();
    await page.waitForFunction(expected => [...document.querySelectorAll('.markedown-editor')].filter(root => root.style.display !== 'none').some(root => Boolean(root.querySelector('.cm-lineNumbers')) === expected), expected);
    await settle();
  };
  const numbers = () => page.locator('.markedown-editor:visible .cm-lineNumbers .cm-gutterElement').evaluateAll(elements => elements.filter(el => el.style.visibility !== 'hidden').map(el => Number(el.textContent)));
  const aligned = async () => {
    const positions = await editor().evaluate(root => {
      const view = root.cmTile.root.view;
      return [...view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(el => el.style.visibility !== 'hidden').map(el => {
        const number = Number(el.textContent);
        const block = view.lineBlockAt(view.state.doc.line(number).from);
        return { number, delta: el.getBoundingClientRect().top - (view.documentTop + block.top) };
      });
    });
    assert(positions.length > 0, 'No visible line numbers');
    assert(positions.every(row => Math.abs(row.delta) < 2), `Line number alignment: ${JSON.stringify(positions)}`);
  };
  const before = await snapshot();
  await toggle(true);
  assert.deepEqual(await snapshot(), before, 'View toggle changed source or selection');
  await aligned();
  assert((await numbers()).includes(5), 'Rendered table has no starting source line number');
  checks.push('View toggle, live Markdown blocks and source-line alignment');

  await page.getByTestId('mode-toggle').click();
  await page.locator('.editor-source:visible').waitFor(); await settle();
  await aligned();
  const first = await numbers();
  assert.deepEqual(first, Array.from({ length: first.length }, (_, i) => i + 1), 'Source numbers are not continuous');
  assert(await editor().evaluate(root => { const view = root.cmTile.root.view; return view.lineBlockAt(view.state.doc.line(3).from).height > view.defaultLineHeight * 2; }), 'Fixture did not exercise wrapped text');
  assert.equal(first.filter(number => number === 3).length, 1, 'Wrapped line was numbered more than once');
  checks.push('Continuous source numbering, blank lines and wrapped Unicode text');

  await editor().focus(); await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('Inserted\n'); await settle();
  const edited = await snapshot();
  await toggle(false); await toggle(true);
  assert.deepEqual(await snapshot(), edited, 'Toggle reset edits or selection');
  await editor().focus(); await page.keyboard.press('Control+z'); await settle();
  assert.equal((await snapshot()).source, source, 'Toggle broke undo history');
  await page.keyboard.press('Control+n');
  await page.waitForFunction(() => document.querySelector('.markedown-editor:not([style*="display: none"]) .cm-content')?.textContent === '');
  await settle(); assert.deepEqual(await numbers(), [1]);
  await page.getByTestId('document-tab').filter({ hasText: '行号 测试.md' }).click(); await settle();
  assert.equal((await snapshot()).source, source);
  checks.push('Edits, undo, tab switches and new document numbering');

  const longSource = Array.from({ length: 15000 }, (_, i) => `Line ${i + 1} 中文 😀`).join('\n');
  await editor().evaluate((root, text) => { const view = root.cmTile.root.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } }); }, longSource);
  await settle();
  const scroller = page.locator('.cm-scroller:visible');
  for (const fraction of [0.5, 0.9, 0.2, 1, 0]) {
    await scroller.evaluate((el, fraction) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction; }, fraction);
    await settle(); await aligned();
    assert((await numbers()).length < 300, 'Gutter rendered the entire document');
    if (fraction === 1) assert((await numbers()).includes(15000), 'Cannot scroll to final source line');
  }
  checks.push('15,000 lines: viewport-only gutters and scrolling to the end and back');

  await editor().evaluate((root, text) => { const view = root.cmTile.root.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } }); }, source);
  for (const theme of ['github', 'night', 'newsprint']) {
    await page.evaluate(theme => window.markedown.updateSettings({ theme }), theme); await settle(); await aligned();
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 650));
  await settle(); await aligned();
  await page.screenshot({ path: path.join(evidence, 'source-line-numbers.png') });
  checks.push('Theme changes and narrow-window line alignment');

  await toggle(false);
  await page.evaluate(() => window.markedown.updateSettings({ readingLayout: 'double' }));
  await page.getByTestId('mode-toggle').click(); await page.locator('.article-preview').waitFor();
  await toggle(true);
  await page.locator('.editor-source:visible .cm-lineNumbers').waitFor();
  const settings = JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8'));
  assert.equal(settings.showLineNumbers, true); assert.equal(settings.readingLayout, 'double');
  assert.deepEqual(errors, []);
  checks.push('Enabling from two-column reading opens numbered source and persists the preference');
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
} finally {
  const report = { status: failure ? 'failed' : 'passed', checks, errors, failure: failure?.stack, run };
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  try { await app.close(); } finally { clearTimeout(watchdog); }
}
if (failure) throw failure;
