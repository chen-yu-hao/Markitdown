import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

const evidence = path.resolve('test-results/image-width');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const data = path.join(run, 'data');
await mkdir(data);
const filename = path.join(run, 'long-figure.md');
const source = '# Long scientific figure\n\n![Long figure](long-figure.png)\n\nEnd of figure.\n';
await writeFile(filename, source);
await sharp({ create: { width: 1200, height: 6000, channels: 3, background: '#b8d3df' } }).png().toFile(path.join(run, 'long-figure.png'));
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', autoSave: false, showActiveBlockSource: false, imageThumbnails: true, readingWidth: 780 }));
const env = { ...process.env, MARKEDOWN_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MARKEDOWN_DEV_URL;
const executable = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode', '--force-device-scale-factor=1', filename], env, timeout: 30000 });
const errors = [], checks = [];
let failure;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content:visible').waitFor();
  const image = page.locator('.cm-content:visible .md-rendered img');
  await image.waitFor();
  await page.waitForFunction(() => [...document.images].some(image => image.src.startsWith('markedown-image:') && image.complete && image.naturalWidth > 0));
  const win = await app.browserWindow(page);
  try {
    for (const width of [1280, 760]) {
      await win.evaluate((window, width) => window.setSize(width, 800), width);
      await page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame); });
      const size = await image.evaluate(image => {
        const rect = image.getBoundingClientRect();
        const content = image.closest('.cm-content');
        const style = getComputedStyle(content);
        return { width: rect.width, height: rect.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, column: content.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      });
      assert.equal(size.naturalWidth, 1200, 'The preview was narrowed to fit a height cap');
      assert.equal(size.naturalHeight, 6000);
      assert(Math.abs(size.width - size.column) < 4, `Long image does not fit the ${width}px window column: ${JSON.stringify(size)}`);
      assert(Math.abs(size.height / size.width - 5) < 0.01, 'Long image aspect ratio changed');
      assert(size.height > 600, 'A legacy display height cap is still active');
      checks.push(`width-based long image at ${width}px window width, aspect ratio preserved`);
    }
  } finally { await win.dispose(); }
  const scroller = page.locator('.cm-scroller:visible');
  for (const fraction of [0.2, 0.4, 0.6, 0.8, 1, 0.8, 0.6, 0.4, 0.2, 0]) {
    await scroller.evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction; }, fraction);
    await page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
    const offset = await scroller.evaluate(element => element.scrollTop);
    assert(Number.isFinite(offset));
  }
  checks.push('scrolling the full height of a long image in both directions remains responsive');
  assert.equal(await readFile(filename, 'utf8'), source);
  assert.equal(errors.length, 0, errors.join('\n'));
  await page.screenshot({ path: path.join(run, 'long-figure-width.png') });
} catch (error) { failure = error; }
finally { await app.close(); }
await writeFile(path.join(run, 'report.json'), JSON.stringify({ passed: !failure, checks, errors, failure: failure?.stack }, null, 2));
if (failure) throw failure;
console.log(JSON.stringify({ checks, evidence: run }, null, 2));
