import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const directory = path.resolve('.cache/document-transfer-qa');
await mkdir(directory, { recursive: true });
const run = await mkdtemp(path.join(directory, 'run-'));
const entry = path.join(directory, 'main', 'index.cjs');
await build({ entryPoints: ['src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: entry, external: ['electron', 'sharp'] });
await build({ entryPoints: ['src/main/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: path.join(directory, 'main', 'preload.cjs'), external: ['electron'] });
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><p>Document transfer verification</p><script>window.qaEvents=[];window.markedown.onEvent(event=>window.qaEvents.push(event));window.markedown.bootstrap().then(value=>window.qaBootstrap=value);</script></body></html>');
const filename = path.join(run, '\u4e2d\u6587 document.md');
const original = Buffer.from('\ufeff# Original\r\n');
await writeFile(filename, original);
const rendererUrl = pathToFileURL(path.join(directory, 'index.html')).href;
const environment = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data'), MARKEDOWN_DEV_URL: rendererUrl };
delete environment.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ args: [entry, '--test-mode'], env: environment, timeout: 30000 });
const patch = (source, editVersion = 1, extra = {}) => ({ source, editVersion, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, ...extra });
const state = value => ({ doc: value.source, selection: { ranges: [value.selection], main: 0 }, history: { done: [{ changes: [[0, 'retained undo']] }], undone: [] } });
const windowId = async page => (await application.browserWindow(page)).evaluate(win => win.id);
const bootstrap = page => page.evaluate(() => window.markedown.bootstrap());
async function startTransfer(page, id, value, position) {
  const created = application.waitForEvent('window', { timeout: 15000 });
  await page.evaluate(({ id, value, editorState, position }) => {
    window.qaTransferResult = null;
    window.qaTransferPromise = window.markedown.detachDocument(id, value, editorState, position).then(result => { window.qaTransferResult = result; return result; });
  }, { id, value, editorState: state(value), position });
  const target = await created;
  await target.waitForFunction(() => window.qaBootstrap?.transfer);
  return target;
}
async function result(page) {
  await page.waitForFunction(() => window.qaTransferResult);
  return page.evaluate(() => window.qaTransferResult);
}
async function acknowledge(page, id, accepted) {
  await page.evaluate(({ id, accepted }) => window.markedown.completeDocumentTransfer(id, accepted), { id, accepted }).catch(error => {
    if (accepted || !/closed|destroyed/i.test(String(error))) throw error;
  });
}
try {
  const source = await application.firstWindow();
  await source.waitForFunction(() => window.qaBootstrap);
  await source.evaluate(() => window.markedown.updateSettings({ autoSave: false, recordHistory: false }));
  assert.equal((await source.evaluate(folder => window.markedown.chooseWorkspace(folder), run)).status, 'ok');
  const keep = (await bootstrap(source)).documents[0].id;
  const opened = await source.evaluate(filename => window.markedown.openFiles([filename]), filename);
  assert.equal(opened.status, 'ok');
  const id = opened.value[0].id;
  const sourceId = await windowId(source);
  const unsaved = patch('# Unsaved \u4e2d\u6587 e\u0301 \ud83d\ude00\n', 1, { mode: 'source', selection: { anchor: 2, head: 11 }, scrollTop: 213 });

  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = () => new Promise(resolve => { globalThis.answerSave = resolve; });
  });
  await source.evaluate(({ id, value }) => {
    window.qaSave = window.markedown.saveDocument(id, value, true);
  }, { id, value: unsaved });
  assert.equal((await source.evaluate(({ id, value, editorState }) => window.markedown.detachDocument(id, value, editorState), { id, value: unsaved, editorState: state(unsaved) })).status, 'conflict');
  await application.evaluate(() => globalThis.answerSave({ canceled: true }));
  assert.equal((await source.evaluate(() => window.qaSave)).status, 'cancelled');

  const target = await startTransfer(source, id, unsaved, { x: 999999, y: 999999 });
  const moved = await bootstrap(target);
  assert.equal(moved.documents.length, 1);
  assert.equal(moved.documents[0].id, id);
  assert.equal(moved.documents[0].source, unsaved.source);
  assert.equal(moved.documents[0].dirty, true);
  assert.equal(moved.documents[0].bom, true);
  assert.equal(moved.documents[0].lineEnding, 'CRLF');
  assert.equal(moved.documents[0].mode, 'source');
  assert.deepEqual(moved.documents[0].selection, unsaved.selection);
  assert.equal(moved.documents[0].scrollTop, unsaved.scrollTop);
  assert.equal(moved.workspace, run);
  assert.deepEqual(moved.transfer, { id, editorState: state(unsaved) });
  assert.equal(await source.evaluate(() => window.qaTransferResult), null);
  const targetId = await windowId(target);
  const geometry = await application.evaluate(({ BrowserWindow, screen }, targetId) => {
    const win = BrowserWindow.fromId(targetId);
    return { visible: win.isVisible(), bounds: win.getBounds(), area: screen.getDisplayMatching(win.getBounds()).workArea };
  }, targetId);
  assert.equal(geometry.visible, false);
  // BrowserWindow bounds include the native Windows frame at the active display scale.
  assert(geometry.bounds.x >= geometry.area.x && geometry.bounds.y >= geometry.area.y);
  assert(geometry.bounds.x + geometry.bounds.width <= geometry.area.x + geometry.area.width);
  assert(geometry.bounds.y + geometry.bounds.height <= geometry.area.y + geometry.area.height);
  assert.equal((await source.evaluate(id => window.markedown.closeOtherDocuments(id), keep)).status, 'cancelled');
  await assert.rejects(source.evaluate(id => window.markedown.completeDocumentTransfer(id, true), id), /receiving window/);
  await assert.rejects(target.evaluate(({ id, value }) => window.markedown.updateDocument(id, value), { id, value: patch('before ack', 2) }), /being moved/);
  assert.deepEqual(await readFile(filename), original);
  assert.deepEqual(await source.evaluate(filename => window.markedown.openFiles([filename]), filename), { status: 'ok', value: [] });
  assert.equal(await application.evaluate(({ BrowserWindow }, targetId) => BrowserWindow.fromId(targetId).isVisible(), targetId), false);
  await acknowledge(target, id, true);
  assert.deepEqual(await result(source), { status: 'ok', value: true });
  assert.equal((await bootstrap(source)).documents.some(doc => doc.id === id), false);
  assert.equal((await bootstrap(target)).transfer, undefined);
  assert.equal(await application.evaluate(({ BrowserWindow }, targetId) => BrowserWindow.fromId(targetId).isVisible(), targetId), true);
  assert(await application.evaluate(({ BrowserWindow, screen }, targetId) => {
    const bounds = BrowserWindow.fromId(targetId).getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    return bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height;
  }, targetId));
  await assert.rejects(source.evaluate(({ id, value }) => window.markedown.updateDocument(id, value), { id, value: patch('wrong owner', 2) }), /not owned/);
  await target.evaluate(({ id, value }) => window.markedown.updateDocument(id, value), { id, value: patch('edited in new window', 2) });
  assert.equal((await bootstrap(target)).documents[0].source, 'edited in new window');
  assert.deepEqual(await source.evaluate(filename => window.markedown.openFiles([filename]), filename), { status: 'ok', value: [] });
  assert.equal((await bootstrap(source)).documents.length, 1);

  const rollback = await source.evaluate(() => window.markedown.newDocument());
  const rollbackPatch = patch('retain this unsaved document', 1, { selection: { anchor: 3, head: 7 }, scrollTop: 54 });
  for (const failure of ['negative-ack', 'target-close', 'source-close']) {
    const failedTarget = await startTransfer(source, rollback.id, rollbackPatch);
    if (failure === 'negative-ack') await acknowledge(failedTarget, rollback.id, false);
    else await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), failure === 'source-close' ? sourceId : await windowId(failedTarget));
    assert.equal((await result(source)).status, 'error');
    const restored = (await bootstrap(source)).documents.find(doc => doc.id === rollback.id);
    assert.equal(restored.source, rollbackPatch.source);
    assert.deepEqual(restored.selection, rollbackPatch.selection);
    assert.equal(restored.scrollTop, rollbackPatch.scrollTop);
    await source.evaluate(({ id, value }) => window.markedown.updateDocument(id, value), { id: rollback.id, value: rollbackPatch });
  }

  await application.evaluate((_electron, url) => { process.env.MARKEDOWN_DEV_URL = url; }, pathToFileURL(path.join(run, 'does-not-exist.html')).href);
  assert.equal((await source.evaluate(({ id, value, editorState }) => window.markedown.detachDocument(id, value, editorState), { id: rollback.id, value: rollbackPatch, editorState: state(rollbackPatch) })).status, 'error');
  await application.evaluate((_electron, url) => { process.env.MARKEDOWN_DEV_URL = url; }, rendererUrl);
  assert.equal((await bootstrap(source)).documents.some(doc => doc.id === rollback.id), true);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);

  const third = await source.evaluate(async value => {
    const doc = await window.markedown.newDocument();
    await window.markedown.updateDocument(doc.id, value);
    return doc;
  }, patch('third unsaved document'));
  await application.evaluate(({ dialog }) => {
    globalThis.closeCalls = 0;
    const decisions = [1, 2];
    dialog.showMessageBox = async () => { globalThis.closeCalls++; return { response: decisions.shift() ?? 2, checkboxChecked: false }; };
  });
  assert.equal((await source.evaluate(id => window.markedown.closeOtherDocuments(id), keep)).status, 'cancelled');
  assert.equal(await application.evaluate(() => globalThis.closeCalls), 2);
  assert.deepEqual(new Set((await bootstrap(source)).documents.map(doc => doc.id)), new Set([keep, rollback.id, third.id]));
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  const closed = await source.evaluate(id => window.markedown.closeOtherDocuments(id), keep);
  assert.equal(closed.status, 'ok');
  assert.deepEqual(new Set(closed.value), new Set([rollback.id, third.id]));
  assert.deepEqual((await bootstrap(source)).documents.map(doc => doc.id), [keep]);
  assert.equal((await bootstrap(target)).documents[0].id, id);

  await target.evaluate(() => window.markedown.updateSettings({ autoSave: true }));
  await target.evaluate(({ id, value }) => {
    window.qaEvents.length = 0;
    return window.markedown.updateDocument(id, value);
  }, { id, value: patch('autosave after transfer', 3) });
  await application.evaluate(({ BrowserWindow }, targetId) => {
    const win = BrowserWindow.fromId(targetId);
    globalThis.qaPollFocus = setInterval(() => win.emit('focus'), 150);
  }, targetId);
  try { await target.waitForFunction(id => window.qaEvents.some(event => event.type === 'document' && event.document.id === id && !event.document.dirty), id, { timeout: 1800 }); }
  finally { await application.evaluate(() => clearInterval(globalThis.qaPollFocus)); }
  assert.equal(await readFile(filename, 'utf8'), '\ufeffautosave after transfer');
  await target.evaluate(() => window.markedown.updateSettings({ autoSave: false }));

  const crashFile = path.join(run, 'crash-transfer.md');
  const orphanFile = path.join(run, 'orphan.md');
  await writeFile(crashFile, 'original crash document');
  await writeFile(orphanFile, 'original orphan document');
  const created = application.waitForEvent('window', { timeout: 15000 });
  await target.evaluate(() => window.markedown.newWindow());
  const doomed = await created;
  await doomed.waitForFunction(() => window.qaBootstrap);
  const crashOpened = await doomed.evaluate(paths => window.markedown.openFiles(paths), [crashFile, orphanFile]);
  assert.equal(crashOpened.status, 'ok');
  const [crashDocument, orphanDocument] = crashOpened.value;
  await doomed.evaluate(({ id, value }) => window.markedown.updateDocument(id, value), { id: orphanDocument.id, value: patch('retained orphan edits') });
  const crashPatch = patch('retained edits during source destruction');
  const crashReceiver = await startTransfer(doomed, crashDocument.id, crashPatch);
  const receiverClosed = crashReceiver.waitForEvent('close', { timeout: 15000 });
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(), await windowId(doomed));
  await receiverClosed;
  const reclaimedTransfer = await target.evaluate(filename => window.markedown.openFiles([filename]), crashFile);
  assert.equal(reclaimedTransfer.status, 'ok');
  assert.equal(reclaimedTransfer.value.length, 1);
  assert.equal(reclaimedTransfer.value[0].id, crashDocument.id);
  assert.equal(reclaimedTransfer.value[0].source, crashPatch.source);
  const reclaimedOrphan = await source.evaluate(filename => window.markedown.openFiles([filename]), orphanFile);
  assert.equal(reclaimedOrphan.status, 'ok');
  assert.equal(reclaimedOrphan.value.length, 1);
  assert.equal(reclaimedOrphan.value[0].id, orphanDocument.id);
  assert.equal(reclaimedOrphan.value[0].source, 'retained orphan edits');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
  console.log(JSON.stringify({ run, checks: ['busy save guard', 'single-owner ACK handshake', 'hidden target until editor ready', 'snapshot and workspace retention', 'visible native-frame bounds before and after showing', 'foreign write rejection', 'open-file deduplication', 'negative ACK rollback', 'target close rollback', 'source close rollback', 'renderer load failure cleanup', 'atomic close-other cancellation', 'close-other window isolation', 'autosave survives frequent external checks', 'hard-destroy transfer reclamation', 'stale owner reclamation'] }));
} finally {
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await application.close().catch(() => undefined);
}
