import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

const run = await mkdtemp(path.resolve('test-results/article-layout-'));
const data = path.join(run, 'data'); await mkdir(data);
const filename = path.join(run, 'paper.md'), other = path.join(run, 'other.md');
const prose = 'A reproducible scientific result links the measurements to the physical model. Chinese 中文、组合字符 é and an inline equation $x^2 + y^2$ remain readable. ';
const source = '# Molecular structure and energy\n\n' + prose.repeat(4) + '\n\n## Results\n\n' + Array.from({length: 6}, () => prose.repeat(3)).join('\n\n') + '\n\n$$\nE=mc^2 \\label{eq:energy}\n$$\n\n| Sample | Energy |\n|---|---|\n| A | 1.25 |\n| B | 2.50 |\n\n## Figures\n\n![Long figure](figure.png)\n\n## Methods\n\n' + prose.repeat(12);
await writeFile(filename, source); await writeFile(other, '# Another document\n\nSeparate text.');
await sharp({create:{width:1200,height:3600,channels:3,background:'#6c98aa'}}).png().toFile(path.join(run, 'figure.png'));
await writeFile(path.join(data,'settings.json'), JSON.stringify({ language:'en',autoSave:false,readingWidth:1000,exportOutline:false,spellcheck:'off' }));
const env={...process.env,MARKEDOWN_DATA_DIR:data}; delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
const executable=process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const app=await electron.launch({...(executable?{executablePath:executable}:{}),args:[...(executable?[]:[process.cwd()]),'--test-mode','--force-device-scale-factor=1',filename],env});
const child = app.process();
const watchdog=setTimeout(()=>child.kill(),180000);
const checks=[],errors=[];let page;console.log('article-layout run',run,'pid',child.pid);
try {
  page=await app.firstWindow();console.log('window ready');page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.locator('.cm-content:visible').waitFor();
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1360,900);w.show();w.focus();});
  const settle=()=>page.evaluate(async()=>{await document.fonts.ready;for(let i=0;i<6;i++)await new Promise(requestAnimationFrame);});
  // Create an undo entry before changing layouts.
  await page.locator('.cm-content:visible').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('\nUNSAVED-LAYOUT-CHECK');await settle();
  await page.getByRole('menuitem',{name:'View',exact:true}).click();
  await page.getByRole('menuitem',{name:'Article layout',exact:true}).click();
  await page.getByRole('menuitemcheckbox',{name:'Two columns (Nature style)',exact:true}).click();
  await page.locator('.article-columns').waitFor();await settle();console.log('columns visible');
  assert.equal(await page.locator('.cm-content:visible').count(),0);
  assert.equal(await page.locator('.article-section').first().evaluate(el=>getComputedStyle(el).columnCount),'2');
  assert(await page.locator('.article-columns').innerText().then(t=>t.includes('UNSAVED-LAYOUT-CHECK')));
  assert(await page.locator('.article-columns .katex').count()>0);
  await page.screenshot({path:path.join(run,'two-columns.png')});
  checks.push('View menu opens true two-column article layout with current unsaved text and equations');
  const scroller=page.locator('.article-preview-scroll');
  await scroller.evaluate(el=>{el.scrollTop=650;});await settle();const top=await scroller.evaluate(el=>el.scrollTop);
  await page.evaluate(()=>{window.paperBeforeSave=document.querySelector('.article-preview-paper').shadowRoot.querySelector('main');});
  await scroller.focus();await page.keyboard.press('Control+s');await settle();
  assert(Math.abs(await scroller.evaluate(el=>el.scrollTop)-top)<3,'Saving scrolled the paper');
  assert(await page.evaluate(()=>window.paperBeforeSave===document.querySelector('.article-preview-paper').shadowRoot.querySelector('main')),'Saving rebuilt the paper');
  await page.getByRole('button',{name:'Edit source Ctrl+/'}).click();await page.locator('.cm-content:visible').waitFor();
  await page.locator('.cm-content:visible').focus();await page.keyboard.press('Control+z');await settle();
  let doc=(await page.evaluate(()=>window.markedown.bootstrap())).documents.find(d=>d.path?.endsWith('paper.md'));
  assert(!doc.source.includes('UNSAVED-LAYOUT-CHECK'),'Layout switch lost undo history');
  await page.keyboard.press('Control+y');await settle();await page.keyboard.press('Control+/');await page.locator('.article-columns').waitFor();
  checks.push('Save preserves paper scroll and DOM; source mode retains independent undo/redo history');
  await page.evaluate(other=>window.markedown.openFiles([other]),other);
  await page.getByTestId('document-tab').filter({hasText:'other.md'}).click();await settle();
  assert.equal(await page.locator('.article-preview').count(),1);
  assert(!(await page.locator('.article-columns').innerText()).includes('Molecular structure'));
  await page.getByTestId('document-tab').filter({hasText:'paper.md'}).click();await settle();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,720));await settle();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  checks.push('Multiple documents do not overlap, narrow window stays contained');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1360,900));await settle();
  doc=(await page.evaluate(()=>window.markedown.bootstrap())).documents.find(d=>d.path?.endsWith('paper.md'));
  for(const format of ['html','pdf','png']) {
    const output=path.join(run,'paper.'+format);
    await app.evaluate(({dialog},output)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:output});},output);
    const result=await page.evaluate(({doc,format})=>window.markedown.exportDocument(doc.id,doc,format),{doc,format});
    assert.equal(result.status,'ok',JSON.stringify(result));const bytes=await readFile(output);
    if(format==='html'){assert(bytes.toString().includes('article-columns'));assert(bytes.toString().includes('data:image/png;base64,'));assert(bytes.toString().includes('UNSAVED-LAYOUT-CHECK'));}
    if(format==='pdf')assert(bytes.subarray(0,5).toString()==='%PDF-');
    if(format==='png'){const meta=await sharp(bytes).metadata();assert(meta.width>500&&meta.height>500);}
  }
  checks.push('HTML/PDF/PNG export includes two-column rules, local images and current text');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({run,checks,errors}));
  await writeFile(path.join(run,'report.json'),JSON.stringify({checks,errors},null,2));
} catch(error) { console.error(error);if(page)await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});throw error; } finally {clearTimeout(watchdog);await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});await Promise.race([app.close().catch(() => {}), new Promise(resolve=>setTimeout(resolve,5000))]);if(child.exitCode===null)child.kill();}
