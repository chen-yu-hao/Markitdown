export type TranslationProvider = 'google' | 'baidu';
export type TranslationTarget = 'zh-CN' | 'en' | 'ja' | 'de' | 'fr';

/** Public translation preferences. Credentials are deliberately omitted. */
export interface TranslationConfig {
  provider: TranslationProvider;
  targetLanguage: TranslationTarget;
  googleConfigured: boolean;
  baiduConfigured: boolean;
}

export interface TranslationConfigUpdate {
  provider?: TranslationProvider;
  targetLanguage?: TranslationTarget;
  googleApiKey?: string;
  baiduAppId?: string;
  baiduSecret?: string;
}

export interface TranslationResult {
  text: string;
  provider: TranslationProvider;
  targetLanguage: TranslationTarget;
}

export interface TranslationAPI {
  getConfig(): Promise<TranslationConfig>;
  configure(update: TranslationConfigUpdate): Promise<TranslationConfig>;
  translate(text: string, signal?: AbortSignal, options?: { provider: TranslationProvider; targetLanguage: TranslationTarget }): Promise<TranslationResult>;
  cancel(): void;
}
