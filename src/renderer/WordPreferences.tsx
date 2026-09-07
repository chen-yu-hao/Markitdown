import { useEffect, useRef, useState } from 'react';
import { defaultSettings, type Settings } from '../shared/contracts';
import './word-preferences.css';

interface Props { settings: Settings; zh: boolean; change(patch: Partial<Settings>): void }
const wordSize = (value: string) => value.trim() && Number.isFinite(Number(value)) ? String(Math.min(72, Math.max(6, Math.round(Number(value) * 2) / 2))) : null;
const fontName = (value: string) => value.trim() && value.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;

export default function WordPreferences({ settings: s, zh, change }: Props) {
  const t = (cn: string, en: string) => zh ? cn : en;
  return <section className="word-preferences" aria-label={t('Word 文字样式','Word typography')}>
    <h3>{t('Word 文字样式','Word typography')}</h3>
    <p className="pref-hint">{t('所有 Word 预设共用以下样式，重新导出时生效。字体需在打开 Word 文档的电脑上可用。','All Word presets share these styles. Changes apply to future exports. Fonts must be available on the computer opening the Word document.')}</p>
    <label className="pref-row"><span>{t('中文字体','Chinese font')}</span><WordInput label={t('Word 中文字体','Word Chinese font')} value={s.wordChineseFont} normalize={fontName} list="word-chinese-fonts" commit={value => change({ wordChineseFont: value })}/></label>
    <datalist id="word-chinese-fonts">{['宋体','仿宋','楷体','黑体','微软雅黑','等线'].map(font => <option key={font} value={font}/>)}</datalist>
    <label className="pref-row"><span>{t('西文字体','Latin font')}</span><WordInput label={t('Word 西文字体','Word Latin font')} value={s.wordLatinFont} normalize={fontName} list="word-latin-fonts" commit={value => change({ wordLatinFont: value })}/></label>
    <datalist id="word-latin-fonts">{['Times New Roman','Arial','Calibri','Cambria','Georgia'].map(font => <option key={font} value={font}/>)}</datalist>
    <div className="pref-row"><span>{t('统一文字颜色','Text color')}</span><div className="word-color"><input type="color" aria-label={t('Word 文字颜色','Word text color')} value={s.wordTextColor} onChange={event => change({ wordTextColor: event.target.value.toUpperCase() })}/><WordInput label={t('Word 颜色值','Word color hex')} value={s.wordTextColor} normalize={value => /^#[a-f\d]{6}$/i.test(value.trim()) ? value.trim().toUpperCase() : null} commit={value => change({ wordTextColor: value })}/></div></div>
    <label className="pref-row"><span>{t('正文字号（磅）','Body size (pt)')}</span><WordInput label={t('Word 正文字号','Word body size')} type="number" value={String(s.wordBodyFontSize)} normalize={wordSize} commit={value => change({ wordBodyFontSize: Number(value) })}/></label>
    <div className="word-heading-sizes">{s.wordHeadingSizes.map((size, index) => <label className="pref-row" key={index}><span>{t(`${index + 1} 级标题（磅）`,`Heading ${index + 1} (pt)`)}</span><WordInput label={t(`Word ${index + 1} 级标题字号`,`Word heading ${index + 1} size`)} type="number" value={String(size)} normalize={wordSize} commit={value => change({ wordHeadingSizes: s.wordHeadingSizes.map((current, at) => at === index ? Number(value) : current) })}/></label>)}</div>
    <label className="pref-check"><input type="checkbox" checked={s.wordHeadingBold} onChange={event => change({ wordHeadingBold: event.target.checked })}/><span>{t('标题加粗','Bold headings')}</span></label>
    <label className="pref-check"><input type="checkbox" checked={s.wordHeadingItalic} onChange={event => change({ wordHeadingItalic: event.target.checked })}/><span>{t('标题斜体','Italic headings')}</span></label>
    <p className="pref-hint">{t('字体与文字颜色统一应用于正文、标题、列表、表格、链接和代码。字号可按 0.5 磅调整（6–72 磅）。','Fonts and text color apply to body text, headings, lists, tables, links and code. Sizes support 0.5 pt increments (6–72 pt).')}</p>
    <button type="button" className="pref-button" onClick={() => change({ wordChineseFont: defaultSettings.wordChineseFont, wordLatinFont: defaultSettings.wordLatinFont, wordTextColor: defaultSettings.wordTextColor, wordBodyFontSize: defaultSettings.wordBodyFontSize, wordHeadingSizes: [...defaultSettings.wordHeadingSizes], wordHeadingBold: defaultSettings.wordHeadingBold, wordHeadingItalic: defaultSettings.wordHeadingItalic })}>{t('恢复 Word 默认样式','Reset Word styles')}</button>
  </section>;
}

function WordInput({ value, commit, normalize, label, type = 'text', list }: { value: string; commit(value: string): void; normalize(value: string): string | null; label: string; type?: 'text' | 'number'; list?: string }) {
  const [draft, setDraft] = useState(value); const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return <input aria-label={label} type={type} list={list} value={draft} {...(type === 'number' ? { min: 6, max: 72, step: 0.5, className: 'pref-number' } : {})} onFocus={() => { focused.current = true; }} onChange={event => setDraft(event.target.value)} onBlur={() => { focused.current = false; const next = normalize(draft); setDraft(next ?? value); if (next !== null && next !== value) commit(next); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/>
}
