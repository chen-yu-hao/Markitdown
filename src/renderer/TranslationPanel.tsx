import { useEffect, useRef, useState } from 'react';
import type { TranslationConfig, TranslationProvider, TranslationTarget } from '../shared/translation';
import './translation.css';

const languages: [TranslationTarget, string][] = [['zh-CN', '简体中文'], ['en', 'English'], ['ja', '日本語'], ['de', 'Deutsch'], ['fr', 'Français']];

export function TranslationPreferences({ zh, onSaved }: { zh: boolean; onSaved?(config: TranslationConfig): void }) {
  const [config, setConfig] = useState<TranslationConfig>();
  const [google, setGoogle] = useState('');
  const [appid, setAppid] = useState('');
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const t = (cn: string, en: string) => zh ? cn : en;
  useEffect(() => { let active = true; void window.markedown.translation.getConfig().then(result => {
    if (!active) return;
    if (result.status === 'ok') setConfig(result.value);
    else if (result.status === 'error') setMessage(result.message);
  }).catch(error => { if (active) setMessage(String(error)); }); return () => { active = false; }; }, []);
  async function save(clear?: TranslationProvider) {
    if (!config) return;
    setBusy(true); setMessage('');
    try {
      const result = await window.markedown.translation.configure({
        provider: config.provider, targetLanguage: config.targetLanguage,
        ...(google ? { googleApiKey: google } : {}), ...(appid ? { baiduAppId: appid } : {}), ...(secret ? { baiduSecret: secret } : {}),
        ...(clear === 'google' ? { googleApiKey: '' } : {}), ...(clear === 'baidu' ? { baiduAppId: '', baiduSecret: '' } : {}),
      });
      if (result.status === 'ok') { setConfig(result.value); setGoogle(''); setAppid(''); setSecret(''); onSaved?.(result.value); setMessage(t('设置已保存。', 'Settings saved.')); }
      else if (result.status === 'error') setMessage(result.message);
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }
  return <div className="translation-settings">
    <p className="pref-hint">{t('Google 默认免密使用；也可填写自己的 Google Cloud API Key。百度需要通用翻译 API 的 App ID 和密钥。凭据仅保存在本机，使用系统加密。', 'Google works without a key by default; an optional Google Cloud API key is supported. Baidu requires a General Translation API App ID and secret. Credentials are encrypted on this computer.')}</p>
    {config && <>
      <label>{t('默认服务', 'Default service')}<select aria-label={t('默认翻译服务', 'Default translation service')} value={config.provider} onChange={event => setConfig({ ...config, provider: event.target.value as TranslationProvider })}><option value="google">Google</option><option value="baidu">{t('百度', 'Baidu')}</option></select></label>
      <label>{t('目标语言', 'Target language')}<select aria-label={t('默认目标语言', 'Default target language')} value={config.targetLanguage} onChange={event => setConfig({ ...config, targetLanguage: event.target.value as TranslationTarget })}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Google API Key<input type="password" autoComplete="off" aria-label="Google API Key" value={google} onChange={event => setGoogle(event.target.value)} placeholder={config.googleConfigured ? t('已配置，留空保留', 'Configured; leave blank to keep') : t('可选，留空使用免密翻译', 'Optional; leave blank for keyless translation')} /></label>
      {config.googleConfigured && <button className="text-command" disabled={busy} onClick={() => void save('google')}>{t('移除 Google 密钥', 'Remove Google key')}</button>}
      <label>Baidu App ID<input autoComplete="off" aria-label="Baidu App ID" value={appid} onChange={event => setAppid(event.target.value)} placeholder={config.baiduConfigured ? t('已配置，留空保留', 'Configured; leave blank to keep') : ''} /></label>
      <label>{t('百度密钥', 'Baidu secret')}<input type="password" autoComplete="off" aria-label="Baidu secret" value={secret} onChange={event => setSecret(event.target.value)} placeholder={config.baiduConfigured ? t('已配置，留空保留', 'Configured; leave blank to keep') : ''} /></label>
      {config.baiduConfigured && <button className="text-command" disabled={busy} onClick={() => void save('baidu')}>{t('移除百度凭据', 'Remove Baidu credentials')}</button>}
      <button className="primary-command" disabled={busy} onClick={() => void save()}>{busy ? t('保存中…', 'Saving…') : t('保存翻译设置', 'Save translation settings')}</button>
    </>}
    {message && <p role="status">{message}</p>}
  </div>;
}

export default function TranslationPanel({ text, provider: initialProvider, zh }: { text: string; provider: TranslationProvider; zh: boolean }) {
  const [provider, setProvider] = useState(initialProvider);
  const [target, setTarget] = useState<TranslationTarget>('zh-CN');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sequence = useRef(0);
  const t = (cn: string, en: string) => zh ? cn : en;
  async function translate(service = provider, language = target) {
    const id = ++sequence.current; setBusy(true); setError(''); setResult('');
    try {
      const reply = await window.markedown.translation.translate(text, service, language);
      if (id !== sequence.current) return;
      if (reply.status === 'ok') setResult(reply.value.text);
      else if (reply.status === 'error') setError(reply.message);
    } catch (cause) { if (id === sequence.current) setError(String(cause)); }
    finally { if (id === sequence.current) setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void window.markedown.translation.getConfig().then(reply => {
      if (!active) return;
      if (reply.status !== 'ok') { if (reply.status === 'error') setError(reply.message); return; }
      setTarget(reply.value.targetLanguage);
      if (initialProvider === 'baidu' && !reply.value.baiduConfigured) { setSettingsOpen(true); return; }
      void translate(initialProvider, reply.value.targetLanguage);
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; sequence.current++; void window.markedown.translation.cancel(); };
  }, []);
  return <div className="translation-panel">
    <div className="translation-controls">
      <select aria-label={t('翻译服务', 'Translation service')} value={provider} disabled={busy} onChange={event => { setProvider(event.target.value as TranslationProvider); setResult(''); }}><option value="google">Google</option><option value="baidu">{t('百度', 'Baidu')}</option></select>
      <span>→</span><select aria-label={t('翻译目标语言', 'Translation target language')} value={target} disabled={busy} onChange={event => { setTarget(event.target.value as TranslationTarget); setResult(''); }}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button className="primary-command" disabled={busy} onClick={() => void translate()}>{busy ? t('翻译中…', 'Translating…') : t('翻译', 'Translate')}</button>
      {busy && <button className="text-command" onClick={() => { sequence.current++; setBusy(false); void window.markedown.translation.cancel(); }}>{t('取消', 'Cancel')}</button>}
    </div>
    <p className="pref-hint">{t('仅把下方选中文字发送给所选翻译服务，不修改文稿。Google 免密接口可能受网络及服务限制影响。', 'Only the selected text below is sent to the chosen service. Your document stays unchanged. Keyless Google translation may be limited by connectivity or service availability.')}</p>
    <label>{t('原文', 'Selected text')}<textarea readOnly value={text} aria-label={t('翻译原文', 'Translation source')} /></label>
    <label>{t('译文', 'Translation')}<textarea readOnly value={result} aria-label={t('翻译结果', 'Translation result')} placeholder={busy ? t('正在请求翻译…', 'Requesting translation…') : ''} /></label>
    {error && <p role="alert" className="translation-error">{error}</p>}
    <div className="translation-controls"><button className="primary-command" disabled={!result} onClick={() => void window.markedown.copyText(result).catch(cause => setError(String(cause)))}>{t('复制译文', 'Copy translation')}</button><button className="text-command" onClick={() => setSettingsOpen(value => !value)}>{t('翻译设置', 'Translation settings')}</button></div>
    {settingsOpen && <TranslationPreferences zh={zh} />}
  </div>;
}
