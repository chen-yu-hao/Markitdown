import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

const execFileAsync = promisify(execFile);
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

async function renderWithWord(docx, pdf) {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$existing = @([Diagnostics.Process]::GetProcessesByName('WINWORD') | ForEach-Object { $_.Id })
$started = [DateTime]::Now
$application = $null; $document = $null; $owned = $false
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MarkedownWordOwner { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); }'
  $application = New-Object -ComObject Word.Application
  $created = @([Diagnostics.Process]::GetProcessesByName('WINWORD') | Where-Object { $existing -notcontains $_.Id })
  if ($created.Count -ne 1 -or $created[0].StartTime -lt $started) { throw 'Word did not create an identifiable new process; no document was opened.' }
  [uint32]$wordProcessId = $created[0].Id
  if ($application.Visible -or $application.Documents.Count -ne 0 -or $application.Windows.Count -ne 0) { throw 'The automation application is not an empty hidden instance; no document was opened.' }
  $document = $application.Documents.Open([string]$request.docx, $false, $true, $false)
  [uint32]$windowProcessId = 0
  [void][MarkedownWordOwner]::GetWindowThreadProcessId([IntPtr]$document.ActiveWindow.Hwnd, [ref]$windowProcessId)
  if ($windowProcessId -ne $wordProcessId -or -not [String]::Equals([string]$document.FullName, [string]$request.docx, [StringComparison]::OrdinalIgnoreCase)) { throw 'The Word document window does not belong to the expected new process and file; it was not closed.' }
  $owned = $true
  [Console]::Error.WriteLine(('Verified test Word process: ' + $wordProcessId + ', started ' + $created[0].StartTime.ToString('o')))
  $application.DisplayAlerts = 0
  $application.AutomationSecurity = 3
  $document.ExportAsFixedFormat([string]$request.pdf, 17)
  [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ version = [string]$application.Version; processId = $wordProcessId; nativeEquations = $document.OMaths.Count; inlineImages = $document.InlineShapes.Count; pageWidth = $document.PageSetup.PageWidth; leftMargin = $document.PageSetup.LeftMargin; rightMargin = $document.PageSetup.RightMargin }))
} finally {
  $noSave = 0
  try { if ($document -ne $null) { try { if ($owned) { $document.Close([ref]$noSave) } } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) } } }
  finally { if ($application -ne $null) { try { if ($owned -and $application.Documents.Count -eq 0) { $application.Quit([ref]$noSave) } } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) } } }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
`;
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`Word rendering failed: ${stderr || error.message}`)); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch (failure) { reject(failure); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ docx, pdf }));
  });
}

const evidence = path.resolve('test-results/academic-live');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const keys = ['D9PGQUM4', 'T4IQZGRM', 'MRHTZ5CI'];
const source = (await readFile('resources/AcademicExample.md', 'utf8')).replace('<!-- markedown:bibliography -->', '![Local figure](figure%20image.png)\n\n<!-- markedown:bibliography -->') + '\n\nCURRENT-UNSAVED-ACADEMIC-CONTENT\n';
const filename = path.join(run, '论文 draft.md');
await writeFile(filename, '# Old disk content\n');
await writeFile(path.join(run, 'unsaved-source.md'), source, 'utf8');
await sharp({ create: { width: 500, height: 140, channels: 3, background: '#2e8a78' } }).png().toFile(path.join(run, 'figure image.png'));
const env = { ...process.env, MARKEDOWN_DATA_DIR: path.join(run, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MARKEDOWN_DEV_URL;
const executablePath = process.argv[2] && path.resolve(process.argv[2]);
const app = await electron.launch({ ...(executablePath ? { executablePath, args: ['--test-mode'] } : { args: [process.cwd(), '--test-mode'] }), env, timeout: 30_000 });
const errors = [], checks = [];
const files = {};
let page, status;
try {
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content:visible').waitFor();
  await page.evaluate(() => window.markedown.updateSettings({ autoSave: false, language: 'zh-CN', mathNumbering: 'all', mathNumberingStyle: 'document', citationStyle: 'numeric', exportOutline: false }));
  status = await page.evaluate(() => window.markedown.references.status());
  assert(status.available, 'This live check requires Zotero with its local API enabled.');
  const data = await page.evaluate(source => window.markedown.references.resolve(source, true), source);
  assert.deepEqual(data.entries.map(item => item.key), keys);
  assert.deepEqual(data.missing, []);
  assert.equal(data.offline, false);
  assert(data.bibliography.includes('ref-D9PGQUM4'));
  checks.push('real Zotero ' + status.version + ' via preload: supplied three keys resolve to CSL bibliography');
  const keySearch = await page.evaluate(key => window.markedown.references.search(key), keys[0]);
  assert.deepEqual(keySearch.items.map(item => item.key), [keys[0]]);
  checks.push('real Zotero item-key search returns the exact requested reference');
  const extensions = await page.evaluate(() => window.markedown.extensions.list());
  assert.deepEqual(extensions.map(item => item.id).sort(), ['markedown.citations', 'markedown.equations', 'markedown.zotero']);
  const opened = await page.evaluate(filename => window.markedown.openFiles([filename]), filename);
  assert.equal(opened.status, 'ok');
  const doc = opened.value[0];
  await page.waitForFunction(filename => document.querySelector('.document-tab.selected')?.getAttribute('title') === filename, filename);
  await page.bringToFront();
  await page.locator('.cm-content:visible').focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(source);
  await page.waitForFunction(async ({ id, source }) => (await window.markedown.bootstrap()).documents.find(item => item.id === id)?.source === source, { id: doc.id, source });
  await page.keyboard.press('Control+Home');
  await page.locator('.md-citation').first().waitFor({ timeout: 20_000 });
  await page.screenshot({ path: path.join(run, 'editor-live.png') });
  const current = await page.evaluate(async id => (await window.markedown.bootstrap()).documents.find(item => item.id === id), doc.id);
  assert(current.dirty, 'Typing through the real editor must leave the source unsaved.');
  const patch = { source: current.source, mode: current.mode, selection: current.selection, scrollTop: current.scrollTop, editVersion: current.editVersion };
  checks.push('real editor typing updates its unsaved snapshot and renders live citations');
  for (const format of ['html', 'pdf', 'png', 'docx']) {
    const target = path.join(run, 'academic.' + format);
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, target);
    const result = await page.evaluate(({ id, patch, format }) => window.markedown.exportDocument(id, patch, format), { id: doc.id, patch, format });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    const bytes = await readFile(target);
    files[format] = { path: target, bytes: bytes.length };
    if (format === 'html') {
      const html = bytes.toString('utf8');
      assert(html.includes('CURRENT-UNSAVED-ACADEMIC-CONTENT'));
      for (const key of keys) assert(html.includes('id="ref-' + key + '"'));
      assert(html.includes('data:image/png;base64,'));
      assert(html.includes('class="md-equation-reference"'));
      assert(!/class="[^"]*\bcitation-unresolved\b/.test(html));
      assert(html.indexOf('id="markedown-references"') < html.indexOf('id="附录"'));
    } else if (format === 'pdf') {
      assert.equal(bytes.toString('ascii', 0, 5), '%PDF-');
      const extracted = process.env.PDFTOTEXT
        ? await execFileAsync(process.env.PDFTOTEXT, ['-enc', 'UTF-8', '-layout', target, '-'], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
        : await execFileAsync(process.env.MARKEDOWN_QA_PYTHON || 'python', ['-c', 'import sys; from pypdf import PdfReader; sys.stdout.reconfigure(encoding="utf-8"); print("\\n".join(page.extract_text() or "" for page in PdfReader(sys.argv[1]).pages))', target], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      const stdout = extracted.stdout.replaceAll('\r\n', '\n');
      await writeFile(path.join(run, 'academic-pdf.txt'), stdout, 'utf8');
      assert(stdout.includes('CURRENT-UNSAVED-ACADEMIC-CONTENT'));
      assert(stdout.includes('Gagliardi') && stdout.includes('Multiconfiguration'));
      for (const number of ['(1)', '(2)', '(3)', '(4)']) assert(stdout.includes(number), `PDF is missing equation number ${number}`);
      assert(stdout.indexOf('参考文献') < stdout.indexOf('附录\n'));
      assert(!stdout.includes('[@') && !stdout.includes('\\label'));
      await execFileAsync(process.env.PDFTOPPM || 'pdftoppm', ['-png', '-r', '110', target, path.join(run, 'pdf-page')], { windowsHide: true, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
      files.pdf.pages = (await readdir(run)).filter(name => /^pdf-page-\d+\.png$/.test(name)).sort().map(name => path.join(run, name));
      assert(files.pdf.pages.length > 0);
    }
    else if (format === 'png') {
      const metadata = await sharp(bytes).metadata();
      const stats = await sharp(bytes).stats();
      assert(metadata.width > 0 && metadata.height > 0 && stats.channels.some(channel => channel.stdev > 5));
      files.png.width = metadata.width; files.png.height = metadata.height;
    } else {
      const zip = unzipSync(bytes), xml = strFromU8(zip['word/document.xml']);
      const body = new DOMParser().parseFromString(xml, 'application/xml');
      const paragraphs = Array.from(body.getElementsByTagNameNS(W, 'p'));
      const text = paragraphs.map(item => item.textContent || '').join('\n');
      const nativeMath = body.getElementsByTagNameNS(M, 'oMath').length;
      const numberedMath = paragraphs.filter(item => item.getElementsByTagNameNS(M, 'oMath').length && /\([1-4]\)/.test(item.textContent || '')).length;
      const media = Object.keys(zip).filter(name => name.startsWith('word/media/'));
      assert(text.includes('CURRENT-UNSAVED-ACADEMIC-CONTENT'));
      assert(nativeMath >= 4 && numberedMath >= 4, 'Word must retain native equations and all four adjoining numbers.');
      assert.equal(media.length, 1);
      assert(text.indexOf('Multiconfiguration Pair-Density Functional Theory') < text.indexOf('\n附录\n'));
      assert(!text.includes('[@') && !text.includes('\\label'));
      const bookmarks = new Set(Array.from(body.getElementsByTagNameNS(W, 'bookmarkStart')).map(item => item.getAttributeNS(W, 'name')));
      const anchors = Array.from(body.getElementsByTagNameNS(W, 'hyperlink')).map(item => item.getAttributeNS(W, 'anchor')).filter(Boolean);
      assert(anchors.length > 0 && anchors.every(anchor => bookmarks.has(anchor)), 'Word citation and equation links must target existing bookmarks.');
      const page = body.getElementsByTagNameNS(W, 'pgSz')[0], margins = body.getElementsByTagNameNS(W, 'pgMar')[0];
      assert(page && margins, 'Numbered Word equations need an explicit page width and margins.');
      files.docx.availableWidth = (Number(page.getAttributeNS(W, 'w')) - Number(margins.getAttributeNS(W, 'left')) - Number(margins.getAttributeNS(W, 'right'))) / 20;
      files.docx.nativeMath = nativeMath; files.docx.numberedMath = numberedMath; files.docx.media = media;
    }
  }
  checks.push('actual HTML/PDF/PNG/DOCX IPC export with live Zotero data, local media and unsaved source');
  const wordPdf = path.join(run, 'academic-word.pdf');
  const word = await renderWithWord(files.docx.path, wordPdf);
  assert(word.nativeEquations >= 4 && word.inlineImages === 1, 'Installed Word must load the actual DOCX equations and image.');
  assert(Math.abs(word.pageWidth - word.leftMargin - word.rightMargin - files.docx.availableWidth) < 0.1, 'Actual Word text width must match the equation tab stops.');
  await execFileAsync(process.env.PDFTOPPM || 'pdftoppm', ['-png', '-r', '110', wordPdf, path.join(run, 'word-page')], { windowsHide: true, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
  files.wordPdf = { path: wordPdf, bytes: (await readFile(wordPdf)).length, ...word, pages: (await readdir(run)).filter(name => /^word-page-\d+\.png$/.test(name)).sort().map(name => path.join(run, name)) };
  assert(files.wordPdf.pages.length > 0);
  checks.push('installed Word opens DOCX with native equations, then renders PDF in an isolated hidden process');
  assert.equal(await readFile(filename, 'utf8'), '# Old disk content\n');
  assert.deepEqual(errors, []);
  const report = { result: 'passed', run, executablePath, status, checks, files, errors };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ run, checks, files, errors }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  const report = { result: 'failed', run, executablePath, status, checks, files, errors, error: String(error) };
  await writeFile(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
  await app.close();
}
