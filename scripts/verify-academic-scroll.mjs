import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// Public fixtures run in CI; local manuscripts and cache entries stay inside
// ignored test-results. No manuscript content is included in the report.
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const documentArgument = option('--document'), cacheArgument = option('--cache');
const project = path.resolve(option('--project') || '.');
const executable = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : undefined;
const evidence = path.resolve('test-results/academic-scroll');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const data = path.join(run, 'data'), cache = path.join(data, 'references', 'zotero');
await mkdir(cache, { recursive: true });
const filename = path.join(run, 'scroll-document.md'), other = path.join(run, 'other.md');
const keys = Array.from({ length: 37 }, (_, i) => `TEST${String(i + 1).padStart(4, '0')}`);
const table = '| Functional | Variant | References |\n| --- | :---: | --- |\n' + Array.from({ length: 44 }, (_, i) => `| **Functional ${i + 1}** | $x_{${i + 1}}$ | [@${keys[i % keys.length]}] |`).join('\n');
const publicSource = '# Academic scrolling regression\n\nPublic synthetic references, tables and equations.\n\n' + table + '\n\n' + Array.from({ length: 7 }, (_, i) => `## Method ${i + 1}\n\n` + ('A paragraph with **bold text**, an [ordinary link](https://example.org/) and an inline equation $x+y=z$. '.repeat(3)) + `\n\n$$\nE_{${i + 1}}=\\sum_{j=1}^{n} x_j^2 \\tag{S${i + 1}}\n$$\n`).join('\n') + '\n| Result | Value |\n| --- | --- |\n| Sample A | 1.25 |\n| Sample B | 2.50 |\n\n<!-- markedown:bibliography -->\n';
const bytes = documentArgument ? await readFile(path.resolve(documentArgument)) : Buffer.from(publicSource);
const source = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
const required = [...new Set([...source.matchAll(/@([A-Z0-9]{8})/g)].map(match => match[1]))];
assert(required.length > 20, 'Fixture must contain a substantial bibliography');
if (documentArgument) {
  assert(cacheArgument, 'A private --document requires its --cache directory');
  for (const key of required) await copyFile(path.join(path.resolve(cacheArgument), `${key}.json`), path.join(cache, `${key}.json`));
} else {
  for (const [i, key] of keys.entries()) await writeFile(path.join(cache, `${key}.json`), JSON.stringify({ version: 1, key, bibliographic: true, csl: {
    id: key, type: 'article-journal', title: `Synthetic reference ${i + 1}: stable academic document layout with long bibliographic entries, tables, equations and repeated viewport changes`,
    author: [{ family: `Researcher ${i + 1}`, given: 'A.' }, { family: 'Example', given: 'B.' }], 'container-title': 'Public Test Journal', volume: '12', page: `${100 + i}-${110 + i}`, issued: { 'date-parts': [[2020 + i % 6]] },
  } }));
}
await writeFile(filename, bytes);
await writeFile(other, '# Other document\n\nIndependent tab.\n');
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ autoSave: false, saveOnSwitch: false, language: 'en', spellcheck: 'off', theme: 'github', zoom: 100, showToolbar: false }));
const env = { ...process.env, MARKEDOWN_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [...(executable ? [] : [project]), '--test-mode', '--force-device-scale-factor=1'], env, timeout: 30000 });
const child = app.process();
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1; }, 180000);
const errors = [], checks = [], motion = [];
let page, failure;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content:visible').waitFor();
  // Exercise real cached-reference resolution in this isolated app, without
  // consulting (or altering) any Zotero library running on the test machine.
  await app.evaluate(async () => {
    const http = process.getBuiltinModule('node:http');
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const originalGet = http.get;
    http.get = function (url, ...rest) {
      if (String(url).startsWith('http://127.0.0.1:23119/api/')) {
        const request = new EventEmitter(); request.destroy = () => {};
        queueMicrotask(() => request.emit('error', new Error('Offline regression fixture')));
        return request;
      }
      return originalGet.call(this, url, ...rest);
    };
  });
  const opened = await page.evaluate(filename => window.markedown.openFiles([filename]), filename);
  assert.equal(opened.status, 'ok');
  await page.getByTestId('document-tab').filter({ hasText: 'scroll-document.md' }).waitFor();
  const handle = await app.browserWindow(page);
  try { await handle.evaluate(window => { window.show(); window.focus(); }); } finally { await handle.dispose(); }
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus());
  await page.evaluate(() => document.fonts.ready);
  const original = (await page.evaluate(() => window.markedown.bootstrap())).documents.find(doc => doc.path === filename);
  assert(original);
  const state = async () => (await page.evaluate(() => window.markedown.bootstrap())).documents.find(doc => doc.id === original.id);
  const scroller = () => page.locator('.cm-scroller:visible');
  const geometry = () => scroller().evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight }));
  async function settle() { await page.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => requestAnimationFrame(resolve)); }); }
  async function waitFor(predicate, label) {
    const end = Date.now() + 10000;
    do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < end);
    throw new Error(label);
  }
  const resolved = await page.evaluate(source => window.markedown.references.resolve(source), source);
  assert.equal(resolved.entries.length, required.length);
  assert.equal(resolved.missing.length, 0);
  // App resolves asynchronously; verify that the actual editor displays it.
  await scroller().evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(count => document.querySelectorAll('.markedown-editor .csl-entry').length === count, required.length);
  await settle();
  checks.push('all cached references resolved and rendered in the full application');
  // Measure each block once before testing directional scrolling. First-time
  // CodeMirror estimates can legitimately change when a block is first seen.
  for (const fraction of [1, .75, .5, .25, 0]) {
    await scroller().evaluate((el, fraction) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction; }, fraction);
    await settle();
  }
  await page.locator('.markedown-editor:visible table').first().waitFor();
  await page.evaluate(() => { window.scrollRegressionTable = document.querySelector('.markedown-editor table'); });
  const box = await scroller().boundingBox();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .4);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 35); await settle(); }
  assert(await page.evaluate(() => window.scrollRegressionTable === document.querySelector('.markedown-editor table')), 'Scrolling rebuilt a visible table without a content/settings change');
  checks.push('small wheel movements reuse the visible table DOM');
  async function stationary(label) {
    await settle();
    const start = await geometry();
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 40));
      const current = await geometry();
      assert(Math.abs(start.top - current.top) < 3 && Math.abs(start.height - current.height) < 3, `${label}: stationary scroll geometry kept changing`);
    }
    return start;
  }
  for (let round = 0; round < 2; round++) {
    for (const direction of [1, -1]) {
      let reached = false;
      for (let step = 0; step < 120; step++) {
        const before = await geometry(), started = Date.now();
        await page.mouse.wheel(0, direction * 460); await settle();
        const after = await geometry();
        motion.push({ round, direction, step, elapsed: Date.now() - started, ...after });
        assert((after.top - before.top) * direction >= -3, 'Wheel movement jumped in the opposite direction');
        if (direction > 0 ? after.height - after.viewport - after.top < 3 : after.top < 3) { reached = true; break; }
      }
      assert(reached, `Could not scroll to the ${direction > 0 ? 'bottom' : 'top'}`);
      await stationary(`round ${round}, direction ${direction}`);
    }
  }
  checks.push('two full wheel roundtrips reach both ends without reverse jumps or stationary height churn');
  await scroller().evaluate(el => { el.scrollTop = 450; }); await settle();
  const savedPosition = (await stationary('before tab switch')).top;
  await waitFor(async () => Math.abs((await state()).scrollTop - savedPosition) < 3, 'Scroll position did not reach the main process');
  await page.evaluate(other => window.markedown.openFiles([other]), other);
  await page.getByTestId('document-tab').filter({ hasText: 'other.md' }).click(); await settle();
  await page.getByTestId('document-tab').filter({ hasText: 'scroll-document.md' }).click(); await settle();
  assert(Math.abs((await geometry()).top - savedPosition) < 3, 'Tab switch lost the latest scroll position');
  assert.equal((await state()).source, source);
  assert.equal((await state()).editVersion, original.editVersion);
  assert.equal((await state()).dirty, original.dirty);
  assert.deepEqual(await readFile(filename), bytes);
  if (documentArgument) assert.deepEqual(await readFile(path.resolve(documentArgument)), bytes, 'Original manuscript changed');
  assert.deepEqual(errors, []);
  checks.push('main-process position, tab switching and unchanged Markdown/dirty state');
  await page.screenshot({ path: path.join(run, 'editor.png') });
} catch (error) { failure = error; }
finally {
  const report = { status: failure ? 'failed' : 'passed', fixture: documentArgument ? 'private local copy' : 'public synthetic', references: required.length, checks, errors, motion, failure: failure?.message };
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, motion: `${motion.length} samples`, run }));
  await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill();
  clearTimeout(watchdog);
}
if (failure) throw failure;
