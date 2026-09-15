import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const args=process.argv.slice(2), local=args.indexOf('--sample'), fixture=local>=0?args[local+1]:path.resolve('resources/ElementShowcase.md');
const executable=args[0]&&!args[0].startsWith('--')?path.resolve(args[0]):undefined;
const run=await mkdtemp(path.resolve('test-results/document-elements-')),data=path.join(run,'data');await mkdir(data);
const filename=path.join(run,'sample.md'),source=await readFile(fixture,'utf8');await writeFile(filename,source);
if(local>=0){await mkdir(path.join(run,'assets'));await copyFile(path.join(path.dirname(fixture),'assets/128x128.png'),path.join(run,'assets/128x128.png'));}
else await copyFile('resources/icon.png',path.join(run,'icon.png'));
await writeFile(path.join(run,'AcademicWriting.md'),'# Guide\n\nA linked document.');
await writeFile(path.join(data,'settings.json'),JSON.stringify({language:'en',autoSave:false,spellcheck:'off',exportOutline:false}));
const env={...process.env,MARKEDOWN_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;delete env.MARKEDOWN_DEV_URL;
const app=await electron.launch({...(executable?{executablePath:executable}:{}),args:[...(executable?[]:[process.cwd()]),'--test-mode','--force-device-scale-factor=1',filename],env});
const child=app.process(),watchdog=setTimeout(()=>child.kill(),240000),errors=[],checks=[];
let page,failure;
try {
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.locator('.md-metadata').first().waitFor();
  const state=async()=>(await page.evaluate(()=>window.markedown.bootstrap())).documents.find(doc=>doc.path===filename);
  const settle=()=>page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise(requestAnimationFrame);});
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1280,900);w.show();w.focus();});
  await page.locator('.md-metadata').first().click();
  const input=page.getByRole('textbox',{name:'Node source',exact:true});await input.waitFor();
  const yaml=await input.inputValue();await input.fill(yaml.replace('title:', 'title: TEST '));await settle();
  assert((await state()).source.includes('title: TEST '));await page.keyboard.press('Escape');await settle();assert.equal((await state()).source,source.replace(/\r\n/g,'\n'));
  checks.push('YAML card edits the original metadata; Escape restores the exact source');
  const scroll=page.locator('.cm-scroller:visible'),seen=new Set();
  let allImageCount=0;
  for(let i=0;i<120;i++){
    await scroll.evaluate((node,i)=>node.scrollTop=i*450,i);await settle();
    await page.waitForFunction(()=>![...document.querySelectorAll('.markedown-editor [data-diagram-ready]')].some(n=>n.dataset.diagramReady==='pending'),{},{timeout:20000});
    for(const item of await page.locator('.markedown-editor [data-diagram-ready]').evaluateAll(nodes=>nodes.map(n=>({type:n.dataset.diagramSource?.trim().split(/\s+/)[0],status:n.dataset.diagramReady,error:n.querySelector('.md-diagram-error')?.textContent,svg:!!n.querySelector('svg')})))){assert.equal(item.status,'true',JSON.stringify(item));assert(item.svg);seen.add(item.type);}
    allImageCount=Math.max(allImageCount,await page.locator('.markedown-editor img[src]').count());
    if(await scroll.evaluate(node=>node.scrollTop+node.clientHeight>=node.scrollHeight-2))break;
  }
  assert.equal(seen.size,7,`Expected seven Mermaid families, saw ${[...seen]}`);assert(allImageCount>=1);
  assert.equal((await state()).source,source.replace(/\r\n/g,'\n'),'Opening and scrolling changed source');
  checks.push('Seven offline Mermaid families render while scrolling; local images and original Markdown survive');
  await scroll.evaluate(node=>node.scrollTop=0);await settle();
  // The first table in either fixture is enough to exercise sizing and typing.
  for(let i=0;i<30&&await page.locator('.markedown-editor table').count()===0;i++){await scroll.evaluate(node=>node.scrollTop+=350);await settle();}
  await page.locator('.markedown-editor table td').first().click();const panel=page.getByRole('dialog',{name:'Table editor',exact:true});await panel.waitFor();
  await page.evaluate(()=>{window.stableTable=document.querySelector('.markedown-editor table');});
  const beforeZoom=(await page.evaluate(()=>window.markedown.bootstrap())).settings.zoom;
  await panel.getByRole('slider',{name:'Table zoom'}).fill('150');await settle();assert.equal(await panel.locator('output').innerText(),'150%');
  await panel.locator('.node-table-viewport').hover();await page.keyboard.down('Control');await page.mouse.wheel(0,-120);await page.keyboard.up('Control');await settle();assert.equal(await panel.locator('output').innerText(),'160%');
  await page.keyboard.press('Control+-');await settle();assert.equal(await panel.locator('output').innerText(),'150%');
  await panel.getByRole('button',{name:'Maximize or restore'}).click();await settle();assert((await panel.boundingBox()).width>1000);
  await panel.getByRole('button',{name:'Maximize or restore'}).click();
  const box=await panel.boundingBox();await page.mouse.move(box.x+box.width-3,box.y+box.height-3);await page.mouse.down();await page.mouse.move(box.x+box.width+80,box.y+box.height+40,{steps:8});await page.mouse.up();
  assert((await panel.boundingBox()).width>box.width+30,'Native panel resize did not change width');
  const resized=await panel.boundingBox();assert(resized.y+resized.height<=await page.evaluate(()=>innerHeight),'Resizing moved controls below the window');
  const field=panel.locator('textarea').first();await field.fill('连续输入中文 é 😀');await field.press('End');await page.keyboard.type(' abcdefghijklmnopqrstuvwxyz');await settle();
  assert((await state()).source.includes('连续输入中文'));
  assert(await page.evaluate(()=>window.stableTable===document.querySelector('.markedown-editor table')),'Typing rebuilt the visible Markdown table');
  assert.equal((await page.evaluate(()=>window.markedown.bootstrap())).settings.zoom,beforeZoom,'Panel zoom changed the whole app');
  await page.keyboard.press('Tab');assert.equal(await panel.locator('textarea').count(),1);
  await page.screenshot({path:path.join(run,'table-editor.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,650));await settle();
  const compact=await panel.boundingBox(),windowSize=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  assert(compact.x>=0&&compact.y>=0&&compact.x+compact.width<=windowSize.width+1&&compact.y+compact.height<=windowSize.height+1,'Compact table panel escaped the window');
  const resizeButton=await panel.getByRole('button',{name:'Resize table',exact:true}).boundingBox();assert(resizeButton.y+resizeButton.height<windowSize.height,'Compact table controls became unreachable');
  await page.screenshot({path:path.join(run,'table-editor-compact.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,900));await settle();
  await panel.getByRole('button',{name:'Finish node editing'}).click();await settle();checks.push('Table panel zoom, maximize, native resize and continuous Unicode input preserve the editor DOM');
  await page.screenshot({path:path.join(run,'table-and-elements.png')});
  if(local<0){
    const find=async selector=>{
      await scroll.evaluate(node=>node.scrollTop=0);await settle();
      for(let i=0;i<120;i++){
        const node=page.locator('.markedown-editor '+selector).first();if(await node.count())return node;
        await scroll.evaluate(node=>node.scrollTop+=400);await settle();
      }
      throw Error('Element not found: '+selector);
    };
    for(const [selector,label] of [['.md-code-node','Code block editor'],['.md-author-comment','Comment editor'],['.md-footnote-definition','Footnote editor'],['.md-safe-html section','HTML editor']]){
      const before=(await state()).source;
      await (await find(selector)).click();await page.getByRole('dialog',{name:label,exact:true}).waitFor();
      const field=page.getByRole('textbox',{name:'Node source',exact:true}),old=await field.inputValue();
      await field.fill(old+'\nNODE-CHECK ```');await settle();assert((await state()).source.includes('NODE-CHECK'));
      if(label==='Code block editor')assert((await state()).source.includes('````ts'),'Embedded backticks broke the code fence');
      await field.press('Escape');await settle();assert.equal((await state()).source,before);
    }
    await (await find('[data-diagram="mermaid"]')).click();const diagramPanel=page.getByRole('dialog',{name:'Diagram editor',exact:true});await diagramPanel.waitFor();
    await diagramPanel.locator('[data-diagram-ready="true"]').waitFor();await diagramPanel.getByRole('button',{name:'View full diagram'}).click();
    await page.locator('.md-image-viewer img').waitFor();await page.waitForFunction(()=>document.querySelector('.md-image-viewer img').naturalWidth>0);
    await page.keyboard.press('Escape');await diagramPanel.getByRole('button',{name:'Finish node editing'}).click();await settle();
    const picture=await find('img[src]');await picture.scrollIntoViewIfNeeded();await settle();
    await picture.dblclick();await page.locator('.md-image-viewer img').waitFor();await page.keyboard.press('Escape');
    await app.evaluate(({Menu})=>{const build=Menu.buildFromTemplate;globalThis.restoreImageMenu=()=>{Menu.buildFromTemplate=build;};Menu.buildFromTemplate=(items)=>{const menu=build.call(Menu,items);globalThis.imageTestMenu=menu;menu.popup=()=>{};return menu;};});
    await picture.click({button:'right'});
    await app.evaluate(()=>{const item=globalThis.imageTestMenu?.getMenuItemById('image-settings');if(!item?.enabled)throw Error('Native image settings unavailable');item.click();globalThis.restoreImageMenu();});
    const imagePanel=page.getByRole('dialog',{name:'Image settings',exact:true});await imagePanel.waitFor();
    await imagePanel.getByLabel('Width (pixels or percent)',{exact:true}).fill('45%');await imagePanel.getByLabel('Alignment',{exact:true}).selectOption('center');
    await imagePanel.getByRole('button',{name:'Apply image settings'}).click();await settle();assert((await state()).source.includes('width="45%"'));
    await imagePanel.getByRole('button',{name:'Finish node editing'}).click();await settle();
    const current=await state();
    const navigation=await page.evaluate(id=>window.markedown.openDocumentLink(id,'AcademicWriting.md#guide'),current.id);assert.equal(navigation.status,'ok');
    await page.getByTestId('document-tab').filter({hasText:'AcademicWriting.md'}).waitFor();
    await page.getByTestId('document-tab').filter({hasText:'sample.md'}).click();await settle();
    checks.push('Code fences, comments, footnotes and HTML edit/cancel exactly; Mermaid viewer, native image settings and local document navigation work');
    await page.getByRole('menuitem',{name:'View',exact:true}).click();await page.getByRole('menuitem',{name:'Article layout',exact:true}).click();await page.getByRole('menuitemcheckbox',{name:'Two columns (Nature style)',exact:true}).click();
    await page.locator('.article-columns').waitFor();await page.waitForFunction(()=>document.querySelector('.article-preview-paper').shadowRoot.querySelectorAll('main:not([aria-hidden]) [data-diagram-ready="true"]').length===7);
    await page.locator('.article-columns .md-document-toc a').last().click();await settle();assert.equal(await page.locator('.paper-edit-overlay').count(),0,'TOC opened editing instead of navigating');
    assert(await page.locator('.article-preview-scroll').evaluate(node=>node.scrollTop)>100);
    await page.locator('.article-columns .md-footnote-ref a').click();await settle();assert.equal(await page.locator('.paper-edit-overlay').count(),0);
    await page.screenshot({path:path.join(run,'elements-a4.png')});
    checks.push('A4 pages render seven diagrams; TOC and footnote clicks navigate without opening an editor');
  }
  // Use an isolated output path and the current unsaved snapshot for each format.
  for(const format of ['html','pdf','png']){
    const destination=path.join(run,`elements.${format}`);
    await app.evaluate(({dialog},filename)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:filename});},destination);
    const doc=await state();const result=await page.evaluate(({doc,format})=>window.markedown.exportDocument(doc.id,{source:doc.source,mode:doc.mode,selection:doc.selection,scrollTop:doc.scrollTop,editVersion:doc.editVersion},format),{doc,format});
    assert.equal(result.status,'ok',JSON.stringify(result));const bytes=await readFile(destination);assert(bytes.length>500);
    if(format==='html'){const html=bytes.toString();assert.equal((html.match(/data-diagram-ready="true"/g)||[]).length,7);assert(!html.includes('<script'));assert(html.includes('data:image/'));assert(!html.includes('md-author-comment"'));}
  }
  checks.push('HTML/PDF/PNG embed all seven diagrams and local images; exported HTML contains no scripts or author comments');
  assert.deepEqual(errors,[]);
}catch(error){failure=error;}
finally{
  const report={status:failure?'failed':'passed',fixture:local>=0?'local Nomo sample':'public Markit showcase',checks,errors,failure:failure?.message,run};await writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await app.close().catch(()=>{});clearTimeout(watchdog);if(child.exitCode===null)child.kill();
}
if(failure)throw failure;
