import { build } from 'esbuild';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const directory = path.resolve('.cache/main-qa');
await mkdir(directory, { recursive: true });
const run = await mkdtemp(path.join(directory, 'run-'));
const entry = path.join(directory, 'main', 'index.cjs');
await build({ entryPoints: ['src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: entry, external: ['electron', 'sharp'] });
await build({ entryPoints: ['src/main/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: path.join(directory, 'main', 'preload.cjs'), external: ['electron'] });
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><p>Markedown main-process verification</p><script>window.qaEvents=[];window.markedown.onEvent(event=>window.qaEvents.push(event));window.markedown.bootstrap().then(bootstrap=>window.qaBootstrap=bootstrap);</script></body></html>');
const realDocument = path.join(run, 'image-test.md');
const oversized = path.join(run, 'oversized.png');
await writeFile(realDocument, '# Image test\n');
const handle = await open(oversized, 'w');
try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
const environment = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data'), MARKEDOWN_DEV_URL: pathToFileURL(path.join(directory, 'index.html')).href };
delete environment.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ args: [entry, '--test-mode', path.join(run, 'missing-startup.md')], env: environment, timeout: 30000 });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  const page = await application.firstWindow();
  await page.waitForFunction(() => window.qaBootstrap);
  const bootstrap = await page.evaluate(() => window.qaBootstrap);
  assert(bootstrap.documents.length === 1, 'A fresh startup did not create one document.');
  assert(bootstrap.recoveryErrors.some(error => error.includes('missing-startup.md')), 'Startup file errors were lost before renderer bootstrap.');
  const first = bootstrap.documents[0].id;
  const second = await page.evaluate(async id => {
    const patch = source => ({ source, mode:'live', selection:{anchor:0,head:0}, scrollTop:0,editVersion:1 });
    await window.markedown.updateDocument(id,patch('First unsaved document'));
    const second = await window.markedown.newDocument();
    await window.markedown.updateDocument(second.id,patch('Second unsaved document'));
    return second.id;
  }, first);
  await application.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.dialogCalls = 0;
    const decisions = [1, 2];
    dialog.showMessageBox = async () => { globalThis.dialogCalls++; return { response:decisions.shift() ?? 2, checkboxChecked:false }; };
    BrowserWindow.getAllWindows()[0].close();
  });
  await page.evaluate(async () => { if ((await window.markedown.bootstrap()).documents.length !== 2) throw new Error('Close cancellation removed documents.'); });
  assert(await application.evaluate(() => globalThis.dialogCalls) === 2, 'Native close did not preflight both documents.');
  let remaining = await page.evaluate(() => window.markedown.bootstrap());
  assert(remaining.documents.some(doc => doc.id === first && doc.source === 'First unsaved document') && remaining.documents.some(doc => doc.id === second), 'Cancelling a later close deleted earlier documents.');

  await application.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.dialogCalls = 0;
    dialog.showMessageBox = () => { globalThis.dialogCalls++; return new Promise(resolve => { globalThis.answerClose = resolve; }); };
    const window = BrowserWindow.getAllWindows()[0];
    window.close();
    window.close();
  });
  assert(await application.evaluate(() => globalThis.dialogCalls) === 1, 'Repeated native close opened concurrent dialogs.');
  await application.evaluate(() => globalThis.answerClose({ response:2,checkboxChecked:false }));
  remaining = await page.evaluate(() => window.markedown.bootstrap());
  assert(remaining.documents.length === 2, 'Cancelling repeated close removed documents.');

  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response:1, checkboxChecked:false }); });
  const singleClose = await page.evaluate(id => window.markedown.closeDocument(id), first);
  assert(singleClose.status === 'ok', 'Single-tab close failed.');
  remaining = await page.evaluate(() => window.markedown.bootstrap());
  assert(remaining.documents.length === 1 && remaining.documents[0].id === second, 'Single-tab close removed another document.');

  const opened = await page.evaluate(filename => window.markedown.openFiles([filename]), realDocument);
  assert(opened.status === 'ok', 'Could not open image import fixture.');
  const imageId = opened.value[0].id;
  await application.evaluate(({ dialog }, oversized) => { dialog.showOpenDialog = async () => ({ canceled:false,filePaths:[oversized] }); }, oversized);
  const tooLarge = await page.evaluate(id => window.markedown.importImages(id), imageId);
  assert(tooLarge.status === 'error' && tooLarge.message.includes('64 MiB'), 'The file picker did not reject oversized images before import.');
  await application.evaluate(({ dialog }, oversized) => { dialog.showOpenDialog = async () => ({ canceled:false,filePaths:Array(101).fill(oversized) }); }, oversized);
  const tooMany = await page.evaluate(id => window.markedown.importImages(id), imageId);
  assert(tooMany.status === 'error' && tooMany.message.includes('100'), 'The file picker did not cap image count.');
  const ipcTooMany = await page.evaluate(id => window.markedown.importImages(id,Array.from({length:101},()=>({name:'test.png',bytes:new Uint8Array([0])}))), imageId);
  assert(ipcTooMany.status === 'error' && ipcTooMany.message.includes('100'), 'The IPC boundary did not cap image count.');

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
  await writeFile(realDocument, '# Other text\n');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await page.waitForFunction(id => window.qaEvents.some(event => event.type === 'document' && event.document.id === id && event.document.source === '# Other text\n'), imageId, { polling: 100 }).catch(async error => {
    console.error(JSON.stringify(await page.evaluate(async id => ({ document: (await window.markedown.bootstrap()).documents.find(doc => doc.id === id), events: window.qaEvents.filter(event => event.type === 'document' && event.document.id === id) }), imageId), null, 2));
    throw error;
  });
  assert(await page.evaluate(async id => (await window.markedown.bootstrap()).documents.find(doc => doc.id === id)?.source === '# Other text\n', imageId), 'The main process did not retain the external reload.');
  console.log(JSON.stringify({ directory, checks:['startup error delivery','atomic close preflight','close cancellation preserves all tabs','duplicate native close guard','single-tab close','image picker size/count limits','image IPC count limit','external reload on focus'] }));
} finally {
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response:1,checkboxChecked:false }); }).catch(() => undefined);
  await application.close();
}
