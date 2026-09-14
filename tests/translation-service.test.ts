import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationService, type TranslationEncryption } from '../src/main/translation-service';

let directory: string;
const encryptionKey = randomBytes(32);
const encryption: TranslationEncryption = {
  encrypt(value) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  },
  decrypt(value) {
    const data = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const google = (text = '你好') => json({ data: { translations: [{ translatedText: text }] } });
const credentials = { googleApiKey: 'google-sensitive-api-key', baiduAppId: '1234567890123', baiduSecret: 'baidu-sensitive-secret' };
const file = () => path.join(directory, 'translation-credentials.json');

beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'markedown-translation-')); });
afterEach(async () => {
  vi.useRealTimers();
  const relative = path.relative(os.tmpdir(), directory);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('markedown-translation-')) throw new Error('Unsafe translation test cleanup.');
  await rm(directory, { recursive: true, force: true });
});

describe('translation configuration', () => {
  it('encrypts credentials and restores provider/target without exposing keys', async () => {
    const service = new TranslationService({ dataDir: directory, encryption });
    const config = await service.configure({ ...credentials, provider: 'baidu', targetLanguage: 'ja' });
    expect(config).toEqual({ provider: 'baidu', targetLanguage: 'ja', googleConfigured: true, baiduConfigured: true });
    const persisted = await readFile(file(), 'utf8');
    for (const value of Object.values(credentials)) expect(persisted).not.toContain(value);
    expect(Object.keys(JSON.parse(persisted)).sort()).toEqual(['encryptedCredentials', 'provider', 'targetLanguage', 'version']);
    expect(await new TranslationService({ dataDir: directory, encryption }).getConfig()).toEqual(config);
    config.provider = 'google';
    expect((await service.getConfig()).provider).toBe('baidu');
    expect(await readdir(directory)).toEqual(['translation-credentials.json']);
  });

  it('supports preferences without credentials but refuses plaintext credential fallback', async () => {
    const service = new TranslationService({ dataDir: directory });
    await expect(service.configure({ provider: 'baidu' })).resolves.toMatchObject({ provider: 'baidu', baiduConfigured: false });
    await expect(service.configure(credentials)).rejects.toThrow('Secure translation credential storage');
    expect((await service.getConfig()).googleConfigured).toBe(false);
    expect(await readFile(file(), 'utf8')).not.toContain(credentials.googleApiKey);
  });

  it('treats missing, corrupted, oversized and foreign-user files as unconfigured', async () => {
    expect(await new TranslationService({ dataDir: directory, encryption }).getConfig()).toMatchObject({ googleConfigured: false, baiduConfigured: false });
    for (const content of ['{ broken', 'x'.repeat(35_000), JSON.stringify({ version: 1, encryptedCredentials: 'not-os-encrypted' })]) {
      await writeFile(file(), content);
      expect(await new TranslationService({ dataDir: directory, encryption }).getConfig()).toMatchObject({ googleConfigured: false, baiduConfigured: false });
    }
  });

  it('serializes simultaneous updates and clears keys with an explicit empty string', async () => {
    const service = new TranslationService({ dataDir: directory, encryption });
    await Promise.all([service.configure({ googleApiKey: credentials.googleApiKey }), service.configure({ provider: 'baidu', baiduAppId: credentials.baiduAppId }), service.configure({ baiduSecret: credentials.baiduSecret })]);
    expect(await service.getConfig()).toMatchObject({ provider: 'baidu', googleConfigured: true, baiduConfigured: true });
    await service.configure({ googleApiKey: '' });
    expect(await new TranslationService({ dataDir: directory, encryption }).getConfig()).toMatchObject({ googleConfigured: false, baiduConfigured: true });
  });

  it('rejects malformed preferences/keys and keeps previous configuration after encryption fails', async () => {
    const encrypt = vi.fn(encryption.encrypt); const service = new TranslationService({ dataDir: directory, encryption: { ...encryption, encrypt } });
    await service.configure(credentials);
    const original = await readFile(file(), 'utf8');
    await expect(service.configure({ provider: 'third-party' as never })).rejects.toThrow('Invalid translation provider');
    await expect(service.configure({ targetLanguage: 'invalid' as never })).rejects.toThrow('Invalid translation target');
    await expect(service.configure({ googleApiKey: '\nsecret' })).rejects.toThrow('Invalid translation credential');
    encrypt.mockRejectedValueOnce(new Error(`private failure ${credentials.googleApiKey}`));
    await expect(service.configure({ provider: 'baidu' })).rejects.toThrow('Secure translation credential storage');
    expect(await readFile(file(), 'utf8')).toBe(original);
    expect((await service.getConfig()).provider).toBe('google');
  });
});

describe('translation requests', () => {
  it('does not contact Baidu before credentials or send empty selections', async () => {
    const fetch = vi.fn(); const service = new TranslationService({ dataDir: directory, encryption, fetch });
    await expect(service.translate('')).rejects.toThrow('Select text');
    await service.configure({ provider: 'baidu' });
    await expect(service.translate('hello')).rejects.toThrow('Baidu translation is not configured');
    await expect(service.translate(' \n ')).rejects.toThrow('Select text');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses keyless Google by default and snapshots per-request provider and target', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([[['你好', 'Hello'], ['世界', 'world']], null, 'en']));
    const service = new TranslationService({ dataDir: directory, encryption, fetch });
    await service.configure({ provider: 'baidu' });
    await expect(service.translate('Hello world', undefined, { provider: 'google', targetLanguage: 'zh-CN' })).resolves.toEqual({ text: '你好世界', provider: 'google', targetLanguage: 'zh-CN' });
    const [request, options] = fetch.mock.calls[0];
    const url = new URL(request);
    expect(url.origin + url.pathname).toBe('https://translate.googleapis.com/translate_a/single');
    expect(url.searchParams.get('q')).toBe('Hello world');
    expect(url.searchParams.get('key')).toBeNull();
    expect(options).toMatchObject({ redirect: 'error', method: 'GET', credentials: 'omit' });
    expect((await service.getConfig()).provider).toBe('baidu');
    await expect(service.translate('Hello', undefined, { provider: 'other' as never, targetLanguage: 'en' })).rejects.toThrow('Invalid translation options');
  });

  it('posts only selected text to the fixed Google API endpoint with text format and rejects redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(google('The &lt;script&gt; stays text &amp; &#39;quoted&#39; &#x1f600;.'));
    const service = new TranslationService({ dataDir: directory, encryption, fetch }); await service.configure({ ...credentials, targetLanguage: 'en' });
    const selected = '选中的文字 & 项目';
    expect(await service.translate(selected)).toEqual({ text: "The <script> stays text & 'quoted' 😀.", provider: 'google', targetLanguage: 'en' });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://translation.googleapis.com/language/translate/v2');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', headers: { 'X-Goog-Api-Key': credentials.googleApiKey } });
    expect(JSON.parse(options.body)).toEqual({ q: selected, target: 'en', format: 'text' });
    expect(await readFile(file(), 'utf8')).not.toContain(selected);
  });

  it.each([['zh-CN', 'zh'], ['en', 'en'], ['ja', 'jp'], ['de', 'de'], ['fr', 'fra']] as const)('signs Baidu requests with UTF-8 text and maps %s to %s', async (targetLanguage, expectedTarget) => {
    const fetch = vi.fn().mockResolvedValue(json({ trans_result: [{ dst: '第一段' }, { dst: '第二段' }] }));
    const service = new TranslationService({ dataDir: directory, encryption, fetch }); await service.configure({ ...credentials, provider: 'baidu', targetLanguage });
    const selected = 'Energy ΔE & 中文\nSecond paragraph';
    expect(await service.translate(selected)).toEqual({ text: '第一段\n第二段', provider: 'baidu', targetLanguage });
    const [url, options] = fetch.mock.calls[0]; const values = new URLSearchParams(options.body);
    expect(url).toBe('https://fanyi-api.baidu.com/api/trans/vip/translate');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(values.get('q')).toBe(selected); expect(values.get('to')).toBe(expectedTarget); expect(values.get('from')).toBe('auto');
    expect(values.get('sign')).toBe(createHash('md5').update(credentials.baiduAppId + selected + values.get('salt') + credentials.baiduSecret, 'utf8').digest('hex'));
    expect(options.body).not.toContain(credentials.baiduSecret);
  });

  it('enforces UTF-8 limits before sending network requests', async () => {
    const fetch = vi.fn(); const service = new TranslationService({ dataDir: directory, encryption, fetch }); await service.configure({ ...credentials, provider: 'baidu' });
    await expect(service.translate('中'.repeat(1501))).rejects.toThrow('4500-byte');
    await service.configure({ provider: 'google' });
    await expect(service.translate('😀'.repeat(7501))).rejects.toThrow('30000-byte');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes HTTP, provider, and malformed response errors without revealing text or credentials', async () => {
    const selected = 'UNPUBLISHED PRIVATE MANUSCRIPT'; const fetch = vi.fn();
    const service = new TranslationService({ dataDir: directory, encryption, fetch }); await service.configure(credentials);
    for (const result of [json({ error: { message: selected + credentials.googleApiKey } }, 403), json({ data: { translations: [] } }), new Response('invalid json')]) {
      fetch.mockResolvedValueOnce(result);
      const error = await service.translate(selected).then(() => new Error('Unexpected success'), error => error as Error);
      expect(error.message).toContain('Google translation failed');
      expect(error.message).not.toContain(selected); expect(error.message).not.toContain(credentials.googleApiKey);
    }
    fetch.mockRejectedValueOnce(new Error('Network error ' + selected + credentials.googleApiKey));
    await expect(service.translate(selected)).rejects.toThrow(/^Google translation failed/);
    await service.configure({ provider: 'baidu' });
    for (const body of [{ error_code: '54003', error_msg: credentials.baiduSecret }, { trans_result: [{ dst: 'ok' }, { dst: null }] }, { trans_result: [] }]) {
      fetch.mockResolvedValueOnce(json(body));
      await expect(service.translate(selected)).rejects.toThrow(/^Baidu translation failed/);
    }
  });

  it('rejects oversized responses with and without content length', async () => {
    const fetch = vi.fn(); const service = new TranslationService({ dataDir: directory, encryption, fetch }); await service.configure(credentials);
    fetch.mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': '99999999' } }));
    await expect(service.translate('hello')).rejects.toThrow('Google translation failed');
    fetch.mockResolvedValueOnce(google('x'.repeat(300_000)));
    await expect(service.translate('hello')).rejects.toThrow('Google translation failed');
  });

  it('times out pending requests even when a custom fetch does not reject on abort', async () => {
    const fetch = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const service = new TranslationService({ dataDir: directory, encryption, fetch, timeoutMs: 20 }); await service.configure(credentials);
    await expect(service.translate('hello')).rejects.toThrow('Translation request timed out');
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('honors pre-aborted signals, window-local cancellation, and app-wide cancellation', async () => {
    const fetch = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const service = new TranslationService({ dataDir: directory, encryption, fetch }); await service.configure(credentials);
    const preAborted = new AbortController(); preAborted.abort();
    await expect(service.translate('hello', preAborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    const windowOne = new AbortController();
    const first = expect(service.translate('first', windowOne.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const second = expect(service.translate('second')).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    windowOne.abort(); await first;
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
    service.cancel(); await second;
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
  });
});
