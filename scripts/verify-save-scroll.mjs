import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const evidence = path.resolve('test-results/save-scroll');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const data = path.join(run, 'data');
await mkdir(data);
const filename = path.join(run, 'save-scroll.md');
const source = '# Save and copy scrolling\n\n' + Array.from({ length: 28 }, (_, i) => `## Section ${i + 1}\n\n` + 'A long scientific paragraph with **bold text**, an [ordinary link](https://example.org/) and inline equation $x^2+y^2=z^2$. '.repeat(5) + `\n\n| Sample | Value |\n| --- | --- |\n| A | ${i + 1}.25 |\n\n$$\nE_{${i + 1}} = \\sum_{j=1}^{n} x_j^2\n$$\n\n`).join('');
await writeFile(filename, source);
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ autoSave: false, saveOnSwitch: false, language: 'en', spellcheck: 'off', theme: 'github', zoom: 100, showToolbar: false }));
const env = { ...process.env, MARKEDOWN_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
const executable = process.argv.slice(2).find(argument => /\.exe$/i.test(argument));
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable) } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode', '--force-device-scale-factor=1'], env, timeout: 30000 });
const child = app.process();
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1; }, 120000);
const measurements = [], errors = [];
let failure;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content:visible').waitFor();
  assert.equal((await page.evaluate(filename => window.markedown.openFiles([filename]), filename)).status, 'ok');
  await page.getByTestId('document-tab').filter({ hasText: 'save-scroll.md' }).waitFor();
  const browserWindow = await app.browserWindow(page);
  await browserWindow.evaluate(win => { win.show(); win.focus(); });
  await browserWindow.dispose();
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus());
  const settle = () => page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => requestAnimationFrame(resolve)); });
  const state = () => page.evaluate(() => {
    const root = [...document.querySelectorAll('.cm-content')].find(el => el.getBoundingClientRect().height && el.closest('.markedown-editor').style.display !== 'none');
    const view = root.cmTile.root.view;
    return { top: view.scrollDOM.scrollTop, height: view.scrollDOM.scrollHeight, source: view.state.doc.toString(), selection: view.state.selection.toJSON(), pointerTop: view.dom.style.getPropertyValue('--editor-pointer-top'), pointerBottom: view.dom.style.getPropertyValue('--editor-pointer-bottom') };
  });
  await page.evaluate(() => document.fonts.ready);
  await settle();
  const rememberWidgets = () => page.evaluate(() => { window.saveScrollWidgets = [...document.querySelectorAll('.markedown-editor .md-rendered')]; });
  const widgetsUnchanged = () => page.evaluate(() => {
    const current = [...document.querySelectorAll('.markedown-editor .md-rendered')];
    return current.length === window.saveScrollWidgets.length && current.every((node, index) => node === window.saveScrollWidgets[index]);
  });
  for (let click = 0; click < 8; click++) {
    const scroller = page.locator('.cm-scroller:visible');
    await scroller.evaluate((el, click) => { el.scrollTop = 300 + click * 115; }, click);
    await settle();
    const box = await scroller.boundingBox();
    await page.mouse.click(box.x + box.width * .57, box.y + box.height * .6);
    await settle();
    const before = await state();
    await rememberWidgets();
    await page.keyboard.press('Control+s');
    await settle();
    const after = await state();
    measurements.push({ mode: 'pointer', click, before: { top: before.top, height: before.height, pointerTop: before.pointerTop, pointerBottom: before.pointerBottom }, after: { top: after.top, height: after.height, pointerTop: after.pointerTop, pointerBottom: after.pointerBottom } });
    assert(Math.abs(after.top - before.top) < 3, `pointer save: scroll moved from ${before.top} to ${after.top}`);
    assert(await widgetsUnchanged(), 'Saving recreated existing table/equation widgets');
  }
  for (const mode of ['live', 'source']) {
    if (mode === 'source') { await page.getByTestId('mode-toggle').click(); await settle(); }
    for (const selected of [false, true]) {
      await page.locator('.cm-content:visible').evaluate((root, selected) => {
        const view = root.cmTile.root.view;
        const from = view.state.doc.line(180).from;
        view.dispatch({ selection: { anchor: from, head: selected ? from + 20 : from } });
        view.focus();
      }, selected);
      await settle();
      // The caret can be outside the part being read when users save/copy.
      await page.locator('.cm-scroller:visible').evaluate(el => { el.scrollTop = 800; });
      await settle();
      for (const key of ['Control+s', 'Control+c']) {
        const before = await state();
        await page.keyboard.press(key);
        await settle();
        const after = await state();
        measurements.push({ mode, selected, key, before: { top: before.top, height: before.height }, after: { top: after.top, height: after.height } });
        assert.equal(after.source, before.source, `${key} changed Markdown`);
        assert.deepEqual(after.selection, before.selection, `${key} changed selection`);
        assert(Math.abs(after.top - before.top) < 3, `${mode} ${key}: scroll moved from ${before.top} to ${after.top}`);
      }
    }
  }
  assert.equal(await readFile(filename, 'utf8'), source);
  // Delay the real atomic replacement so continued input and scrolling happen
  // while the save IPC is pending, rather than relying on machine/disk speed.
  await app.evaluate((_electron, filename) => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const originalRename = fs.rename;
    globalThis.saveScrollGate = { started: false };
    fs.rename = async function (...args) {
      if (args[1] === filename && !globalThis.saveScrollGate.started) {
        globalThis.saveScrollGate.started = true;
        await new Promise(resolve => { globalThis.saveScrollGate.release = resolve; });
      }
      return originalRename.apply(this, args);
    };
    globalThis.saveScrollRestore = () => { fs.rename = originalRename; };
  }, filename);
  await page.locator('.cm-content:visible').evaluate(root => {
    const view = root.cmTile.root.view;
    const from = view.state.doc.line(5).to;
    view.dispatch({ changes: { from, insert: ' Saved revision.' }, selection: { anchor: from + ' Saved revision.'.length }, userEvent: 'input.type' });
    view.focus();
  });
  await settle();
  const savedSource = (await state()).source;
  await page.keyboard.press('Control+s');
  const deadline = Date.now() + 8000;
  while (!await app.evaluate(() => globalThis.saveScrollGate.started)) {
    if (Date.now() > deadline) throw new Error('Save did not reach atomic replacement');
    await page.waitForTimeout(20);
  }
  await page.keyboard.insertText(' Unsaved continuation.');
  await page.locator('.cm-scroller:visible').evaluate(el => { el.scrollTop = 1200; });
  await settle();
  const whileSaving = await state();
  await app.evaluate(() => globalThis.saveScrollGate.release());
  await page.waitForFunction(async ({ filename, savedSource }) => {
    const current = (await window.markedown.bootstrap()).documents.find(doc => doc.path === filename);
    return current?.savedSource === savedSource && current?.dirty;
  }, { filename, savedSource });
  await settle();
  const afterSave = await state();
  assert.equal(afterSave.source, whileSaving.source, 'A completed save replaced newer typing');
  assert.deepEqual(afterSave.selection, whileSaving.selection, 'A completed save changed the caret');
  assert(Math.abs(afterSave.top - whileSaving.top) < 3, 'A completed save reset newer scrolling');
  assert.equal(await readFile(filename, 'utf8'), savedSource, 'Save did not write its original snapshot');
  const current = await page.evaluate(filename => window.markedown.bootstrap().then(initial => initial.documents.find(doc => doc.path === filename)), filename);
  assert.equal(current.dirty, true, 'Pending edits were incorrectly marked saved');
  assert.equal(current.source, whileSaving.source);
  await app.evaluate(() => globalThis.saveScrollRestore());
  measurements.push({ mode: 'pending-save', before: { top: whileSaving.top }, after: { top: afterSave.top }, dirty: current.dirty });
  assert.deepEqual(errors, []);
} catch (error) { failure = error; }
finally {
  const report = { status: failure ? 'failed' : 'passed', measurements, errors, failure: failure?.message, run };
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill();
  clearTimeout(watchdog);
}
if (failure) throw failure;
