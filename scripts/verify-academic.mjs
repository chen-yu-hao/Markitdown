import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const evidence = path.resolve('test-results', 'academic');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const marker = '<!-- markedown:bibliography -->';
const source = '# Academic writing\n\nStart INSERT_HERE end.\n\n$$\na^2+b^2=c^2\\label{eq:pythagoras}\n$$\n\nInline $E=mc^2\\label{eq:energy}$.\n\nSee \\eqref{eq:pythagoras}.\n\nTail.\n';
const imported = '# Imported manuscript\n\nEvidence [@ABCDEFGH].\n\nTail.\n';
const typed = '# Typed citation\n\nEvidence [@ABCDEFGH';
const files = { main: path.join(run, 'academic manuscript.md'), imported: path.join(run, 'imported.md'), typed: path.join(run, 'typed.md'), composition: path.join(run, 'composition.md') };
await writeFile(files.main, source);
await writeFile(files.imported, imported);
await writeFile(files.typed, typed);
await writeFile(files.composition, 'Composition: ');
const fixtures = [
  { key: 'ABCDEFGH', title: 'Fixture citation A: reliable editing', authors: 'Author A', year: '2024', csl: { id: 'ABCDEFGH', type: 'article-journal', title: 'Fixture citation A: reliable editing' } },
  { key: 'IJKLMNOP', title: 'Fixture citation B: academic references', authors: 'Author B', year: '2025', csl: { id: 'IJKLMNOP', type: 'article-journal', title: 'Fixture citation B: academic references' } },
];
const env = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MARKEDOWN_DEV_URL;
const checks = [], errors = [];
let app, page;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const wait = async (predicate, message = 'Application state did not settle') => {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(message);
};
const current = () => page.evaluate(async () => {
  const title = document.querySelector('.document-tab.selected')?.getAttribute('title');
  return (await window.markedown.bootstrap()).documents.find(doc => (doc.path || doc.title) === title);
});
const open = async file => {
  await page.evaluate(file => window.markedown.openFiles([file]), file);
  await wait(async () => (await current())?.path === file, 'Requested document did not activate');
  await page.locator('.cm-content:visible').waitFor();
};
const home = async () => { await page.locator('.cm-content:visible').focus(); await page.keyboard.press('Control+Home'); };
const selectText = async text => {
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: 'Find text', exact: true }).fill(text);
  await wait(async () => {
    const doc = await current();
    return doc && doc.source.slice(Math.min(doc.selection.anchor, doc.selection.head), Math.max(doc.selection.anchor, doc.selection.head)) === text;
  }, `Could not select ${text}`);
  await page.getByRole('button', { name: 'Close find', exact: true }).click();
};
const openPanel = async (kind = 'citations') => {
  await page.keyboard.press(kind === 'citations' ? 'Control+Shift+c' : 'Control+Shift+r');
  await page.getByRole('dialog', { name: 'Insert Academic Reference', exact: true }).waitFor();
};

try {
  app = await electron.launch({ ...(executablePath ? { executablePath, args: ['--test-mode'] } : { args: [process.cwd(), '--test-mode'] }), env, timeout: 30000 });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content:visible').waitFor();
  await page.getByRole('status', { name: 'citeproc-js attribution', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'startup-attribution.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 480));
  await page.screenshot({ path: path.join(evidence, 'startup-attribution-700.png') });
  assert(await page.evaluate(() => {
    const credit = document.querySelector('.citation-startup-credit');
    const bounds = credit.getBoundingClientRect();
    return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight && credit.scrollWidth <= credit.clientWidth + 1;
  }), 'Narrow startup attribution overflows');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await wait(() => page.getByRole('status', { name: 'citeproc-js attribution', exact: true }).count().then(count => count === 0), 'Startup attribution did not disappear');
  checks.push('startup citeproc-js attribution fits desktop/narrow windows and dismisses after its display interval');
  // Fixture transport is confined to this launched process; renderer and preload remain real.
  await app.evaluate(({ ipcMain }, fixtures) => {
    const state = globalThis.__academicTest = { offline: false, lastSearch: '', cancellations: 0, resolveCalls: [], refreshed: false };
    for (const name of ['status', 'search', 'cancelSearch', 'resolve']) ipcMain.removeHandler('markedown:references.' + name);
    ipcMain.handle('markedown:references.status', () => ({ available: !state.offline, version: 'fixture' }));
    ipcMain.handle('markedown:references.cancelSearch', () => { state.cancellations++; });
    ipcMain.handle('markedown:references.search', async (_event, query) => {
      state.lastSearch = query;
      if (query === 'slow') await new Promise(resolve => setTimeout(resolve, 1000));
      if (state.offline) throw new Error('Fixture Zotero offline');
      const items = query === 'slow' ? [fixtures[0]] : query === 'second' ? [fixtures[1]] : fixtures.filter(item => `${item.title} ${item.authors} ${item.year} ${item.key}`.toLowerCase().includes(query.toLowerCase()));
      return { items, hasMore: false };
    });
    ipcMain.handle('markedown:references.resolve', async (_event, source, refresh) => {
      state.resolveCalls.push({ source, refresh: Boolean(refresh) });
      if (refresh) { state.refreshed = true; await new Promise(resolve => setTimeout(resolve, 700)); }
      const groups = [...source.matchAll(/\[\s*@[A-Z0-9]{8}(?:\s*;\s*@[A-Z0-9]{8})*\s*\]/g)].map(match => match[0]);
      const keys = [...new Set(groups.flatMap(group => group.match(/[A-Z0-9]{8}/g)))];
      const entries = keys.map((key, index) => ({ ...fixtures.find(item => item.key === key), key, number: index + 1 })).filter(item => item.title);
      const clusters = Object.fromEntries(groups.map(group => [group, '[' + group.match(/[A-Z0-9]{8}/g).map(key => entries.find(item => item.key === key)?.number || '?').join(', ') + ']']));
      const bibliography = entries.map(item => `<div class="csl-entry" id="ref-${item.key}">${item.number}. ${item.authors} (${item.year}). ${item.title}.${state.refreshed ? ' Refreshed fixture data.' : ''}</div>`).join('');
      return { clusters, bibliography, entries, missing: keys.filter(key => !entries.some(item => item.key === key)), warnings: [], offline: state.offline };
    });
  }, fixtures);
  await page.evaluate(() => window.markedown.updateSettings({ language: 'en', autoSave: false, saveOnSwitch: false, theme: 'github', showActiveBlockSource: true, mathNumbering: 'all', inlineMath: true, pairBrackets: false }));
  await open(files.imported);
  await home();
  await wait(() => page.locator('.cm-content:visible .md-citation').count().then(count => count > 0));
  assert((await current()).source === imported && !(await current()).dirty, 'Opening an old citation document changed its source');
  assert(await page.locator('.cm-content:visible .md-bibliography').count() === 1, 'Virtual bibliography is missing or duplicated');
  await page.locator('.cm-content:visible .md-citation').click();
  assert((await current()).source === imported, 'Citation navigation changed source');
  checks.push('imported citations render a virtual bibliography without modifying source');

  await open(files.main);
  await selectText('INSERT_HERE');
  await openPanel();
  await page.getByRole('checkbox').filter({ visible: true }).first().waitFor();
  const documentsBeforeModalShortcut = await page.evaluate(async () => (await window.markedown.bootstrap()).documents.length);
  const referenceSearch = page.getByRole('textbox', { name: 'Search references', exact: true });
  await referenceSearch.fill('replace me');
  await referenceSearch.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('reliable');
  assert(await referenceSearch.inputValue() === 'reliable', 'Ctrl+A did not select reference search text');
  assert(await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true });
    document.querySelector('.academic-search input').dispatchEvent(event);
    return !event.defaultPrevented;
  }), 'The app intercepts native paste while the academic search field is focused');
  await page.keyboard.press('Control+n');
  assert(await page.evaluate(async () => (await window.markedown.bootstrap()).documents.length) === documentsBeforeModalShortcut && (await current()).source === source, 'A modal keyboard shortcut modified the background document');
  await referenceSearch.fill('');
  await page.locator('.academic-result').filter({ hasText: fixtures[1].title }).waitFor();
  checks.push('modal search supports Ctrl+A, permits native paste key propagation and blocks background Ctrl+N');
  await page.locator('.academic-result').filter({ hasText: fixtures[1].title }).getByRole('checkbox').check();
  await page.getByRole('textbox', { name: 'Search references', exact: true }).fill('reliable');
  await page.locator('.academic-result').filter({ hasText: fixtures[0].title }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  const inserted = source.replace('INSERT_HERE', '[@IJKLMNOP; @ABCDEFGH]').trimEnd() + '\n\n' + marker + '\n';
  await wait(async () => (await current()).source === inserted, 'Citation insertion did not replace the retained selection or preserve order');
  assert((await current()).selection.head === source.indexOf('INSERT_HERE') + '[@IJKLMNOP; @ABCDEFGH]'.length, 'Citation insertion did not retain the insertion caret');
  await page.keyboard.press('Control+z');
  await wait(async () => (await current()).source === source, 'Citation and bibliography did not undo together');
  await page.keyboard.press('Control+y');
  await wait(async () => (await current()).source === inserted, 'Citation redo failed');
  await home();
  await wait(() => page.locator('.cm-content:visible .md-citation').count().then(count => count > 0));
  await page.screenshot({ path: path.join(evidence, 'academic-document.png') });
  checks.push('multi-citation insertion preserves selection order, caret and single-step undo/redo');

  const resolveCount = await app.evaluate(() => globalThis.__academicTest.resolveCalls.length);
  await page.locator('.cm-content:visible').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('Ordinary prose');
  await wait(async () => (await current()).source.endsWith('Ordinary prose'));
  await new Promise(resolve => setTimeout(resolve, 600));
  assert(await app.evaluate(() => globalThis.__academicTest.resolveCalls.length) === resolveCount, 'Ordinary prose triggered redundant citation resolution');
  await page.keyboard.press('Control+z');
  await wait(async () => (await current()).source === inserted);
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Academic references', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Refresh references', exact: true }).click();
  await wait(() => app.evaluate(() => globalThis.__academicTest.resolveCalls.some(call => call.refresh)));
  await page.locator('.cm-content:visible').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('Race prose');
  await wait(async () => (await current()).source.endsWith('Race prose'));
  await home();
  await wait(() => page.locator('.cm-content:visible .md-bibliography').textContent().then(text => text?.includes('Refreshed fixture data.')), 'An ordinary edit discarded the pending explicit refresh');
  await page.keyboard.press('Control+z');
  await wait(async () => (await current()).source === inserted);
  await home();
  checks.push('ordinary prose reuses citation data while explicit refresh survives a concurrent edit');

  const reference = page.locator('.cm-content:visible .md-equation-reference[data-equation-label="eq:pythagoras"]');
  assert((await reference.getAttribute('title')).includes('a^2+b^2=c^2'), 'Equation reference hover lacks equation source');
  await reference.click();
  await wait(async () => (await current()).selection.head === source.indexOf('$$') + '[@IJKLMNOP; @ABCDEFGH]'.length - 'INSERT_HERE'.length, 'Equation reference did not jump to its target');
  await home();
  await selectText('Tail.');
  await openPanel('equations');
  await page.locator('.academic-result').filter({ hasText: 'eq:energy' }).getByRole('radio').check();
  await page.screenshot({ path: path.join(evidence, 'equation-panel.png') });
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await wait(async () => (await current()).source.includes('\\eqref{eq:energy}'), 'Equation panel failed to insert a reference');
  await page.keyboard.press('Control+z');
  await wait(async () => (await current()).source === inserted);
  checks.push('equation hover, target navigation and inline-equation panel insertion');

  await openPanel();
  const search = page.getByRole('textbox', { name: 'Search references', exact: true });
  await search.fill('slow');
  await wait(() => app.evaluate(() => globalThis.__academicTest.lastSearch === 'slow'));
  await search.fill('second');
  await page.locator('.academic-result').filter({ hasText: fixtures[1].title }).waitFor();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert(await page.locator('.academic-result').filter({ hasText: fixtures[0].title }).count() === 0, 'Stale search replaced the latest results');
  await page.keyboard.press('Escape');
  await app.evaluate(() => { globalThis.__academicTest.offline = true; });
  await openPanel();
  await wait(() => page.locator('.academic-status').textContent().then(text => text.includes('offline')));
  await page.locator('.academic-result').filter({ hasText: fixtures[0].title }).waitFor();
  for (const [width, height, theme] of [[1100, 800, 'github'], [700, 480, 'night']]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height });
    await page.evaluate(theme => window.markedown.updateSettings({ theme }), theme);
    await page.waitForFunction(theme => document.documentElement.dataset.editorTheme === theme, theme);
    await page.screenshot({ path: path.join(evidence, `citation-panel-${theme}-${width}.png`) });
    assert(await page.evaluate(() => {
      const dialog = document.querySelector('.academic-dialog');
      const bounds = dialog.getBoundingClientRect();
      return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight && dialog.scrollWidth <= dialog.clientWidth + 1;
    }), 'Academic dialog overflows the window');
  }
  await page.keyboard.press('Escape');
  checks.push('stale search suppression, cached offline results, desktop/narrow/night layouts');

  await open(files.typed);
  await page.locator('.cm-content:visible').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(']');
  await wait(async () => (await current()).source === typed + ']\n\n' + marker + '\n', 'Typed citation did not append the bibliography');
  await page.keyboard.press('Control+z');
  await wait(async () => (await current()).source === typed, 'Typed citation and bibliography did not undo together');
  checks.push('completed typed citations append one bibliography in the same undo');

  await open(files.composition);
  await page.locator('.cm-content:visible').focus();
  await page.keyboard.press('Control+End');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '[@ABCDEFGH]', selectionStart: 11, selectionEnd: 11 });
  await wait(async () => (await current()).source.includes('[@ABCDEFGH]'));
  assert(!(await current()).source.includes(marker), 'Bibliography interrupted an active composition');
  await cdp.send('Input.insertText', { text: '[@ABCDEFGH]' });
  await wait(async () => (await current()).source.includes(marker), 'Committed composition did not append a bibliography');
  await page.keyboard.press('Control+z');
  await wait(async () => (await current()).source === 'Composition: ', 'Composed citation and bibliography did not undo together');
  await cdp.detach();
  checks.push('CDP composition defers bibliography mutation until commit and remains one undo');

  assert(errors.length === 0, errors.join('\n'));
  const result = { status: 'passed', executablePath, referenceTransport: 'isolated main-process IPC fixtures', checks, errors, run };
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'failed', executablePath, checks, errors, error: String(error), document: page ? await current().catch(() => null) : null, focus: page ? await page.evaluate(() => document.activeElement?.outerHTML).catch(() => null) : null, run }, null, 2));
  throw error;
} finally {
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
    await app.close();
  }
}
