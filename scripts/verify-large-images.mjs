import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

const evidence = path.resolve('test-results/large-images');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const input = path.join(run, '\u5927\u56fe \u7c98\u8d34.md');
const source = 'BEFOREAFTER\n\nSaved document.\n';
await writeFile(input, source);
const dimensions = { width: 10000, height: 8001 };
const fixturePath = path.join(run, 'large-paste.png');
const quadrant = async (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
await sharp({ create: { ...dimensions, channels: 3, background: '#eff2f7' } })
  .composite([
    { input: await quadrant(5000, 4000, '#d44f59'), top: 0, left: 0 },
    { input: await quadrant(5000, 4000, '#37a17c'), top: 0, left: 5000 },
    { input: await quadrant(5000, 4001, '#4b79c6'), top: 4000, left: 0 },
  ]).png().toFile(fixturePath);
const fixture = await readFile(fixturePath);
const pixelsHash = async filename => {
  const hash = createHash('sha256');
  for await (const chunk of sharp(filename, { limitInputPixels: 256_000_000 }).removeAlpha().raw()) hash.update(chunk);
  return hash.digest('hex');
};
const originalPixels = await pixelsHash(fixturePath);
const env = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MARKEDOWN_DEV_URL;
const app = await electron.launch({ ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]) } : {}), args: [...(process.argv[2] ? [] : [process.cwd()]), '--test-mode', input], env, timeout: 30000 });
const page = await app.firstWindow();
const checks = [], errors = [], timing = {}, imageResponses = [];
let clipboardBackedUp = false;
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.url().startsWith('markedown-image:')) imageResponses.push({ status: response.status(), url: response.url() }); });
page.on('requestfailed', request => { if (request.url().startsWith('markedown-image:')) imageResponses.push({ failure: request.failure(), url: request.url() }); });
const document = () => page.evaluate(async () => (await window.markedown.bootstrap()).documents.find(doc => doc.path));
const wait = async (predicate, message, timeout = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};
async function restoreClipboard() {
  if (!clipboardBackedUp) return;
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    const snapshot = globalThis.markedownLargeImageClipboardBackup;
    if (snapshot.length) await clipboard.write(snapshot.map(formats => new ClipboardItem(formats)));
    else clipboard.clear();
    delete globalThis.markedownLargeImageClipboardBackup;
  });
  clipboardBackedUp = false;
}

try {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.show(); window.focus(); window.webContents.focus();
  });
  await page.bringToFront();
  await page.locator('.cm-content:visible').waitFor();
  await page.evaluate(() => window.markedown.updateSettings({ language: 'zh-CN', theme: 'github', autoSave: false, saveOnSwitch: false, imageThumbnails: true }));
  await page.locator('.cm-content:visible').focus();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await wait(async () => (await document()).selection.head === 6, 'The real editor caret did not reach the intended insertion point');
  await page.evaluate(() => {
    window.markedownLargeImagePaste = [];
    document.addEventListener('paste', event => {
      const entry = { trusted: event.isTrusted, files: [] };
      window.markedownLargeImagePaste.push(entry);
      for (const file of event.clipboardData?.files || []) {
        const info = { type: file.type, size: file.size, name: file.name };
        entry.files.push(info);
        void file.slice(0, 16).arrayBuffer().then(bytes => { info.header = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); });
      }
    }, { capture: true });
  });
  // Materialize every available format before replacing the native clipboard.
  await app.evaluate(async ({ clipboard }) => {
    const snapshot = [];
    for (const item of await clipboard.read()) {
      const formats = {};
      for (const type of item.types) {
        const data = await item.getType(type);
        formats[type] = data instanceof Blob ? new Blob([await data.arrayBuffer()], { type: data.type }) : data;
      }
      snapshot.push(formats);
    }
    globalThis.markedownLargeImageClipboardBackup = snapshot;
  });
  clipboardBackedUp = true;
  let inserted;
  try {
    await app.evaluate(async ({ clipboard, ClipboardItem }, data) => {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(data, 'base64')], { type: 'image/png' }) })]);
      const started = Date.now();
      while (Date.now() - started < 10000) {
        const item = (await clipboard.read()).find(item => item.types.includes('image/png'));
        if (item) {
          const bytes = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
          if (bytes.length && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
            globalThis.markedownLargeImageClipboardReady = { bytes: bytes.length, header: bytes.subarray(0, 16).toString('hex') };
            return;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('The native clipboard did not expose the generated PNG after writing it');
    }, fixture.toString('base64'));
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.focus(); window.webContents.focus(); });
    await page.bringToFront();
    const started = performance.now();
    await page.keyboard.press('Control+v');
    await wait(async () => {
      if ((await document()).source.includes('![](<assets/')) return true;
      const messages = await page.locator('[role=alert]').allTextContents();
      if (messages.length) throw new Error('Native large-image paste failed: ' + messages.join('; '));
      return false;
    }, 'Native large-image paste did not produce an insertion');
    timing.nativePasteMilliseconds = Math.round(performance.now() - started);
    inserted = await document();
    const pastes = await page.evaluate(() => window.markedownLargeImagePaste);
    assert(pastes.some(event => event.trusted && event.files.some(file => file.type === 'image/png')), 'The editor never received a trusted native image paste event');
  } catch (error) {
    await app.evaluate(async ({ clipboard }) => {
      const item = (await clipboard.read()).find(item => item.types.includes('image/png'));
      if (item) {
        const bytes = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
        globalThis.markedownLargeImageClipboardAfterFailure = { bytes: bytes.length, header: bytes.subarray(0, 16).toString('hex') };
      }
    });
    throw error;
  } finally {
    await restoreClipboard();
  }
  assert.match(inserted.source, /^BEFORE\n!\[\]\(<assets\/[^>]+>\)\nAFTER\n\nSaved document\.\n$/);
  assert.equal(inserted.dirty, true);
  assert.equal(await readFile(input, 'utf8'), source, 'Pasting changed the saved Markdown without an explicit save');
  checks.push('trusted native Ctrl+V of an 80,010,000-pixel PNG at the real mid-line caret; native clipboard restored');
  const destination = /!\[\]\(<([^>]+)>\)/.exec(inserted.source)[1];
  const asset = path.resolve(run, decodeURIComponent(destination));
  const metadata = await sharp(asset).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, dimensions);
  assert.equal(await pixelsHash(asset), originalPixels, 'Imported image pixels differ from the native clipboard fixture');
  checks.push('asset retains all 10000 x 8001 source pixels without resizing');

  await page.keyboard.press('Control+End');
  const preview = page.locator('.cm-content:visible .md-rendered img').first();
  await preview.scrollIntoViewIfNeeded();
  await wait(() => preview.evaluateAll(images => images.some(image => image.complete && image.naturalWidth > 0)), 'Large image preview remained blank');
  const previewSize = await preview.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert(previewSize.width <= 2048 && previewSize.height <= 2048);
  await preview.scrollIntoViewIfNeeded();
  const previewScreenshot = await preview.screenshot({ path: path.join(run, 'preview-pixels.png') });
  const previewStats = await sharp(previewScreenshot).stats();
  assert(previewStats.channels.slice(0, 3).every(channel => channel.stdev > 20), 'Thumbnail pixels are blank or uniform');
  await page.screenshot({ path: path.join(run, 'native-paste-preview.png') });
  checks.push('live editor loads a nonblank cached preview bounded to 2048 pixels');

  await page.keyboard.press('Control+z');
  await wait(async () => (await document()).source === source, 'One undo did not remove the whole image insertion');
  await page.keyboard.press('Control+y');
  await wait(async () => (await document()).source === inserted.source, 'One redo did not restore the whole image insertion');
  checks.push('image paste is one undo/redo step');
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nUNSAVED-LARGE-IMAGE-EXPORT\n');
  await wait(async () => (await document()).source.includes('UNSAVED-LARGE-IMAGE-EXPORT'), 'Unsaved export text did not reach the document snapshot');
  const doc = await document();
  const exportPath = path.join(run, 'large-image.html');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  const result = await page.evaluate(doc => window.markedown.exportDocument(doc.id, { source: doc.source, mode: doc.mode, selection: doc.selection, scrollTop: doc.scrollTop, editVersion: doc.editVersion }, 'html'), doc);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  const html = await readFile(exportPath, 'utf8');
  assert(html.includes('UNSAVED-LARGE-IMAGE-EXPORT'));
  const exportedImage = await page.evaluate(html => new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src'), html);
  assert(exportedImage?.startsWith('data:image/png;base64,'));
  const exportedBytes = Buffer.from(exportedImage.slice('data:image/png;base64,'.length), 'base64');
  assert(exportedBytes.equals(await readFile(asset)), 'HTML export changed the original PNG or embedded the cached preview');
  const exportMetadata = await sharp(exportedBytes).metadata();
  assert.deepEqual({ width: exportMetadata.width, height: exportMetadata.height }, dimensions);
  assert.equal(await readFile(input, 'utf8'), source);
  checks.push('HTML export uses current unsaved source and embeds the exact full-resolution PNG');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 480));
  await page.keyboard.press('Control+,');
  await page.locator('.preferences-nav').getByRole('button', { name: '\u56fe\u50cf', exact: true }).click();
  const limits = page.locator('.pref-hint').filter({ hasText: '2.56' });
  await limits.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.equal(await limits.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
  await page.screenshot({ path: path.join(run, 'image-preferences-700x480.png') });
  await page.keyboard.press('Escape');
  checks.push('image limits wrap within compact 700 x 480 preferences');
  assert.deepEqual(errors, []);
  const pastes = await page.evaluate(() => window.markedownLargeImagePaste);
  const nativeClipboard = await app.evaluate(() => globalThis.markedownLargeImageClipboardReady);
  const report = { status: 'passed', executable: process.argv[2] ? path.resolve(process.argv[2]) : 'development Electron', dimensions, fixtureBytes: fixture.length, nativeClipboard, pastes, previewSize, checks, timing, imageResponses, errors, run };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  const pastes = await page.evaluate(() => window.markedownLargeImagePaste).catch(() => undefined);
  const nativeClipboard = await app.evaluate(() => globalThis.markedownLargeImageClipboardReady).catch(() => undefined);
  const nativeClipboardAfterFailure = await app.evaluate(() => globalThis.markedownLargeImageClipboardAfterFailure).catch(() => undefined);
  const previewState = await page.locator('.cm-content:visible .md-rendered img').evaluateAll(images => images.map(image => ({ src: image.currentSrc || image.src, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, bounds: image.getBoundingClientRect().toJSON() }))).catch(() => undefined);
  const report = { status: 'failed', error: String(error), fixtureBytes: fixture.length, nativeClipboard, nativeClipboardAfterFailure, pastes, previewState, checks, imageResponses, errors, run };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await restoreClipboard();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await app.close();
}
