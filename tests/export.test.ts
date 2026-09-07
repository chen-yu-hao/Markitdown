import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { defaultSettings, type DocumentSession } from '../src/shared/contracts';
import { buildExportHtml, constrainedImageSize, exportDocument, findPandoc } from '../src/main/export-service';
import { imageResponse, importImages, resolveImage } from '../src/main/image-service';

let directory: string;
const document = (overrides: Partial<DocumentSession> = {}): DocumentSession => ({
  id: 'test-document', path: path.join(directory, 'document.md'), title: 'Current draft', source: '', savedSource: '', dirty: false,
  recovered: false, bom: false, lineEnding: 'LF', revision: null, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 0,
  ...overrides,
});
const raster = (width = 32, height = 24) => sharp({ create: { width, height, channels: 4, background: '#24a080' } }).png().toBuffer();

beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-export-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('local image security and assets', () => {
  it('resolves relative, parent, encoded filenames and local file URLs', async () => {
    const filename = path.join(directory, 'figure #1 中文.png');
    await writeFile(filename, await raster());
    await mkdir(path.join(directory, 'chapters'));
    const expected = await realpath(filename);
    expect(await resolveImage(document().path, 'figure%20%231%20%E4%B8%AD%E6%96%87.png')).toBe(expected);
    expect(await resolveImage(path.join(directory, 'chapters', 'draft.md'), '../figure%20%231%20%E4%B8%AD%E6%96%87.png#preview')).toBe(expected);
    expect(await resolveImage(null, pathToFileURL(filename).href)).toBe(expected);
    expect(await resolveImage(null, filename)).toBe(expected);
    expect(await resolveImage(null, 'figure.png')).toBeNull();
  });

  it.each([
    'https://example.com/a.png', 'http://example.com/a.png', '//server/share/a.png', '\\\\server\\share\\a.png',
    'file://server/share/a.png', '%2f%2fserver/share/a.png', '%5c%5cserver\\share\\a.png', 'javascript:alert(1)',
    'data:image/svg+xml,<svg/>', 'data:image/png;base64,AAAA', 'file:////server/share/a.png', 'file:///C:/a.png:secret',
    'a%00.png', 'a\u0000.png', 'https%3A%2F%2Fexample.com/a.png', 'C:relative.png',
  ])('blocks unsafe destination %s', async destination => {
    expect(await resolveImage(document().path, destination)).toBeNull();
    expect(await imageResponse(document().path, destination)).toBeNull();
  });

  it('validates content before writing, preserves batch order, and escapes Markdown destinations', async () => {
    const first = await raster(22, 11);
    const second = await raster(33, 17);
    const destinations = await importImages(document(), [{ name: 'first (image).txt', bytes: first }, { name: 'second.png', bytes: second }]);
    expect(destinations).toHaveLength(2);
    expect(destinations[0]).toMatch(/^assets\/first%20%28image%29-.+\.png$/);
    expect(destinations[1]).toMatch(/^assets\/second-.+\.png$/);
    expect((await sharp(await readFile(path.join(directory, decodeURIComponent(destinations[0])))).metadata()).width).toBe(22);
    expect((await sharp(await readFile(path.join(directory, decodeURIComponent(destinations[1])))).metadata()).width).toBe(33);
    await expect(importImages(document(), [{ name: 'safe.png', bytes: first }, { name: 'fake.png', bytes: Buffer.from('<script>bad()</script>') }])).rejects.toThrow('Unsupported');
    expect(await readdir(path.join(directory, 'assets'))).toHaveLength(2);
    await expect(importImages(document({ path: null }), [{ name: 'image.png', bytes: first }])).rejects.toThrow('Save');
  });

  it('creates bounded thumbnails and notices an image replaced on disk', async () => {
    const filename = path.join(directory, 'large.png');
    await writeFile(filename, await raster(3000, 1500));
    const first = await imageResponse(document().path, 'large.png');
    expect(first?.mime).toBe('image/png');
    expect(await sharp(first!.data).metadata()).toMatchObject({ width: 2048, height: 1024 });
    await writeFile(filename, await raster(21, 14));
    expect(await sharp((await imageResponse(document().path, 'large.png'))!.data).metadata()).toMatchObject({ width: 21, height: 14 });
    expect(await imageResponse(document().path, 'missing.png')).toBeNull();
  });

  it('preserves animated GIF bytes', async () => {
    const pixels = Buffer.alloc(2 * 2 * 4 * 3);
    for (let index = 0; index < pixels.length; index += 3) { pixels[index] = index < 12 ? 255 : 0; pixels[index + 1] = index < 12 ? 0 : 255; }
    const gif = await sharp(pixels, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
    await writeFile(path.join(directory, 'animated.gif'), gif);
    const response = await imageResponse(document().path, 'animated.gif');
    expect(response?.mime).toBe('image/gif');
    expect(response?.data).toEqual(gif);
  });
});

describe('standalone exports', () => {
  it('embeds current source, local images and offline fonts, with scripts and remote requests blocked', async () => {
    await writeFile(path.join(directory, 'figure.png'), await raster());
    const current = document({ source: '# Current unsaved draft\n\n$x^2$\n\n![Figure](figure.png)\n\n![remote](https://example.com/tracker.png)\n\n<script>alert(1)</script>', savedSource: '# Old saved content', dirty: true });
    const html = await buildExportHtml(current, defaultSettings);
    expect(html).toContain('Current unsaved draft');
    expect(html).not.toContain('Old saved content');
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).toContain('class="katex"');
    expect(html).toContain('script-src \'none\'');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('src="https://example.com');
    expect(html.includes('loading="lazy"')).toBe(false);
    expect(html).toContain('<nav class="export-outline"');
    const target = path.join(directory, 'standalone.html');
    await exportDocument(current, 'html', target, defaultSettings);
    expect(await readFile(target, 'utf8')).toBe(html);
  });

  it('allows optional remote images only in HTML and omits optional contents', async () => {
    const current = document({ source: '# Heading\n\n![remote](https://example.com/image.png)' });
    const options = { ...defaultSettings, exportOutline: false, htmlRemoteImages: true };
    expect(await buildExportHtml(current, options)).toContain('src="https://example.com/image.png"');
    expect(await buildExportHtml(current, options, 'pdf')).not.toContain('src="https://example.com/image.png"');
    expect(await buildExportHtml(current, options)).not.toContain('<nav class="export-outline"');
  });

  it('constrains long captures without exceeding the dimension and pixel budgets', () => {
    expect(constrainedImageSize(1200, 900)).toEqual({ width: 1200, height: 900, scale: 1 });
    const tall = constrainedImageSize(1200, 60_000);
    expect(tall.height).toBe(16384);
    expect(tall.width).toBeLessThan(1200);
    const large = constrainedImageSize(20_000, 20_000);
    expect(large.width * large.height).toBeLessThanOrEqual(40_000_000);
    expect(() => constrainedImageSize(1200, 1_000_001)).toThrow('limit');
    expect(() => constrainedImageSize(Number.NaN, 100)).toThrow('limit');
  });

  it('reports absent or incorrect Pandoc installations', async () => {
    expect(await findPandoc(path.join(directory, 'absent-pandoc.exe'))).toBeNull();
    expect(await findPandoc(process.execPath)).toBeNull();
    await expect(exportDocument(document({ source: 'Unsaved content' }), 'docx', path.join(directory, 'out.docx'), { ...defaultSettings, pandocPath: path.join(directory, 'missing.exe') })).rejects.toThrow('Pandoc was not found');
  });

  it('exports current content through an available Pandoc and rejects network image input', async context => {
    const pandoc = await findPandoc();
    if (!pandoc) { context.skip(); return; }
    await writeFile(path.join(directory, 'local figure.png'), await raster());
    const settings = { ...defaultSettings, pandocPath: pandoc };
    const current = document({ source: '# Current unsaved heading\n\nUnsaved paragraph.\n\n$x^2$\n\n![Figure](local%20figure.png)', savedSource: 'Old version', dirty: true });
    for (const format of ['docx', 'epub', 'tex', 'rtf', 'odt'] as const) {
      const target = path.join(directory, `export.${format}`);
      await exportDocument(current, format, target, settings);
      const bytes = await readFile(target);
      expect(bytes.length).toBeGreaterThan(100);
      if (['docx', 'epub', 'odt'].includes(format)) expect(bytes.toString('ascii', 0, 2)).toBe('PK');
      else expect(bytes.toString('utf8')).toContain('Unsaved paragraph');
    }
    await expect(exportDocument(document({ source: '![Remote](https://example.com/tracker.png)' }), 'docx', path.join(directory, 'network.docx'), settings)).rejects.toThrow('cannot resolve a local image');
  }, 30_000);
});
