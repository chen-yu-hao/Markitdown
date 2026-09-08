import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const arguments_ = process.argv.slice(2);
const overlayRequested = arguments_.includes('--overlay');
const executableArgument = arguments_.find(argument => !argument.startsWith('--'));
const executable = executableArgument ? path.resolve(executableArgument) : undefined;
const evidence = path.resolve('test-results/equation-scroll');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const filename = path.join(run, 'public-equation-scroll.md'), data = path.join(run, 'data');
await mkdir(data);
const expression = Array.from({ length: 45 }, (_, index) => `a_{${index + 1}}x^{${index % 4 + 1}}`).join(' + ');
const source = ['# Public equation scroll checks', 'A long numbered equation:', `$$\n${expression}=0\n$$`, 'A long unnumbered equation:', `$$\n${expression}=1 \\notag\n$$`, 'Selection parking paragraph.'].join('\n\n') + '\n';
const froms = [source.indexOf('$$'), source.indexOf('$$', source.indexOf('$$') + expression.length + 8)];
assert(froms.every(from => from >= 0));
await writeFile(filename, source);
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ autoSave: false, saveOnSwitch: false, language: 'zh-CN', spellcheck: 'off', theme: 'github', zoom: 100, mathNumbering: 'all', mathAlignment: 'left', mathNumberPosition: 'right', showToolbar: false }));
const env = { ...process.env, MARKEDOWN_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
// Feature switches request an overlay configuration; measured geometry determines coverage.
const extraArguments = overlayRequested ? ['--enable-features=OverlayScrollbar,FluentOverlayScrollbar'] : [];
const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode', '--force-device-scale-factor=1', ...extraArguments, filename], env, timeout: 30000 });
const page = await app.firstWindow().catch(async error => { await app.close().catch(() => {}); throw error; });
const checks = [], errors = [], cases = [], captures = [];
let version, pendingCase;
page.on('pageerror', error => errors.push(error.message));
const editor = () => page.locator('.cm-content:visible');
const formula = from => page.locator(`.markedown-editor:visible .math-block[data-equation-from="${from}"]`);
const current = async () => (await page.evaluate(() => window.markedown.bootstrap())).documents.find(document => document.path === filename);
async function waitFor(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
  throw new Error(message);
}
async function native(action, argument) {
  const handle = await app.browserWindow(page);
  try { return await handle.evaluate(action, argument); } finally { await handle.dispose(); }
}
async function settle() {
  await page.evaluate(async () => { await document.fonts.ready; for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); });
}
async function focus() {
  await native(window => { window.show(); window.focus(); }); await page.bringToFront();
  await waitFor(() => native(window => window.isFocused()), 'Native window focus did not settle');
  await page.waitForFunction(() => document.hasFocus());
}
async function park() {
  await focus(); await editor().focus(); await page.keyboard.press('Control+End');
  for (let count = 0; count < 4; count++) await page.keyboard.press('Shift+ArrowLeft');
  await waitFor(async () => { const selection = (await current()).selection; return selection.anchor === source.length && selection.head === source.length - 4; }, 'Parking selection did not settle');
  await settle();
}
async function geometry(from) {
  return formula(from).evaluate(block => {
    const body = block.querySelector('.md-equation-body'), number = block.querySelector('.md-equation-number');
    const bounds = body.getBoundingClientRect(), style = getComputedStyle(body);
    const borderTop = parseFloat(style.borderTopWidth) || 0, borderBottom = parseFloat(style.borderBottomWidth) || 0;
    const occupiedScrollbarHeight = Math.max(0, body.offsetHeight - body.clientHeight - borderTop - borderBottom);
    return { block: block.getBoundingClientRect().toJSON(), body: bounds.toJSON(), number: number?.getBoundingClientRect().toJSON(), numberText: number?.textContent || null, clientWidth: body.clientWidth, clientHeight: body.clientHeight, scrollWidth: body.scrollWidth, scrollLeft: body.scrollLeft, occupiedScrollbarHeight, scrollbarKind: occupiedScrollbarHeight > 1 ? 'reserved-space' : 'overlay-or-hidden', scrollbarY: bounds.bottom - borderBottom - Math.max(occupiedScrollbarHeight / 2, 3), overflowX: style.overflowX };
  });
}
async function resetScroll(from) {
  await formula(from).evaluate(block => { block.scrollIntoView({ block: 'center' }); block.querySelector('.md-equation-body').scrollLeft = 0; });
  await settle();
}
async function beginAction(from, name, point) {
  await page.evaluate(() => { window.markedownEquationEvents = []; });
  const document = await current();
  const action = { name, point, before: { selection: document.selection, editVersion: document.editVersion, dirty: document.dirty }, geometry: await geometry(from) };
  action.hit = await page.evaluate(({ x, y }) => { const target = document.elementFromPoint(x, y); return target && { tag: target.tagName, class: target.getAttribute('class'), equationFrom: target.closest('[data-equation-from]')?.getAttribute('data-equation-from') || null }; }, point);
  pendingCase.actions.push(action);
  return action;
}
async function endScroll(from, action) {
  await settle();
  const document = await current(), rendered = await formula(from).count();
  action.after = { selection: document.selection, editVersion: document.editVersion, dirty: document.dirty, sourceUnchanged: document.source === source, rendered: Boolean(rendered), geometry: rendered ? await geometry(from) : null };
  action.events = await page.evaluate(() => window.markedownEquationEvents);
  assert.equal(action.after.rendered, true, `${action.name}: scrollbar interaction exposed equation source`);
  assert.equal(document.source, source, `${action.name}: scrolling changed Markdown`);
  assert.deepEqual(document.selection, action.before.selection, `${action.name}: scrolling changed editor selection`);
  assert.equal(document.editVersion, action.before.editVersion, `${action.name}: scrolling created an edit`);
  assert.equal(document.dirty, action.before.dirty, `${action.name}: scrolling changed dirty state`);
  if (action.geometry.number) assert.deepEqual(action.after.geometry.number, action.geometry.number, `${action.name}: scrolling moved the equation number`);
  return action.after.geometry;
}
async function scrollChecks(from, numbered) {
  await resetScroll(from);
  const measured = await geometry(from);
  assert(measured.scrollWidth > measured.clientWidth + 100, 'Public fixture must overflow horizontally');
  assert.equal(Boolean(measured.numberText), numbered);
  assert(measured.body.width > 30 && measured.body.height > 10, 'Equation scroll area has no usable dimensions');
  if (measured.number) {
    assert(pendingCase.position === 'right' ? measured.body.right <= measured.number.left + 1 : measured.number.right <= measured.body.left + 1, 'Equation number overlaps its scroll area');
  }
  pendingCase.measurements.push(measured);
  if (measured.occupiedScrollbarHeight > 1) {
    const point = { x: measured.body.left + measured.clientWidth * 0.78, y: measured.scrollbarY };
    const action = await beginAction(from, 'native-track-click', point);
    await page.mouse.click(point.x, point.y);
    const after = await endScroll(from, action);
    await waitFor(async () => (await geometry(from)).scrollLeft > after.clientWidth / 4, 'Track click did not move the native scrollbar');

    await resetScroll(from);
    const thumb = await geometry(from), arrow = thumb.occupiedScrollbarHeight;
    const trackWidth = thumb.clientWidth - arrow * 2;
    const thumbWidth = Math.max(20, trackWidth * thumb.clientWidth / thumb.scrollWidth);
    const start = { x: thumb.body.left + arrow + thumbWidth / 2, y: thumb.scrollbarY };
    const drag = await beginAction(from, 'native-thumb-drag', start);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    drag.motion = [];
    try {
      for (const [phase, fraction] of [['pressed', 0], ['right', 0.3], ['left', 0.15]]) {
        const measurement = { phase, x: start.x + trackWidth * fraction, y: start.y, scrollLeft: null };
        drag.motion.push(measurement);
        if (fraction) await page.mouse.move(measurement.x, measurement.y, { steps: 8 });
        await settle();
        measurement.scrollLeft = await formula(from).count() ? (await geometry(from)).scrollLeft : null;
        assert.notEqual(measurement.scrollLeft, null, `Native thumb ${phase}: equation source was exposed`);
      }
    } finally { await page.mouse.up(); }
    await endScroll(from, drag);
    const [pressed, right, left] = drag.motion;
    assert(right.scrollLeft > pressed.scrollLeft + 20, 'Native scrollbar thumb did not follow the rightward drag');
    assert(left.scrollLeft < right.scrollLeft - 20, 'Native scrollbar thumb did not follow the leftward return drag');
    if (numbered && (pendingCase.width === 1280 || pendingCase.width === 700 && pendingCase.zoom === 100 && pendingCase.theme === 'night' && pendingCase.position === 'right')) await capture(`dragged-${pendingCase.width}-${pendingCase.theme}`);
  } else {
    pendingCase.nativeScrollbar = 'No reserved scrollbar area observed; track and thumb coordinates are not inferred. Native overlay interaction requires an observed visible scrollbar.';
  }

  await resetScroll(from);
  const wheelBounds = await geometry(from), point = { x: wheelBounds.body.left + wheelBounds.clientWidth / 2, y: wheelBounds.body.top + Math.min(10, wheelBounds.clientHeight / 2) };
  const wheel = await beginAction(from, 'horizontal-wheel', point);
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(180, 0);
  await waitFor(async () => await formula(from).count() === 0 || (await geometry(from)).scrollLeft > 20, 'Horizontal wheel did not move the equation');
  await endScroll(from, wheel);
}
async function editCheck(from) {
  await resetScroll(from);
  const glyph = formula(from).locator('.katex-html .mord').first();
  const bounds = await glyph.boundingBox(); assert(bounds && bounds.width > 0);
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const action = await beginAction(from, 'formula-content-edit-and-undo', point);
  await page.mouse.click(point.x, point.y);
  await waitFor(async () => await formula(from).count() === 0 && (await current()).selection.head >= from && (await current()).selection.head <= from + expression.length + 6, 'Clicking formula content did not expose its source');
  action.events = await page.evaluate(() => window.markedownEquationEvents);
  assert.equal((await current()).source, source, 'Entering equation source changed Markdown');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await waitFor(async () => (await current()).selection.head === from + 3, 'Equation source cursor did not enter the formula line');
  await page.keyboard.insertText('z+');
  const edited = source.slice(0, from + 3) + 'z+' + source.slice(from + 3);
  await waitFor(async () => (await current()).source === edited, 'Formula source is not editable at the selected location');
  await page.keyboard.press('Control+z'); await waitFor(async () => (await current()).source === source, 'Formula edit could not be undone');
  await page.keyboard.press('Control+y'); await waitFor(async () => (await current()).source === edited, 'Formula edit could not be redone');
  await page.keyboard.press('Control+z'); await waitFor(async () => (await current()).source === source, 'Final formula undo did not restore source');
  action.after = { sourceUnchanged: true, editUndoRedo: 'passed' };
  await park(); await resetScroll(from);
}
async function capture(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Application viewport overflows horizontally');
  const filename = `${name}.png`; await page.screenshot({ path: path.join(run, filename) }); captures.push(filename);
}

try {
  await editor().waitFor(); await focus();
  version = (await page.evaluate(() => window.markedown.bootstrap())).version;
  await page.evaluate(() => {
    window.markedownEquationEvents = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'wheel']) document.addEventListener(type, event => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const record = { type, trusted: event.isTrusted, target: target?.tagName, class: target?.getAttribute('class'), path: event.composedPath().filter(node => node instanceof Element).slice(0, 5).map(node => ({ tag: node.tagName, class: node.getAttribute('class') })), equationFrom: target?.closest('[data-equation-from]')?.getAttribute('data-equation-from') || null, x: event.clientX, y: event.clientY, button: event.button, deltaX: event.deltaX, deltaY: event.deltaY, defaultPrevented: event.defaultPrevented };
      window.markedownEquationEvents.push(record);
      setTimeout(() => { record.defaultPrevented = event.defaultPrevented; }, 0);
    }, { capture: true, passive: true });
  });
  await native(window => window.setSize(1280, 900));
  const sidebarButton = page.getByRole('button', { name: '\u6536\u8d77\u4fa7\u680f', exact: true });
  if (await sidebarButton.count()) await sidebarButton.click();
  await page.locator('.citation-startup-credit').waitFor({ state: 'detached', timeout: 20000 });
  const scenarios = [{ width: 1280, zoom: 100, theme: 'github', position: 'right' }];
  for (const zoom of [100, 125, 150, 200]) for (const theme of ['github', 'night']) for (const position of ['right', 'left']) scenarios.push({ width: 700, zoom, theme, position });
  for (const scenario of scenarios) {
    pendingCase = { ...scenario, actions: [], measurements: [] }; cases.push(pendingCase);
    await native((window, width) => window.setSize(width, 900), scenario.width);
    await page.evaluate(({ zoom, theme, position }) => window.markedown.updateSettings({ zoom, theme, mathNumberPosition: position }), scenario);
    await waitFor(async () => Math.abs(await native(window => window.webContents.getZoomFactor()) - scenario.zoom / 100) < 0.01, 'Requested application zoom was not applied');
    await park();
    for (const [index, from] of froms.entries()) {
      await formula(from).waitFor();
      await scrollChecks(from, index === 0);
      await editCheck(from);
    }
    await resetScroll(froms[0]);
    await capture(`scroll-${scenario.width}-${scenario.zoom}-${scenario.theme}-${scenario.position}`);
    pendingCase.status = 'passed';
  }
  assert.equal(await readFile(filename, 'utf8'), source, 'Verification wrote to the fixture file');
  assert.deepEqual(errors, []);
  const reservedCases = cases.filter(item => item.measurements.every(measurement => measurement.occupiedScrollbarHeight > 1)).length;
  if (!overlayRequested) assert(reservedCases > 0, 'Default verification did not exercise native scrollbar track clicks and thumb drags');
  checks.push(`${cases.length} desktop/narrow, theme and application zoom cases preserve Markdown and selection during wheel scrolling`);
  checks.push(`${reservedCases} cases with observed native scrollbar space pass real track clicks and thumb drags for numbered and unnumbered formulas`);
  checks.push('Formula content clicks expose editable source; insertion, undo, redo and final undo preserve source in every case');
  const overlay = { requested: overlayRequested, arguments: extraArguments, observed: cases.some(item => item.measurements.some(measurement => measurement.occupiedScrollbarHeight <= 1)), limitation: 'Zero reserved space alone does not prove an overlay scrollbar is visible or draggable; unobserved native overlay controls are not reported as tested.' };
  const report = { status: 'passed', version, executable: executable || 'development Electron', run, checks, overlay, errors, captures, cases };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, cases: cases.length }));
} catch (error) {
  await page.mouse.up().catch(() => {});
  await focus().catch(() => {}); await page.screenshot({ path: path.join(run, 'failure.png'), timeout: 5000 }).catch(() => {});
  const report = { status: 'failed', error: String(error), version, executable: executable || 'development Electron', overlayRequested, run, checks, errors, captures, cases, document: await current().catch(() => null), events: await page.evaluate(() => window.markedownEquationEvents).catch(() => null) };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ status: report.status, error: report.error, run, cases: cases.length, lastAction: pendingCase?.actions.at(-1) }));
  throw error;
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await app.close();
}
