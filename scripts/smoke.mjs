import { mkdir, mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const evidence = path.resolve('test-results');
await mkdir(evidence, { recursive:true });
const run = await mkdtemp(path.join(evidence, 'ui-fixtures-'));
const workspace = path.join(run, 'workspace');
await mkdir(path.join(workspace, 'notes'), { recursive:true });
await mkdir(path.join(workspace, 'assets'), { recursive:true });
const alpha = path.join(workspace, 'alpha.md');
const beta = path.join(workspace, 'beta.md');
const nested = path.join(workspace, 'notes', 'nested.md');
const fixtureImage = path.join(workspace, 'assets', 'icon.png');
// Keep the smoke fixture self-contained; release checkouts do not require a
// source image asset to be present under resources/.
await writeFile(fixtureImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=', 'base64'));
const source = '# Markit Windows\n\n## \u7814\u7a76\u7b14\u8bb0\n\nMarkdown keeps **important ideas**, *emphasis*, ==highlights== and H<sub>2</sub>O together.\n\nneedle needle\n\n| Document | Status |\n| --- | --- |\n| Windows edition | Ready |\n\n```javascript\nconst windows = true;\n```\n\n$$\nx^2 + y^2 = 1\n$$\n\n![Markit](assets/icon.png)\n\n## Next section\n\nA final paragraph.\n';
await writeFile(alpha,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(source.replaceAll('\n','\r\n'))]));
await writeFile(beta,'# Second document\n\nIndependent editing history.\n');
await writeFile(nested,'# Nested note\n\nworkspace-match belongs here.\n');
const large = path.join(workspace,'large.md');
const recommended = path.join(workspace,'recommended.md');
const forced = path.join(workspace,'forced.md');
const paragraph = 'A large Markdown document with ordinary text and predictable line wrapping.\n\n';
await writeFile(large,paragraph.repeat(Math.ceil(350000/paragraph.length)).slice(0,350000));
await writeFile(recommended,paragraph.repeat(Math.ceil((1024*1024+1)/paragraph.length)).slice(0,1024*1024+1));
await writeFile(forced,paragraph.repeat(Math.ceil((5*1024*1024+1)/paragraph.length)).slice(0,5*1024*1024+1));
const environment = { ...process.env, MARKEDOWN_DATA_DIR:path.join(run,'data') };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.MARKEDOWN_DEV_URL;
const application = await electron.launch({ args:[process.cwd(),'--test-mode'],env:environment,timeout:30000 });
const assert = (condition,message) => { if (!condition) throw new Error(message); };
const errors = [];
const checks = [];
const timing = {};
let page;
async function openDialog(paths) { await application.evaluate(({dialog},paths) => { dialog.showOpenDialog=async()=>({canceled:false,filePaths:paths}); },paths); }
async function saveDialog(filename) { await application.evaluate(({dialog},filename)=>{ dialog.showSaveDialog=async()=>({canceled:false,filePath:filename}); },filename); }
async function currentDocument() { return page.evaluate(async()=>{ const id=document.querySelector('.markedown-editor:not([style*="display: none"])')?.getAttribute('data-document-id'); return (await window.markedown.bootstrap()).documents.find(doc=>doc.id===id); }); }
async function focusEnd() { await page.locator('.cm-content:visible').click(); await page.keyboard.press('Control+End'); }
async function switchTab(name) { await page.getByTestId('document-tab').filter({hasText:name}).click(); await page.waitForFunction(name=>document.querySelector('.document-tab.selected')?.textContent.includes(name),name); }
async function waitForState(predicate,arg,timeout=10000) {
  const started=performance.now();
  while(performance.now()-started<timeout) {
    if(await page.evaluate(predicate,arg)) return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error('Timed out waiting for asynchronous application state: '+predicate.toString());
}
async function screenshot(name,width,height) {
  await page.setViewportSize({width,height});
  await page.screenshot({path:path.join(evidence,name)});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
  assert(!overflow,'Horizontal page overflow at '+width+'px.');
}
try {
  page=await application.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{ if(message.type()==='error') errors.push(message.text()); });
  await page.getByTestId('app').waitFor();
  await page.locator('.cm-content:visible').waitFor();
  await page.evaluate(()=>{window.qaKeys=[];window.qaCommands=[];window.addEventListener('keydown',event=>{if(event.ctrlKey)window.qaKeys.push(event.key);},true);window.markedown.onEvent(event=>{if(event.type==='command')window.qaCommands.push(event.command);});});
  await page.evaluate(()=>window.markedown.updateSettings({language:'en',theme:'github',autoSave:false,showToolbar:true}));
  await page.getByRole('menuitem',{name:'File',exact:true}).waitFor();
  assert(await page.getByTestId('document-tab').count()===1,'Empty startup must have one document.');
  checks.push('empty production startup');
  await screenshot('empty-desktop.png',1280,860);

  await openDialog([alpha,beta]);
  await page.keyboard.press('Control+o');
  await page.getByTestId('document-tab').filter({hasText:'beta.md'}).waitFor();
  await switchTab('alpha.md');
  assert(await page.locator('.cm-content:visible').count()===1,'Inactive editors overlap the active tab.');
  await page.getByRole('tab',{name:'Outline',exact:true}).click();
  await page.locator('.outline-list button').filter({hasText:'Next section'}).waitFor({timeout:15000});
  await page.waitForFunction(()=>Number(document.querySelector('.status-bar>div>span')?.textContent?.split(' ')[0])>10);
  checks.push('two tabs and production analysis worker');
  const alphaId=(await currentDocument()).id;
  await focusEnd();
  await page.keyboard.insertText('\u4e2d\u6587 \ud83d\ude00 e\u0301');
  const session=await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition',{text:'zhongwen',selectionStart:0,selectionEnd:8});
  await session.send('Input.imeSetComposition',{text:'\u7ec4\u5408\u8f93\u5165',selectionStart:4,selectionEnd:4});
  await session.send('Input.insertText',{text:'\u7ec4\u5408\u8f93\u5165'});
  await session.detach();
  await waitForState(async id=>(await window.markedown.bootstrap()).documents.find(doc=>doc.id===id)?.source.endsWith('\u4e2d\u6587 \ud83d\ude00 e\u0301\u7ec4\u5408\u8f93\u5165'),alphaId);
  const edited=(await currentDocument()).source;
  await page.getByTestId('mode-toggle').click();
  await page.getByTestId('mode-toggle').filter({hasText:'Source'}).waitFor();
  await page.getByTestId('mode-toggle').click();
  assert((await currentDocument()).source===edited,'Mode roundtrip changed source.');
  // Live tables are presentation-only. Editing table content or structure is
  // intentionally available from source mode, so common table gestures must
  // leave the Markdown source and DOM unchanged.
  const renderedTable=page.locator('.md-rendered table:visible').first();
  await renderedTable.waitFor();
  const tableBefore=(await currentDocument()).source;
  const tableCell=renderedTable.locator('th,td').first();
  await tableCell.dblclick();
  await page.keyboard.press('Enter');
  await page.keyboard.press('F2');
  await page.keyboard.press('Tab');
  await tableCell.click({button:'right'});
  await page.waitForTimeout(100);
  assert(await page.locator('.md-table-cell-editor').count()===0,'Live table opened a cell editor.');
  assert(await page.locator('.md-table-context-menu').count()===0,'Live table opened an editing context menu.');
  assert((await currentDocument()).source===tableBefore,'Live table interaction changed Markdown source.');
  checks.push('live tables remain read-only while source mode handles edits');
  await page.evaluate(()=>window.markedown.updateSettings({theme:'night'}));
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  assert((await currentDocument()).source===edited,'Theme change altered source.');
  await screenshot('dark-desktop.png',1280,860);
  await page.evaluate(()=>window.markedown.updateSettings({theme:'github'}));
  await switchTab('beta.md');
  await focusEnd();
  await page.keyboard.insertText('BETA-ONLY');
  await page.keyboard.press('Control+z');
  assert((await currentDocument()).source==='# Second document\n\nIndependent editing history.\n','Undo did not remain local to the second tab.');
  await switchTab('alpha.md');
  assert((await currentDocument()).source===edited,'Another tab undo changed this source.');
  checks.push('Unicode and IME composition','mode/theme source preservation','per-tab undo');

  await page.keyboard.press('Control+h');
  await page.getByRole('textbox',{name:'Find text',exact:true}).fill('needle');
  await page.waitForFunction(()=>document.querySelector('.find-count')?.textContent?.includes('/ 2'));
  await page.getByRole('textbox',{name:'Replace with',exact:true}).fill('replaced');
  await page.getByRole('button',{name:'Replace all',exact:true}).click();
  await waitForState(async id=>(await window.markedown.bootstrap()).documents.find(doc=>doc.id===id)?.source.includes('replaced replaced'),alphaId);
  await page.getByRole('button',{name:'Close find',exact:true}).click();
  await page.locator('.outline-list button').filter({hasText:'Next section'}).click();
  await waitForState(async id=>{const doc=(await window.markedown.bootstrap()).documents.find(doc=>doc.id===id);return doc?.selection.head===doc?.source.indexOf('## Next section');},alphaId);
  const beforeParagraph=(await currentDocument()).source;
  await page.waitForFunction(()=>document.querySelector('.heading-select')?.value==='heading2');
  await page.getByRole('combobox',{name:'Paragraph style'}).selectOption('paragraph');
  await waitForState(async id=>(await window.markedown.bootstrap()).documents.find(doc=>doc.id===id)?.source.includes('\nNext section\n'),alphaId);
  await page.keyboard.press('Control+z');
  await waitForState(async ({id,source})=>(await window.markedown.bootstrap()).documents.find(doc=>doc.id===id)?.source===source,{id:alphaId,source:beforeParagraph});
  checks.push('find and replace','outline navigation','heading to paragraph');

  await page.getByRole('tab',{name:'Files',exact:true}).click();
  await openDialog([workspace]);
  await page.getByRole('button',{name:'Open folder',exact:true}).first().click();
  await page.locator('.tree-row').filter({hasText:'notes'}).waitFor();
  assert(await page.locator('.tree-row').filter({hasText:'nested.md'}).count()===0,'Nested folder loaded visibly before expansion.');
  await page.locator('.tree-row').filter({hasText:'notes'}).click();
  await page.locator('.tree-row').filter({hasText:'nested.md'}).waitFor();
  await page.locator('.tree-row').filter({hasText:'nested.md'}).dblclick();
  await page.getByTestId('document-tab').filter({hasText:'nested.md'}).waitFor();
  await page.getByRole('tab',{name:'Search',exact:true}).click();
  await page.getByRole('textbox',{name:'Search workspace',exact:true}).fill('workspace-match');
  await page.locator('.search-results>button').filter({hasText:'nested.md'}).waitFor();
  await page.locator('.search-results>button').filter({hasText:'nested.md'}).click();
  await waitForState(async()=>{const doc=(await window.markedown.bootstrap()).documents.find(doc=>doc.title==='nested.md');return doc?.selection.head===doc?.source.indexOf('workspace-match');});
  checks.push('lazy workspace tree','workspace search result navigation');

  await switchTab('alpha.md');
  await focusEnd();
  const beforeImage=(await currentDocument()).source;
  await openDialog([fixtureImage,fixtureImage]);
  await page.getByRole('button',{name:'Insert image',exact:true}).click();
  await waitForState(async id=>((await window.markedown.bootstrap()).documents.find(doc=>doc.id===id)?.source.match(/!\[\]\(<assets\/icon-/g)||[]).length===2,alphaId);
  await page.keyboard.press('Control+z');
  await waitForState(async ({id,source})=>(await window.markedown.bootstrap()).documents.find(doc=>doc.id===id)?.source===source,{id:alphaId,source:beforeImage});
  await page.keyboard.press('Control+y');
  await waitForState(async id=>((await window.markedown.bootstrap()).documents.find(doc=>doc.id===id)?.source.match(/!\[\]\(<assets\/icon-/g)||[]).length===2,alphaId);
  const finalSource=(await currentDocument()).source;
  assert(finalSource.includes('replaced replaced'),'Later formatting or image undo reverted an earlier replacement.');
  await page.keyboard.press('Control+s');
  await waitForState(async id=>(await window.markedown.bootstrap()).documents.find(doc=>doc.id===id)?.dirty===false,alphaId);
  const bytes=await readFile(alpha);
  assert(bytes.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf])),'Save lost UTF-8 BOM.');
  if(bytes.subarray(3).toString('utf8')!==finalSource.replaceAll('\n','\r\n')) {
    await writeFile(path.join(evidence,'save-expected.txt'),finalSource.replaceAll('\n','\r\n'));
    await writeFile(path.join(evidence,'save-actual.txt'),bytes.subarray(3));
    console.error(JSON.stringify({expectedLength:finalSource.length,actualLength:bytes.subarray(3).toString('utf8').replaceAll('\r\n','\n').length,current:await currentDocument()}));
  }
  assert(bytes.subarray(3).toString('utf8')===finalSource.replaceAll('\n','\r\n'),'Save did not preserve CRLF or current source.');
  checks.push('UI batch image import and single undo','UI save BOM/CRLF roundtrip');

  await focusEnd();
  await page.keyboard.insertText('\nUNSAVED-EXPORT-CONTENT');
  for(const format of ['html','pdf']) {
    const destination=path.join(run,'ui-export.'+format);
    await saveDialog(destination);
    await page.getByRole('menuitem',{name:'File',exact:true}).click(); await page.getByRole('menuitem',{name:'Export…',exact:true}).click();
    await page.getByRole('dialog',{name:'Export document'}).getByRole('button',{name:format.toUpperCase(),exact:true}).click();
    await page.getByRole('dialog',{name:'Export document'}).waitFor({state:'hidden',timeout:30000});
    assert((await stat(destination)).size>1000,format+' export is empty.');
    if(format==='html') {const html=await readFile(destination,'utf8');assert(html.includes('UNSAVED-EXPORT-CONTENT')&&html.includes('data:image/png;base64,'),'HTML export lost unsaved content or local image.');}
    else assert((await readFile(destination)).toString('ascii',0,5)==='%PDF-','PDF export has no valid signature.');
  }
  checks.push('UI HTML/PDF export including unsaved content and local images');

  await page.getByRole('tab',{name:'Outline',exact:true}).click();
  await page.locator('.outline-list button').filter({hasText:'Markit Windows'}).click();
  await page.evaluate(()=>window.markedown.updateSettings({language:'zh-CN'}));
  await page.getByRole('menuitem',{name:'编辑',exact:true}).waitFor();
  const dismissToast=page.getByRole('button',{name:'\u5173\u95ed\u63d0\u793a',exact:true});
  if(await dismissToast.count()) await dismissToast.click();
  await screenshot('windows-zh-desktop.png',1280,860);
  await screenshot('windows-zh-compact.png',900,650);
  await page.keyboard.press('Control+,');
  await screenshot('settings-zh-compact.png',900,650);
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem',{name:'文件',exact:true}).click(); await page.getByRole('menuitem',{name:'导出…',exact:true}).click();
  await screenshot('export-zh-compact.png',900,650);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'\u6536\u8d77\u4fa7\u680f',exact:true}).click();
  await screenshot('windows-zh-narrow.png',390,844);
  await page.keyboard.press('Control+,');
  await screenshot('settings-zh-narrow.png',390,844);
  await page.keyboard.press('Escape');
  checks.push('Chinese locale and desktop/compact/narrow screenshots');

  await page.setViewportSize({width:1280,height:860});
  await page.evaluate(()=>window.markedown.updateSettings({language:'en'}));
  const started=performance.now();
  await openDialog([large]);
  await page.keyboard.press('Control+o');
  await page.getByTestId('document-tab').filter({hasText:'large.md'}).waitFor();
  await page.locator('.cm-content:visible').filter({hasText:'A large Markdown document'}).waitFor();
  timing.open350kMilliseconds=Math.round(performance.now()-started);
  for(const filename of [recommended,forced]) {
    await openDialog([filename]);
    await page.keyboard.press('Control+o');
    await page.getByTestId('document-tab').filter({hasText:path.basename(filename)}).waitFor();
    await page.getByTestId('mode-toggle').filter({hasText:'Source'}).waitFor();
  }
  await page.getByTestId('mode-toggle').click();
  assert((await currentDocument()).mode==='source','Document above 5 MiB entered live mode.');
  checks.push('350k document opening timing','1 MiB recommendation and 5 MiB source guard');
  assert(errors.length===0,'Renderer console errors: '+errors.join('\n'));
  const result={run,checks,timing,errors};
  await writeFile(path.join(evidence,'smoke-results.json'),JSON.stringify(result,null,2));
  await writeFile(path.join(evidence,'smoke-verification-status.json'),JSON.stringify({status:'passed',run,checks,timing,errors},null,2));
  console.log(JSON.stringify(result));
} catch(error) {
  if(page) await page.screenshot({path:path.join(evidence,'smoke-failure.png')}).catch(()=>undefined);
  if(page) console.error(await page.evaluate(()=>({keys:window.qaKeys,commands:window.qaCommands})).catch(()=>({})));
  console.error(JSON.stringify({errors}));
  throw error;
} finally {
  await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});}).catch(()=>undefined);
  await application.close();
}
