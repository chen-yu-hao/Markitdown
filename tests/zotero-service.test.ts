import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZoteroService } from '../src/main/zotero-service';

const first = 'D9PGQUM4';
const second = 'T4IQZGRM';
const third = 'MRHTZ5CI';
const attachment = 'ATTACH01';
const note = 'NOTE0001';
const csl = (title = 'Reference title') => ({ id: 'http://zotero.org/users/123/items/OLDKEY00', type: 'article-journal', title, author: [{ given: 'Ada', family: 'Lovelace' }], issued: { 'date-parts': [['2026', '9', '7']] }, DOI: '10.1234/example', URL: 'https://doi.org/10.1234/example' });
const wrapper = (key: string, value: unknown = csl()) => ({ key, version: 1, csljson: JSON.stringify([value]) });
const json = (response: ServerResponse, value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
const keyFor = (index: number) => `KEY${index.toString(36).toUpperCase().padStart(5, '0')}`;
let directory: string;
let server: Server;
let url: string;
let requested: URL[];
let keys: string[];
let records: Map<string, unknown>;
let overrides: ((request: IncomingMessage, response: ServerResponse, target: URL) => boolean) | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-zotero-'));
  requested = []; keys = [first, second, third]; records = new Map(keys.map(key => [key, wrapper(key)])); overrides = undefined;
  server = createServer((request, response) => {
    const target = new URL(request.url!, 'http://127.0.0.1');
    requested.push(target);
    response.setHeader('X-Zotero-Version', '9.0.6');
    if (overrides?.(request, response, target)) return;
    if (target.pathname === '/api/') { response.end('Nothing to see here.'); return; }
    if (target.pathname === '/api/itemTypes') { json(response, ['journalArticle', 'document', 'book', 'attachment', 'note', 'annotation'].map(itemType => ({ itemType }))); return; }
    if (target.pathname === '/api/users/0/items' && target.searchParams.get('format') === 'keys') {
      const start = Number(target.searchParams.get('start'));
      response.setHeader('Total-Results', String(keys.length)); response.end(keys.slice(start, start + 1000).join('\n')); return;
    }
    if (target.pathname === '/api/users/0/items/top') { response.setHeader('Total-Results', String(records.size)); json(response, [...records.values()].slice(0, 50)); return; }
    const key = target.pathname.split('/').at(-1)!;
    if (records.has(key)) json(response, records.get(key));
    else { response.statusCode = 404; response.end('Missing'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
});

afterEach(async () => {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const relative = path.relative(os.tmpdir(), directory);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('markedown-zotero-')) throw new Error('Unsafe Zotero test cleanup.');
  await rm(directory, { recursive: true, force: true });
});

describe('local Zotero references', () => {
  it('accepts only loopback API endpoints and reads status from the Zotero version header', async () => {
    for (const endpoint of ['https://127.0.0.1:23119/api/', 'http://example.com/api/', 'http://127.0.0.1.evil.test/api/', 'http://user:password@127.0.0.1/api/', 'http://127.0.0.1/connector/', 'http://127.0.0.1/api/?redirect=1', 'file:///api/']) expect(() => new ZoteroService(directory, endpoint)).toThrow();
    const service = new ZoteroService(directory, url.replace('127.0.0.1', 'localhost'));
    expect(await service.status()).toEqual({ available: true, version: '9.0.6' });
    overrides = (_request, response) => { response.removeHeader('X-Zotero-Version'); response.end('Other service'); return true; };
    expect((await service.status()).available).toBe(false);
  });

  it('resolves unique keys in citation order and sanitizes citation metadata without attachment paths', async () => {
    records.set(first, wrapper(first, { ...csl('A <sub>2</sub> reference'), abstract: 'Not needed for citation', note: 'Private note', path: 'C:/private/paper.pdf', URL: 'file:///C:/private/paper.pdf', author: [{ family: 'Researcher', given: 'Example', path: 'C:/private/name' }] }));
    records.set(attachment, wrapper(attachment, { ...csl(), type: 'document' }));
    records.set(note, wrapper(note, { ...csl(), type: 'document' }));
    const service = new ZoteroService(directory, url);
    const result = await service.resolve([second, first, second, attachment, note]);
    expect(result.items.map(item => item.key)).toEqual([second, first]);
    expect(result.items[1]).toMatchObject({ title: 'A 2 reference', authors: 'Researcher, Example', year: '2026', csl: { id: first, issued: { 'date-parts': [[2026, 9, 7]] } } });
    expect(result.items[1].csl).not.toHaveProperty('path');
    expect(result.items[1].csl).not.toHaveProperty('URL');
    expect(result.items[1].csl).not.toHaveProperty('note');
    expect(result.items[1].csl).not.toHaveProperty('abstract');
    expect(JSON.stringify(result.items[1])).not.toContain('private');
    expect(result).toMatchObject({ missing: [attachment, note], offline: false, warnings: [] });
    const index = requested.find(target => target.searchParams.get('format') === 'keys')!;
    expect(index.searchParams.get('itemType')).toBe('journalArticle || document || book');
    expect(requested.filter(target => target.pathname.endsWith(`/${first}`))).toHaveLength(1);
    expect(requested.some(target => target.pathname.endsWith(`/${attachment}`) || target.pathname.endsWith(`/${note}`))).toBe(false);
    expect(requested.every(target => !target.searchParams.get('include')?.includes('data') && !/fulltext|file\/view|children/.test(target.pathname))).toBe(true);
  });

  it('persists separate cache files, restores offline and isolates corrupt records', async () => {
    const service = new ZoteroService(directory, url);
    await service.resolve([first, second]);
    const cache = path.join(directory, 'references', 'zotero');
    expect((await readdir(cache)).sort()).toEqual([`${first}.json`, `${second}.json`].sort());
    expect(JSON.parse(await readFile(path.join(cache, `${first}.json`), 'utf8'))).toMatchObject({ version: 1, key: first, bibliographic: true, csl: { id: first } });
    await writeFile(path.join(cache, `${first}.json`), '{broken');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const result = await new ZoteroService(directory, url).resolve([first, second, third]);
    expect(result.items.map(item => item.key)).toEqual([second]);
    expect(result.missing).toEqual([first, third]);
    expect(result.offline).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining(first), expect.stringContaining('cached')]));
  });

  it('returns resolved metadata when writing the cache is impossible', async () => {
    await writeFile(path.join(directory, 'references'), 'Existing file');
    const result = await new ZoteroService(directory, url).resolve([first]);
    expect(result.items).toHaveLength(1);
    expect(result.offline).toBe(false);
    expect(result.warnings).toContain(`Reference ${first} was resolved but its offline cache could not be saved.`);
    expect(await readFile(path.join(directory, 'references'), 'utf8')).toBe('Existing file');
  });

  it('refreshes changed metadata, removes deleted records and never exposes mutable cache objects', async () => {
    const service = new ZoteroService(directory, url);
    const result = await service.resolve([first, second]);
    result.items[0].csl.title = 'Caller mutated';
    expect((await service.resolve([first])).items[0].title).toBe('Reference title');
    records.set(first, wrapper(first, csl('Updated metadata')));
    keys = keys.filter(key => key !== second);
    const refreshed = await service.resolve([first, second], true);
    expect(refreshed.items[0].title).toBe('Updated metadata');
    expect(refreshed.missing).toEqual([second]);
    await expect(readFile(path.join(directory, 'references', 'zotero', `${second}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    records.delete(first);
    expect((await service.resolve([first], true)).missing).toEqual([first]);
  });

  it('continues past malformed live metadata and enforces bounded concurrent item requests', async () => {
    keys = Array.from({ length: 15 }, (_, index) => keyFor(index));
    records = new Map(keys.map(key => [key, wrapper(key)]));
    records.set(keys[0], { key: keys[0], csljson: 'bad-json' });
    records.set(keys[1], wrapper('WRONGKEY'));
    let active = 0; let maximum = 0;
    overrides = (_request, response, target) => {
      const key = target.pathname.split('/').at(-1)!;
      if (!records.has(key)) return false;
      active++; maximum = Math.max(maximum, active);
      setTimeout(() => { active--; json(response, records.get(key)); }, 15);
      return true;
    };
    const result = await new ZoteroService(directory, url).resolve(keys);
    expect(result.items).toHaveLength(13);
    expect(result.missing).toEqual(keys.slice(0, 2));
    expect(result.offline).toBe(false);
    expect(result.warnings).toHaveLength(2);
    expect(maximum).toBeLessThanOrEqual(6);
  });

  it('searches metadata only, limits results and honours cancellation', async () => {
    keys = Array.from({ length: 60 }, (_, index) => keyFor(index));
    records = new Map(keys.map(key => [key, wrapper(key)]));
    const service = new ZoteroService(directory, url);
    const result = await service.search('title & 作者');
    expect(result.items).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    const target = requested.find(request => request.pathname.endsWith('/top'))!;
    expect(target.searchParams.get('q')).toBe('title & 作者');
    expect(target.searchParams.get('qmode')).toBe('titleCreatorYear');
    expect(target.searchParams.get('include')).toBe('csljson');
    expect(target.searchParams.get('limit')).toBe('50');
    expect(target.searchParams.has('itemType')).toBe(false);
    const controller = new AbortController();
    overrides = (_request, _response, target) => { if (target.pathname.endsWith('/top')) { controller.abort(); return true; } return false; };
    await expect(service.search('cancel', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.search('already cancelled', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('skips invalid search records and attachments even if the local search filter returns them', async () => {
    records = new Map<string, unknown>([[first, wrapper(first)], [second, { key: second, csljson: '{}' }], [attachment, wrapper(attachment, { ...csl(), type: 'document' })]]);
    expect((await new ZoteroService(directory, url).search('reference')).items.map(item => item.key)).toEqual([first]);
  });

  it('searches valid item keys directly and falls back to metadata search for ordinary eight-letter queries', async () => {
    const service = new ZoteroService(directory, url);
    expect((await service.search(` ${first.toLowerCase()} `)).items.map(item => item.key)).toEqual([first]);
    expect(requested.some(target => target.pathname.endsWith('/top'))).toBe(false);
    expect(requested.some(target => target.pathname.endsWith(`/${first}`))).toBe(true);
    await service.search('research');
    expect(requested.some(target => target.pathname.endsWith('/top') && target.searchParams.get('q') === 'research')).toBe(true);
    records.set(first, { key: first, csljson: '{}' });
    expect(await service.search(first)).toEqual({ items: [], hasMore: false });
    records.delete(first);
    expect(await service.search(first)).toEqual({ items: [], hasMore: false });
    await service.search(attachment);
    expect(requested.some(target => target.pathname.endsWith(`/${attachment}`))).toBe(false);
  });

  it('paginates the positive key index and fails closed for incomplete classification', async () => {
    keys = Array.from({ length: 1001 }, (_, index) => keyFor(index));
    records = new Map([[keys[1000], wrapper(keys[1000])]]);
    const service = new ZoteroService(directory, url);
    expect((await service.resolve([keys[1000]])).items).toHaveLength(1);
    expect(requested.filter(target => target.searchParams.get('format') === 'keys').map(target => target.searchParams.get('start'))).toEqual(['0', '1000']);
    overrides = (_request, response, target) => { if (target.searchParams.get('format') !== 'keys') return false; response.setHeader('Total-Results', '1001'); response.end(keys[0]); return true; };
    const failure = await service.resolve([first], true);
    expect(failure).toMatchObject({ items: [], missing: [first], offline: true });
    expect(requested.some(target => target.pathname.endsWith(`/${first}`))).toBe(false);
  });

  it('rejects redirects and oversized responses without following external locations', async () => {
    overrides = (_request, response) => { response.statusCode = 302; response.setHeader('Location', 'http://example.com/private'); response.end(); return true; };
    const service = new ZoteroService(directory, url);
    expect((await service.status()).available).toBe(false);
    expect(requested).toHaveLength(1);
    overrides = (_request, response) => { response.setHeader('Content-Length', String(9 * 1024 * 1024)); response.end(); return true; };
    expect((await service.resolve([first])).offline).toBe(true);
    expect(requested.some(target => target.pathname.endsWith(`/${first}`))).toBe(false);
  });

  it('retains cached metadata on live item service failures and reports offline state', async () => {
    const service = new ZoteroService(directory, url);
    await service.resolve([first]);
    overrides = (_request, response, target) => { if (!target.pathname.endsWith(`/${first}`)) return false; response.statusCode = 503; response.end(); return true; };
    const result = await service.resolve([first], true);
    expect(result.items.map(item => item.key)).toEqual([first]);
    expect(result.offline).toBe(true);
    expect(result.warnings).toContain('Zotero reference metadata is unavailable; cached references are being used where possible.');
  });

  it('caps streaming responses and expires requests that never finish', async () => {
    overrides = (_request, response) => { response.write(Buffer.alloc(8 * 1024 * 1024, 32)); response.end('extra'); return true; };
    expect((await new ZoteroService(directory, url).status()).available).toBe(false);
    overrides = () => true;
    const started = Date.now();
    expect((await new ZoteroService(directory, url).status()).available).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5800);
    expect(Date.now() - started).toBeLessThan(7500);
  }, 10_000);

  it('validates input limits before requesting data', async () => {
    const service = new ZoteroService(directory, url);
    for (const key of ['bad', '../notes', 'abcdefgh', 'ABCDEF%2']) await expect(service.resolve([key])).rejects.toThrow('item keys');
    await expect(service.resolve(Array.from({ length: 501 }, (_, index) => keyFor(index)))).rejects.toThrow('500');
    await expect(service.search('x'.repeat(501))).rejects.toThrow('500');
    expect(await service.resolve([])).toEqual({ items: [], missing: [], offline: false, warnings: [] });
    expect(requested).toEqual([]);
    expect((await service.resolve(Array(501).fill(first))).items).toHaveLength(1);
  });

  it('rejects unverified or oversized offline cache records while preserving valid siblings', async () => {
    const cache = path.join(directory, 'references', 'zotero');
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, `${first}.json`), JSON.stringify({ version: 1, key: first, csl: csl() }));
    await writeFile(path.join(cache, `${second}.json`), ' '.repeat(130 * 1024));
    await writeFile(path.join(cache, `${third}.json`), JSON.stringify({ version: 1, key: third, bibliographic: true, csl: csl() }));
    overrides = (_request, response) => { response.statusCode = 503; response.end(); return true; };
    const result = await new ZoteroService(directory, url).resolve([first, second, third]);
    expect(result.items.map(item => item.key)).toEqual([third]);
    expect(result.missing).toEqual([first, second]);
    expect(result.warnings).toHaveLength(3);
  });
});
