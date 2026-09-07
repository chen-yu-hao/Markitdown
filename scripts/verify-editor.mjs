import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const directory = path.resolve('.cache/editor-qa');
await mkdir(directory, { recursive: true });
const initialSource = '# Editor verification\n\nText with **bold**, *italic*, ==marked== and x<sup>2</sup>.\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```javascript\nconst value = 42;\n```\n\n$$\nx^2 + y^2 = 1\n$$\n\n![Local image](assets/test.png)\n\nneedle needle\n\nanchor\n\n';
const harness = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './src/renderer/Editor';
import { defaultSettings } from './src/shared/contracts';
window.markedown = { imageURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=', openExternal: async url => { window.openedLink = url; } };
const makeDoc = (id, source) => ({ id, path:'C:/fixture/'+id+'.md', title:id, source, savedSource:source, dirty:false, recovered:false, bom:false, lineEnding:'LF', revision:null, mode:'live', selection:{anchor:source.length,head:source.length}, scrollTop:0, editVersion:0 });
function Harness() {
  const [docs,setDocs] = useState([makeDoc('first', ${JSON.stringify(initialSource)}), makeDoc('second','Second document\\n')]);
  const [active,setActive] = useState('first');
  const [settings,setSettings] = useState(defaultSettings);
  const refs = useRef({});
  window.editorTest = { docs, active, setActive, settings, setSettings: patch => setSettings(previous => ({...previous,...patch})), controls: () => refs.current[active], setSource: source => setDocs(previous => previous.map(doc => doc.id === active ? {...doc, source,editVersion:doc.editVersion+1} : doc)), setMode: mode => setDocs(previous => previous.map(doc => doc.id === active ? {...doc, mode} : doc)) };
  return <div style={{height:'100vh'}}>{docs.map(doc => <div key={doc.id} style={{height:'100%',display:doc.id === active ? 'block':'none'}}><Editor ref={value => refs.current[doc.id]=value} document={doc} active={doc.id === active} fontSize={17} readingWidth={760} theme="light" typewriter={false} settings={settings} onChange={patch => setDocs(previous => previous.map(item => item.id === doc.id ? {...item,...patch,dirty:patch.source !== item.savedSource}:item))} onImportImages={() => new Promise(resolve => {window.resolveImages=resolve})} onFindResult={result => {window.searchResult=result}} /></div>)}</div>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
await build({ stdin: { contents: harness, sourcefile: 'editor-harness.tsx', loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome130', outfile: path.join(directory, 'harness.js'), loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css"><style>html,body,#root{margin:0;height:100%;background:white}</style></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
await build({ stdin: { contents: `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(path.join(directory, 'user-data'))}); app.whenReady().then(()=>new BrowserWindow({width:1200,height:960,show:false,webPreferences:{sandbox:true}}).loadFile(${JSON.stringify(path.join(directory, 'index.html'))}));`, sourcefile: 'driver.js', resolveDir: directory }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'driver.cjs'), external: ['electron'] });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ args: [path.join(directory, 'driver.cjs')], env: environment, timeout: 30000 });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => window.editorTest?.controls());
  await page.setViewportSize({ width: 1200, height: 960 });
  await page.waitForFunction(() => document.querySelectorAll('.md-rendered-block').length >= 3);
  const initial = await page.evaluate(() => ({ source: window.editorTest.docs[0].source, tables: document.querySelectorAll('.md-rendered table').length, math: document.querySelectorAll('.md-rendered .katex').length, images: document.querySelectorAll('.md-rendered img').length }));
  assert(initial.source === initialSource, 'Rendering changed the source.');
  assert(initial.tables === 1 && initial.math >= 1 && initial.images === 1, 'A live Markdown widget is missing.');
  const inlineHeight = await page.locator('.cm-line').filter({ hasText: 'Text with' }).first().evaluate(element => element.getBoundingClientRect().height);
  assert(inlineHeight < 40, 'Inline widgets introduced extra line breaks.');
  await page.screenshot({ path: path.join(directory, 'live-desktop.png') });

  await page.evaluate(() => window.editorTest.controls().scrollTo(window.editorTest.docs[0].source.length));
  await page.keyboard.insertText('\u4e2d\u6587 \ud83d\ude00 e\u0301');
  await page.waitForFunction(() => window.editorTest.docs[0].source.endsWith('\u4e2d\u6587 \ud83d\ude00 e\u0301'));
  await page.evaluate(() => window.editorTest.setActive('second'));
  await page.waitForFunction(() => window.editorTest.active === 'second');
  await page.evaluate(() => window.editorTest.controls().scrollTo(window.editorTest.docs[1].source.length));
  await page.keyboard.insertText('independent');
  await page.evaluate(() => window.editorTest.setActive('first'));
  await page.waitForFunction(() => window.editorTest.active === 'first');
  await page.evaluate(() => window.editorTest.controls().command('undo'));
  await page.waitForFunction(source => window.editorTest.docs[0].source === source, initialSource);
  assert(await page.evaluate(() => window.editorTest.docs[1].source.endsWith('independent')), 'Undo affected a different tab.');

  await page.evaluate(() => { window.editorTest.setMode('source'); });
  await page.waitForFunction(() => window.editorTest.docs[0].mode === 'source');
  await page.evaluate(() => window.editorTest.controls().command('redo'));
  await page.waitForFunction(() => window.editorTest.docs[0].source.endsWith('\u4e2d\u6587 \ud83d\ude00 e\u0301'));
  await page.evaluate(() => window.editorTest.setMode('live'));
  await page.evaluate(() => window.editorTest.controls().find('needle', { caseSensitive:true,wholeWord:true,regex:false }));
  await page.waitForFunction(() => window.searchResult?.total === 2 && window.searchResult.current === 1);
  await page.evaluate(() => window.editorTest.controls().replace('replacement', true));
  await page.waitForFunction(() => window.editorTest.docs[0].source.includes('replacement replacement'));

  await page.evaluate(() => { window.editorTest.controls().scrollTo(window.editorTest.docs[0].source.indexOf('anchor')); window.editorTest.controls().command('image'); });
  await page.waitForFunction(() => typeof window.resolveImages === 'function');
  await page.evaluate(() => window.editorTest.controls().scrollTo(0));
  await page.keyboard.insertText('PREFIX\n');
  const beforeImages = await page.evaluate(() => window.editorTest.docs[0].source);
  await page.evaluate(() => window.resolveImages(['assets/first.png','assets/second.png']));
  await page.waitForFunction(() => window.editorTest.docs[0].source.includes('![](<assets/first.png>)\n![](<assets/second.png>)\nanchor'));
  assert(await page.evaluate(() => window.editorTest.docs[0].source.startsWith('PREFIX\n')), 'Async image insertion lost intervening input.');
  await page.evaluate(() => window.editorTest.controls().command('undo'));
  await page.waitForFunction(source => window.editorTest.docs[0].source === source, beforeImages);

  await page.evaluate(() => window.editorTest.controls().scrollTo(window.editorTest.docs[0].source.length));
  const beforeComposition = await page.evaluate(() => window.editorTest.docs[0].source);
  const session = await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition', { text:'zhongwen',selectionStart:0,selectionEnd:8 });
  await session.send('Input.imeSetComposition', { text:'\u4e2d\u6587\u8f93\u5165',selectionStart:4,selectionEnd:4 });
  await session.send('Input.insertText', { text:'\u4e2d\u6587\u8f93\u5165' });
  await page.waitForFunction(source => window.editorTest.docs[0].source === source + '\u4e2d\u6587\u8f93\u5165', beforeComposition);
  await session.detach();

  const beforeSettings = await page.evaluate(() => window.editorTest.docs[0].source);
  await page.evaluate(() => window.editorTest.setSettings({ highlight:false, inlineMath:false, spellcheck:'en-GB' }));
  await page.waitForFunction(() => document.querySelector('.markedown-editor[data-document-id="first"] .cm-content')?.getAttribute('lang') === 'en-GB');
  assert(await page.evaluate(() => window.editorTest.docs[0].source) === beforeSettings, 'Preference changes mutated Markdown source.');
  await page.evaluate(() => window.editorTest.controls().command('undo'));
  await page.waitForFunction(source => window.editorTest.docs[0].source === source, beforeComposition);
  await page.evaluate(() => window.editorTest.controls().command('redo'));
  await page.waitForFunction(source => window.editorTest.docs[0].source === source, beforeSettings);
  await page.evaluate(() => { window.editorTest.setSettings({ smartPunctuation:'typing', smartDashes:true, unicodePunctuation:true }); window.editorTest.controls().scrollTo(window.editorTest.docs[0].source.length); });
  await page.keyboard.type(' test...');
  await page.waitForFunction(() => window.editorTest.docs[0].source.endsWith(' test…'));
  await page.evaluate(() => window.editorTest.setSettings({ highlight:true, inlineMath:true, smartPunctuation:'off' }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.editorTest.controls().scrollTo(0));
  await page.screenshot({ path: path.join(directory, 'live-mobile.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert(!overflow, 'Editor overflows the narrow viewport.');

  await page.setViewportSize({ width: 760, height: 720 });
  const pointerSource = 'Selection anchor words.\n\nPointer target has **bold words**, [reference](https://example.com/' + 'destination/'.repeat(16) + ') then landing-zone.\n\nDoubleclick chooseword here.\n\nDrag alpha beta gamma delta.\n\nFinal keyboard selection.';
  await page.evaluate(source => window.editorTest.setSource(source), pointerSource);
  await page.waitForFunction(source => window.editorTest.docs[0].source === source, pointerSource);
  const settlePointer = () => page.evaluate(async () => { for (let frame = 0; frame < 10; frame++) await new Promise(requestAnimationFrame); });
  const textPoint = (text, edge = 'end') => page.evaluate(({ text, edge }) => {
    const root = document.querySelector('.markedown-editor[data-document-id="first"] .cm-content');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      const index = node.textContent.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index + (edge === 'start' ? 0 : edge === 'middle' ? Math.floor(text.length / 2) : text.length - 1));
      range.setEnd(node, range.startOffset + 1);
      const bounds = range.getBoundingClientRect();
      if (bounds.height && bounds.width) return { x: edge === 'start' ? bounds.left + 0.2 : edge === 'middle' ? (bounds.left + bounds.right) / 2 : bounds.right - 0.2, y: (bounds.top + bounds.bottom) / 2 };
    }
    throw new Error('Mouse selection target not found: ' + text);
  }, { text, edge });
  const selectedText = () => page.evaluate(() => {
    const doc = window.editorTest.docs[0];
    return { ...doc.selection, text: doc.source.slice(Math.min(doc.selection.anchor, doc.selection.head), Math.max(doc.selection.anchor, doc.selection.head)) };
  });

  await page.keyboard.press('Control+Home');
  const shiftTarget = await textPoint('anchor');
  await page.keyboard.down('Shift');
  await page.mouse.click(shiftTarget.x, shiftTarget.y);
  await page.keyboard.up('Shift');
  await settlePointer();
  const shiftSelection = await selectedText();
  assert(shiftSelection.anchor === 0 && shiftSelection.text === 'Selection anchor', 'Shift+click did not extend the existing caret to the clicked text.');

  await page.keyboard.press('Control+Home');
  const dragStart = await textPoint('alpha', 'start');
  const dragEnd = await textPoint('gamma');
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 });
  await page.mouse.up();
  await settlePointer();
  assert((await selectedText()).text === 'alpha beta gamma', 'Dragging did not retain the intended text range.');

  await page.keyboard.press('Control+Home');
  const wordPoint = await textPoint('chooseword', 'middle');
  await page.mouse.click(wordPoint.x, wordPoint.y, { clickCount: 2 });
  await settlePointer();
  assert((await selectedText()).text === 'chooseword', 'Double-click did not select the complete word.');
  await page.mouse.click(wordPoint.x, wordPoint.y, { clickCount: 3 });
  await settlePointer();
  assert((await selectedText()).text === 'Doubleclick chooseword here.\n', 'Triple-click did not select the complete line.');

  await page.keyboard.press('Control+End');
  await page.keyboard.press('Shift+Home');
  assert((await selectedText()).text === 'Final keyboard selection.', 'Keyboard setup did not create the prior nonempty selection.');
  const outsidePoint = await textPoint('landing-zone.');
  await page.mouse.click(outsidePoint.x, outsidePoint.y);
  await settlePointer();
  const outsideSelection = await selectedText();
  const expectedOutside = pointerSource.indexOf('landing-zone.') + 'landing-zone.'.length;
  assert(outsideSelection.anchor === expectedOutside && outsideSelection.head === expectedOutside, 'Clicking outside an existing selection did not preserve the clicked source position.');
  const outsideCursor = await page.locator('.markedown-editor[data-document-id="first"] .cm-cursor').first().boundingBox();
  assert(outsideCursor && Math.abs(outsideCursor.y + outsideCursor.height / 2 - outsidePoint.y) <= 2, 'Clicking outside an existing selection moved the caret away from the clicked visual row.');
  assert(await page.evaluate(() => window.editorTest.docs[0].source) === pointerSource, 'Mouse selection changed the Markdown source.');
  assert(errors.length === 0, 'Renderer errors: ' + errors.join('\n'));
  console.log(JSON.stringify({ directory, checks: ['live widgets', 'source integrity', 'Unicode insertion', 'independent tab undo', 'mode history preservation', 'find/replace', 'tracked async image insertion', 'single image batch undo', 'Chromium Chinese IME composition', 'preference reconfiguration preserves source and history', 'native spellcheck attributes', 'smart typing punctuation', 'narrow viewport', 'Shift+click range selection', 'mouse drag selection', 'double-click word selection', 'triple-click line selection', 'click outside prior selection preserves source and visual caret'], errors }));
} finally {
  await application.close();
}
