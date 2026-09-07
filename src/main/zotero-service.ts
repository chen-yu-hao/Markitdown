import http from 'node:http';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ReferenceItem, ReferenceProvider, ReferenceResolution, ReferenceSearch, ReferenceStatus } from '../shared/academic-contracts';
import { atomicWrite } from './document-service';

const KEY = /^[A-Z0-9]{8}$/;
const REQUEST_TIMEOUT = 6000;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const ITEM_LIMIT = 128 * 1024;
const CACHE_FRESH = 5 * 60 * 1000;
const stringFields = new Set(['type', 'title', 'title-short', 'container-title', 'container-title-short', 'collection-title', 'collection-number', 'publisher', 'publisher-place', 'event', 'event-title', 'event-place', 'archive', 'archive-place', 'archive_location', 'authority', 'call-number', 'chapter-number', 'citation-label', 'dimensions', 'DOI', 'edition', 'genre', 'ISBN', 'ISSN', 'issue', 'jurisdiction', 'language', 'medium', 'number', 'number-of-pages', 'number-of-volumes', 'original-publisher', 'original-publisher-place', 'original-title', 'page', 'page-first', 'part', 'PMCID', 'PMID', 'section', 'shortTitle', 'status', 'version', 'volume', 'volume-title', 'volume-title-short', 'year-suffix']);
const nameFields = new Set(['author', 'chair', 'collection-editor', 'compiler', 'composer', 'container-author', 'contributor', 'curator', 'director', 'editor', 'editorial-director', 'executive-producer', 'guest', 'host', 'illustrator', 'interviewer', 'narrator', 'organizer', 'original-author', 'performer', 'producer', 'recipient', 'reviewed-author', 'script-writer', 'series-creator', 'translator']);
const dateFields = new Set(['accessed', 'available-date', 'event-date', 'issued', 'original-date', 'submitted']);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 16_384);
const labelText = (value: string) => cleanText(value).replace(/<[^>]*>/g, '').trim();
const abortError = () => new DOMException('The reference search was cancelled.', 'AbortError');
class ZoteroHTTPError extends Error { constructor(readonly status: number) { super(`Zotero returned HTTP ${status}.`); } }
class ZoteroMetadataError extends Error {}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/api', '/api/'].includes(url.pathname)) throw new Error('Zotero must use a local loopback /api/ endpoint.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  url.pathname = '/api/';
  return url;
}

function reference(key: string, raw: unknown): ReferenceItem {
  if (!KEY.test(key) || !object(raw) || typeof raw.type !== 'string' || !raw.type.trim() || ['attachment', 'note', 'annotation'].includes(raw.type) || typeof raw.title !== 'string' || Buffer.byteLength(JSON.stringify(raw), 'utf8') > ITEM_LIMIT) throw new ZoteroMetadataError('Invalid reference metadata.');
  const csl: Record<string, unknown> = { id: key };
  for (const [field, value] of Object.entries(raw)) {
    if (stringFields.has(field) && (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value))) csl[field] = typeof value === 'string' ? cleanText(value) : value;
    else if (field === 'URL' && typeof value === 'string') {
      try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) csl.URL = url.href; } catch { /* Non-web locations are not citation metadata. */ }
    } else if (nameFields.has(field) && Array.isArray(value)) {
      csl[field] = value.slice(0, 500).filter(object).map(name => Object.fromEntries(Object.entries(name).filter(([part, text]) => ['family', 'given', 'literal', 'suffix', 'dropping-particle', 'non-dropping-particle'].includes(part) && typeof text === 'string').map(([part, text]) => [part, cleanText(text as string)])));
    } else if (dateFields.has(field) && object(value)) {
      const date: Record<string, unknown> = {};
      if (Array.isArray(value['date-parts'])) date['date-parts'] = value['date-parts'].slice(0, 2).filter(Array.isArray).map(parts => parts.slice(0, 3).map(part => typeof part === 'number' && Number.isFinite(part) ? part : typeof part === 'string' && /^-?\d{1,6}$/.test(part) ? Number(part) : null)).filter(parts => parts.length && parts.every(part => part !== null));
      for (const part of ['literal', 'raw', 'season'] as const) if (typeof value[part] === 'string' || typeof value[part] === 'number') date[part] = cleanText(String(value[part]));
      if (value.circa === true || value.circa === 1) date.circa = true;
      if (Object.keys(date).length) csl[field] = date;
    }
  }
  const names = csl.author ?? csl.editor;
  const authors = Array.isArray(names) ? names.map(name => object(name) ? labelText(String(name.literal || [name.family, name.given].filter(Boolean).join(', '))) : '').filter(Boolean).slice(0, 6).join('; ') : '';
  const issued = object(csl.issued) ? csl.issued : undefined;
  const dateParts = issued?.['date-parts'];
  const year = Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? String(dateParts[0][0] ?? '') : typeof issued?.literal === 'string' ? /\b\d{4}\b/.exec(issued.literal)?.[0] ?? '' : '';
  return { key, csl, title: labelText(raw.title), authors, year };
}

function wrapperReference(raw: unknown, expectedKey?: string): ReferenceItem {
  if (!object(raw) || typeof raw.key !== 'string' || !KEY.test(raw.key) || expectedKey && raw.key !== expectedKey) throw new ZoteroMetadataError('Zotero returned mismatched reference metadata.');
  let csl = raw.csljson;
  if (typeof csl === 'string') csl = JSON.parse(csl);
  if (Array.isArray(csl)) { if (csl.length !== 1) throw new ZoteroMetadataError('Zotero returned ambiguous reference metadata.'); csl = csl[0]; }
  return reference(raw.key, csl);
}

export class ZoteroService implements ReferenceProvider {
  readonly id = 'zotero';
  readonly name = 'Zotero';
  private readonly baseURL: URL;
  private readonly cacheDir: string;
  private readonly memory = new Map<string, ReferenceItem>();
  private readonly checked = new Map<string, number>();
  private readonly writes = new Map<string, Promise<void>>();
  private itemTypes?: string[];

  // A positive key index avoids Zotero 9.0.6's nested-filter bug and attachment CSL masquerading as "document".
  private async bibliographicKeys(signal?: AbortSignal): Promise<Set<string>> {
    if (!this.itemTypes) {
      const response = await this.request('itemTypes', undefined, signal);
      const types: unknown = JSON.parse(response.body);
      if (!Array.isArray(types)) throw new ZoteroMetadataError('Zotero returned an invalid item type list.');
      this.itemTypes = types.filter(object).map(item => item.itemType).filter((type): type is string => typeof type === 'string' && /^[a-zA-Z]{1,50}$/.test(type) && !['attachment', 'note', 'annotation'].includes(type));
      if (!this.itemTypes.length || this.itemTypes.length > 100) { this.itemTypes = undefined; throw new ZoteroMetadataError('Zotero returned an invalid item type list.'); }
    }
    const keys = new Set<string>();
    for (let start = 0; start < 200_000; start += 1000) {
      const response = await this.request('users/0/items', new URLSearchParams({ format: 'keys', itemType: this.itemTypes.join(' || '), limit: '1000', start: String(start) }), signal);
      const page = response.body.trim() ? response.body.trim().split(/\s+/) : [];
      if (page.length > 1000 || page.some(key => !KEY.test(key))) throw new ZoteroMetadataError('Zotero returned an invalid bibliography key index.');
      for (const key of page) keys.add(key);
      const total = Number(response.headers['total-results']);
      if (Number.isFinite(total) && total >= 0 ? start + page.length >= total : page.length < 1000) return keys;
      if (page.length !== 1000) throw new ZoteroMetadataError('Zotero returned an incomplete bibliography key index.');
    }
    throw new ZoteroMetadataError('The Zotero bibliography exceeds the 200,000-item index limit.');
  }

  constructor(dataDir: string, baseURL = 'http://127.0.0.1:23119/api/') {
    this.baseURL = endpoint(baseURL);
    this.cacheDir = path.join(path.resolve(dataDir), 'references', 'zotero');
  }

  private request(route: string, query?: URLSearchParams, signal?: AbortSignal): Promise<{ body: string; headers: http.IncomingHttpHeaders }> {
    if (signal?.aborted) return Promise.reject(abortError());
    const url = new URL(route, this.baseURL);
    if (query) url.search = query.toString();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, value?: { body: string; headers: http.IncomingHttpHeaders }) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value!);
      };
      const req = http.get(url, { agent: false, headers: { Accept: 'application/json', 'Zotero-API-Version': '3' } }, res => {
        if (res.statusCode !== 200) { finish(new ZoteroHTTPError(res.statusCode ?? 0)); res.destroy(); return; }
        const length = Number(res.headers['content-length']);
        if (Number.isFinite(length) && length > RESPONSE_LIMIT) { finish(new Error('Zotero metadata exceeds the response size limit.')); res.destroy(); return; }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > RESPONSE_LIMIT) { finish(new Error('Zotero metadata exceeds the response size limit.')); res.destroy(); return; }
          chunks.push(chunk);
        });
        res.on('end', () => finish(undefined, { body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(new Error('Zotero closed an incomplete metadata response.')));
      });
      const abort = () => { finish(abortError()); req.destroy(); };
      timeout = setTimeout(() => { finish(new Error('Zotero did not respond within 6 seconds.')); req.destroy(); }, REQUEST_TIMEOUT);
      signal?.addEventListener('abort', abort, { once: true });
      req.on('error', error => finish(error));
    });
  }

  async status(): Promise<ReferenceStatus> {
    try {
      const response = await this.request('');
      const version = response.headers['x-zotero-version'];
      if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[-.a-z\d]*)$/i.test(version)) return { available: false, message: 'The local endpoint did not identify as Zotero.' };
      return { available: true, version };
    } catch { return { available: false, message: 'Zotero is unavailable. Start Zotero and enable its local API; cached references remain available.' }; }
  }

  private async cached(key: string, warnings: string[]): Promise<ReferenceItem | undefined> {
    const memory = this.memory.get(key);
    if (memory) return memory;
    try {
      const file = await open(path.join(this.cacheDir, `${key}.json`), 'r');
      let bytes: Buffer;
      try {
        if ((await file.stat()).size > ITEM_LIMIT + 1024) throw new Error('Oversized cached reference.');
        const buffer = Buffer.alloc(ITEM_LIMIT + 1025);
        let length = 0;
        while (length < buffer.length) {
          const result = await file.read(buffer, length, buffer.length - length, null);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length > ITEM_LIMIT + 1024) throw new Error('Oversized cached reference.');
        bytes = buffer.subarray(0, length);
      } finally { await file.close(); }
      const record: unknown = JSON.parse(bytes.toString('utf8'));
      if (!object(record) || record.version !== 1 || record.key !== key || record.bibliographic !== true) throw new Error('Invalid reference cache record.');
      const item = reference(key, record.csl);
      this.memory.set(key, item);
      return item;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Cached reference ${key} could not be read; other references remain available.`);
      return undefined;
    }
  }

  private async persist(item: ReferenceItem): Promise<void> {
    const previous = this.writes.get(item.key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await mkdir(this.cacheDir, { recursive: true });
      await atomicWrite(path.join(this.cacheDir, `${item.key}.json`), Buffer.from(JSON.stringify({ version: 1, key: item.key, bibliographic: true, csl: item.csl }), 'utf8'));
    });
    this.writes.set(item.key, operation);
    try { await operation; } finally { if (this.writes.get(item.key) === operation) this.writes.delete(item.key); }
  }

  async search(query: string, signal?: AbortSignal): Promise<ReferenceSearch> {
    if (typeof query !== 'string' || query.length > 500 || /[\x00-\x1f]/.test(query)) throw new Error('Use a reference search query of at most 500 characters.');
    if (signal?.aborted) throw abortError();
    const allowed = await this.bibliographicKeys(signal);
    const itemKey = query.trim().toUpperCase();
    if (KEY.test(itemKey) && allowed.has(itemKey)) {
      try {
        const response = await this.request(`users/0/items/${itemKey}`, new URLSearchParams({ format: 'json', include: 'csljson' }), signal);
        const item = wrapperReference(JSON.parse(response.body), itemKey);
        if (signal?.aborted) throw abortError();
        return { items: [item], hasMore: false };
      } catch (error) {
        if (error instanceof ZoteroHTTPError && error.status === 404 || error instanceof ZoteroMetadataError || error instanceof SyntaxError) return { items: [], hasMore: false };
        throw error;
      }
    }
    const parameters = new URLSearchParams({ format: 'json', include: 'csljson', q: query.trim(), qmode: 'titleCreatorYear', limit: '50', start: '0' });
    const response = await this.request('users/0/items/top', parameters, signal);
    const records: unknown = JSON.parse(response.body);
    if (!Array.isArray(records)) throw new Error('Zotero returned an invalid search response.');
    const items: ReferenceItem[] = [];
    for (const raw of records.slice(0, 50)) {
      if (!object(raw) || typeof raw.key !== 'string' || !allowed.has(raw.key)) continue;
      try { items.push(wrapperReference(raw)); } catch { /* One malformed record must not hide the rest of the search results. */ }
    }
    if (signal?.aborted) throw abortError();
    return { items, hasMore: Number(response.headers['total-results']) > 50 || records.length > 50 };
  }

  async resolve(keys: string[], refresh = false): Promise<ReferenceResolution> {
    if (!Array.isArray(keys) || keys.length > 10_000 || keys.some(key => typeof key !== 'string' || !KEY.test(key))) throw new Error('References must use eight-character uppercase Zotero item keys.');
    const unique = [...new Set(keys)];
    if (unique.length > 500) throw new Error('A document may resolve up to 500 distinct Zotero references.');
    const warnings: string[] = [];
    const items = new Map<string, ReferenceItem>();
    await Promise.all(unique.map(async key => { const item = await this.cached(key, warnings); if (item) items.set(key, item); }));
    const pending = unique.filter(key => refresh || !items.has(key) || Date.now() - (this.checked.get(key) ?? 0) > CACHE_FRESH);
    if (!pending.length) return { items: unique.map(key => structuredClone(items.get(key)!)), missing: [], offline: false, warnings };
    let allowed: Set<string>;
    try { allowed = await this.bibliographicKeys(); }
    catch { return { items: unique.flatMap(key => items.has(key) ? [structuredClone(items.get(key)!)] : []), missing: unique.filter(key => !items.has(key)), offline: true, warnings: [...warnings, 'Zotero could not verify bibliography items; cached references are being used where possible.'] }; }
    const remove = async (key: string) => {
      items.delete(key); this.memory.delete(key); this.checked.delete(key);
      await this.writes.get(key)?.catch(() => undefined);
      await unlink(path.join(this.cacheDir, `${key}.json`)).catch(failure => { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`The stale cache for missing reference ${key} could not be removed.`); });
    };
    let next = 0; let offline = false;
    await Promise.all(Array.from({ length: Math.min(6, pending.length) }, async () => {
      while (next < pending.length && !offline) {
        const key = pending[next++];
        if (!allowed.has(key)) { await remove(key); continue; }
        try {
          const response = await this.request(`users/0/items/${key}`, new URLSearchParams({ format: 'json', include: 'csljson' }));
          const item = wrapperReference(JSON.parse(response.body), key);
          items.set(key, item); this.memory.set(key, item); this.checked.set(key, Date.now());
          try { await this.persist(item); } catch { warnings.push(`Reference ${key} was resolved but its offline cache could not be saved.`); }
        } catch (error) {
          if (error instanceof ZoteroHTTPError && error.status === 404) {
            await remove(key);
          } else if (error instanceof ZoteroMetadataError || error instanceof SyntaxError) {
            warnings.push(`Zotero reference ${key} contains invalid metadata; its cached version is used when available.`);
          } else {
            offline = true;
            warnings.push('Zotero reference metadata is unavailable; cached references are being used where possible.');
          }
        }
      }
    }));
    return { items: unique.flatMap(key => items.has(key) ? [structuredClone(items.get(key)!)] : []), missing: unique.filter(key => !items.has(key)), offline, warnings: [...new Set(warnings)] };
  }
}
