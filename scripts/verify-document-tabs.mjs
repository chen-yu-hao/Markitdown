import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const labels = { move: '\u6253\u5f00\u65b0\u7a97\u53e3', close: '\u5173\u95ed', others: '\u5173\u95ed\u5176\u4ed6\u6807\u7b7e' };
const evidence = path.resolve('test-results/document-tabs');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const files = Object.fromEntries(['alpha', 'target', 'long', 'dirty-one', 'dirty-two'].map(name => [name, path.join(run, `${name}.md`)]));
const longSource = '# Transfer document\n\n' + Array.from({ length: 140 }, (_, index) => `Paragraph ${index + 1}: \u4e2d\u6587 \ud83d\ude00 e\u0301. Independent document state survives moving between windows.\n\n`).join('');
for (const [name, filename] of Object.entries(files)) await writeFile(filename, name === 'long' ? longSource : `# ${name}\n\nOriginal ${name} content.\n`);
const executable = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const checks = [], errors = [], captures = [], applications = [], layouts = [], scrolls = [];
let app, origin;

async function waitFor(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  throw new Error(message);
}
async function launch(scale = 1) {
  const env = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, `data-${scale}`) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MARKEDOWN_DEV_URL;
  const instance = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode', `--force-device-scale-factor=${scale}`, files.alpha, files.target, files.long], env, timeout: 30000 });
  applications.push(instance);
  const observed = new WeakSet();
  const track = page => { if (observed.has(page)) return; observed.add(page); page.on('pageerror', error => errors.push({ scale, message: error.message, url: page.url() })); };
  instance.on('window', track);
  instance.windows().forEach(track);
  return instance;
}
const bootstrap = page => page.evaluate(() => window.markedown.bootstrap());
const documents = async page => (await bootstrap(page)).documents;
const ids = async page => (await documents(page)).map(document => document.id).sort();
const byId = async (page, id) => (await documents(page)).find(document => document.id === id);
const byPath = async (page, filename) => (await documents(page)).find(document => document.path?.toLowerCase() === filename.toLowerCase());
const exactTab = (page, document) => page.getByTestId('document-tab').and(page.locator(`[title=${JSON.stringify(document.path || document.title)}]`));
const editor = page => page.locator('.cm-content:visible');
const activeId = page => page.locator('.markedown-editor:visible').getAttribute('data-document-id');
const alive = instance => instance.windows().filter(page => !page.isClosed());
async function native(instance, page, action, argument) {
  const handle = await instance.browserWindow(page);
  try { return await handle.evaluate(action, argument); } finally { await handle.dispose(); }
}
async function focus(page) {
  await native(app, page, window => { window.show(); window.focus(); }); await page.bringToFront();
  await waitFor(async () => await native(app, page, window => window.isFocused()), 'Native window did not receive focus');
  await page.waitForFunction(() => document.hasFocus(), undefined, { polling: 100 });
  await settle(page);
}
async function settle(page) { await page.evaluate(async () => { await document.fonts.ready; for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); }); }
async function ready(page) { await editor(page).waitFor(); await page.waitForFunction(() => document.querySelector('.cm-content[contenteditable="true"]')); await settle(page); }
async function idle(page) { await focus(page); await page.waitForFunction(() => document.querySelector('.document-tabs')?.getAttribute('aria-busy') !== 'true', undefined, { polling: 100 }); await settle(page); }
async function select(page, document) { await focus(page); await exactTab(page, document).click(); await waitFor(async () => await activeId(page) === document.id, 'Wrong selected document'); await settle(page); }
async function context(page, document, label) {
  await focus(page);
  await exactTab(page, document).click({ button: 'right' });
  const menu = page.getByTestId('document-tab-menu');
  await menu.waitFor();
  if (label) await menu.getByRole('menuitem', { name: label, exact: true }).click();
  return menu;
}
async function decisions(responses) {
  await app.evaluate(({ dialog }, responses) => {
    globalThis.markedownTabDialogCalls = [];
    const pending = [...responses];
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1), response = pending.shift() ?? 2;
      globalThis.markedownTabDialogCalls.push({ message: options.message, response });
      return { response, checkboxChecked: false };
    };
  }, responses);
}
async function dialogCount(count) { await waitFor(async () => await app.evaluate(() => globalThis.markedownTabDialogCalls.length) === count, `Expected ${count} close decisions`); }
async function open(page, filename) {
  const result = await page.evaluate(filename => window.markedown.openFiles([filename]), filename);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  await waitFor(async () => Boolean(await byPath(page, filename)), 'Opened document missing from its owner');
  const document = await byPath(page, filename);
  await exactTab(page, document).waitFor();
  return document;
}
async function append(page, document, text) {
  await select(page, document);
  await editor(page).focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(text);
  await waitFor(async () => (await byId(page, document.id))?.source.endsWith(text), 'Editor text did not reach the main process');
  return byId(page, document.id);
}
async function newWindow(action) {
  const pending = app.waitForEvent('window', { timeout: 20000 });
  pending.catch(() => {});
  await action();
  const page = await pending;
  await ready(page);
  return page;
}
async function moved(page, document, action) {
  const target = await newWindow(action);
  await waitFor(async () => !(await byId(page, document.id)) && Boolean(await byId(target, document.id)), 'Document transfer did not commit');
  await idle(page); await idle(target);
  assert.equal((await documents(target)).length, 1, 'Transfer created an extra blank target document');
  return target;
}
async function screenshot(page, name) {
  await focus(page); await settle(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: page overflows horizontally`);
  const menu = page.getByTestId('document-tab-menu');
  if (await menu.count()) {
    const box = await menu.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${name}: context menu escapes viewport`);
  }
  await page.screenshot({ path: path.join(run, `${name}.png`) }); captures.push(name);
}
async function inspectLayout(page, name) {
  layouts.push({ name, ...(await page.evaluate(() => {
    const selectors = ['.document-tabs', '.document-tab', '.tab-band', '.document-area', '.workspace', '.app', '.sidebar'];
    return { width: innerWidth, height: innerHeight, elements: selectors.flatMap(selector => Array.from(document.querySelectorAll(selector), element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element), atCenter = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { selector, title: element.getAttribute('title'), rect: rect.toJSON(), scrollLeft: element.scrollLeft, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, width: style.width, position: style.position, zIndex: style.zIndex, centerTarget: atCenter?.outerHTML.slice(0, 200) };
    })) };
  })) });
}
async function collapseNarrowSidebar(page) {
  if (await page.getByTestId('sidebar').count()) await page.getByRole('button', { name: '\u6536\u8d77\u4fa7\u680f', exact: true }).click();
  await settle(page);
}
async function pointerStart(page, document, button = false) {
  await focus(page);
  await page.evaluate(() => {
    window.markedownTabPointerEvents = [];
    if (!window.markedownTabPointerInstalled) {
      window.markedownTabPointerInstalled = true;
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) document.addEventListener(type, event => window.markedownTabPointerEvents.push({ type, tab: Boolean(event.target.closest('[data-testid="document-tab"]')), x: event.clientX, y: event.clientY, buttons: event.buttons, pointerId: event.pointerId }), true);
      window.addEventListener('blur', () => window.markedownTabPointerEvents.push({ type: 'blur' }));
      document.addEventListener('visibilitychange', () => window.markedownTabPointerEvents.push({ type: 'visibilitychange', hidden: document.hidden }));
    }
  });
  const locator = button ? exactTab(page, document).getByRole('button') : exactTab(page, document).locator(':scope > span');
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox(), band = await page.locator('.tab-band').boundingBox();
  const start = { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  return { ...start, band };
}

try {
  app = await launch(); origin = await app.firstWindow(); await ready(origin);
  await origin.evaluate(() => window.markedown.updateSettings({ language: 'zh-CN', autoSave: false, saveOnSwitch: false, spellcheck: 'off', theme: 'github' }));
  await native(app, origin, window => window.setSize(1280, 860));
  const alpha = await byPath(origin, files.alpha), clean = await byPath(origin, files.target), long = await byPath(origin, files.long);
  await select(origin, alpha); await decisions([]);
  await context(origin, clean, labels.close);
  await waitFor(async () => !(await byId(origin, clean.id)), 'Right-click closed the wrong clean document');
  assert(await byId(origin, alpha.id)); assert(await byId(origin, long.id));
  assert.equal(await app.evaluate(() => globalThis.markedownTabDialogCalls.length), 0);
  checks.push('right-click on a non-active clean tab closes that tab without prompting');

  const dirty = await open(origin, files.target);
  await append(origin, dirty, 'UNSAVED-CLOSE'); await select(origin, alpha);
  const beforeCancel = await byId(origin, dirty.id);
  await decisions([2]); await context(origin, dirty, labels.close); await dialogCount(1); await idle(origin);
  assert.deepEqual(await byId(origin, dirty.id), beforeCancel);
  await decisions([1]); await context(origin, dirty, labels.close);
  await waitFor(async () => !(await byId(origin, dirty.id)), 'Discard did not close its target');
  assert.equal(await readFile(files.target, 'utf8'), '# target\n\nOriginal target content.\n');
  checks.push('dirty-tab Cancel retains content; Discard closes only its target and leaves disk unchanged');

  const companion = await newWindow(() => origin.evaluate(() => window.markedown.newWindow()));
  const companionDocument = (await documents(companion))[0];
  await append(companion, companionDocument, 'OTHER WINDOW MUST REMAIN OPEN');
  const protectedDocument = await byId(companion, companionDocument.id);
  const firstDirty = await open(origin, files['dirty-one']); await append(origin, firstDirty, 'FIRST-DIRTY');
  const secondDirty = await open(origin, files['dirty-two']); await append(origin, secondDirty, 'SECOND-DIRTY');
  const allIds = await ids(origin), sourceById = Object.fromEntries((await documents(origin)).map(document => [document.id, document.source]));
  await decisions([1, 2]); await context(origin, long, labels.others); await dialogCount(2); await idle(origin);
  assert.deepEqual(await ids(origin), allIds, 'Cancelling later close partially removed earlier tabs');
  assert.deepEqual(Object.fromEntries((await documents(origin)).map(document => [document.id, document.source])), sourceById);
  await decisions([1, 1]); await context(origin, long, labels.others);
  await waitFor(async () => (await ids(origin)).length === 1, 'Close other tabs did not complete');
  assert.deepEqual(await ids(origin), [long.id]); assert.deepEqual(await byId(companion, companionDocument.id), protectedDocument);
  checks.push('Close other tabs preflights all decisions atomically and never closes another window');

  await select(origin, long);
  if ((await byId(origin, long.id)).mode !== 'source') await origin.getByTestId('mode-toggle').click();
  const markedSource = longSource + 'TRANSFER-UNDO';
  await append(origin, long, 'TRANSFER-UNDO');
  await editor(origin).focus(); await origin.keyboard.press('Control+Home');
  for (let index = 0; index < 3; index++) await origin.keyboard.press('Shift+ArrowRight');
  await origin.keyboard.press('Control+b');
  await waitFor(async () => (await byId(origin, long.id)).source !== markedSource, 'Could not prepare independent formatting history');
  const redoSource = (await byId(origin, long.id)).source;
  await origin.keyboard.press('Control+z');
  await waitFor(async () => (await byId(origin, long.id)).source === markedSource, 'Could not prepare redo history');
  await origin.keyboard.press('Control+End');
  for (let index = 0; index < 6; index++) await origin.keyboard.press('Shift+ArrowLeft');
  // Finish CodeMirror's pending selection scroll before setting the test viewport.
  await settle(origin);
  const assignedScroll = await origin.locator('.cm-scroller:visible').evaluate(element => {
    const before = element.scrollTop;
    element.scrollTop = 450;
    return { before, assigned: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight };
  });
  await settle(origin);
  scrolls.push({ ...assignedScroll, afterFrames: await origin.locator('.cm-scroller:visible').evaluate(element => element.scrollTop), document: (await byId(origin, long.id)).scrollTop });
  await waitFor(async () => Math.abs((await byId(origin, long.id)).scrollTop - 450) < 3 && Math.abs(await origin.locator('.cm-scroller:visible').evaluate(element => element.scrollTop) - 450) < 3, 'Scroll position was not synchronized');
  const moving = await byId(origin, long.id);
  assert.notEqual(moving.selection.anchor, moving.selection.head); assert(moving.dirty);
  const otherTab = await open(origin, files.alpha); await select(origin, otherTab);
  assert.equal(await activeId(origin), otherTab.id);
  const target = await moved(origin, moving, () => context(origin, moving, labels.move));
  const transferred = await byId(target, moving.id);
  assert.equal(transferred.source, markedSource); assert.equal(transferred.mode, 'source'); assert.equal(transferred.dirty, true);
  assert.deepEqual(transferred.selection, moving.selection); assert(Math.abs(transferred.scrollTop - moving.scrollTop) < 3, 'Inactive tab lost its saved scroll position');
  assert(Math.abs(await target.locator('.cm-scroller:visible').evaluate(element => element.scrollTop) - moving.scrollTop) < 3, 'Target editor did not restore its scroll position');
  assert.deepEqual(await ids(origin), [otherTab.id]);
  await focus(target); await editor(target).focus(); await target.keyboard.press('Control+y');
  await waitFor(async () => (await byId(target, moving.id)).source === redoSource, 'Redo history was lost in transfer');
  await target.keyboard.press('Control+z'); await waitFor(async () => (await byId(target, moving.id)).source === markedSource, 'Formatting undo failed after transfer');
  await target.keyboard.press('Control+z'); await waitFor(async () => (await byId(target, moving.id)).source === longSource, 'Earlier undo history was lost in transfer');
  await target.keyboard.press('Control+y'); await waitFor(async () => (await byId(target, moving.id)).source === markedSource, 'Earlier redo history was lost in transfer');
  const reopen = await origin.evaluate(filename => window.markedown.openFiles([filename]), files.long);
  assert.equal(reopen.status, 'ok'); assert.equal(reopen.value.length, 0); assert.equal(await byId(origin, moving.id), undefined);
  assert.equal((await documents(target)).filter(document => document.id === moving.id).length, 1);
  await waitFor(async () => await native(app, target, window => window.isFocused()), 'Reopening a moved file did not focus its existing window');
  assert.equal(await readFile(files.long, 'utf8'), longSource);
  checks.push('non-active tab transfer preserves ID, unsaved source, source mode, selection, scroll and both history stacks; reopening focuses its owner');
  await screenshot(target, 'transferred-editor');

  const windowsBefore = alive(app).length;
  let drag = await pointerStart(origin, otherTab);
  await origin.mouse.move(drag.x + 40, drag.y, { steps: 4 });
  assert(await origin.evaluate(() => window.markedownTabPointerEvents.some(event => event.type === 'gotpointercapture' && event.tab)), 'Tab drag did not capture the pointer');
  await origin.mouse.up(); await idle(origin); assert.equal(alive(app).length, windowsBefore);
  drag = await pointerStart(origin, otherTab);
  await origin.mouse.move(drag.x + 25, drag.band.y + drag.band.height + 100, { steps: 6 });
  await origin.locator('.document-tab-ghost.is-detaching').waitFor();
  await origin.keyboard.press('Escape'); await origin.mouse.up(); await idle(origin);
  assert.equal(alive(app).length, windowsBefore); assert(await byId(origin, otherTab.id));
  assert.equal(await origin.locator('.document-tab-ghost').count(), 0);
  drag = await pointerStart(origin, otherTab, true);
  await origin.mouse.move(drag.x, drag.band.y + drag.band.height + 100, { steps: 6 }); await origin.mouse.up(); await idle(origin);
  assert.equal(alive(app).length, windowsBefore); assert(await byId(origin, otherTab.id));
  assert.equal(await origin.evaluate(() => window.markedownTabPointerEvents.some(event => event.type === 'gotpointercapture' && event.tab)), false, 'Close button initiated a tab drag');
  const dragged = await moved(origin, otherTab, async () => {
    const drag = await pointerStart(origin, otherTab);
    await origin.mouse.move(drag.x + 30, drag.band.y + drag.band.height + 100, { steps: 6 });
    await origin.locator('.document-tab-ghost.is-detaching').waitFor();
    await origin.mouse.up();
  });
  const replacement = await documents(origin);
  assert.equal(replacement.length, 1); assert.equal(replacement[0].source, ''); assert.equal(replacement[0].path, null); assert.notEqual(replacement[0].id, otherTab.id);
  assert.equal((await byId(dragged, otherTab.id)).source, otherTab.source);
  assert.deepEqual(await byId(companion, companionDocument.id), protectedDocument);
  checks.push('trusted pointer capture: inside-band release, Escape and close-button movement do not detach; outside-band drop moves the last tab and leaves a blank document');

  const outsideDocument = await open(origin, files.target);
  const outsideTarget = await moved(origin, outsideDocument, async () => {
    const drag = await pointerStart(origin, outsideDocument), outsideY = await origin.evaluate(() => innerHeight + 40);
    await origin.mouse.move(drag.x + 25, outsideY, { steps: 12 });
    await origin.locator('.document-tab-ghost.is-detaching').waitFor({ timeout: 5000 });
    await origin.mouse.up();
  });
  assert.equal((await byId(outsideTarget, outsideDocument.id)).source, outsideDocument.source);
  checks.push('captured native pointer released beyond the window viewport moves its tab');

  await native(app, origin, window => window.setSize(700, 480));
  await open(origin, files['dirty-one']); await inspectLayout(origin, 'narrow-before-sidebar-collapse');
  await collapseNarrowSidebar(origin); await context(origin, replacement[0]);
  await screenshot(origin, 'context-menu-700'); await origin.keyboard.press('Escape');
  await screenshot(origin, 'tabs-700');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await app.close(); applications.splice(applications.indexOf(app), 1);

  for (const scale of [1.25, 2]) {
    app = await launch(scale); const page = await app.firstWindow(); await ready(page);
    await page.evaluate(() => window.markedown.updateSettings({ language: 'zh-CN', autoSave: false, saveOnSwitch: false, spellcheck: 'off' }));
    await native(app, page, window => window.setSize(700, 480)); await settle(page);
    await collapseNarrowSidebar(page);
    const ratio = await page.evaluate(() => devicePixelRatio);
    assert(Math.abs(ratio - scale) < 0.05, `Requested ${scale} display scale but received ${ratio}`);
    await context(page, await byPath(page, files.long)); await screenshot(page, `context-menu-${scale * 100}percent`); await page.keyboard.press('Escape');
    await screenshot(page, `tabs-${scale * 100}percent`);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await app.close(); applications.splice(applications.indexOf(app), 1);
  }
  checks.push('700 DIP narrow windows and native 125%/200% device scale retain bounded menus and layout');
  assert.deepEqual(errors, []);
  const report = { status: 'passed', executable: executable || 'development Electron', run, checks, captures, errors, layouts, scrolls };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const pointers = [];
  for (const page of alive(app || { windows: () => [] })) pointers.push(await page.evaluate(() => ({ pointerEvents: window.markedownTabPointerEvents, focused: document.hasFocus(), hidden: document.hidden })).catch(() => null));
  for (const [index, page] of alive(app || { windows: () => [] }).entries()) {
    await inspectLayout(page, `failure-${index}`).catch(() => {});
    await native(app, page, window => { window.show(); window.focus(); }).catch(() => {});
    await page.screenshot({ path: path.join(run, `failure-${index}.png`), timeout: 5000 }).catch(() => {});
  }
  await writeFile(path.join(run, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), checks, captures, errors, pointers, layouts, scrolls, run }, null, 2));
  throw error;
} finally {
  for (const instance of applications) {
    await instance.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
    await instance.close().catch(() => {});
  }
}
