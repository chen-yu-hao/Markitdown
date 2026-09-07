import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { defaultSettings, type DocumentSession } from '../src/shared/contracts';
import { importImages, imageResponse } from '../src/main/image-service';
import { buildExportHtml } from '../src/main/export-service';

let directory: string;
let smallPng: Buffer;
let largePng: Buffer;
const settings = { ...defaultSettings, language: 'en' as const, exportOutline: false };
const document = (source = ''): DocumentSession => ({
  id: 'large-image-test', path: path.join(directory, 'draft.md'), title: 'Image draft', source, savedSource: '', dirty: true,
  recovered: false, bom: false, lineEnding: 'LF', revision: null, mode: 'live', selection: { anchor: 0, head: 0 }, scrollTop: 0, editVersion: 1,
});

function oversizedPngHeader(width: number, height: number): Buffer {
  const data = Buffer.from(smallPng);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  data.writeUInt32BE(crc32(data.subarray(12, 29)), 29);
  return data;
}

async function animatedGif(frames: number): Promise<Buffer> {
  const pixels = Buffer.alloc(frames * 3);
  for (let frame = 0; frame < frames; frame++) pixels[frame * 3 + frame % 2] = 255;
  return sharp(pixels, { raw: { width: 1, height: frames, channels: 3, pageHeight: 1 } }).gif({ delay: Array(frames).fill(20), loop: 0 }).toBuffer();
}

// Alter only GIF canvas/frame headers; the over-budget fixture must never be decoded.
function oversizedGifHeaders(input: Buffer, width: number, height: number): Buffer {
  const data = Buffer.from(input);
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  const colorTableBytes = (packed: number) => packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0;
  let offset = 13 + colorTableBytes(data[10]);
  const skipBlocks = () => { while (data[offset]) offset += data[offset] + 1; offset++; };
  while (offset < data.length) {
    const marker = data[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) { offset++; skipBlocks(); continue; }
    if (marker !== 0x2c) throw new Error('Invalid GIF fixture block.');
    data.writeUInt16LE(width, offset + 4);
    data.writeUInt16LE(height, offset + 6);
    const tableBytes = colorTableBytes(data[offset + 8]);
    offset += 9 + tableBytes + 1;
    skipBlocks();
  }
  return data;
}

beforeAll(async () => {
  smallPng = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#287e68' } }).png().toBuffer();
  // The constant-image source is lazy in libvips, avoiding an 80 MP raw JS buffer.
  largePng = await sharp({ create: { width: 10_000, height: 8_001, channels: 3, background: '#287e68' } }).png().toBuffer();
}, 60_000);
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-image-service-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('large image admission and rendering', () => {
  it('imports a real image above 80 MP unchanged and keeps preview and HTML export consistent', async () => {
    expect(largePng.length).toBeLessThan(64 * 1024 * 1024);
    const [destination] = await importImages(document(), [{ name: 'large.png', bytes: largePng }], settings);
    const stored = await readFile(path.join(directory, decodeURIComponent(destination)));
    expect(stored.equals(largePng)).toBe(true);

    const preview = await imageResponse(document().path, destination);
    expect(preview?.mime).toBe('image/png');
    expect(await sharp(preview!.data).metadata()).toMatchObject({ width: 2048, height: 1639 });

    const full = await imageResponse(document().path, destination, { thumbnails: false });
    expect(full?.data.equals(largePng)).toBe(true);
    expect(await sharp(full!.data).metadata()).toMatchObject({ width: 10_000, height: 8_001 });
    const html = await buildExportHtml(document(`![Large figure](${destination})`), settings);
    const embedded = /data:image\/png;base64,([^"\s]+)/.exec(html);
    expect(embedded).not.toBeNull();
    expect(Buffer.from(embedded![1], 'base64').equals(largePng)).toBe(true);
    expect(/class="image-unavailable"/.test(html)).toBe(false);
  }, 60_000);

  it('rejects images beyond 256 MP with dimensions before creating assets', async () => {
    const bytes = oversizedPngHeader(16_001, 16_000);
    await expect(importImages(document(), [{ name: 'oversized.png', bytes }], settings)).rejects.toThrow(/16[,.]?001.*16[,.]?000/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects corrupt images and rolls back a mixed batch without touching existing assets', async () => {
    const corrupt = smallPng.subarray(0, 50);
    await expect(importImages(document(), [{ name: 'corrupt.png', bytes: corrupt }], settings)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    const [existing] = await importImages(document(), [{ name: 'existing.png', bytes: smallPng }], settings);
    const before = await readdir(path.join(directory, 'assets'));
    for (const bytes of [corrupt, oversizedPngHeader(16_001, 16_000)]) {
      await expect(importImages(document(), [{ name: 'first.png', bytes: smallPng }, { name: 'invalid.png', bytes }], settings)).rejects.toThrow();
      expect(await readdir(path.join(directory, 'assets'))).toEqual(before);
      expect(await readFile(path.join(directory, decodeURIComponent(existing)))).toEqual(smallPng);
    }
  });

  it('rejects a broken PNG pixel stream even when its dimension headers are valid', async () => {
    const bytes = Buffer.from(smallPng);
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
        bytes[offset + 8] ^= 0xff;
        bytes.writeUInt32BE(crc32(bytes.subarray(offset + 4, offset + 8 + length)), offset + 8 + length);
        break;
      }
      offset += length + 12;
    }
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 2, height: 2 });
    const [destination] = await importImages(document(), [{ name: 'broken-pixels.png', bytes }], settings);
    expect(await imageResponse(document().path, destination, { thumbnails: false })).toBeNull();
    expect(await imageResponse(document().path, destination)).toBeNull();
    const [valid] = await importImages(document(), [{ name: 'valid.png', bytes: smallPng }], settings);
    expect((await imageResponse(document().path, valid))?.mime).toBe('image/png');
  });

  it('preserves successful batch order across ordinary and large images', async () => {
    const destinations = await importImages(document(), [{ name: 'first.png', bytes: smallPng }, { name: 'second.png', bytes: largePng }], settings);
    expect(destinations[0]).toMatch(/\/first-/);
    expect(destinations[1]).toMatch(/\/second-/);
    expect(await readFile(path.join(directory, decodeURIComponent(destinations[0])))).toEqual(smallPng);
    expect((await readFile(path.join(directory, decodeURIComponent(destinations[1])))).equals(largePng)).toBe(true);
  });
});

describe('animation budgets remain independent from static images', () => {
  it('rejects an animation above 80 MP total even when each frame fits', async () => {
    const bytes = oversizedGifHeaders(await animatedGif(2), 10_000, 5_000);
    expect(await sharp(bytes, { animated: true, limitInputPixels: false }).metadata()).toMatchObject({ width: 10_000, pageHeight: 5_000, pages: 2 });
    await expect(importImages(document(), [{ name: 'oversized.gif', bytes }], settings)).rejects.toThrow(/80|animation|multi.page|pixel/i);
    expect(await readdir(directory)).toEqual([]);
  });

  it('accepts 500 small frames unchanged and rejects 501 frames before writing', async () => {
    const tooMany = await animatedGif(501);
    expect((await sharp(tooMany, { animated: true }).metadata()).pages).toBe(501);
    await expect(importImages(document(), [{ name: 'too-many.gif', bytes: tooMany }], settings)).rejects.toThrow(/500|frame/i);
    expect(await readdir(directory)).toEqual([]);

    const accepted = await animatedGif(500);
    const [destination] = await importImages(document(), [{ name: 'accepted.gif', bytes: accepted }], settings);
    expect(await readFile(path.join(directory, decodeURIComponent(destination)))).toEqual(accepted);
    expect((await imageResponse(document().path, destination))?.data).toEqual(accepted);
  }, 30_000);
});
