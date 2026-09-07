import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { defaultSettings, type DocumentSession } from '../src/shared/contracts';
import { imageResponse, importImages, resolveImage } from '../src/main/image-service';
import { buildExportHtml, exportDocument, findPandoc, importDocumentToMarkdown } from '../src/main/export-service';
const execFileAsync = promisify(execFile);

let directory: string;
const document = (source = ''): DocumentSession => ({ id: 'settings-test', path: path.join(directory, 'draft.md'), title: 'Settings draft', source, savedSource: '', dirty: true, recovered: false, bom: false, lineEnding: 'LF', revision: null, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 1 });
const raster = (width = 32, height = 24) => sharp({ create: { width, height, channels: 4, background: '#218760' } }).png().toBuffer();

beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-export-settings-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('image preferences', () => {
  it('imports into custom relative and absolute folders with resolvable destinations', async () => {
    const bytes = await raster();
    const relative = await importImages(document(), [{ name: '画面 #1.png', bytes }], { imageFolder: '插图 (本地)' });
    expect(relative[0]).toMatch(/^%E6%8F%92%E5%9B%BE%20%28%E6%9C%AC%E5%9C%B0%29\//);
    const resolved = await resolveImage(document().path, relative[0]);
    expect(path.dirname(resolved!)).toBe(await realpath(path.join(directory, '插图 (本地)')));
    const absolute = await importImages(document(), [{ name: 'space #1.png', bytes }], { imageFolder: path.join(directory, 'global assets'), imageUseRelative: false });
    expect(absolute[0]).toMatch(/^file:\/\/\//);
    expect(absolute[0]).toContain('global%20assets');
    expect(await resolveImage(null, absolute[0])).not.toBeNull();
  });

  it('keeps readable spaces and Unicode when auto escape is off, while protecting URI delimiters', async () => {
    const bytes = await raster();
    for (const imageUseRelative of [true, false]) {
      const [destination] = await importImages(document(), [{ name: '图 #1 %.png', bytes }], { imageFolder: 'my images', imageUseRelative, imageAutoEscape: false });
      expect(destination).toContain('my images');
      expect(destination).toContain('图 %231 %25');
      expect(await resolveImage(document().path, destination)).not.toBeNull();
    }
  });

  it('rejects network and URI folders before importing', async () => {
    const bytes = await raster();
    for (const folder of ['//server/share', '\\\\server\\share', 'https://example.com/assets', 'file:///C:/assets', 'assets\u0000x']) {
      await expect(importImages(document(), [{ name: 'image.png', bytes }], { imageFolder: folder })).rejects.toThrow('local image folder');
    }
  });

  it('does not reuse a thumbnail for a full size request', async () => {
    await writeFile(path.join(directory, 'large.png'), await raster(3000, 1500));
    const thumbnail = await imageResponse(document().path, 'large.png');
    const full = await imageResponse(document().path, 'large.png', { thumbnails: false });
    expect(await sharp(thumbnail!.data).metadata()).toMatchObject({ width: 2048, height: 1024 });
    expect(await sharp(full!.data).metadata()).toMatchObject({ width: 3000, height: 1500 });
    expect(await sharp((await imageResponse(document().path, 'large.png'))!.data).metadata()).toMatchObject({ width: 2048, height: 1024 });
  });
});

describe('export preferences', () => {
  it('writes plain HTML with MathML and embedded full size images without a theme', async () => {
    await writeFile(path.join(directory, 'large.png'), await raster(3000, 1500));
    const current = document('# Heading\n\n$x^2$\n\n![Image](large.png)\n\n<script>alert(1)</script>');
    const target = path.join(directory, 'plain.html');
    await exportDocument(current, 'htmlPlain', target, { ...defaultSettings, mathOutput: 'mathml' });
    const html = await readFile(target, 'utf8');
    expect(html).toContain('<h1');
    expect(html).toContain('<math');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('data-theme=');
    expect(html).not.toContain('katex-html');
    expect(html).not.toContain('<script>');
    const encodedImage = /data:image\/png;base64,([^"\s]+)/.exec(html)![1];
    expect(await sharp(Buffer.from(encodedImage, 'base64')).metadata()).toMatchObject({ width: 3000, height: 1500 });
  });

  it('applies the chosen export theme to HTML, PDF and PNG, and uses neutral styling when disabled', async () => {
    for (const format of ['html', 'pdf', 'png'] as const) {
      const html = await buildExportHtml(document('# Heading'), { ...defaultSettings, theme: 'night', exportTheme: true }, format);
      expect(html.includes('data-theme="night"')).toBe(true);
      expect(html.includes('data-theme="github"')).toBe(false);
    }
    expect((await buildExportHtml(document(), { ...defaultSettings, theme: 'night', exportTheme: false })).includes('data-theme="github"')).toBe(true);
  });

  it('supports all added Pandoc export formats using current content', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    for (const format of ['mediawiki', 'rst', 'textile', 'opml'] as const) {
      const target = path.join(directory, `output.${format}`);
      await exportDocument(document('# Draft heading\n\nCurrent paragraph.\n\n## Child'), format, target, { ...defaultSettings, pandocPath });
      expect(await readFile(target, 'utf8')).toContain('Draft heading');
    }
  }, 30_000);

  it('uses Markdown switches and layout preferences in standalone output', async () => {
    const html = await buildExportHtml(document('# ==Heading==\n\n$math$ ==mark== www.example.com\n\n```ts\nconst x = 1;\n```'), { ...defaultSettings, inlineMath: false, highlight: false, autoLinks: false, readingWidth: 1400, fontSize: 24, fontSizeMode: 'custom', codeWordWrap: false, codeLineNumbers: true });
    expect(html.includes('max-width:1400px')).toBe(true);
    expect(html.includes('font-size:24px')).toBe(true);
    expect(html.includes('class="katex"')).toBe(false);
    expect(html.includes('<mark>')).toBe(false);
    expect(html.includes('href="http://www.example.com"')).toBe(false);
    expect(html.includes('md-code-numbered')).toBe(true);
    const headingId = /<h1 id="([^"]+)"/.exec(html)![1];
    expect(html.includes(`href="#${headingId}"`)).toBe(true);
  });
});

describe('Pandoc document import', () => {
  it('imports Office and EPUB content with durable media, preserving the original document', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    await writeFile(path.join(directory, 'local image.png'), await raster(42, 28));
    const settings = { ...defaultSettings, pandocPath };
    const current = document('# Imported heading\n\nText with **emphasis**.\n\n![Figure](local%20image.png)');
    for (const format of ['docx', 'odt', 'epub'] as const) {
      const input = path.join(directory, `original.${format}`);
      await exportDocument(current, format, input, settings);
      const original = await readFile(input);
      const target = path.join(directory, `converted-${format}.md`);
      const source = await importDocumentToMarkdown(input, target, settings);
      expect(source).toContain('Imported heading');
      expect(source).toContain('**emphasis**');
      expect(source).toMatch(/assets\/import-[a-z\d-]+\//);
      const html = await buildExportHtml({ ...document(source), path: target }, settings, 'htmlPlain');
      const image = /data:image\/png;base64,([^"\s]+)/.exec(html);
      expect(image).not.toBeNull();
      expect(await sharp(Buffer.from(image![1], 'base64')).metadata()).toMatchObject({ width: 42, height: 28 });
      expect(await readFile(input)).toEqual(original);
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 30_000);

  it('imports local HTML images and preserves remote references without fetching them', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const remote = `http://127.0.0.1:${address.port}/never-download.png`;
      const input = path.join(directory, 'page.html');
      const image = await raster();
      await writeFile(path.join(directory, 'local.png'), image);
      await writeFile(input, `<h1>HTML import</h1><p>Current content</p><img src="local.png" alt="Local"><img src="data:image/png;base64,${image.toString('base64')}" alt="Embedded"><img src="${remote}" alt="Remote"><script>alert(1)</script>`);
      const source = await importDocumentToMarkdown(input, path.join(directory, 'converted.md'), { ...defaultSettings, pandocPath });
      expect(source).toContain('HTML import');
      expect(source).toContain('assets/import-');
      expect(source).toContain(remote);
      expect(source).not.toContain('data:image');
      expect(source).not.toContain('<script>');
      expect(requests).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 30_000);

  it('imports the supported text formats and provides an upgrade message for unavailable readers', async context => {
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const settings = { ...defaultSettings, pandocPath };
    const { stdout: readers } = await execFileAsync(pandocPath, ['--list-input-formats'], { windowsHide: true });
    for (const format of ['rst', 'textile', 'mediawiki', 'opml', 'rtf'] as const) {
      const input = path.join(directory, `original.${format}`);
      await exportDocument(document('# Imported heading\n\nParagraph\n\n## Child'), format, input, settings);
      if (readers.split(/\s+/).includes(format)) expect(await importDocumentToMarkdown(input, path.join(directory, `${format}.md`), settings)).toContain('Imported heading');
      else await expect(importDocumentToMarkdown(input, path.join(directory, `${format}.md`), settings)).rejects.toThrow('newer Pandoc');
    }
  }, 30_000);

  it('rejects unsupported documents and malformed archives', async context => {
    await expect(importDocumentToMarkdown(path.join(directory, 'bad.exe'), path.join(directory, 'out.md'), defaultSettings)).rejects.toThrow('format');
    const pandocPath = await findPandoc();
    if (!pandocPath) { context.skip(); return; }
    const archive = Buffer.alloc(22);
    archive.writeUInt32LE(0x06054b50, 0);
    archive.writeUInt16LE(1, 4);
    const input = path.join(directory, 'bad.docx');
    await writeFile(input, archive);
    await expect(importDocumentToMarkdown(input, path.join(directory, 'out.md'), { ...defaultSettings, pandocPath })).rejects.toThrow('ZIP archive');
  });
});
