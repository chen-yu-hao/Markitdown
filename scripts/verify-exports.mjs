import { build } from 'esbuild';
import { mkdir, cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

const directory = path.resolve('.cache/export-qa');
await mkdir(directory, { recursive: true });
await build({ entryPoints: ['src/main/export-service.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: path.join(directory, 'export-service.cjs'), external: ['electron', 'sharp'] });
await cp('node_modules/katex/dist/katex.min.css', path.join(directory, 'katex.min.css'));
await cp('node_modules/katex/dist/fonts', path.join(directory, 'fonts'), { recursive: true });
await build({ stdin: { contents: `const { app, BrowserWindow } = require('electron'); globalThis.exportDocument = require('./export-service.cjs').exportDocument; app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))}); app.whenReady().then(() => new BrowserWindow({show:false,webPreferences:{sandbox:true}}).loadURL('data:text/html,<body>Export verification</body>'));`, resolveDir: directory, sourcefile: 'driver.js' }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'driver.cjs'), external: ['electron', './export-service.cjs'] });
const image = path.join(directory, 'local figure.png');
await sharp({ create: { width: 800, height: 300, channels: 3, background: '#248a70' } }).png().toFile(image);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ args: [path.join(directory, 'driver.cjs')], env: environment, timeout: 30_000 });
try {
  await application.firstWindow();
  const result = await application.evaluate(async ({ app, BrowserWindow }, { directory }) => {
    const { exportDocument } = globalThis;
    const settings = { theme: 'paper', language: 'en', fontSize: 17, readingWidth: 720, autoSave: true, reopenWorkspace: true, showToolbar: true, showStatusBar: true, pageSize: 'A4', exportOutline: true, htmlRemoteImages: false, pandocPath: '', recentWorkspaces: [] };
    const source = '# Export verification\n\nCurrent unsaved content.\n\n$x^2+\\frac{1}{2}$\n\n![Local figure](local%20figure.png)\n\n| Column | Value |\n|---|---|\n| First | 42 |\n\n```js\nconst current = true;\n```\n\n<script>throw new Error("must never execute")</script>\n\n' + 'Paragraph with multilingual text: 中文测试.\n\n'.repeat(120);
    const document = { id: 'export-check', path: directory + '/draft.md', title: 'Export verification', source, savedSource: '# Old content', dirty: true, recovered: false, bom: false, lineEnding: 'LF', revision: null, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 1 };
    for (const format of ['html', 'pdf', 'png']) await exportDocument(document, format, directory + '/verification.' + format, settings);
    await exportDocument(document, 'pdf', directory + '/letter.pdf', { ...settings, pageSize: 'Letter' });
    const long = { ...document, source: '# Scaled capture\n\n' + 'Long capture paragraph.\n\n'.repeat(800) };
    await exportDocument(long, 'png', directory + '/scaled.png', { ...settings, exportOutline: false });
    return { windowsRemaining: BrowserWindow.getAllWindows().length, version: app.getVersion() };
  }, { directory });
  if (result.windowsRemaining !== 1) throw new Error('An export rendering window leaked.');
  const png = await sharp(path.join(directory, 'verification.png')).metadata();
  const scaled = await sharp(path.join(directory, 'scaled.png')).metadata();
  if (!png.width || !png.height || png.width > 16384 || png.height > 16384 || png.width * png.height > 40_000_000) throw new Error('PNG dimensions are invalid.');
  if (scaled.height !== 16384) throw new Error('The long document was not scaled to the dimension limit.');
  const stats = await sharp(path.join(directory, 'verification.png')).stats();
  if (stats.channels.every(channel => channel.stdev < 1)) throw new Error('The PNG capture is blank.');
  const pdf = await readFile(path.join(directory, 'verification.pdf'));
  if (pdf.toString('ascii', 0, 5) !== '%PDF-') throw new Error('Invalid PDF file.');
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(new URL('file:///' + directory.replaceAll('\\', '/') + '/verification.html').href);
  await page.screenshot({ path: path.join(directory, 'html-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(directory, 'html-mobile.png') });
  console.log(JSON.stringify({ directory, pdfBytes: pdf.length, png: { width: png.width, height: png.height }, scaled: { width: scaled.width, height: scaled.height }, windowsRemaining: result.windowsRemaining }));
} finally {
  await application.close();
}
