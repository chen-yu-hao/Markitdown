import type { ThemeName } from './contracts';

// Independently authored styles. No Typora theme files or proprietary assets are used.
export const themeTokens: Record<ThemeName, { background: string; chrome: string; ink: string; muted: string; accent: string; code: string; line: string; font: string; headingFont: string }> = {
  github: { chrome: "#f7f7f7", background: '#ffffff', ink: '#24292f', muted: '#6e7781', accent: '#0969da', code: '#f6f8fa', line: '#d8dee4', font: '"Segoe UI","Microsoft YaHei",sans-serif', headingFont: '"Segoe UI","Microsoft YaHei",sans-serif' },
  newsprint: { chrome: "#e8e5dd", background: '#f5f2e9', ink: '#333333', muted: '#858078', accent: '#75654a', code: '#eae7de', line: '#c8c2b7', font: 'Georgia,"Noto Serif CJK SC","SimSun",serif', headingFont: 'Georgia,"SimSun",serif' },
  night: { chrome: "#24282c", background: '#363d43', ink: '#d7d9db', muted: '#a2a8ad', accent: '#a4c3dd', code: '#2d343a', line: '#4e575f', font: '"Segoe UI","Microsoft YaHei",sans-serif', headingFont: '"Segoe UI","Microsoft YaHei",sans-serif' },
  pixyll: { chrome: "#f8f8f8", background: '#ffffff', ink: '#333333', muted: '#888888', accent: '#0076df', code: '#f5f5f5', line: '#dddddd', font: 'Georgia,"SimSun",serif', headingFont: '"Segoe UI","Microsoft YaHei",sans-serif' },
  whitey: { chrome: "#f6f6f6", background: '#fefefe', ink: '#333333', muted: '#999999', accent: '#555555', code: '#f4f4f4', line: '#dddddd', font: 'Georgia,"SimSun",serif', headingFont: 'Georgia,"SimSun",serif' },
};
export function exportThemeCss(theme: ThemeName): string {
  const p = themeTokens[theme] || themeTokens.github;
  return `html,body{background:${p.background};color:${p.ink};color-scheme:${theme === 'night' ? 'dark' : 'light'}}body{font-family:${p.font}}.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{font-family:${p.headingFont};color:${p.ink}}.markdown-body a{color:${p.accent}}.markdown-body code,.markdown-body pre{background:${p.code};color:inherit}.markdown-body th,.markdown-body td{border-color:${p.line}}.markdown-body th{background:${p.code}}.markdown-body blockquote{border-left-color:${p.line};color:${p.muted}}.markdown-body h1,.markdown-body h2{border-bottom-color:${p.line}}.export-outline{border-color:${p.line}}.export-outline a{color:${p.muted}}` +
    (theme === 'newsprint' ? '.markdown-body h1{font-size:2em;font-weight:400;border-bottom:1px solid;padding-bottom:.25em}.markdown-body h2{font-weight:400}' : '') +
    (theme === 'pixyll' ? '.markdown-body{line-height:1.8}.markdown-body h1{font-size:2.7em;line-height:1.2;border-bottom:0;font-weight:750}.markdown-body h2{border-bottom:0;font-weight:700}' : '') +
    (theme === 'whitey' ? '.markdown-body h1{font-size:2.8em;line-height:1.3;text-align:center;border-bottom:0;font-weight:400;margin:1em 0}.markdown-body h2{font-weight:400;border-bottom:0}' : '') +
    (theme === 'night' ? '.markdown-body h1,.markdown-body h2{border-bottom:0}.markdown-body .hljs-keyword,.markdown-body .hljs-selector-tag{color:#c792ea}.markdown-body .hljs-string{color:#c3e88d}.markdown-body .hljs-number,.markdown-body .hljs-literal{color:#f78c6c}' : '');
}
