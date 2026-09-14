import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { TranslationAPI, TranslationConfig, TranslationConfigUpdate, TranslationProvider, TranslationResult, TranslationTarget } from '../shared/translation';

/** The main process supplies OS-backed encryption (Electron safeStorage). No plaintext fallback. */
export interface TranslationEncryption {
  encrypt(value: string): Promise<string> | string;
  decrypt(value: string): Promise<string> | string;
}

export interface TranslationServiceOptions {
  dataDir: string;
  encryption?: TranslationEncryption;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

type Credentials = { googleApiKey?: string; baiduAppId?: string; baiduSecret?: string };
type Preferences = Pick<TranslationConfig, 'provider' | 'targetLanguage'>;
const PROVIDERS: TranslationProvider[] = ['google', 'baidu'];
const TARGETS: TranslationTarget[] = ['zh-CN', 'en', 'ja', 'de', 'fr'];
const CREDENTIAL_KEYS = ['googleApiKey', 'baiduAppId', 'baiduSecret'] as const;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 32 * 1024;
const BAIDU_TARGETS: Record<TranslationTarget, string> = { 'zh-CN': 'zh', en: 'en', ja: 'jp', de: 'de', fr: 'fra' };
const object = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const cancelled = () => new DOMException('Translation was cancelled.', 'AbortError');
const storageError = () => new Error('Secure translation credential storage is unavailable.');

function credential(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid translation credential.');
  return value.trim() || undefined;
}

/** Google v2 may entity-encode even format:text responses; decode once without interpreting markup. */
function decodeGoogleText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? match;
  });
}

/** Fixed-endpoint translation client; neither source text nor plaintext credentials are persisted. */
export class TranslationService implements TranslationAPI {
  private config: Preferences = { provider: 'google', targetLanguage: 'zh-CN' };
  private credentials: Credentials = {};
  private loading?: Promise<void>;
  private configuration: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<AbortController>();
  private readonly file: string;
  private readonly encryptor?: TranslationEncryption;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: TranslationServiceOptions) {
    this.file = path.join(path.resolve(options.dataDir), 'translation-credentials.json');
    this.encryptor = options.encryption;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 15_000, 120_000));
  }

  private load(): Promise<void> {
    return this.loading ??= this.readConfig();
  }

  private async readConfig(): Promise<void> {
    let file;
    try {
      file = await open(this.file, 'r');
      if ((await file.stat()).size > MAX_CONFIG_BYTES) return;
      const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_CONFIG_BYTES) return;
      const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (!object(parsed) || parsed.version !== 1) return;
      if (PROVIDERS.includes(parsed.provider as TranslationProvider)) this.config.provider = parsed.provider as TranslationProvider;
      if (TARGETS.includes(parsed.targetLanguage as TranslationTarget)) this.config.targetLanguage = parsed.targetLanguage as TranslationTarget;
      if (!this.encryptor || typeof parsed.encryptedCredentials !== 'string') return;
      const secrets: unknown = JSON.parse(await this.encryptor.decrypt(parsed.encryptedCredentials));
      if (!object(secrets)) return;
      const restored: Credentials = {};
      for (const key of CREDENTIAL_KEYS) if (secrets[key] !== undefined) restored[key] = credential(secrets[key]);
      this.credentials = restored;
    } catch { /* Missing, corrupt, or foreign-user credential files are unconfigured. */ }
    finally { await file?.close(); }
  }

  private publicConfig(): TranslationConfig {
    return { ...this.config, googleConfigured: Boolean(this.credentials.googleApiKey), baiduConfigured: Boolean(this.credentials.baiduAppId && this.credentials.baiduSecret) };
  }

  async getConfig(): Promise<TranslationConfig> {
    await this.load(); await this.configuration;
    return this.publicConfig();
  }

  configure(update: TranslationConfigUpdate): Promise<TranslationConfig> {
    const action = this.configuration.then(async () => {
      await this.load();
      if (!object(update)) throw new Error('Invalid translation configuration.');
      const nextConfig = { ...this.config }; const nextCredentials = { ...this.credentials };
      if (update.provider !== undefined) {
        if (!PROVIDERS.includes(update.provider as TranslationProvider)) throw new Error('Invalid translation provider.');
        nextConfig.provider = update.provider as TranslationProvider;
      }
      if (update.targetLanguage !== undefined) {
        if (!TARGETS.includes(update.targetLanguage as TranslationTarget)) throw new Error('Invalid translation target language.');
        nextConfig.targetLanguage = update.targetLanguage as TranslationTarget;
      }
      for (const key of CREDENTIAL_KEYS) if (update[key] !== undefined) nextCredentials[key] = credential(update[key]);
      let encryptedCredentials: string | undefined;
      if (Object.values(nextCredentials).some(Boolean)) {
        if (!this.encryptor) throw storageError();
        try { encryptedCredentials = await this.encryptor.encrypt(JSON.stringify(nextCredentials)); }
        catch { throw storageError(); }
        if (!encryptedCredentials || encryptedCredentials.length > MAX_CONFIG_BYTES / 2) throw storageError();
      }
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, ...nextConfig, encryptedCredentials }), 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.file);
      } catch { throw new Error('Translation settings could not be saved.'); }
      finally { await unlink(temporary).catch(() => undefined); }
      this.config = nextConfig; this.credentials = nextCredentials;
      return this.publicConfig();
    });
    this.configuration = action.catch(() => undefined);
    return action;
  }

  /** Window-level callers should use their own signal; cancel() is for app-wide shutdown. */
  cancel(): void { for (const controller of this.active) controller.abort(); }

  async translate(text: string, signal?: AbortSignal, options?: { provider: TranslationProvider; targetLanguage: TranslationTarget }): Promise<TranslationResult> {
    await this.load(); await this.configuration;
    if (signal?.aborted) throw cancelled();
    if (typeof text !== 'string' || !text.trim()) throw new Error('Select text to translate.');
    const { provider, targetLanguage } = options || this.config;
    if (!PROVIDERS.includes(provider) || !TARGETS.includes(targetLanguage)) throw new Error('Invalid translation options.');
    const maxBytes = provider === 'baidu' ? 4500 : 30_000;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`Selected text exceeds the ${maxBytes}-byte translation limit.`);
    const credentials = { ...this.credentials };
    if (provider === 'baidu' && (!credentials.baiduAppId || !credentials.baiduSecret)) throw new Error('Baidu translation is not configured.');
    const controller = new AbortController(); this.active.add(controller);
    const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let onRequestAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => { onRequestAbort = () => reject(cancelled()); controller.signal.addEventListener('abort', onRequestAbort, { once: true }); });
    try {
      const request = provider === 'google' ? this.google(text, targetLanguage, credentials, controller.signal) : this.baidu(text, targetLanguage, credentials, controller.signal);
      const translated = await Promise.race([request, aborted]);
      return { text: translated, provider, targetLanguage };
    } catch {
      if (timedOut) throw new Error('Translation request timed out.');
      if (controller.signal.aborted) throw cancelled();
      if (provider === 'google' && !credentials.googleApiKey) throw new Error('Google 免密翻译暂不可用，请稍后重试，或在翻译设置中配置百度 / Google Cloud 密钥。Keyless Google translation is unavailable on this network or temporarily limited.');
      throw new Error(`${provider === 'google' ? 'Google' : 'Baidu'} translation failed. Check the network, API credentials, and quota.`);
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); controller.signal.removeEventListener('abort', onRequestAbort); this.active.delete(controller);
    }
  }

  private async json(url: string, init: RequestInit): Promise<unknown> {
    // Reject redirects so credentials and selected manuscript text cannot be forwarded elsewhere.
    const response = await this.fetchImpl(url, { ...init, redirect: 'error', cache: 'no-store', credentials: 'omit' });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error('Translation response rejected.'); }
    if (!response.body) throw new Error('Empty translation response.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Translation response too large.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  private async google(text: string, target: TranslationTarget, secrets: Credentials, signal: AbortSignal): Promise<string> {
    if (!secrets.googleApiKey) {
      const url = new URL('https://translate.googleapis.com/translate_a/single');
      url.searchParams.set('client', 'gtx'); url.searchParams.set('sl', 'auto'); url.searchParams.set('tl', target); url.searchParams.set('dt', 't'); url.searchParams.set('q', text);
      const body = await this.json(url.toString(), { method: 'GET', signal });
      const rows: unknown[] = Array.isArray(body) && Array.isArray(body[0]) ? body[0] : [];
      const translated = rows.map(row => Array.isArray(row) ? row[0] : '').filter((value): value is string => typeof value === 'string').join('');
      if (!translated) throw new Error('Invalid Google translation response.');
      return translated;
    }
    const body = await this.json('https://translation.googleapis.com/language/translate/v2', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': secrets.googleApiKey! },
      body: JSON.stringify({ q: text, target, format: 'text' }),
    });
    const data = object(body) && object(body.data) ? body.data : undefined;
    const translations = data?.translations;
    if (!Array.isArray(translations) || translations.length !== 1 || !object(translations[0]) || typeof translations[0].translatedText !== 'string' || !translations[0].translatedText.trim()) throw new Error('Malformed translation response.');
    return decodeGoogleText(translations[0].translatedText);
  }

  private async baidu(text: string, target: TranslationTarget, secrets: Credentials, signal: AbortSignal): Promise<string> {
    const salt = randomUUID(); const appid = secrets.baiduAppId!;
    const sign = createHash('md5').update(appid + text + salt + secrets.baiduSecret!, 'utf8').digest('hex');
    const body = await this.json('https://fanyi-api.baidu.com/api/trans/vip/translate', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ appid, q: text, from: 'auto', to: BAIDU_TARGETS[target], salt, sign }).toString(),
    });
    if (!object(body) || body.error_code !== undefined || !Array.isArray(body.trans_result) || !body.trans_result.length || body.trans_result.some(item => !object(item) || typeof item.dst !== 'string')) throw new Error('Malformed translation response.');
    const translated = body.trans_result.map(item => (item as { dst: string }).dst).join('\n');
    if (!translated.trim()) throw new Error('Empty translation response.');
    return translated;
  }
}
