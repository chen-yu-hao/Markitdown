import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const run=await mkdtemp(path.resolve('test-results/paste-heading-'));
const data=path.join(run,'data');await mkdir(data);
const filename=path.join(run,'clipboard.md');
const source='# Heading 中文 😀\n\nFirst paragraph for mouse selection.\n\n'+Array.from({length:180},(_,i)=>`Paragraph ${i}. Text with **bold** and [a link](https://example.com), $x^2$.\n\n`).join('');
await writeFile(filename,source);
await writeFile(path.join(data,'settings.json'),JSON.stringify({language:'en',autoSave:false,spellcheck:'off',copyMarkdown:true}));
const env={...process.env,MARKEDOWN_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;delete env.MARKEDOWN_DEV_URL;
const executable=process.argv[2]?path.resolve(process.argv[2]):undefined;
const app=await electron.launch({...(executable?{executablePath:executable}:{}),args:[...(executable?[]:[process.cwd()]),'--test-mode','--force-device-scale-factor=1',filename],env});
const child=app.process(),watchdog=setTimeout(()=>child.kill(),120000),checks=[],errors=[];
let page;
try {
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.locator('.cm-content:visible').waitFor();
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1280,900);w.show();w.focus();});
  const settle=()=>page.evaluate(async()=>{await document.fonts.ready;for(let i=0;i<10;i++)await new Promise(requestAnimationFrame);});
  const content=()=>page.locator('.cm-content:visible');
  // Real mouse drag starts at the first visible glyph of an inactive heading.
  await content().evaluate(el=>{const v=el.cmTile.root.view;v.dispatch({selection:{anchor:v.state.doc.length}});v.scrollDOM.scrollTop=0;});await settle();
  const points=await content().evaluate(el=>{const v=el.cmTile.root.view;const a=v.coordsAtPos(2),b=v.coordsAtPos(v.state.doc.line(3).to);return {x:a.left+1,y:(a.top+a.bottom)/2,endX:b.left,endY:(b.top+b.bottom)/2};});
  await page.mouse.move(points.x,points.y);await page.mouse.down();await page.mouse.move(points.endX,points.endY,{steps:15});await page.mouse.up();await settle();
  await page.keyboard.press('Control+c');await settle();
  const copied=await app.evaluate(({clipboard})=>clipboard.readText());
  assert(copied.startsWith('# Heading 中文 😀'),`Missing heading prefix: ${JSON.stringify(copied)}`);
  checks.push('Mouse drag and Ctrl+C include the hidden # heading prefix');
  for(const mode of ['live','source']) {
    if(mode==='source'){await page.getByTestId('mode-toggle').click();await settle();}
    for(const caret of ['visible','below','above']) {
      await content().evaluate((el,caret)=>{const v=el.cmTile.root.view;v.dispatch({selection:{anchor:v.state.doc.line(caret==='below'?240:caret==='above'?10:100).from}});v.focus();v.scrollDOM.scrollTop=v.lineBlockAt(v.state.doc.line(98).from).top;},caret);await settle();
      const before=await content().evaluate(el=>{const v=el.cmTile.root.view;const b=v.elementAtHeight((v.scrollDOM.getBoundingClientRect().top-v.documentTop)/v.scaleY);return {top:v.scrollDOM.scrollTop,source:v.state.doc.toString(),from:v.state.selection.main.from,anchor:b.from,y:v.documentTop+b.top*v.scaleY};});
      const pasted='Pasted 中文 é 😀\n'+ 'A long pasted paragraph. '.repeat(250)+'\n';
      await app.evaluate(({clipboard},text)=>clipboard.writeText(text),pasted);
      await page.keyboard.press('Control+v');await settle();
      const after=await content().evaluate(el=>{const v=el.cmTile.root.view;return {top:v.scrollDOM.scrollTop,source:v.state.doc.toString()};});
      assert.equal(after.source,before.source.slice(0,before.from)+pasted+before.source.slice(before.from));
      const anchor=before.anchor+(before.from<before.anchor?pasted.length:0);
      const y=await content().evaluate((el,anchor)=>{const v=el.cmTile.root.view;return v.documentTop+v.lineBlockAt(anchor).top*v.scaleY;},anchor);
      assert(Math.abs(y-before.y)<4,`${mode} caret=${caret} visible text jumped ${before.y} -> ${y}`);
      await page.keyboard.press('Control+z');await settle();
      assert.equal(await content().evaluate(el=>el.cmTile.root.view.state.doc.toString()),before.source);
      checks.push(`${mode} paste (caret ${caret}) retains viewport and one-step undo`);
    }
  }
  assert.deepEqual(errors,[]);await writeFile(path.join(run,'report.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({run,checks,errors}));
}catch(error){if(page)await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});throw error;}
finally{clearTimeout(watchdog);await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});}).catch(()=>{});await app.close().catch(()=>{});if(child.exitCode===null)child.kill();}
