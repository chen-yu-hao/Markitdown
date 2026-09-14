import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { exportCss, getSafeLinkURL, renderMarkdown } from '../shared/markdown';
import { articleColumns, articleColumnCss } from '../shared/article-layout';
import { exportThemeCss, themeTokens } from '../shared/themes';
import type { DocumentSession, Settings, ThemeName } from '../shared/contracts';
import type { CitationRenderData } from '../shared/academic-contracts';
import { sameEditorSettings } from './editor-settings-equality';
import katexCss from 'katex/dist/katex.min.css?inline';
import './article-preview.css';

export default function ArticlePreview({ document: doc, settings, citations, theme, zh, edit }: {
  document: DocumentSession; settings: Settings; citations: CitationRenderData; theme: ThemeName; zh: boolean; edit(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const retainedSettings = useRef(settings);
  if (!sameEditorSettings(retainedSettings.current, settings)) retainedSettings.current = settings;
  const renderSettings = retainedSettings.current;
  const html = useMemo(() => articleColumns(renderMarkdown(doc.source, {
    settings: renderSettings, citations, purpose: 'editor', allowRemoteImages: false,
    imageURL: destination => window.markedown.imageURL(doc.id, destination),
  })), [doc.source, doc.id, renderSettings, citations]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot || el.attachShadow({ mode: 'open' });
    const palette = themeTokens[theme];
    const tableCss = exportCss.replaceAll('html[data-table-style', '[data-table-style');
    const style = document.createElement('style');
    style.textContent = `${katexCss}\n${tableCss}\n${exportThemeCss(theme)}\n${articleColumnCss}
      :host{display:block;color:${palette.ink};background:${palette.background};font-size:var(--paper-font-size,17px);letter-spacing:0}
      main{margin:0;max-width:none;overflow-wrap:anywhere}p:first-child{margin-top:0}
      .article-columns{color:${palette.ink}}.article-columns .article-section{column-width:260px}
      .article-columns h1,.article-columns h2{font-family:"Segoe UI","Microsoft YaHei",sans-serif;font-weight:650;text-align:left}
      a{color:${palette.accent}}code,pre{background:${palette.code}}blockquote{color:${palette.muted}}
      .md-equation-body{overflow-x:auto}.md-bibliography{font-size:.9em}input{pointer-events:none}
      @media(max-width:680px){.article-columns .article-section{column-count:1}}
    `;
    const content = document.createElement('div');
    content.dataset.tableStyle = settings.tableStyle;
    content.innerHTML = `<main class="markdown-body article-columns">${html}</main>`;
    root.replaceChildren(style, content);
    const follow = (event: Event) => {
      const link = (event.target as Element).closest('a');
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) {
        let id = href.slice(1); try { id = decodeURIComponent(id); } catch { /* Literal anchor. */ }
        root.getElementById(id)?.scrollIntoView({ block: 'center' });
      } else {
        const safe = getSafeLinkURL(href);
        if (safe && /^(https?:|mailto:)/i.test(safe)) void window.markedown.openExternal(safe);
      }
    };
    root.addEventListener('click', follow);
    return () => root.removeEventListener('click', follow);
  }, [html, settings.tableStyle, theme]);
  return <section className="article-preview" aria-label={zh ? '双栏论文阅读' : 'Two-column article preview'}>
    <div className="article-preview-tools"><span>{zh ? '双栏 · 论文阅读' : 'Two columns · Article preview'}</span><button type="button" onClick={edit}>{zh ? '编辑源码' : 'Edit source'} <kbd>Ctrl+/</kbd></button></div>
    <div className="article-preview-scroll" tabIndex={0} aria-label={zh ? '论文内容' : 'Article content'}>
      <div className="article-preview-paper" ref={host} style={{ '--paper-font-size': `${settings.fontSizeMode === 'auto' ? 17 : settings.fontSize}px`, maxWidth: Math.max(800, settings.readingWidth) } as CSSProperties} />
    </div>
  </section>;
}
