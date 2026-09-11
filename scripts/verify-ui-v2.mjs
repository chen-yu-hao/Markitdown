import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const evidence = path.resolve('test-results', 'ui-v2');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const file = path.join(run, '中文 测试.md');
const second = path.join(run, 'second.md');
const source = '# Welcome to Markit\n\n## 中文写作与排版\n\n记录每一个值得留下的想法。Use **bold**, *emphasis* and ==highlights==.\n\n> [!NOTE]\n> Markdown 始终是文稿的唯一数据源。\n\n| 功能 | 体验 |\n| --- | --- |\n| 多标签 | 独立撤销 |\n| 五种主题 | 即时切换 |\n\n```javascript\nconst ideas = ["write", "think", "create"];\n```\n\n$$E = mc^2$$\n\n## 下一段\n\nFind this needle.\n';
await writeFile(file, source.replaceAll('\n', '\r\n')); await writeFile(second, '# Second\n\nIndependent history.\n');
const env = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.MARKEDOWN_DEV_URL;
const checks = [], errors = [];
let app, page;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const wait = async predicate => { const start = Date.now(); while(Date.now() - start < 10000) { if(await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Application state did not settle'); };
const current = () => page.evaluate(async () => { const id = document.querySelector('.document-tab.selected .dirty-dot')?.closest('.document-tab') || document.querySelector('.document-tab.selected'); const title = id?.getAttribute('title'); return (await window.markedown.bootstrap()).documents.find(doc => (doc.path || doc.title) === title); });
const menu = async (name, entry) => { await page.getByRole('menuitem', { name, exact: true }).click(); await page.getByRole('menuitem', { name: entry, exact: true }).click(); };
try {
  app = await electron.launch({ args: [process.cwd(), '--test-mode', file, second], env, timeout: 30000 });
  page = await app.firstWindow(); page.on('pageerror',error => errors.push(error.message));
  await page.locator('.cm-content:visible').waitFor();
  await page.evaluate(() => window.markedown.updateSettings({language:'zh-CN',autoSave:false,showToolbar:false}));
  await page.getByRole('menuitem',{name:'主题',exact:true}).waitFor();
  assert(await page.locator('.app-header').count()===0,'Old branded header remains');
  assert(await page.locator('.format-toolbar').count()===0,'Toolbar must be off by default');
  await page.getByTestId('document-tab').filter({hasText:'中文 测试.md'}).click();
  await page.locator('.cm-content:visible').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('中文 😀 e\u0301');
  await wait(async () => (await current())?.source.endsWith('中文 😀 e\u0301'));
  const typed=(await current()).source;
  for(const [theme,label] of [['github','Github'],['newsprint','Newsprint'],['night','Night'],['pixyll','Pixyll'],['whitey','Whitey']]) {
    await page.getByRole('menuitem',{name:'主题',exact:true}).click();
    await page.getByRole('menuitemcheckbox',{name:label,exact:true}).click();
    await page.waitForFunction(theme=>document.documentElement.dataset.editorTheme===theme,theme);
    assert((await current()).source===typed,`${theme} changed source`);
    await page.locator('.cm-content:visible').click(); await page.keyboard.press('Control+Home');
    await page.screenshot({path:path.join(evidence,`theme-${theme}.png`)});
  }
  checks.push('compact chrome and five theme choices','theme switches retain source and history');
  await page.locator('.cm-content:visible').click(); await page.keyboard.press('Control+z');
  await wait(async()=> (await current()).source===source);
  await page.getByTestId('document-tab').filter({hasText:'second.md'}).click(); await page.locator('.cm-content:visible').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('SECOND'); await page.keyboard.press('Control+z');
  await wait(async()=> (await current()).source==='# Second\n\nIndependent history.\n'); checks.push('independent undo survives settings and tab changes');
  await menu('编辑','偏好设置…');
  await page.getByRole('dialog',{name:'偏好设置',exact:true}).waitFor();
  for(const category of ['文件','编辑器','图像','Markdown','导出','外观','通用']) {
    await page.locator('.preferences-nav').getByRole('button',{name:category,exact:true}).click();
    await page.screenshot({path:path.join(evidence,`preferences-${['文件','编辑器','图像','Markdown','导出','外观','通用'].indexOf(category)}.png`)});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Preferences overflow');
  }
  await page.getByRole('textbox',{name:'搜索设置',exact:true}).fill('自动配对');
  assert(await page.getByRole('checkbox',{name:'自动配对括号和引号',exact:true}).count()===1,'Settings search missing editor option');
  await page.getByRole('checkbox',{name:'自动配对括号和引号',exact:true}).uncheck();
  await wait(()=>page.evaluate(async()=>!(await window.markedown.bootstrap()).settings.pairBrackets));
  await page.getByRole('button',{name:'关闭偏好设置',exact:true}).click();
  await page.keyboard.press('Control+,'); await page.getByRole('dialog',{name:'偏好设置',exact:true}).waitFor();
  await page.locator('.preferences-nav').getByRole('button',{name:'编辑器',exact:true}).click();
  assert(!await page.getByRole('checkbox',{name:'自动配对括号和引号',exact:true}).isChecked(),'Preference was not persisted');
  checks.push('seven searchable preferences categories','real settings changes persist');
  await page.locator('.preferences-nav').getByRole('button',{name:'通用',exact:true}).click(); await page.getByRole('button',{name:'自定义快捷键…',exact:true}).click();
  await page.getByRole('textbox',{name:'偏好设置快捷键',exact:true}).focus(); await page.keyboard.press('Control+Alt+p');
  await wait(()=>page.evaluate(async()=>(await window.markedown.bootstrap()).settings.shortcuts.settings==='Ctrl+Alt+P'));
  await page.getByRole('button',{name:'关闭偏好设置',exact:true}).click(); await page.keyboard.press('Control+Alt+p'); await page.getByRole('dialog',{name:'偏好设置',exact:true}).waitFor();
  checks.push('custom shortcut dispatch');
  await page.getByRole('button',{name:'关闭偏好设置',exact:true}).click();
  await page.evaluate(()=>window.markedown.updateSettings({theme:'github',language:'en',saveOnSwitch:true,autoSave:false}));
  await page.getByTestId('document-tab').filter({hasText:'中文 测试.md'}).click(); await page.locator('.cm-content:visible').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('SAVED ON SWITCH');
  await page.getByTestId('document-tab').filter({hasText:'second.md'}).click();
  await wait(async()=> (await readFile(file,'utf8')).includes('SAVED ON SWITCH')); checks.push('save previous document on tab switch');
  for(const [width,height] of [[900,650],[700,480]]) { await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height}); await page.screenshot({path:path.join(evidence,`window-${width}.png`)}); await page.keyboard.press('Control+Alt+p'); await page.getByTestId('preferences').waitFor(); await page.screenshot({path:path.join(evidence,`preferences-${width}.png`)}); assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Compact window overflow'); await page.keyboard.press('Escape'); }
  checks.push('900 and 700 pixel window layouts');
  assert(errors.length===0,errors.join('\n'));
  const result={status:'passed',checks,errors,run}; await writeFile(path.join(evidence,'results.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
} catch(error) {
  if(page) await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  await writeFile(path.join(evidence,'results.json'),JSON.stringify({status:'failed',checks,errors,error:String(error),run},null,2)); throw error;
} finally { if(app) { await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{}); await app.close(); } }
