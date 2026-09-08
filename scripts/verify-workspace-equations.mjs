import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

// Optional --inspect-pdf needs pdftoppm plus PDFTOTEXT or Python with pypdf.
const execute = promisify(execFile);
const evidence = path.resolve('test-results/workspace-equations');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const workspace = path.join(run, '\u4e2d\u6587 \u516c\u5171\u6837\u4f8b');
const filename = path.join(workspace, '\u516c\u5f0f \u5355\u51fb.md');
const data = path.join(run, 'data');
await mkdir(workspace, { recursive: true }); await mkdir(data);
const source = [
  '# Public equation checks',
  'Paragraph $r$ stays inline.',
  '$E=mc^2$',
  'No blank line before display:\n$$\nF=ma\n$$',
  'No blank line before brackets:\n\\[\na^2+b^2=c^2\n\\]',
  '  $a=b$  ',
  '## Heading $h$',
  '- List $\\ell$',
  '> Quote $q$',
  '| Symbol | Meaning |\n| --- | --- |\n| $t$ | Time |',
  'End of public fixture.',
].join('\n\n') + '\n';
await writeFile(filename, source);
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ autoSave: false, saveOnSwitch: false, language: 'zh-CN', spellcheck: 'off', theme: 'github', exportTheme: false, exportOutline: false }));
const env = { ...process.env, MARKEDOWN_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
const arguments_ = process.argv.slice(2);
const inspectPdf = arguments_.includes('--inspect-pdf');
const executableArgument = arguments_.find(argument => !argument.startsWith('--'));
const executable = executableArgument ? path.resolve(executableArgument) : undefined;
const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode', '--force-device-scale-factor=1'], env, timeout: 30000 });
const page = await app.firstWindow();
const checks = [], errors = [], measurements = [], exports = {};
page.on('pageerror', error => errors.push(error.message));
const editor = () => page.locator('.cm-content:visible');
const snapshot = async () => (await page.evaluate(() => window.markedown.bootstrap())).documents.find(document => document.path === filename);
async function waitFor(predicate, message, timeout = 15000) {
  const until = Date.now() + timeout;
  do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < until);
  throw new Error(message);
}
async function native(action, argument) {
  const handle = await app.browserWindow(page);
  try { return await handle.evaluate(action, argument); } finally { await handle.dispose(); }
}
async function focus() {
  await native(window => { window.show(); window.focus(); }); await page.bringToFront();
  await waitFor(() => native(window => window.isFocused()), 'Native focus did not settle');
  await page.waitForFunction(() => document.hasFocus(), undefined, { polling: 100 });
}
async function settle() { await focus(); await page.evaluate(async () => { await document.fonts.ready; for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); }); }
async function parkCursor() { await focus(); await editor().focus(); await page.keyboard.press('Control+End'); await settle(); await page.locator('.cm-scroller:visible').evaluate(element => { element.scrollTop = 0; }); await settle(); }
async function numbers(expected) {
  await settle();
  await waitFor(async () => JSON.stringify(await page.locator('.markedown-editor:visible .md-equation-number').allTextContents()) === JSON.stringify(expected), 'Incorrect live equation numbers: ' + expected.join(', '));
  assert.equal(await page.locator('.markedown-editor:visible .md-equation-inline-number').count(), 0, 'Ordinary inline math received a number');
}
async function toggleStandalone(enabled) {
  await focus(); await page.keyboard.press('Control+,');
  await page.locator('.preferences-nav').getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.getByRole('checkbox', { name: '\u72ec\u5360\u6bb5\u843d\u7684\u884c\u5185\u516c\u5f0f\u6309\u884c\u95f4\u516c\u5f0f\u5904\u7406', exact: true }).setChecked(enabled);
  await waitFor(async () => (await page.evaluate(() => window.markedown.bootstrap())).settings.mathStandaloneParagraphs === enabled, 'Standalone formula preference was not saved');
  await page.getByRole('button', { name: '\u5173\u95ed\u504f\u597d\u8bbe\u7f6e', exact: true }).click();
  await parkCursor();
}
async function capture(name) {
  await settle();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ': viewport overflow');
  await page.screenshot({ path: path.join(run, `${name}.png`) });
}
async function geometry(locator) {
  return locator.evaluateAll(blocks => blocks.map(block => {
    const rect = node => node.getBoundingClientRect().toJSON();
    return { from: Number(block.dataset.equationFrom), number: block.querySelector('.md-equation-number')?.textContent, block: rect(block), body: rect(block.querySelector('.md-equation-body')), content: rect(block.querySelector('.md-equation-content')), label: rect(block.querySelector('.md-equation-number')) };
  }));
}
function checkLayout(items) {
  assert.deepEqual(items.map(item => item.number), ['(1)', '(2)', '(3)', '(4)']);
  for (const item of items) {
    assert(item.content.width > 0 && item.content.height > 0);
    assert(item.body.right <= item.label.left + 1, 'Equation and number overlap');
    assert(item.label.right <= item.block.right + 1, 'Equation number escapes its block');
    assert(Math.abs(item.body.y + item.body.height / 2 - item.label.y - item.label.height / 2) < 3, 'Equation number is not vertically centered');
  }
}
async function exportFile(format) {
  const document = await snapshot(), output = path.join(run, `equations.${format}`);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  const result = await page.evaluate(({ document, format }) => window.markedown.exportDocument(document.id, { source: document.source, mode: document.mode, selection: document.selection, scrollTop: document.scrollTop, editVersion: document.editVersion }, format), { document, format });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  exports[format] = { path: output };
  return output;
}

try {
  await editor().waitFor(); await native(window => window.setSize(1280, 1100)); await settle();
  const initial = await page.evaluate(() => window.markedown.bootstrap());
  assert.equal(initial.settings.mathStandaloneParagraphs, true); assert.equal(initial.settings.mathNumbering, 'all');
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, workspace);
  await page.getByTestId('sidebar').getByRole('button', { name: '\u6253\u5f00\u6587\u4ef6\u5939', exact: true }).first().click();
  const fileRow = page.locator('.tree-row').and(page.locator(`[title=${JSON.stringify(filename)}]`));
  await fileRow.click();
  await waitFor(async () => Boolean(await snapshot()), 'Single sidebar click did not open the Markdown file');
  const id = (await snapshot()).id;
  assert.equal(await page.locator('.markedown-editor:visible').getAttribute('data-document-id'), id);
  await fileRow.click(); assert.equal((await snapshot()).id, id);
  checks.push('one trusted sidebar click opens a Chinese-path Markdown file; another click retains its document identity');
  await parkCursor(); await numbers(['(1)', '(2)', '(3)', '(4)']);
  const live = await geometry(page.locator('.markedown-editor:visible .math-block')); checkLayout(live);
  measurements.push({ surface: 'editor', items: live });
  assert.equal((await snapshot()).source, source);
  await capture('equations-default');
  checks.push('standalone single-dollar paragraphs, including two-space indentation, and adjacent dollar/bracket blocks are numbered; prose, headings, lists, quotes and tables stay inline');

  await toggleStandalone(false); await numbers(['(1)', '(2)']); assert.equal((await snapshot()).source, source);
  await toggleStandalone(true); await numbers(['(1)', '(2)', '(3)', '(4)']); assert.equal((await snapshot()).source, source);
  await page.getByTestId('mode-toggle').click(); await waitFor(async () => (await snapshot()).mode === 'source', 'Source mode did not activate');
  await editor().focus(); await page.keyboard.press('Control+End');
  await waitFor(async () => (await snapshot()).selection.head === source.length, 'End-of-document selection did not settle');
  await page.keyboard.press('Enter'); await page.keyboard.insertText('UNSAVED-ROUNDTRIP');
  const unsaved = source + '\nUNSAVED-ROUNDTRIP';
  await waitFor(async () => (await snapshot()).source === unsaved, 'Unsaved editor change was not synchronized');
  await page.getByTestId('mode-toggle').click(); await parkCursor(); await numbers(['(1)', '(2)', '(3)', '(4)']);
  await toggleStandalone(false); await toggleStandalone(true); assert.equal((await snapshot()).source, unsaved);
  await editor().focus(); await page.keyboard.press('Control+z'); await waitFor(async () => (await snapshot()).source === source, 'Mode or settings changes damaged undo history');
  await page.keyboard.press('Control+y'); await waitFor(async () => (await snapshot()).source === unsaved, 'Mode or settings changes damaged redo history');
  await parkCursor(); await numbers(['(1)', '(2)', '(3)', '(4)']);
  checks.push('preference off/on and source/live mode changes preserve Markdown and independent undo/redo');

  await page.evaluate(() => window.markedown.updateSettings({ theme: 'night' }));
  await native(window => window.setSize(700, 650));
  if (await page.getByTestId('sidebar').count()) await page.getByRole('button', { name: '\u6536\u8d77\u4fa7\u680f', exact: true }).click();
  await parkCursor(); await capture('equations-night-700');
  await native(window => window.setSize(1280, 1100));
  await page.evaluate(() => window.markedown.updateSettings({ theme: 'github', exportTheme: false, exportOutline: false }));
  await parkCursor();
  checks.push('dark theme and a 700 DIP window render the new formula blocks without viewport overflow');

  const html = await exportFile('html');
  const pending = app.waitForEvent('window'); pending.catch(() => {});
  const previewId = await app.evaluate(async ({ BrowserWindow }, filename) => {
    const preview = new BrowserWindow({ show: false, width: 1200, height: 1100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await preview.loadFile(filename); return preview.id;
  }, html);
  const preview = await pending;
  await preview.evaluate(() => document.fonts.ready);
  const rendered = await geometry(preview.locator('.math-block')); checkLayout(rendered);
  assert.equal(await preview.locator('.md-equation-inline-number').count(), 0);
  assert((await preview.locator('main').innerText()).includes('UNSAVED-ROUNDTRIP'));
  measurements.push({ surface: 'html', items: rendered });
  const previewCapture = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'), previewId);
  await writeFile(path.join(run, 'export-html.png'), Buffer.from(previewCapture, 'base64'));
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), previewId);
  await focus();

  const pdf = await exportFile('pdf'); assert.equal((await readFile(pdf)).toString('ascii', 0, 5), '%PDF-');
  assert((await readFile(pdf)).length > 1000, 'PDF output is empty');
  if (inspectPdf) {
    const extracted = process.env.PDFTOTEXT
    ? await execute(process.env.PDFTOTEXT, ['-enc', 'UTF-8', '-layout', pdf, '-'], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
    : await execute(process.env.MARKEDOWN_QA_PYTHON || 'python', ['-c', 'import sys; from pypdf import PdfReader; sys.stdout.reconfigure(encoding="utf-8"); print("\\n".join(page.extract_text() or "" for page in PdfReader(sys.argv[1]).pages))', pdf], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    for (const number of ['(1)', '(2)', '(3)', '(4)']) assert(extracted.stdout.includes(number), 'PDF is missing ' + number);
    assert(extracted.stdout.includes('UNSAVED-ROUNDTRIP'));
    await writeFile(path.join(run, 'pdf-text.txt'), extracted.stdout);
    await execute(process.env.PDFTOPPM || 'pdftoppm', ['-png', '-r', '100', pdf, path.join(run, 'pdf-page')], { windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    exports.pdf.pages = (await readdir(run)).filter(name => /^pdf-page-\d+\.png$/.test(name)).sort();
    assert(exports.pdf.pages.length > 0);
    exports.pdf.inspection = 'text and page rendering passed';
  } else exports.pdf.inspection = 'not requested; pass --inspect-pdf for text extraction and page rendering';
  const png = await exportFile('png'), bytes = await readFile(png), metadata = await sharp(bytes).metadata();
  assert(metadata.width > 0 && metadata.height > 0 && metadata.height <= 16384);
  assert((await sharp(bytes).stats()).channels.some(channel => channel.stdev > 5));
  exports.png.width = metadata.width; exports.png.height = metadata.height;
  checks.push('HTML retains all four numbers and current unsaved content; PDF header/size and long PNG pixel checks pass');
  if (inspectPdf) checks.push('PDF text contains all four numbers and current unsaved content; all PDF pages render for visual inspection');
  assert.equal(await readFile(filename, 'utf8'), source); assert.deepEqual(errors, []);
  const report = { status: 'passed', executable: executable || 'development Electron', run, checks, errors, measurements, exports };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, measurements: measurements.length }));
} catch (error) {
  await focus().catch(() => {}); await page.screenshot({ path: path.join(run, 'failure.png'), timeout: 5000 }).catch(() => {});
  const document = await snapshot().catch(() => null);
  await writeFile(path.join(run, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), run, checks, errors, measurements, exports, document }, null, 2));
  throw error;
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await app.close();
}
