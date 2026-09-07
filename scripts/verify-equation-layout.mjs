import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

const evidence = path.resolve('test-results/equation-layout');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const input = path.join(run, 'equation-layout.md');
await writeFile(input, 'x^2 + y^2');
const source = [
  '# Equation layout',
  'Inline $r$ remains part of this paragraph. See \\eqref{eq:sum}.',
  ['$$', '\\begin{aligned}', 'f(x) &= x^2 + 2x + 1 \\\\', '     &= (x+1)^2', '\\end{aligned} \\label{eq:sum}', '$$'].join('\n'),
  '$$\nE=mc^2\n$$',
  '$$\nx+y \\tag*{S1} \\label{eq:manual}\n$$',
  '$$\nz=1 \\notag\n$$',
  '$$\n' + Array.from({ length: 35 }, (_, index) => `a_{${index + 1}}`).join(' + ') + '=0\n$$',
  'End of document.',
].join('\n\n') + '\n';
const env = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MARKEDOWN_DEV_URL;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable) } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode', input], env, timeout: 30000 });
const page = await app.firstWindow();
const errors = [], checks = [], measurements = [];
page.on('pageerror', error => errors.push(error.message));
const current = () => page.evaluate(async () => (await window.markedown.bootstrap()).documents.find(doc => doc.path));
const settle = () => page.evaluate(async () => { await document.fonts.ready; for (let frame = 0; frame < 5; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); });
const geometry = locator => locator.evaluateAll(blocks => blocks.map(block => {
  const rect = element => element?.getBoundingClientRect().toJSON() || null;
  const body = block.querySelector('.md-equation-body');
  const number = block.querySelector('.md-equation-number');
  const display = block.querySelector('.md-equation-content>.katex-display');
  return { block: rect(block), body: rect(body), content: rect(block.querySelector('.md-equation-content')), number: rect(number), text: number?.textContent, alignment: block.dataset.mathAlign, position: block.dataset.numberPosition, scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, nestedOverflow: display ? getComputedStyle(display).overflow : null };
}));
function checkGeometry(items, alignment, position) {
  assert.equal(items.length, 5);
  assert.deepEqual(items.filter(item => item.number).map(item => item.text), ['(1)', '(2)', 'S1', '(3)']);
  for (const item of items) {
    assert.equal(item.alignment, alignment);
    assert.equal(item.position, position);
    assert(item.body.width > 0 && item.content.height > 0);
    if (item.nestedOverflow !== null) assert.equal(item.nestedOverflow, 'visible', 'Formula acquired a nested scrollbar.');
    if (item.number) {
      assert(Math.abs(item.number.y + item.number.height / 2 - item.body.y - item.body.height / 2) < 3, 'Equation number is not vertically centered.');
      assert(position === 'right' ? item.body.right <= item.number.left : item.number.right <= item.body.left, 'Formula and number overlap.');
      assert(item.number.left >= item.block.left - 1 && item.number.right <= item.block.right + 1, 'Number escapes its equation block.');
    }
    if (item.content.width <= item.body.width + 1) {
      const difference = alignment === 'left' ? item.content.left - item.body.left : alignment === 'right' ? item.content.right - item.body.right : item.content.x + item.content.width / 2 - item.body.x - item.body.width / 2;
      assert(Math.abs(difference) < 3, `Wrong ${alignment} formula alignment: ${difference}`);
    }
  }
}
async function setLayout(alignment, position) {
  await page.keyboard.press('Control+,');
  await page.locator('.preferences-nav').getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.getByRole('combobox', { name: '行间公式对齐', exact: true }).selectOption(alignment);
  await page.getByRole('combobox', { name: '编号位置', exact: true }).selectOption(position);
  await page.waitForFunction(({ alignment, position }) => window.markedown.bootstrap().then(data => data.settings.mathAlignment === alignment && data.settings.mathNumberPosition === position), { alignment, position });
  await page.getByRole('button', { name: '关闭偏好设置', exact: true }).click();
  await settle();
}
async function exportFile(format, stem) {
  const doc = await current();
  const destination = path.join(run, `${stem}.${format === 'htmlPlain' ? 'plain.html' : format}`);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
  const result = await page.evaluate(({ doc, format }) => window.markedown.exportDocument(doc.id, { source: doc.source, mode: doc.mode, selection: doc.selection, scrollTop: doc.scrollTop, editVersion: doc.editVersion }, format), { doc, format });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return destination;
}
try {
  await page.locator('.cm-content:visible').waitFor();
  const initial = await page.evaluate(() => window.markedown.bootstrap());
  assert.equal(initial.settings.mathNumbering, 'all');
  assert.equal(initial.settings.mathAlignment, 'left');
  assert.equal(initial.settings.mathNumberPosition, 'right');
  await page.evaluate(() => window.markedown.updateSettings({ language: 'zh-CN', autoSave: false, theme: 'github', spellcheck: 'off' }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  await page.locator('.cm-content:visible').click();
  await page.keyboard.press('Control+a');
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  await page.getByRole('menuitem', { name: '格式', exact: true }).click();
  await page.getByRole('menuitem', { name: '行间公式', exact: true }).click();
  assert.equal((await current()).source, '$$\nx^2 + y^2\n$$\n');
  await page.keyboard.press('Control+z');
  assert.equal((await current()).source, 'x^2 + y^2');
  await page.keyboard.press('Control+y');
  assert.equal((await current()).source, '$$\nx^2 + y^2\n$$\n');
  checks.push('menu inserts display math at the selection with one undo and redo');
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(source);
  await page.locator('.cm-content:visible .md-equation-number').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.md-equation-number').length === 4);
  for (const alignment of ['left', 'center', 'right']) for (const position of ['right', 'left']) {
    await setLayout(alignment, position);
    const items = await geometry(page.locator('.cm-content:visible .math-block'));
    checkGeometry(items, alignment, position);
    measurements.push({ surface: 'editor', alignment, position, items });
    assert.equal((await current()).source, source, 'Layout preferences changed Markdown source.');
  }
  assert.equal(await page.locator('.md-equation-inline-number').count(), 0);
  checks.push('six alignment and number-position combinations, multiline numbering, tag*, notag and inline math');
  await setLayout('left', 'right');
  await page.locator('.cm-scroller:visible').evaluate(element => { element.scrollTop = 0; });
  await page.locator('.citation-startup-credit').waitFor({ state: 'detached', timeout: 20000 });
  await page.screenshot({ path: path.join(run, 'nature-desktop.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 480));
  await settle();
  const compact = await geometry(page.locator('.cm-content:visible .math-block'));
  checkGeometry(compact, 'left', 'right');
  assert(compact.at(-1).scrollWidth > compact.at(-1).clientWidth, 'Wide equations are not scrollable.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.keyboard.press('Control+,');
  await page.locator('.preferences-nav').getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.getByRole('combobox', { name: '编号位置', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(run, 'preferences-compact.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  checks.push('compact window preferences and horizontally scrollable equations without number overlap');
  for (const [alignment, position] of [['left', 'right'], ['right', 'left']]) {
    await setLayout(alignment, position);
    for (const format of ['html', 'htmlPlain', 'pdf', 'png']) {
      const filename = await exportFile(format, `${alignment}-${position}`);
      const bytes = await readFile(filename);
      if (format.startsWith('html')) {
        const pending = app.waitForEvent('window');
        const id = await app.evaluate(async ({ BrowserWindow }, filename) => {
          const window = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
          await window.loadFile(filename);
          return window.id;
        }, filename);
        const exported = await pending;
        await exported.evaluate(() => document.fonts.ready);
        const items = await geometry(exported.locator('.math-block'));
        checkGeometry(items, alignment, position);
        measurements.push({ surface: format, alignment, position, items });
        const capture = await app.evaluate(async ({ BrowserWindow }, id) => {
          const image = await BrowserWindow.fromId(id).webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
          if (image.isEmpty()) throw new Error('The HTML preview capture is empty.');
          return image.toPNG().toString('base64');
        }, id);
        await writeFile(path.join(run, `${alignment}-${position}-${format}.png`), Buffer.from(capture, 'base64'));
        await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id);
      } else if (format === 'pdf') assert.equal(bytes.toString('ascii', 0, 5), '%PDF-');
      else {
        const metadata = await sharp(bytes).metadata();
        assert(metadata.width > 0 && metadata.height > 0 && metadata.height <= 16384);
        assert((await sharp(bytes).stats()).channels.some(channel => channel.stdev > 10));
      }
    }
  }
  checks.push('HTML, standalone SVG HTML, PDF and PNG exports preserve both layouts with unsaved source');
  const saved = JSON.parse(await readFile(path.join(env.MARKEDOWN_DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(saved.mathAlignment, 'right');
  assert.equal(saved.mathNumberPosition, 'left');
  assert.equal((await current()).source, source);
  assert.deepEqual(errors, []);
  const report = { status: 'passed', checks, errors, run, measurements };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, measurements: measurements.length }));
} catch (error) {
  await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  await writeFile(path.join(run, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), checks, errors, measurements }, null, 2));
  throw error;
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await app.close();
}
