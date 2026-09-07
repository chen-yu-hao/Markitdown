import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const evidence = path.resolve('test-results/caret-position');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const input = path.join(run, 'caret-position.md');
const reset = '\u590d\u4f4d\u6bb5\u843d';
const targets = [
  { name: 'heading-end', text: '\u524d\u7f6e\u5927\u6807\u9898\u6bb5\u672b' },
  { name: 'plain-end', text: '\u666e\u901a\u6bb5\u672b\u7532' },
  { name: 'hard-line-end', text: '\u6362\u884c\u6bb5\u672b\u4e59' },
  { name: 'soft-wrap-end', text: '\u957f\u6bb5\u6bb5\u672b\u4e19' },
  { name: 'bold-end', text: '\u52a0\u7c97\u6bb5\u672b\u4e01' },
  { name: 'link-end', text: '\u94fe\u63a5\u6bb5\u672b\u620a' },
  { name: 'math-end', text: '\u516c\u5f0f\u6bb5\u672b\u5df1' },
  { name: 'after-table', text: '\u8868\u683c\u540e\u6bb5\u672b\u5e9a' },
  { name: 'after-code', text: '\u4ee3\u7801\u540e\u6bb5\u672b\u8f9b' },
  { name: 'after-display-math', text: '\u884c\u95f4\u516c\u5f0f\u540e\u6bb5\u672b\u58ec' },
];
const phrase = '\u8fd9\u662f\u8bba\u6587\u5199\u4f5c\u4e2d\u7684\u4e2d\u6587\u6b63\u6587\uff0c\u9700\u8981\u7cbe\u786e\u5b9a\u4f4d\u9f20\u6807\u4e0e\u7f16\u8f91\u5149\u6807\u3002';
const source = [
  '# ' + targets[0].text,
  reset,
  phrase + targets[1].text,
  phrase + '\n' + phrase + targets[2].text,
  phrase.repeat(4) + targets[3].text,
  phrase + '**\u52a0\u7c97\u4e2d\u6587\u6587\u5b57** ' + phrase + targets[4].text,
  phrase + '[\u53c2\u8003\u94fe\u63a5](https://example.org/research/long-reference-destination/section/paper-writing-and-caret-position) ' + targets[5].text,
  phrase + '$\\frac{\\alpha^2 + \\beta^2}{\\sqrt{1 + x^2}} = \\sum_{i=1}^{n} x_i$ ' + targets[6].text,
  '| Column | Value |\n| --- | --- |\n| First | 123 |\n| Second | 456 |',
  phrase + targets[7].text,
  '```javascript\nfunction research() {\n  return { result: 123, status: "ready" };\n}\n```',
  phrase + targets[8].text,
  '$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$',
  phrase + targets[9].text,
  '\u6587\u6863\u7ed3\u675f\u3002',
].join('\n\n') + '\n';
await writeFile(input, source);
let activeSource = source;
const env = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data') };
delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
const executable = process.argv.slice(2).find(argument => /\.exe$/i.test(argument));
const diagnostic = process.argv.includes('--diagnose');
const shortOnly = process.argv.includes('--short-only');
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable) } : {}), args: [...(executable ? [] : [process.cwd()]), '--test-mode', input], env, timeout: 30000 });
const page = await app.firstWindow();
const measurements = [], errors = [];
const typingMeasurements = [];
let completedReport;
page.on('pageerror', error => errors.push(error.message));
const settle = () => page.evaluate(async () => { for (let frame = 0; frame < 8; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); });
const currentDocument = () => page.evaluate(async () => {
  const id = document.querySelector('.markedown-editor:not([style*="display: none"])')?.getAttribute('data-document-id');
  return (await window.markedown.bootstrap()).documents.find(document => document.id === id);
});

async function measure(text) {
  return page.evaluate(({ text, expectedOffset }) => {
    const root = [...document.querySelectorAll('.cm-content')].find(element => element.getBoundingClientRect().height && element.closest('.markedown-editor').style.display !== 'none');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      const index = node.textContent.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index + text.length - 1); range.setEnd(node, index + text.length);
      const bounds = [...range.getClientRects()].find(bounds => bounds.width && bounds.height);
      if (!bounds) continue;
      const line = node.parentElement.closest('.cm-line,.md-rendered-block') || node.parentElement;
      const style = getComputedStyle(node.parentElement);
      const cursor = root.closest('.cm-editor').querySelector('.cm-cursor');
      const selection = window.getSelection();
      const view = root.cmTile?.root?.view;
      const block = view?.lineBlockAt(expectedOffset);
      const point = { x: bounds.right + 1, y: bounds.top + bounds.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      const browserCaret = document.caretPositionFromPoint?.(point.x, point.y);
      return {
        glyph: bounds.toJSON(), line: line.getBoundingClientRect().toJSON(),
        cursor: cursor?.getBoundingClientRect().toJSON() || null,
        fontSize: style.fontSize, lineHeight: style.lineHeight,
        domSelection: selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect().toJSON() : null,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        scrollTop: root.closest('.cm-scroller').scrollTop,
        scroller: root.closest('.cm-scroller').getBoundingClientRect().toJSON(),
        previousLine: line.previousElementSibling?.getBoundingClientRect().toJSON() || null,
        nextLine: line.nextElementSibling?.getBoundingClientRect().toJSON() || null,
        hit: { inEditor: !!hit && root.contains(hit), tag: hit?.tagName, classes: hit?.className },
        browserCaret: browserCaret ? { text: browserCaret.offsetNode.textContent?.slice(0, 200), offset: browserCaret.offset } : null,
        codemirror: view ? { posAtCoords: view.posAtCoords(point), posAtDOM: view.posAtDOM(node, index + text.length), coordsBefore: view.coordsAtPos(expectedOffset, -1), coordsAfter: view.coordsAtPos(expectedOffset, 1), documentTop: view.documentTop, block: block ? { from: block.from, to: block.to, top: block.top, bottom: block.bottom, height: block.height } : null } : null,
      };
    }
    return null;
  }, { text, expectedOffset: activeSource.indexOf(text) + text.length });
}

async function reveal(text) {
  for (let step = 0; step < 80; step++) {
    const existing = await measure(text);
    if (existing) {
      await page.locator('.cm-scroller:visible').evaluate((element, glyph) => {
        const bounds = element.getBoundingClientRect();
        element.scrollTop += glyph.top + glyph.height / 2 - (bounds.top + bounds.height / 2);
      }, existing.glyph);
      await settle();
      const visible = await measure(text);
      if (visible?.glyph.top >= visible.scroller.top && visible.glyph.bottom <= visible.scroller.bottom && visible.hit.inEditor) return visible;
      continue;
    }
    await page.locator('.cm-scroller:visible').evaluate((element, step) => { element.scrollTop = step ? element.scrollTop + element.clientHeight * 0.7 : 0; }, step);
    await settle();
  }
  throw new Error('Text target did not enter the editor viewport: ' + text);
}

async function clickEnd(text, screenshotTag) {
  const before = await reveal(text);
  assert(before, 'DOM text range missing before mouse click');
  const click = { x: before.glyph.right + 1, y: before.glyph.top + before.glyph.height / 2 };
  if (screenshotTag) await page.screenshot({ path: path.join(run, screenshotTag + '-before.png') });
  await page.mouse.click(click.x, click.y);
  await settle();
  const after = await measure(text);
  const document = await currentDocument();
  if (screenshotTag) await page.screenshot({ path: path.join(run, screenshotTag + '-after.png') });
  return {
    click, before, after, selection: document.selection,
    expectedSourceOffset: activeSource.indexOf(text) + text.length,
    sourceOffsetDelta: document.selection.head - (activeSource.indexOf(text) + text.length),
    glyphShift: after ? { x: after.glyph.right - before.glyph.right, y: after.glyph.top - before.glyph.top } : null,
    cursorFromClick: after?.cursor ? { x: after.cursor.left - click.x, y: after.cursor.top + after.cursor.height / 2 - click.y } : null,
    cursorFromGlyph: after?.cursor ? { x: after.cursor.left - after.glyph.right, y: after.cursor.top + after.cursor.height / 2 - (after.glyph.top + after.glyph.height / 2) } : null,
  };
}

try {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false);
    window.show(); window.focus(); window.webContents.focus();
  });
  await page.bringToFront();
  await page.locator('.cm-content:visible').waitFor();
  await page.evaluate(() => window.markedown.updateSettings({ language: 'zh-CN', theme: 'github', autoSave: false, saveOnSwitch: false, readingWidth: 800, fontSize: 17, fontSizeMode: 'auto', firstLineIndent: false, showActiveBlockSource: true, editorWhitespace: 'preserve', smartPunctuation: 'off' }));
  if (await page.getByTestId('sidebar').count()) await page.getByRole('button', { name: '\u6536\u8d77\u4fa7\u680f', exact: true }).click();
  for (const zoom of shortOnly ? [] : [100, 125, 150, 200]) {
    await page.evaluate(zoom => window.markedown.updateSettings({ zoom }), zoom);
    await settle();
    for (const mode of ['live', 'source']) {
      if ((await currentDocument()).mode !== mode) await page.getByTestId('mode-toggle').click();
      await settle();
      for (const target of targets) {
        await clickEnd(reset);
        const inactive = await clickEnd(target.text, mode === 'live' && ['bold-end', 'link-end', 'math-end'].includes(target.name) ? `${zoom}-${mode}-${target.name}` : undefined);
        const active = await clickEnd(target.text);
        measurements.push({ fixture: 'blocks', width: 1280, zoom, mode, target: target.name, inactive, active });
        if (mode === 'live' && ['bold-end', 'link-end', 'math-end'].includes(target.name)) {
          await page.screenshot({ path: path.join(run, `${zoom}-${mode}-${target.name}.png`) });
        }
      }
      await page.screenshot({ path: path.join(run, `${zoom}-${mode}.png`) });
    }
  }
  assert.equal((await currentDocument()).source, source, 'Mouse positioning changed the Markdown source');
  for (const width of [1280, 620]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 720), width);
    for (const zoom of [100, 150, 200]) {
      await page.evaluate(zoom => window.markedown.updateSettings({ zoom }), zoom);
      for (const name of ['bold-end', 'link-end', 'math-end']) {
        const target = targets.find(target => target.name === name);
        const paragraph = name === 'bold-end'
          ? '\u4e2d'.repeat(40) + '**\u7c97\u4f53**' + target.text
          : source.split('\n\n').find(paragraph => paragraph.includes(target.text));
        const lowerTarget = '\u4e0b\u65b9\u6bb5\u672b';
        const shortSource = reset + '\n\n' + paragraph + '\n\n' + lowerTarget + '\n';
        const filename = path.join(run, `short-${width}-${zoom}-${name}.md`);
        await writeFile(filename, shortSource);
        await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, filename);
        await page.keyboard.press('Control+o');
        await page.getByTestId('document-tab').filter({ hasText: path.basename(filename) }).waitFor();
        activeSource = shortSource;
        await settle();
        for (const mode of ['live', 'source']) {
          if ((await currentDocument()).mode !== mode) await page.getByTestId('mode-toggle').click();
          await settle();
          await clickEnd(reset);
          const inactive = await clickEnd(target.text, mode === 'live' ? `short-${width}-${zoom}-${name}` : undefined);
          const active = await clickEnd(target.text);
          measurements.push({ fixture: 'short', width, zoom, mode, target: target.name, inactive, active });
          assert.equal((await currentDocument()).source, shortSource, 'Mouse positioning changed the short Markdown source');
          if (mode === 'live') {
            const collapsed = await clickEnd(lowerTarget, `collapse-${width}-${zoom}-${name}`);
            const stable = await clickEnd(lowerTarget);
            measurements.push({ fixture: 'short-collapse', width, zoom, mode, target: name, inactive: collapsed, active: stable });
            const before = await reveal(target.text);
            if (before.line.right - before.glyph.right > 20) {
              const click = { x: before.glyph.right + 1, y: before.glyph.top + before.glyph.height / 2 };
              await page.mouse.click(click.x, click.y);
              await page.keyboard.type('x');
              await settle();
              const expectedOffset = shortSource.indexOf(target.text) + target.text.length;
              activeSource = shortSource.slice(0, expectedOffset) + 'x' + shortSource.slice(expectedOffset);
              const typed = await currentDocument();
              assert.equal(typed.source, activeSource, 'Immediate typing did not insert at the clicked source position');
              const after = await measure(target.text + 'x');
              typingMeasurements.push({ width, zoom, target: name, click, before, after,
                sourceOffsetDelta: typed.selection.head - expectedOffset - 1,
                cursorFromClick: after?.cursor ? { x: after.cursor.left - click.x, y: after.cursor.top + after.cursor.height / 2 - click.y } : null,
                cursorFromGlyph: after?.cursor ? { x: after.cursor.left - after.glyph.right, y: after.cursor.top + after.cursor.height / 2 - (after.glyph.top + after.glyph.height / 2) } : null,
              });
              await page.screenshot({ path: path.join(run, `immediate-type-${width}-${zoom}-${name}.png`) });
              await page.keyboard.press('Control+z');
              await settle();
              activeSource = shortSource;
              assert.equal((await currentDocument()).source, shortSource, 'Immediate typing undo changed earlier document content');
            }
          }
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  const summary = measurements.map(({ fixture, width, zoom, mode, target, inactive, active }) => ({ fixture, width, zoom, mode, target, inactiveOffset: inactive.sourceOffsetDelta, inactiveShift: inactive.glyphShift, inactiveCursor: inactive.cursorFromClick, activeOffset: active.sourceOffsetDelta, activeCursor: active.cursorFromClick }));
  const failures = [];
  for (const measurement of measurements) {
    for (const activation of ['inactive', 'active']) {
      const result = measurement[activation];
      const label = `${measurement.fixture} ${measurement.width}px ${measurement.zoom}% ${measurement.mode} ${measurement.target} ${activation}`;
      if (result.sourceOffsetDelta !== 0) failures.push(`${label}: selection offset ${result.sourceOffsetDelta}`);
      if (!result.cursorFromGlyph || Math.abs(result.cursorFromGlyph.x) > 2 || Math.abs(result.cursorFromGlyph.y) > 2) failures.push(`${label}: caret does not match the actual end-of-text glyph`);
      if (measurement.target !== 'heading-end' && (!result.cursorFromClick || Math.abs(result.cursorFromClick.y) > 2)) failures.push(`${label}: caret moved away from the clicked visual row`);
    }
  }
  for (const measurement of typingMeasurements) {
    const label = `immediate typing ${measurement.width}px ${measurement.zoom}% ${measurement.target}`;
    if (measurement.sourceOffsetDelta !== 0) failures.push(`${label}: typing moved the source selection`);
    if (!measurement.cursorFromGlyph || Math.abs(measurement.cursorFromGlyph.x) > 2 || Math.abs(measurement.cursorFromGlyph.y) > 2) failures.push(`${label}: caret does not match the inserted character`);
    if (!measurement.cursorFromClick || Math.abs(measurement.cursorFromClick.y) > 2) failures.push(`${label}: typing interrupted visual row stability`);
  }
  const report = { status: diagnostic ? 'diagnostic' : failures.length ? 'failed' : 'passed', executable: executable ? path.resolve(executable) : 'development Electron', run, summary, failures, measurements, typingMeasurements, errors };
  completedReport = report;
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, run, measurements: measurements.length, immediateTyping: typingMeasurements.length, failures, errors }));
  if (!diagnostic) assert.deepEqual(failures, [], 'Caret position regression failed');
} catch (error) {
  await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  const report = { ...completedReport, status: 'failed', error: String(error), run, measurements, typingMeasurements, errors };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await app.close();
}
