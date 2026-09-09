import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

// Runs the actual packaged ASAR and native modules, with isolated settings and recovery.
// Device-scale flags affect this application only; Windows display settings are untouched.
const executablePath = path.resolve(process.argv[2] || 'release/win-unpacked/Markedown.exe');
await stat(executablePath);
const evidence = path.resolve('test-results');
await mkdir(evidence, { recursive: true });
const cache = path.resolve('.cache/packaged-qa');
await mkdir(cache, { recursive: true });
const run = await mkdtemp(path.join(cache, 'run-'));
const fixture = path.join(run, '中文 文件.md');
const imagePath = path.join(run, 'local image.png');
const source = '# Markedown Windows\n\n中文输入与 Windows 显示缩放。\n\n**Bold** and ==highlighted==, H<sub>2</sub>O.\n\n| Item | Result |\n| --- | --- |\n| Packaged app | Ready |\n\n$$\nx^2 + \\frac{1}{2}\n$$\n\n```js\nconst packaged = true;\n```\n\n![Local image](local%20image.png)\n\nLast paragraph.\n';
await writeFile(fixture, source);
await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#24967b' } }).png().toFile(imagePath);
const checks = [];
const scales = [];
for (const scale of [1, 1.25, 1.5, 2]) {
  const environment = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data-' + scale) };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.MARKEDOWN_DEV_URL;
  const application = await electron.launch({ executablePath, args: ['--test-mode', '--force-device-scale-factor=' + scale, fixture], env: environment, timeout: 30000 });
  let page;
  const errors = [];
  try {
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByTestId('app').waitFor();
    await page.getByTestId('document-tab').filter({ hasText: path.basename(fixture) }).click();
    await page.evaluate(() => window.markedown.updateSettings({ language: 'zh-CN', theme: 'paper', autoSave: false }));
    await page.locator('.cm-content:visible').waitFor();
    const runtime = await application.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().length }));
    assert(runtime.packaged && runtime.appPath.endsWith('app.asar'), 'Verification did not launch the packaged ASAR.');
    assert.equal(path.resolve(runtime.userData), path.resolve(environment.MARKEDOWN_DATA_DIR), 'Packaged verification is not isolated.');
    await page.locator('.cm-content:visible').click();
    await page.locator('.cm-content:visible').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\nUNSAVED-PACKAGED-EXPORT');
    await page.waitForFunction(() => window.markedown.bootstrap().then(data => data.documents.some(document => document.path === undefined || document.source.includes('UNSAVED-PACKAGED-EXPORT'))));
    await page.keyboard.press('Control+Home');
    await page.waitForFunction(() => [...document.querySelectorAll('.md-rendered img')].some(img => img.complete && img.naturalWidth === 2048));
    const dpr = await page.evaluate(() => devicePixelRatio);
    assert(Math.abs(dpr - scale) < 0.01, 'The requested application scale was not applied.');
    for (const [name, width, height] of [['desktop', 1180, 800], ['compact', 900, 650]]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height });
      await page.waitForTimeout(120);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Horizontal document overflow at ' + scale + '/' + name);
      const screenshot = path.join(evidence, `packaged-scale-${scale}-${name}.png`);
      await page.screenshot({ path: screenshot });
      const statistics = await sharp(screenshot).stats();
      assert(statistics.channels.some(channel => channel.stdev > 10), 'The packaged screenshot is blank.');
    }
    if (scale === 1) {
      const doc = await page.evaluate(async () => (await window.markedown.bootstrap()).documents.find(doc => doc.path));
      assert(doc.source.includes('UNSAVED-PACKAGED-EXPORT') && doc.dirty, 'The packaged editor did not retain unsaved input.');
      const bytes = [...await readFile(imagePath)];
      const imported = await page.evaluate(({ id, bytes }) => window.markedown.importImages(id, [{ name: '中文 image.png', bytes: new Uint8Array(bytes) }]), { id: doc.id, bytes });
      assert.equal(imported.status, 'ok', 'Packaged native Sharp image import failed: ' + JSON.stringify(imported));
      assert.equal(imported.value.length, 1);
      // The renderer intentionally forbids fetch(); verify the same image path used by the editor.
      const loaded = await page.evaluate(({ id, destination }) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error('Imported local image could not be displayed'));
        image.src = window.markedown.imageURL(id, destination);
      }), { id: doc.id, destination: imported.value[0] });
      assert.equal(loaded.width, 2048, 'Packaged image protocol did not return the expected thumbnail.');
      assert(loaded.height > 0);
      for (const format of ['html', 'pdf', 'png']) {
        const destination = path.join(run, 'packaged-export.' + format);
        await application.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, destination);
        const result = await page.evaluate(({ doc, format }) => window.markedown.exportDocument(doc.id, { source: doc.source, mode: doc.mode, selection: doc.selection, scrollTop: doc.scrollTop, editVersion: doc.editVersion }, format), { doc, format });
        assert.equal(result.status, 'ok', 'Packaged export failed: ' + JSON.stringify(result));
        const contents = await readFile(destination);
        if (format === 'html') {
          const html = contents.toString('utf8');
          assert(html.includes('UNSAVED-PACKAGED-EXPORT') && html.includes('data:image/png;base64,') && html.includes('katex'), 'Packaged HTML lost current content, local image or formula.');
        } else if (format === 'pdf') assert.equal(contents.toString('ascii', 0, 5), '%PDF-');
        else {
          const png = await sharp(contents).metadata();
          assert(png.width > 0 && png.height > 0 && png.height <= 16384 && png.width * png.height <= 40_000_000);
        }
      }
      assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), runtime.windows, 'An export window leaked.');
      checks.push('actual packaged ASAR launch', 'isolated user data', 'native Sharp image import', 'local image protocol and thumbnail', 'HTML/PDF/PNG export with current unsaved content', 'export window cleanup');
    }
    assert.deepEqual(errors, [], 'Packaged renderer reported errors.');
    scales.push({ requested: scale, actual: dpr, sizes: ['1180×800', '900×650'], errors });
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(evidence, 'packaged-failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => undefined);
    await application.close();
  }
}
checks.push('application display scales 100/125/150/200 percent', 'desktop/compact screenshots without blank output or horizontal overflow');
const report = { executablePath, run, checks, scales, completed: new Date().toISOString() };
await writeFile(path.join(evidence, 'packaged-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
