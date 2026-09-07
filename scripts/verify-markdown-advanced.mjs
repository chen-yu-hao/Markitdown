import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

const evidence = path.resolve('test-results/markdown-advanced');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const input = path.join(run, '公式 空格.md');
const source = '# Markdown settings\n\nTwo  spaces\nand one line break.<br/>Next line.\n\nInline \\(x^2 + y^2\\).\n\n\\[\n\\dv{x}{t} = v\n\\]\n\n```math\n\\qty(\\frac{a}{b})^2\n```\n\n$$E=mc^2$$\n\nEnd.\n';
await writeFile(input, source);
const env = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data') };
delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
const app = await electron.launch({ ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]) } : {}), args: [...(process.argv[2] ? [] : [process.cwd()]), '--test-mode', input], env, timeout: 30000 });
const page = await app.firstWindow();
const checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const wait = async predicate => { const start = Date.now(); while (Date.now() - start < 12000) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Application did not settle'); };
const document = () => page.evaluate(async () => (await window.markedown.bootstrap()).documents.find(doc => doc.path));
const clipboardHtml = () => app.evaluate(async ({ clipboard }) => { const items = await clipboard.read(); for (const item of items) if (item.types.includes('text/html')) return (await item.getType('text/html')).text(); return ''; });
try {
  await page.locator('.cm-content:visible').waitFor();
  await page.evaluate(() => window.markedown.updateSettings({ language: 'zh-CN', autoSave: false, mathPhysics: true, mathNumbering: 'all', mathOutput: 'svg', firstLineIndent: true, codeLanguageTrigger: 'always', defaultCodeLanguage: 'javascript', codeIndentWidth: 4 }));
  await page.locator('.cm-content:visible').click(); await page.keyboard.press('Control+Home');
  await wait(() => page.locator('.md-rendered svg').count().then(n => n >= 3));
  assert.deepEqual(await page.locator('.md-equation-number').allTextContents(), ['(1)', '(2)', '(3)']);
  assert.equal(await page.locator('[data-mjx-error],.math-error').count(), 0);
  assert.equal((await document()).source, source, 'Changing settings rewrote the document');
  await page.screenshot({ path: path.join(evidence, 'live-math.png') });
  checks.push('LaTeX delimiters, physics, math fences and document-wide equation numbers in live editor');

  await page.keyboard.press('Control+,');
  await page.locator('.preferences-nav').getByRole('button', { name: 'Markdown', exact: true }).click();
  const code = page.locator('.pref-group').filter({ has: page.getByRole('heading', { name: '代码块', exact: true }) });
  await code.scrollIntoViewIfNeeded();
  assert.equal(await code.locator('input[type=number]').inputValue(), '4');
  assert.equal(await code.locator('input:not([type])').count() + await code.locator('input[type=text]').count() > 0, true);
  await page.screenshot({ path: path.join(evidence, 'code-preferences.png') });
  const math = page.locator('.pref-group').filter({ has: page.getByRole('heading', { name: /数学公式|^公式$/ }) });
  await math.scrollIntoViewIfNeeded();
  assert.equal(await math.getByRole('checkbox').count() >= 4, true);
  await page.screenshot({ path: path.join(evidence, 'math-preferences.png') });
  for (const size of [{ width: 900, height: 650 }, { width: 700, height: 480 }]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), size);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(evidence, `preferences-${size.width}.png`) });
  }
  await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 800));
  checks.push('Markdown preference controls at desktop and compact window sizes');

  await page.locator('.cm-content:visible').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n```'); await page.keyboard.press('Enter');
  await wait(async () => (await document()).source.includes('```javascript\n'));
  await page.keyboard.insertText('if (ready) {'); await page.keyboard.press('Enter');
  await wait(async () => (await document()).source.includes('if (ready) {\n    '));
  checks.push('new typed code fence uses default language and independent four-space code indentation');
  await page.keyboard.press('Control+a');
  await page.evaluate(() => window.markedown.updateSettings({ copyMarkdown: false, mathOutput: 'svg' }));
  await wait(() => page.evaluate(async () => !(await window.markedown.bootstrap()).settings.copyMarkdown));
  await page.keyboard.press('Control+c');
  await wait(async () => (await clipboardHtml()).includes('<svg'));
  const svgCopy = { html: await clipboardHtml(), text: await app.evaluate(({ clipboard }) => clipboard.readText()) };
  assert(svgCopy.text.includes('Markdown settings') && svgCopy.html.includes('<path'));
  await page.evaluate(() => window.markedown.updateSettings({ mathOutput: 'mathml' }));
  await wait(() => page.evaluate(async () => (await window.markedown.bootstrap()).settings.mathOutput === 'mathml'));
  await page.keyboard.press('Control+c');
  await wait(async () => (await clipboardHtml()).includes('<math'));
  checks.push('native clipboard contains path SVG or MathML according to the formula setting');

  await page.evaluate(() => window.markedown.updateSettings({ mathOutput: 'svg', exportWhitespace: 'preserve' }));
  const doc = await document();
  for (const format of ['html', 'htmlPlain', 'pdf', 'png']) {
    const destination = path.join(run, `formulas.${format === 'htmlPlain' ? 'plain.html' : format}`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    const result = await page.evaluate(({ doc, format }) => window.markedown.exportDocument(doc.id, { source: doc.source, mode: doc.mode, selection: doc.selection, scrollTop: doc.scrollTop, editVersion: doc.editVersion }, format), { doc, format });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    const contents = await readFile(destination);
    if (format === 'html' || format === 'htmlPlain') {
      const html = contents.toString('utf8');
      assert(html.includes('<svg') && html.includes('md-equation-number') && html.includes('if'));
      assert(!html.includes('data-mjx-error') && !html.includes('class="math-error"'));
      if (format === 'htmlPlain') assert(!html.includes('<style'));
    } else if (format === 'pdf') assert.equal(contents.toString('ascii', 0, 5), '%PDF-');
    else { const meta = await sharp(contents).metadata(); assert(meta.height > 100 && meta.width > 100); const stats = await sharp(contents).stats(); assert(stats.channels.some(channel => channel.stdev > 10)); }
  }
  checks.push('HTML, unstyled HTML, PDF and PNG exports retain current source, physics and equation numbers');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks, run }));
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'passed', checks, errors, run }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), checks, errors, run }, null, 2));
  throw error;
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await app.close();
}
