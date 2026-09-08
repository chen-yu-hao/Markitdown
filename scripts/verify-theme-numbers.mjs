import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

const executable = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const output = path.resolve('test-results/theme-numbers');
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'run-'));
const data = path.join(run, 'data'), filename = path.join(run, 'public-numbers.md');
await mkdir(data);
const source = [
  '# Heading 0123456789',
  'Paragraph 0123456789, **1234567890**, *2026-09-08*.',
  '| Digits | Value |\n| --- | --- |\n| 0123456789 | 123.45 |',
  '$$\n0123456789 + x_{123} + x^{456} = 0 \\tag{1234567890} \\label{eq:digits}\n$$',
  'See \\eqref{eq:digits}. Inline $x_1^2=123\\label{eq:inline}$ stays in this paragraph.',
  'Selection parking paragraph.',
].join('\n\n') + '\n';
await writeFile(filename, source);
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ autoSave: false, saveOnSwitch: false, language: 'zh-CN', spellcheck: 'off', theme: 'github', zoom: 100, mathNumbering: 'all', showToolbar: false, exportOutline: false }));
const env = { ...process.env, MARKEDOWN_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode', '--force-device-scale-factor=1', filename], env, timeout: 30000 });
const page = await app.firstWindow().catch(async error => { await app.close().catch(() => {}); throw error; });
page.setDefaultTimeout(20000);
const results = [], errors = [], exports = [];
page.on('pageerror', error => errors.push(error.message));
const settle = target => target.evaluate(async () => { await document.fonts.ready; for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); });
const current = async () => (await page.evaluate(() => window.markedown.bootstrap())).documents.find(document => document.path === filename);
async function styles(target, selectors) {
  const values = await target.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Missing numeric surface: ${selector}`);
    const style = getComputedStyle(node);
    return [name, { family: style.fontFamily, weight: style.fontWeight, numeric: style.fontVariantNumeric, text: node.textContent }];
  })), selectors);
  for (const [name, value] of Object.entries(values)) assert(value.numeric.includes('lining-nums'), `${name} lost lining digits: ${value.numeric}`);
  return values;
}
async function inkBounds(bytes) {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const digits = Array.from({ length: 10 }, (_, index) => {
    let top = info.height, bottom = -1;
    for (let y = 0; y < info.height; y++) for (let x = index * 64; x < (index + 1) * 64; x++) {
      const at = (y * info.width + x) * info.channels;
      if (data[at] < 160 && data[at + 1] < 160 && data[at + 2] < 160) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    assert(bottom > top, `Digit ${index} has no measurable ink`);
    return { digit: index, top, bottom };
  });
  const spread = key => Math.max(...digits.map(digit => digit[key])) - Math.min(...digits.map(digit => digit[key]));
  return { digits, topSpread: spread('top'), bottomSpread: spread('bottom') };
}
async function measureInheritedDigits() {
  // Enlarge inherited production typography for a measurable baseline, without setting its numeric variant.
  await page.evaluate(() => {
    const panel = document.createElement('section'); panel.id = 'qa-numbers';
    Object.assign(panel.style, { position: 'fixed', left: '10px', top: '100px', zIndex: '99999', width: '640px', height: '96px', padding: '0', margin: '0', overflow: 'hidden', background: '#fff', color: '#000', fontSize: '64px', lineHeight: '96px', letterSpacing: '0' });
    for (const digit of '0123456789') {
      const cell = document.createElement('span'); cell.textContent = digit;
      Object.assign(cell.style, { display: 'inline-block', width: '64px', height: '96px', textAlign: 'center', verticalAlign: 'top' }); panel.append(cell);
    }
    document.querySelector('.cm-editor').append(panel);
  });
  try {
    await settle(page);
    const panel = page.locator('#qa-numbers');
    const inherited = await panel.evaluate(element => ({ numeric: getComputedStyle(element).fontVariantNumeric, family: getComputedStyle(element).fontFamily }));
    assert(inherited.family.includes('Georgia'));
    assert(inherited.numeric.includes('lining-nums'));
    const production = await inkBounds(await panel.screenshot({ path: path.join(run, 'georgia-production.png') }));
    assert(production.topSpread <= 2 && production.bottomSpread <= 2, 'Production Georgia digits have uneven heights');
    await panel.evaluate(element => { element.style.fontVariantNumeric = 'normal'; });
    await settle(page);
    const oldStyle = await inkBounds(await panel.screenshot({ path: path.join(run, 'georgia-old-style.png') }));
    return { inherited, production, oldStyle };
  } finally { await page.evaluate(() => document.querySelector('#qa-numbers')?.remove()); }
}
async function exportFile(format) {
  const doc = await current(), destination = path.join(run, `newsprint.${format}`);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
  const result = await page.evaluate(({ doc, format }) => window.markedown.exportDocument(doc.id, { source: doc.source, mode: doc.mode, selection: doc.selection, scrollTop: doc.scrollTop, editVersion: doc.editVersion }, format), { doc, format });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return destination;
}
try {
  await page.locator('.cm-content:visible').waitFor();
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1280, 1000); window.show(); window.focus(); });
  await page.bringToFront();
  const sidebar = page.getByRole('button', { name: '\u6536\u8d77\u4fa7\u680f', exact: true });
  if (await sidebar.count()) await sidebar.click();
  await page.locator('.cm-content:visible').focus(); await page.keyboard.press('Control+End');
  await page.locator('.citation-startup-credit').waitFor({ state: 'detached', timeout: 20000 });
  for (const theme of ['github', 'newsprint', 'night', 'pixyll', 'whitey']) {
    await page.evaluate(theme => window.markedown.updateSettings({ theme }), theme);
    await settle(page);
    await page.locator('.cm-scroller:visible').evaluate(element => { element.scrollTop = 0; }); await settle(page);
    const computed = await styles(page, { body: '.cm-content', heading: '.md-heading-1', table: '.md-rendered td', number: '.md-equation-number', reference: '.md-equation-reference', inlineNumber: '.md-equation-inline-number' });
    await page.screenshot({ path: path.join(run, `theme-${theme}.png`) });
    const record = { theme, computed }; results.push(record);
    if (theme === 'newsprint') {
      record.ink = await measureInheritedDigits();
      const math = page.locator('.math-block .katex-html').first();
      const before = await math.screenshot({ path: path.join(run, 'math-production.png') });
      await math.evaluate(element => { element.style.fontVariantNumeric = 'normal'; }); await settle(page);
      const normal = await math.screenshot({ path: path.join(run, 'math-normal.png') });
      await math.evaluate(element => { element.style.removeProperty('font-variant-numeric'); });
      record.mathPixelIdentical = (await sharp(before).raw().toBuffer()).equals(await sharp(normal).raw().toBuffer());
      assert(record.mathPixelIdentical, 'Numeric typography changed KaTeX contents including sub/superscripts');
    }
    assert.equal((await current()).source, source);
  }
  await page.evaluate(() => window.markedown.updateSettings({ theme: 'newsprint' })); await settle(page);
  for (const format of ['html', 'pdf', 'png']) {
    const destination = await exportFile(format), bytes = await readFile(destination);
    const record = { format, destination, bytes: bytes.length }; exports.push(record);
    if (format === 'html') {
      const pending = app.waitForEvent('window');
      const id = await app.evaluate(async ({ BrowserWindow }, filename) => {
        const window = new BrowserWindow({ show: false, width: 1100, height: 1100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        await window.loadFile(filename); return window.id;
      }, destination);
      try {
        const exported = await pending; await settle(exported);
        record.styles = await styles(exported, { body: '.markdown-body', heading: 'h1', table: 'td', number: '.md-equation-number', reference: '.md-equation-reference', inlineNumber: '.md-equation-inline-number' });
        assert(record.styles.body.family.includes('Georgia'));
        const capture = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'), id);
        await writeFile(path.join(run, 'newsprint-html.png'), Buffer.from(capture, 'base64'));
      } finally { await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id); }
    } else if (format === 'pdf') assert.equal(bytes.toString('ascii', 0, 5), '%PDF-');
    else {
      const metadata = await sharp(bytes).metadata(); record.width = metadata.width; record.height = metadata.height;
      assert(metadata.width > 0 && metadata.height > 0 && metadata.height <= 16384);
      assert((await sharp(bytes).stats()).channels.some(channel => channel.stdev > 10), 'Exported PNG is blank');
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 850)); await settle(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.join(run, 'newsprint-narrow.png') });
  assert.equal((await current()).source, source); assert.equal((await current()).dirty, false);
  assert.equal(await readFile(filename, 'utf8'), source); assert.deepEqual(errors, []);
  await writeFile(path.join(run, 'results.json'), JSON.stringify({ status: 'passed', executable: executable || 'development Electron', run, results, exports, errors, pdfInspection: 'Header verified; page rendering is a separate local visual check.' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', run, themes: results.length, exports: exports.map(item => item.format), errors }));
} catch (error) {
  await page.screenshot({ path: path.join(run, 'failure.png'), timeout: 5000 }).catch(() => {});
  await writeFile(path.join(run, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), run, results, exports, errors }, null, 2)); throw error;
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await app.close();
}
