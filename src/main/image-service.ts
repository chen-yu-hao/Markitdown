import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import type { DocumentSession, ImageInput, Settings } from '../shared/contracts';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 256_000_000;
const MAX_ANIMATED_IMAGE_PIXELS = 80_000_000;
const MAX_IMAGE_BATCH_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const localDrives = new Map<string, { expires: number; result: Promise<boolean> }>();
const thumbnailCache = new Map<string, { data: Buffer; mime: string; cost: number }>();
let thumbnailCacheBytes = 0;
type ImageResponse = { data: Buffer; mime: string };
const imageRequests = new Map<string, Promise<ImageResponse>>();
let imageWorker: Promise<unknown> = Promise.resolve();

function processImage<T>(operation: () => Promise<T>): Promise<T> {
  // Bound simultaneous native decodes, including previews requested by different windows.
  const result = imageWorker.then(operation);
  imageWorker = result.catch(() => {});
  return result;
}

function isNetworkPath(value: string): boolean {
  return /^[\\/]{2}/.test(value) || /^\\[?.]\\/.test(value);
}

async function isLocalDrive(candidate: string): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const root = path.parse(candidate).root;
  if (!/^[a-z]:\\$/i.test(root)) return false;
  const existing = localDrives.get(root.toLowerCase());
  if (existing && existing.expires > Date.now()) return existing.result;
  const script = `([System.IO.DriveInfo]::new('${root}')).DriveType.ToString()`;
  const result = execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000 })
    .then(({ stdout }) => ['Fixed', 'Removable', 'CDRom', 'Ram'].includes(stdout.trim()))
    .catch(() => false);
  localDrives.set(root.toLowerCase(), { expires: Date.now() + 60_000, result });
  return result;
}

/** Resolve only existing local files. Decode after dropping URL fragments so encoded # remains a filename character. */
export async function resolveImage(documentPath: string | null, destination: string): Promise<string | null> {
  try {
    let value = destination.trim();
    if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
    if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
    const isFileURL = /^file:/i.test(value);
    if (isFileURL) {
      const url = new URL(value);
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return null;
      value = fileURLToPath(url);
    } else {
      if (!path.isAbsolute(value)) value = value.split('#', 1)[0];
      try { value = decodeURIComponent(value); } catch { /* Literal percent signs are valid filename characters. */ }
    }
    if (!value || /[\x00-\x1f\x7f]/.test(value) || isNetworkPath(value)) return null;
    const drivePath = /^[a-z]:[\\/]/i.test(value);
    if (!drivePath && /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
    if (process.platform === 'win32' && value.replace(/^[a-z]:/i, '').includes(':')) return null;
    let candidate: string;
    if (path.isAbsolute(value)) candidate = path.normalize(value);
    else {
      if (!documentPath || isNetworkPath(documentPath)) return null;
      candidate = path.resolve(path.dirname(documentPath), value);
    }
    if (isNetworkPath(candidate) || !(await isLocalDrive(candidate))) return null;
    const canonical = await realpath(candidate);
    if (isNetworkPath(canonical) || !(await isLocalDrive(canonical))) return null;
    const metadata = await stat(canonical);
    return metadata.isFile() && metadata.size <= MAX_IMAGE_BYTES ? canonical : null;
  } catch {
    return null;
  }
}

function rasterSignature(data: Buffer): boolean {
  return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    || ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
    || (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP')
    || data.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0]))
    || data.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
    || (data.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis|heic|heix|mif1)$/.test(data.toString('ascii', 8, 12)));
}

async function inspectImage(data: Buffer, language: Settings['language'] = 'en'): Promise<sharp.Metadata> {
  if (!data.length || data.length > MAX_IMAGE_BYTES || !rasterSignature(data)) throw new Error('Unsupported or oversized image. Use PNG, JPEG, GIF, WebP, TIFF or AVIF.');
  // Metadata reads headers only. Apply our limits before starting any bounded pixel decode.
  const metadata = await sharp(data, { animated: true, limitInputPixels: false }).metadata();
  const frames = metadata.pages ?? 1;
  const width = metadata.width ?? 0;
  const height = metadata.pageHeight ?? metadata.height ?? 0;
  const pixels = width * height * frames;
  const limit = frames > 1 ? MAX_ANIMATED_IMAGE_PIXELS : MAX_IMAGE_PIXELS;
  if (!width || !height || !Number.isSafeInteger(pixels) || pixels > limit || frames > 500) {
    const size = `${width} x ${height}${frames > 1 ? ` x ${frames}` : ''}`;
    throw new Error(language === 'en'
      ? `Image dimensions ${size} exceed the limit: 256 million pixels per static image; 80 million total pixels and 500 frames for animations or multi-page images. Resize the image before inserting it.`
      : `图片尺寸 ${size} 超过处理上限：静态图片最多 2.56 亿像素，动画或多页图片合计最多 8000 万像素、500 帧。请缩小图片后再插入。`);
  }
  return metadata;
}

async function localImageDirectory(candidate: string): Promise<string> {
  if (isNetworkPath(candidate) || !(await isLocalDrive(candidate))) throw new Error('Images must be imported into a local document folder.');
  let existing = candidate;
  const missing: string[] = [];
  let canonical: string;
  while (true) {
    try { canonical = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(existing) === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  // Resolve a junction before mkdir, so even creating a missing assets directory cannot write to a network share.
  if (isNetworkPath(canonical) || !(await isLocalDrive(canonical))) throw new Error('The assets folder resolves to a network location.');
  const resolved = path.join(canonical, ...missing);
  await mkdir(resolved, { recursive: true });
  canonical = await realpath(resolved);
  if (isNetworkPath(canonical) || !(await isLocalDrive(canonical))) throw new Error('The assets folder resolves to a network location.');
  return canonical;
}

export async function importImages(document: DocumentSession, inputs: ImageInput[], settings: Partial<Settings> = {}): Promise<string[]> {
  if (!document.path) throw new Error('Save this document before inserting images.');
  if (inputs.length > 100 || inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0) > MAX_IMAGE_BATCH_BYTES) throw new Error('The image batch is too large.');
  const validated: Array<{ input: ImageInput; data: Buffer; extension: string }> = [];
  let validatedBytes = 0;
  for (const input of inputs) {
    let data: Buffer = Buffer.from(input.bytes);
    const metadata = await inspectImage(data, settings.language);
    let extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format ?? 'png';
    if (!['jpeg', 'png', 'gif', 'webp', 'avif'].includes(metadata.format ?? '')) {
      data = await processImage(() => sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS }).timeout({ seconds: 30 }).rotate().png().toBuffer());
      extension = 'png';
    }
    validatedBytes += data.length;
    if (data.length > MAX_IMAGE_BYTES || validatedBytes > MAX_IMAGE_BATCH_BYTES) throw new Error(settings.language === 'en'
      ? 'Converted images exceed the size limit: 64 MiB per image and 256 MiB per batch. Reduce the image sizes before inserting them.'
      : '转换后的图片超过大小上限：单张 64 MiB、每批合计 256 MiB。请缩小图片后再插入。');
    validated.push({ input, data, extension });
  }
  const folder = settings.imageFolder?.trim() || 'assets';
  if (/[\x00-\x1f\x7f]/.test(folder) || isNetworkPath(folder) || (!path.isAbsolute(folder) && /^[a-z][a-z\d+.-]*:/i.test(folder))) throw new Error('Choose a local image folder or a folder relative to the document.');
  const assets = path.resolve(path.dirname(document.path), folder);
  const canonicalAssets = await localImageDirectory(assets);
  const written: string[] = [];
  const markdown: string[] = [];
  try {
    for (const { input, data, extension } of validated) {
      const original = path.parse(path.basename(input.name)).name;
      const stem = original.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/[. ]+$/g, '').slice(0, 60) || 'image';
      const filename = `${stem}-${randomUUID().slice(0, 12)}.${extension}`;
      const target = path.join(canonicalAssets, filename);
      const handle = await open(target, 'wx');
      written.push(target);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      const relative = path.relative(path.dirname(document.path), target).split(path.sep).join('/');
      const absolute = settings.imageUseRelative === false || path.isAbsolute(relative);
      const encode = (part: string) => settings.imageAutoEscape === false
        // These characters remain escaped because they change URL parsing even inside <...>.
        ? part.replace(/[%#?]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
        : encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      if (absolute) {
        markdown.push(settings.imageAutoEscape === false
          ? `file://${process.platform === 'win32' ? '/' : ''}${target.split(path.sep).map(encode).join('/')}`.replace(/^file:\/\/\/([a-z])%3A\//i, 'file:///$1:/')
          : pathToFileURL(target).href.replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`));
      } else markdown.push(relative.split('/').map(encode).join('/'));
    }
    return markdown;
  } catch (error) {
    await Promise.allSettled(written.map(target => unlink(target)));
    throw error;
  }
}

export async function imageResponse(documentPath: string | null, destination: string, options: { thumbnails?: boolean } = {}): Promise<ImageResponse | null> {
  const target = await resolveImage(documentPath, destination);
  if (!target) return null;
  try {
    const info = await stat(target, { bigint: true });
    const thumbnails = options.thumbnails !== false;
    const key = `${target}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${thumbnails}`;
    const cached = thumbnailCache.get(key);
    if (cached) {
      thumbnailCache.delete(key);
      thumbnailCache.set(key, cached);
      return { data: cached.data, mime: cached.mime };
    }
    const existing = imageRequests.get(key);
    if (existing) return await existing;
    const pending = processImage(async () => {
      let data: Buffer = await readFile(target);
      const metadata = await inspectImage(data);
      let mime: string;
      const animated = (metadata.pages ?? 1) > 1 && ['gif', 'webp'].includes(metadata.format ?? '');
      if (animated) mime = metadata.format === 'gif' ? 'image/gif' : 'image/webp';
      else if (!thumbnails && metadata.format === 'png' && !metadata.orientation) {
        // Validate the pixel stream without allocating a full-resolution output buffer.
        await sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS }).timeout({ seconds: 30 }).resize(1, 1).raw().toBuffer();
        mime = 'image/png';
      }
      else {
        let pipeline = sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS }).timeout({ seconds: 30 }).rotate();
        if (thumbnails) pipeline = pipeline.resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true });
        data = await pipeline.png().toBuffer();
        mime = 'image/png';
      }
      const cost = Math.max(data.length, animated
        ? (metadata.width ?? 2048) * (metadata.height ?? 2048) * 4
        : Math.min(metadata.width ?? 2048, thumbnails ? 2048 : Infinity) * Math.min(metadata.height ?? 2048, thumbnails ? 2048 : Infinity) * 4);
      while (thumbnailCache.size && thumbnailCacheBytes + cost > MAX_CACHE_BYTES) {
        const oldest = thumbnailCache.entries().next().value!;
        thumbnailCache.delete(oldest[0]);
        thumbnailCacheBytes -= oldest[1].cost;
      }
      if (cost <= MAX_CACHE_BYTES) {
        thumbnailCache.set(key, { data, mime, cost });
        thumbnailCacheBytes += cost;
      }
      return { data, mime };
    });
    imageRequests.set(key, pending);
    try { return await pending; }
    finally { if (imageRequests.get(key) === pending) imageRequests.delete(key); }
  } catch {
    return null;
  }
}
